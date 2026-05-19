import { BehaviorSubject, Subject, type Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CertificateRecord } from '../../domain/certificate';
import { createCertificateStream, type PollFrame } from './certificate-stream';
import { CtSourceError, type CtQuery, type CtSource } from './ct-source';

const INTERVAL = 1_000;

function certificate(id: string, name = `${id}.example`): CertificateRecord {
  return {
    id,
    names: [name],
    commonName: name,
    issuer: 'Test CA',
    loggedAt: '2026-05-18T09:00:00.000Z',
    notBefore: '2026-05-18T08:00:00.000Z',
    notAfter: '2026-08-18T08:00:00.000Z',
    serialNumber: `serial-${id}`,
    source: 'fixture',
  };
}

const QUERIES: CtQuery[] = [{ identity: '%acme%', watchEntryId: 'watch-1' }];

/** A source whose every response is dictated by the test. */
class ScriptedSource implements CtSource {
  readonly name = 'Scripted';
  readonly calls: CtQuery[] = [];
  readonly signals: AbortSignal[] = [];
  private responses: Array<() => Promise<CertificateRecord[]>> = [];

  script(...responses: Array<() => Promise<CertificateRecord[]>>): void {
    this.responses = responses;
  }

  fetchCertificates(query: CtQuery, signal?: AbortSignal): Promise<CertificateRecord[]> {
    this.calls.push(query);
    if (signal !== undefined) this.signals.push(signal);
    const next = this.responses.shift() ?? (() => Promise.resolve([]));
    return next();
  }
}

describe('createCertificateStream', () => {
  let source: ScriptedSource;
  let queries$: BehaviorSubject<readonly CtQuery[]>;
  let frames: PollFrame[];
  let subscription: Subscription | null;
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    source = new ScriptedSource();
    queries$ = new BehaviorSubject<readonly CtQuery[]>(QUERIES);
    frames = [];
    subscription = null;
    clock = Date.parse('2026-05-18T09:00:00.000Z');
  });

  afterEach(() => {
    subscription?.unsubscribe();
    vi.useRealTimers();
  });

  function start(overrides: Partial<Parameters<typeof createCertificateStream>[0]> = {}): void {
    const stream = createCertificateStream({
      source,
      queries$,
      intervalMs: INTERVAL,
      now: () => clock,
      ...overrides,
    });
    subscription = stream.frames$.subscribe((frame) => frames.push(frame));
  }

  /** Advances both the fake timers and the injected clock. */
  async function tick(ms: number): Promise<void> {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('emits a loading frame and then the results', async () => {
    source.script(() => Promise.resolve([certificate('1')]));
    start();
    await tick(0);

    expect(frames.map((frame) => frame.status)).toEqual(['loading', 'ok']);
    expect(frames.at(-1)?.certificates).toHaveLength(1);
    expect(frames.at(-1)?.lastSuccessAt).toBe('2026-05-18T09:00:00.000Z');
  });

  it('names the source it is polling, for the offline banner', async () => {
    source.script(() => Promise.resolve([]));
    start();
    await tick(0);
    expect(frames.at(-1)?.sourceName).toBe('Scripted');
  });

  it('polls again on the interval', async () => {
    source.script(
      () => Promise.resolve([certificate('1')]),
      () => Promise.resolve([certificate('1')]),
    );
    start();
    await tick(0);
    await tick(INTERVAL);

    expect(source.calls).toHaveLength(2);
  });

  describe('only genuinely new certificates', () => {
    it('reports nothing new and keeps the array identity when the set is unchanged', async () => {
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.resolve([certificate('1')]),
      );
      start();
      await tick(0);
      const first = frames.at(-1) as PollFrame;

      await tick(INTERVAL);
      const second = frames.at(-1) as PollFrame;

      expect(second.newCertificates).toEqual([]);
      // Reference equality is what keeps the results table from re-rendering.
      expect(second.certificates).toBe(first.certificates);
    });

    it('reports only the certificates it has not seen before', async () => {
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.resolve([certificate('1'), certificate('2')]),
      );
      start();
      await tick(0);
      await tick(INTERVAL);

      const frame = frames.at(-1) as PollFrame;
      expect(frame.newCertificates.map((record) => record.id)).toEqual(['2']);
      expect(frame.certificates).toHaveLength(2);
    });

    it('does not re-announce a certificate that disappears and comes back', async () => {
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.resolve([]),
        () => Promise.resolve([certificate('1')]),
      );
      start();
      await tick(0);
      await tick(INTERVAL);
      await tick(INTERVAL);

      expect(frames.at(-1)?.newCertificates).toEqual([]);
    });

    it('emits on newCertificates$ only for genuinely new rows', async () => {
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.resolve([certificate('1')]),
        () => Promise.resolve([certificate('1'), certificate('2')]),
      );

      const stream = createCertificateStream({
        source,
        queries$,
        intervalMs: INTERVAL,
        now: () => clock,
      });
      const announced: string[][] = [];
      subscription = stream.newCertificates$.subscribe((records) =>
        announced.push(records.map((record) => record.id)),
      );

      await tick(0);
      await tick(INTERVAL);
      await tick(INTERVAL);

      expect(announced).toEqual([['1'], ['2']]);
    });
  });

  describe('failure', () => {
    it('produces an error frame instead of terminating the stream', async () => {
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.reject(new CtSourceError('timeout', 'crt.sh did not respond in time')),
        () => Promise.resolve([certificate('1'), certificate('2')]),
      );
      start();
      await tick(0);
      await tick(INTERVAL);

      const failed = frames.at(-1) as PollFrame;
      expect(failed.status).toBe('error');
      expect(failed.error).toMatchObject({ kind: 'timeout' });

      await tick(INTERVAL);
      expect(frames.at(-1)?.status).toBe('ok');
    });

    it('keeps showing the last good certificates while failing', async () => {
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.reject(new CtSourceError('network', 'offline')),
      );
      start();
      await tick(0);
      await tick(INTERVAL);

      expect(frames.at(-1)?.certificates).toHaveLength(1);
    });

    it('freezes lastSuccessAt so the staleness indicator can tell the truth', async () => {
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.reject(new CtSourceError('network', 'offline')),
      );
      start();
      await tick(0);
      const successAt = frames.at(-1)?.lastSuccessAt;

      await tick(INTERVAL);
      expect(frames.at(-1)?.lastSuccessAt).toBe(successAt);
    });

    it('classifies a non-CtSourceError failure rather than leaking it', async () => {
      source.script(() => Promise.reject(new Error('boom')));
      start();
      await tick(0);

      expect(frames.at(-1)?.error).toMatchObject({ kind: 'network', message: 'boom' });
    });

    it('marks a cycle partial when some queries fail and others succeed', async () => {
      queries$.next([
        { identity: '%acme%', watchEntryId: 'watch-1' },
        { identity: '%acmecorp%', watchEntryId: 'watch-2' },
      ]);
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.reject(new CtSourceError('http', 'HTTP 500', { status: 500 })),
      );
      start();
      await tick(0);

      const frame = frames.at(-1) as PollFrame;
      expect(frame.status).toBe('ok');
      expect(frame.partial).toBe(true);
      expect(frame.certificates).toHaveLength(1);
    });

    it('deduplicates certificates returned by more than one query', async () => {
      queries$.next([
        { identity: '%acme%', watchEntryId: 'watch-1' },
        { identity: '%acmecorp%', watchEntryId: 'watch-1' },
      ]);
      source.script(
        () => Promise.resolve([certificate('1')]),
        () => Promise.resolve([certificate('1'), certificate('2')]),
      );
      start();
      await tick(0);

      expect(frames.at(-1)?.certificates).toHaveLength(2);
    });
  });

  describe('the query set', () => {
    it('polls immediately when the watchlist changes rather than waiting a full interval', async () => {
      source.script(
        () => Promise.resolve([]),
        () => Promise.resolve([certificate('9')]),
      );
      start();
      await tick(0);
      expect(source.calls).toHaveLength(1);

      queries$.next([{ identity: '%newdomain%', watchEntryId: 'watch-2' }]);
      await tick(0);

      expect(source.calls).toHaveLength(2);
      expect(source.calls.at(-1)?.identity).toBe('%newdomain%');
    });

    it('cancels an in-flight request when the query set changes', async () => {
      source.script(() => new Promise<CertificateRecord[]>(() => undefined));
      start();
      await tick(0);

      expect(source.signals[0]?.aborted).toBe(false);
      queries$.next([{ identity: '%other%', watchEntryId: 'watch-2' }]);
      await tick(0);

      expect(source.signals[0]?.aborted).toBe(true);
    });

    it('does not call the source at all when there is nothing to watch', async () => {
      queries$.next([]);
      start();
      await tick(0);

      expect(source.calls).toHaveLength(0);
      expect(frames.at(-1)?.status).toBe('ok');
      expect(frames.at(-1)?.certificates).toEqual([]);
    });
  });

  it('polls on demand when refreshed', async () => {
    const refresh$ = new Subject<void>();
    source.script(
      () => Promise.resolve([]),
      () => Promise.resolve([certificate('1')]),
    );
    start({ refresh$ });
    await tick(0);

    refresh$.next();
    await tick(0);

    expect(source.calls).toHaveLength(2);
    expect(frames.at(-1)?.certificates).toHaveLength(1);
  });

  it('calls the cycle hook once per cycle, before any request', async () => {
    const onCycleStart = vi.fn();
    queries$.next([
      { identity: '%a%', watchEntryId: 'watch-1' },
      { identity: '%b%', watchEntryId: 'watch-1' },
    ]);
    start({ onCycleStart });
    await tick(0);

    expect(onCycleStart).toHaveBeenCalledTimes(1);
    await tick(INTERVAL);
    expect(onCycleStart).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the last subscriber goes away', async () => {
    source.script(() => Promise.resolve([]));
    start();
    await tick(0);
    const callsWhileSubscribed = source.calls.length;

    subscription?.unsubscribe();
    subscription = null;
    await tick(INTERVAL * 3);

    expect(source.calls).toHaveLength(callsWhileSubscribed);
  });
});
