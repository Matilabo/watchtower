/**
 * The polling stream.
 *
 * `interval` + `switchMap` is the shape the brief asks for, and switchMap is
 * doing real work here rather than being decoration: it cancels an in-flight
 * crt.sh request when the next tick comes round, and again when the watchlist
 * changes, so a slow request can never land after the query that superseded it
 * and re-populate the table with results for a domain the user just removed.
 * Cancellation is wired all the way down to `AbortController`, so the socket
 * is actually released.
 *
 * Failure is not modelled as stream termination. A CT feed that stops polling
 * because crt.sh 502'd once is useless, so a failed cycle produces an error
 * *frame* -- the last good certificates stay on screen, the error is described,
 * and `lastSuccessAt` stops advancing so the staleness indicator can tell the
 * user how old the data on screen actually is.
 */

import {
  Observable,
  type SchedulerLike,
  combineLatest,
  concat,
  defer,
  merge,
  of,
  timer,
} from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  filter,
  map,
  retry,
  scan,
  shareReplay,
  switchMap,
  tap,
} from 'rxjs/operators';

import type { CertificateRecord } from '../../domain/certificate';
import { certificateKey } from '../../domain/certificate';
import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff';
import { CtSourceError, type CtErrorKind, type CtQuery, type CtSource } from './ct-source';

/**
 * What started a cycle.
 *
 * The UI needs this to tell an automatic check apart from one the user asked
 * for: flipping the button to "Checking…" every interval is noise nobody
 * asked for, while doing nothing when they press it looks broken.
 */
export type PollTrigger = 'auto' | 'manual' | 'watchlist';

export interface PollError {
  readonly kind: CtErrorKind;
  readonly message: string;
  readonly attempts: number;
}

export interface PollFrame {
  readonly status: 'loading' | 'ok' | 'error';
  /**
   * Every certificate from the most recent successful cycle. The array keeps
   * its identity when the set has not changed, so a signal or an `OnPush` view
   * bound to it does not re-render on every poll.
   */
  readonly certificates: readonly CertificateRecord[];
  /** Only those never seen before in this session. Empty on an unchanged poll. */
  readonly newCertificates: readonly CertificateRecord[];
  /** ISO timestamp of the last cycle that produced data; drives staleness. */
  readonly lastSuccessAt: string | null;
  readonly polledAt: string;
  /** What started this cycle. */
  readonly trigger: PollTrigger;
  readonly error: PollError | null;
  /** Some queries failed but others succeeded: the set may be incomplete. */
  readonly partial: boolean;
  readonly sourceName: string;
  /** Failed cycles since the last success. Reset by any successful poll. */
  readonly consecutiveFailures: number;
  /**
   * Automatic polling has given up and is waiting to be asked again.
   *
   * Retrying a broken feed forever is how a client keeps a struggling service
   * down and burns the user's battery describing a problem it cannot fix, so
   * after a handful of consecutive failures the loop stops and hands the
   * decision back. A manual refresh or a watchlist change resumes it.
   */
  readonly autoRetryPaused: boolean;
}

export interface CertificateStreamOptions {
  readonly source: CtSource;
  /** The queries to run, re-emitted whenever the watchlist changes. */
  readonly queries$: Observable<readonly CtQuery[]>;
  readonly intervalMs?: number;
  /** Manual refresh trigger, merged with the interval. */
  readonly refresh$?: Observable<unknown>;
  readonly now?: () => number;
  readonly backoff?: BackoffOptions;
  /**
   * Consecutive failed cycles before automatic polling stops and waits for the
   * user. 0 disables the cap and retries forever.
   */
  readonly maxConsecutiveFailures?: number;
  /** Called once per cycle before any request; the fixture source uses it. */
  readonly onCycleStart?: () => void;
  /** Injected in tests to drive `timer` deterministically. */
  readonly scheduler?: SchedulerLike;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Failed cycles before automatic polling stands down.
 *
 * Five is enough to ride out a restart or a blip -- with jittered backoff that
 * is a couple of minutes of trying -- and few enough that a genuinely broken
 * feed stops burning requests and hands the decision back to the person who
 * can actually do something about it.
 */
export const MAX_AUTO_RETRIES = 5;

interface FetchOutcome {
  readonly certificates: readonly CertificateRecord[];
  readonly partial: boolean;
}

/** Bridges a promise-returning API to an Observable that cancels on unsubscribe. */
function fromAbortable<T>(work: (signal: AbortSignal) => Promise<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const controller = new AbortController();

    work(controller.signal).then(
      (value) => {
        subscriber.next(value);
        subscriber.complete();
      },
      (error: unknown) => subscriber.error(error),
    );

    return () => controller.abort();
  });
}

function toPollError(error: unknown): PollError {
  if (error instanceof CtSourceError) {
    return { kind: error.kind, message: error.message, attempts: error.attempts };
  }
  return {
    kind: 'network',
    message: error instanceof Error ? error.message : 'Unknown certificate source failure',
    attempts: 1,
  };
}

/**
 * Runs every query for one cycle.
 *
 * Partial failure is normal with several queries in flight, so one failed
 * query degrades the cycle to `partial` rather than discarding the results
 * that did come back. Only a total failure is an error.
 */
async function fetchAll(
  source: CtSource,
  queries: readonly CtQuery[],
  signal: AbortSignal,
): Promise<FetchOutcome> {
  if (queries.length === 0) return { certificates: [], partial: false };

  const settled = await Promise.allSettled(
    queries.map((query) => source.fetchCertificates(query, signal)),
  );

  const failures = settled.filter((result) => result.status === 'rejected');
  if (failures.length === queries.length) {
    throw (failures[0] as PromiseRejectedResult).reason;
  }

  const byKey = new Map<string, CertificateRecord>();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const certificate of result.value) {
      byKey.set(certificateKey(certificate), certificate);
    }
  }

  return { certificates: [...byKey.values()], partial: failures.length > 0 };
}

type CycleEvent =
  | { readonly type: 'loading'; readonly trigger: PollTrigger }
  | { readonly type: 'result'; readonly outcome: FetchOutcome }
  | {
      readonly type: 'error';
      readonly error: PollError;
      readonly consecutiveFailures: number;
      readonly autoRetryPaused: boolean;
    };

interface StreamState {
  readonly frame: PollFrame;
  readonly seen: ReadonlySet<string>;
  /** Signature of the last certificate set, to preserve array identity. */
  readonly signature: string;
}

function signatureOf(certificates: readonly CertificateRecord[]): string {
  return certificates.map(certificateKey).sort().join('|');
}

function reduce(state: StreamState, event: CycleEvent, now: () => number): StreamState {
  const polledAt = new Date(now()).toISOString();

  switch (event.type) {
    case 'loading':
      return {
        ...state,
        frame: {
          ...state.frame,
          status: 'loading',
          newCertificates: [],
          trigger: event.trigger,
          polledAt,
        },
      };

    case 'error':
      return {
        ...state,
        frame: {
          ...state.frame,
          status: 'error',
          newCertificates: [],
          error: event.error,
          consecutiveFailures: event.consecutiveFailures,
          autoRetryPaused: event.autoRetryPaused,
          polledAt,
        },
      };

    case 'result': {
      const signature = signatureOf(event.outcome.certificates);
      const unchanged = signature === state.signature;
      const newCertificates = unchanged
        ? []
        : event.outcome.certificates.filter(
            (certificate) => !state.seen.has(certificateKey(certificate)),
          );

      const seen = unchanged
        ? state.seen
        : new Set([...state.seen, ...event.outcome.certificates.map(certificateKey)]);

      return {
        seen,
        signature,
        frame: {
          status: 'ok',
          // Reusing the previous array when nothing changed is what makes
          // "only genuinely new certificates emit" true for consumers.
          certificates: unchanged ? state.frame.certificates : event.outcome.certificates,
          newCertificates,
          lastSuccessAt: polledAt,
          polledAt,
          error: null,
          partial: event.outcome.partial,
          sourceName: state.frame.sourceName,
          trigger: state.frame.trigger,
          consecutiveFailures: 0,
          autoRetryPaused: false,
        },
      };
    }
  }
}

/** Everything a consumer needs from one polling session. */
export interface CertificateStream {
  /** Status, staleness and the current certificate set. */
  readonly frames$: Observable<PollFrame>;
  /** Fires only when certificates not seen before arrive. */
  readonly newCertificates$: Observable<readonly CertificateRecord[]>;
}

export function createCertificateStream(options: CertificateStreamOptions): CertificateStream {
  const {
    source,
    queries$,
    intervalMs = DEFAULT_INTERVAL_MS,
    refresh$,
    now = Date.now,
    backoff = DEFAULT_BACKOFF,
    onCycleStart,
    scheduler,
    maxConsecutiveFailures = MAX_AUTO_RETRIES,
  } = options;

  // Whether the interval is still allowed to fire. Kept as closure state
  // rather than a signal or a Subject because nothing outside this stream may
  // write it: it is decided entirely by the outcomes flowing through here.
  const control = { consecutiveFailures: 0, paused: false, trigger: 'auto' as PollTrigger };

  const resume = (): void => {
    control.consecutiveFailures = 0;
    control.paused = false;
  };

  const registerFailure = (): void => {
    control.consecutiveFailures += 1;
    if (maxConsecutiveFailures > 0 && control.consecutiveFailures >= maxConsecutiveFailures) {
      control.paused = true;
    }
  };

  const initial: StreamState = {
    seen: new Set<string>(),
    signature: '',
    frame: {
      status: 'loading',
      certificates: [],
      newCertificates: [],
      lastSuccessAt: null,
      polledAt: new Date(now()).toISOString(),
      error: null,
      partial: false,
      sourceName: source.name,
      trigger: 'auto',
      consecutiveFailures: 0,
      autoRetryPaused: false,
    },
  };

  const ticks$ = (scheduler ? timer(0, intervalMs, scheduler) : timer(0, intervalMs)).pipe(
    filter(() => !control.paused),
    tap(() => {
      control.trigger = 'auto';
    }),
  );

  // Asking for data by hand is also an instruction to start trying again.
  const manual$ =
    refresh$ === undefined
      ? undefined
      : refresh$.pipe(
          tap(() => {
            resume();
            control.trigger = 'manual';
          }),
        );
  const triggers$ = manual$ === undefined ? ticks$ : merge(ticks$, manual$);

  // Changing the watchlist is user intent too, and it must start a cycle
  // immediately rather than waiting up to a full interval -- hence
  // combineLatest rather than withLatestFrom.
  const cycles$ = combineLatest([
    queries$.pipe(
      tap(() => {
        resume();
        control.trigger = 'watchlist';
      }),
    ),
    triggers$,
  ]).pipe(map(([queries]) => queries));

  const frames$ = cycles$.pipe(
    switchMap((queries) =>
      concat(
        of<CycleEvent>({ type: 'loading', trigger: control.trigger }),
        defer(() => {
          onCycleStart?.();
          return fromAbortable((signal) => fetchAll(source, queries, signal));
        }).pipe(
          tap(resume),
          map((outcome): CycleEvent => ({ type: 'result', outcome })),
          catchError((error: unknown) => {
            registerFailure();
            return of<CycleEvent>({
              type: 'error',
              error: toPollError(error),
              consecutiveFailures: control.consecutiveFailures,
              autoRetryPaused: control.paused,
            });
          }),
        ),
      ),
    ),
    scan((state, event) => reduce(state, event, now), initial),
    map((state) => state.frame),
    // Drops frames that say nothing new: repeated loading states, and successful
    // polls that returned the same certificates and the same status.
    distinctUntilChanged(
      (a, b) =>
        a.status === b.status &&
        a.certificates === b.certificates &&
        b.newCertificates.length === 0 &&
        a.partial === b.partial &&
        a.error?.message === b.error?.message &&
        a.autoRetryPaused === b.autoRetryPaused &&
        a.trigger === b.trigger &&
        a.consecutiveFailures === b.consecutiveFailures &&
        a.lastSuccessAt === b.lastSuccessAt,
    ),
    // Last-resort guard: an unexpected error must not end polling for the
    // session. Genuine fetch failures are already handled as frames above.
    retry({
      delay: (_error, retryCount) =>
        scheduler
          ? timer(backoffDelay(retryCount, backoff), scheduler)
          : timer(backoffDelay(retryCount, backoff)),
    }),
    // One polling session no matter how many consumers subscribe. `refCount`
    // means the interval stops when the last of them goes away, so navigating
    // off the page does not leave a timer hitting crt.sh forever.
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  return {
    frames$,
    newCertificates$: frames$.pipe(
      filter((frame) => frame.newCertificates.length > 0),
      map((frame) => frame.newCertificates),
    ),
  };
}
