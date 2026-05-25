# Watchtower

A certificate transparency watchtower. It surfaces newly issued TLS certificates
whose names resemble domains you own, so phishing infrastructure can be found
while it is still being set up rather than after the first victim reports it.

```bash
npm install && npm start
```

Then open <http://localhost:4200>. It works offline, with no API keys: the app
ships with fixture data and an in-process API.

---

## Why this exists

Every publicly trusted TLS certificate is published to public, append-only
certificate transparency logs within hours of being issued. Attackers use TLS
too, since a phishing page without a padlock converts badly, so they show up in
those logs, usually days before the campaign starts. That gap is the whole
opportunity: `n0rthwindbank.com` getting a certificate on Tuesday is a warning
that something will be mailed to your customers on Friday.

The logs are public and searchable, so the hard part is not access. It is that
CT is a firehose of millions of certificates a day, almost all of them
irrelevant, and the interesting ones are interesting for reasons a human can
usually see instantly and a naive string match never will: a Cyrillic `а`, a
`1` standing in for an `l`, `rn` where you expect `m`.

So the app is built around one belief, which shapes everything below:

> **A score with no reason is not actionable.** Anything that says "87" without
> saying *why* trains the person reading it to skim, and a security tool that
> gets skimmed is worse than no tool at all.

Every alert carries the list of rules that fired and exactly what each one
contributed, and the contributions sum to the score. You are meant to be able to
disagree with it.

---

## Architecture

```
                     ┌───────────────────────────────────────┐
   crt.sh  ─REST──▶  │  data/ct                              │
   (or fixtures)     │    crtsh-client   timeout/backoff/cap │
                     │    certificate-stream  interval+      │
                     │                        switchMap      │
                     │    staleness      "how old is this?"  │
                     └──────────────┬────────────────────────┘
                                    │ CertificateRecord[]
                                    ▼
                     ┌───────────────────────────────────────┐
                     │  domain/          pure TypeScript     │
                     │    normalize · punycode · levenshtein │
                     │    homoglyph · typosquat · scorer     │
                     │    alert (triage transitions)         │
                     └──────────────┬────────────────────────┘
                                    │ LookalikeAssessment
                                    ▼
                     ┌───────────────────────────────────────┐
   your API  ─GQL─▶  │  data/graphql                         │
   (or in-process)   │    schema.graphql · store · mock      │
                     │    watchlist · alerts · triage state  │
                     └──────────────┬────────────────────────┘
                                    │
                                    ▼
                     ┌───────────────────────────────────────┐
                     │  state/  signals in one service       │
                     │  ui/     standalone components        │
                     └───────────────────────────────────────┘
```

Dependencies point one way: `ui → state → data → domain`. The domain layer
imports nothing from Angular, RxJS or the DOM, which is why it can be tested
exhaustively in a bare Node process and why the scoring rules can be reused by a
CLI or a server later without dragging a framework along.

### The REST / GraphQL split

The two halves of this app have almost nothing in common, and using one protocol
for both would mean the wrong trade-off in one of them.

**Certificate transparency data is REST** because it is somebody else's data and
we take it as it comes:

- It is *immutable public record*. A logged certificate never changes, so there
  is nothing to mutate, nothing to invalidate, and no consistency problem.
- The shape is fixed and flat. There is no graph to traverse: a certificate has
  names, an issuer and dates. Nobody ever needs "the issuer's other certificates
  from Tuesday" in the same round trip.
- **We do not own the endpoint.** crt.sh is a free public service with no SLA,
  no GraphQL, and no interest in our query patterns. Putting a GraphQL gateway
  in front of it would add a hop and a server to operate, and would not change
  the fact that the upstream is slow and sometimes fails.
- Failure handling is the interesting part, and it is HTTP-shaped: per-attempt
  timeouts, status-code classification, retry budgets, `Retry-After`. All of
  that is natural over REST and awkward when wrapped in a transport that models
  errors as a field in a 200 response.

**Our own data is GraphQL** because it is the opposite in every respect:

- It is a *small, highly relational, mutable graph*. An alert has a certificate,
  an assessment, a list of rule hits, a watchlist entry, and an append-only
  triage history. The detail card wants all of it; the table wants four fields
  of it. One query shape per screen, no over-fetching, no `?include=` sprawl.
- It is *ours*, so we control the schema and can afford to design it well. The
  SDL is in [`schema.graphql`](src/app/data/graphql/schema.graphql) and is the
  source of truth; a test fails if the bundled copy drifts from it.
- Triage state is *written* constantly and read in several shapes. Mutations
  with typed inputs and a single result type beat inventing REST endpoints for
  "set triage state and append to history atomically".
- Expected failures travel as data. `addWatchlistEntry` returning a `UserError`
  with a `field` is how a typo renders next to the input that caused it. That
  is a domain outcome, not an HTTP 400.

Put briefly: **REST for the firehose we do not own, GraphQL for the small graph
we do.** Both sit behind interfaces (`CtSource`, `GraphQLClient`), so either can
be swapped at the composition root without touching a component.

### What crt.sh can and cannot do for us

crt.sh matches substrings, not similarity. A single `%northwindbank%` query
finds combosquats, hyphenations, doublings and TLD swaps, but never a
homoglyph, because `n0rthwindbank` does not contain `northwindbank`.

The fix is cheap: **any single-character substitution leaves one half of the
name intact**, so the client also queries both halves. This works on
internationalised names too, because an A-label keeps its untouched ASCII in
order: a Cyrillic-`а` variant of `northwindbank.com` is logged as
`xn--northwindbnk-69j.com`, which still contains `northwi`. Three queries per
watched domain, and homoglyphs become findable through a substring search.

What this deliberately does **not** catch is a name with substitutions in *both*
halves. That needs the full CT firehose (certstream) rather than a search
endpoint. The bundled fixture source simulates such a feed: it returns
everything and lets the scorer decide, so the offline demo shows what the
scorer can do. The UI always names the active source so the difference is never
hidden.

---

## The scorer

[`src/app/domain/scorer.ts`](src/app/domain/scorer.ts). Four decisions worth
defending:

**1. Rules have kinds.** `base` rules can raise suspicion alone (homoglyph,
transposition, omission, insertion, doubling, hyphenation, TLD swap,
combosquat, small edit distance). `modifier` rules only amplify something
already suspicious (punycode, mixed script, lure keywords like `login`, abuse-heavy
TLDs). `suppressor` means it is your own certificate. Without that split,
"contains `login`" and "uses `.zip`" would light up half the firehose  
`login-secure.zip` scores **0** against `northwindbank.com`, and a test pins it.

**2. Weights combine with a noisy-OR, not a sum.**

```
score = 100 × (1 − exp(−Σ −ln(1 − wᵢ/100)))
```

Two independent weak signals should raise the score; ten of them must not
outrank one strong one, and nothing needs clamping at 100.

**3. Every hit gets an attributed contribution that sums to the score exactly**
(largest-remainder apportionment over each rule's share of that log-space sum).
The UI renders a breakdown that adds up, rather than a score plus some unrelated
numbers.

**4. Overlapping evidence is counted once.** A hyphenation variant is not also
an insertion. `paypall` containing `paypal` is not a second finding on top of
the doubling. A specific structural rule suppresses the generic distance rule.
Each of these was a real over-scoring bug caught by the calibration snapshot in
[`snapshot.spec.ts`](src/app/domain/snapshot.spec.ts), which pins the ranking so
any weight change shows up as a reviewable diff:

```
 95 critical  pаypal.com                 Cyrillic а + punycode + mixed script
 87 critical  login-secure.paypa1.top    homoglyph + 2 lures + abuse TLD
 78 high      paypa1.com                 74 high  papyal.com
 71 high      paypal-secure.com          70 high  paypa.com
 64 high      paypall.com                64 high  pay-pal.com
 55 medium    paypal.info                55 medium paypaq.com
  0 none      mail.paypal.com  (yours)    0 none  wikipedia.org
```

### Known limits

- **Short names are not fuzzy-matched** (`minCoreLength: 4`). Every three-letter
  string is one edit from some other three-letter string.
- **The public suffix list is a subset.** The full PSL is ~250KB and changes
  weekly; unknown suffixes fall back to "last label", which is correct for every
  gTLD, so it degrades rather than breaks.
- **Skeleton folding is deliberately lossy.** Two genuinely different names can
  collapse onto one skeleton. Both sides get the same treatment and the evidence
  is always reported, so a human dismisses it in a glance.

---

## Frontend

Angular 20, standalone components, zoneless. No zone.js: state is signals, and
the polling stream writes into signals, so there is nothing left for zone
patching to do.

### Why there is no store library

**The shared state is small and has exactly one owner.**
[`WatchtowerStore`](src/app/state/watchtower.store.ts) holds a watchlist, a list
of alerts, a poll frame and a few flags. Nothing else writes to them.

NgRx earns its indirection when many unrelated features mutate overlapping
state, when you need time-travel debugging over a long action history, or when
effects coordinate across teams. None of that is true here. Adding actions,
reducers, selectors and effects would mean writing four files to express "set
this list", and would move logic *away* from the pure functions where it is
currently unit tested.

The parts that genuinely deserve rigour (scoring, triage transitions, ordering,
the certificate-to-alert join) are pure functions in `domain/`, tested without
a framework. The service is the thin, boring part, and it should stay that way.
If this grew multi-user collaboration or optimistic offline sync, that judgement
would change; it is a judgement about *this* state, not a position on stores.

### Directive Composition API

`riskHighlight` is defined **once** in
[`risk-highlight.directive.ts`](src/app/ui/risk-highlight.directive.ts) and
composed into two structurally unrelated hosts via `hostDirectives`:

```ts
// alert-row.component.ts: the component *is* the <tr>
@Component({
  selector: 'tr[wtAlertRow]',
  hostDirectives: [
    { directive: RiskHighlightDirective, inputs: ['riskLevel', 'riskScore', 'benign'] },
  ],
})

// alert-detail.component.ts: a card, sharing no structure with a table row
@Component({
  selector: 'wt-alert-detail',
  hostDirectives: [
    { directive: RiskHighlightDirective, inputs: ['riskLevel', 'riskScore', 'benign'] },
  ],
})
```

A table row and a detail card have no structure in common, which is exactly why
composition beats the alternatives: no shared base class (they extend nothing
alike), no wrapper element that exists only to hold a class, no duplicated host
bindings that drift. The hosts declare *what they are*; the directive decides
*what risk looks like*: accent colour, border weight and `data-risk-level`, for
both at once.

The directive is presentation only. Risk reaches assistive technology as text
from the badge, never as a CSS custom property.

### RxJS polling

[`certificate-stream.ts`](src/app/data/ct/certificate-stream.ts) uses `interval` +
`switchMap`, and `switchMap` is load-bearing rather than decorative: it cancels
the in-flight request on the next tick *and* when the watchlist changes, wired
through to `AbortController`. A slow response can never land after the query
that superseded it and repopulate the table for a domain you just removed.

Failure is a *frame*, not a terminated stream. A feed that stops polling because
crt.sh 502'd once is useless, so the last good certificates stay on screen, the
error is described in the status bar, and `lastSuccessAt` stops advancing, which
is what makes the staleness indicator honest.

The status bar distinguishes a check the user asked for from one the interval
started: an automatic check pulses the indicator and says "checking
automatically…", while the button only ever responds to presses. The indicator
also keeps the colour it earned while a request is in flight. Dropping it to
grey mid-check made the light appear to cycle green, blank, amber on its own,
which is a status bar reporting on itself rather than on the data.

Automatic retries are capped at **five consecutive failures**. Past that the
interval stands down and the status bar says so, because hammering a feed that
is genuinely down helps nobody and "retrying automatically" is a lie once you
have decided to stop. A manual *Try again*, or any watchlist change, resumes it
and resets the count. Partial cycles (some queries failed, others returned)  
are not failures: they are reported as incomplete and the data is kept.

"Only genuinely new certificates emit" is implemented by keeping the
`certificates` array *identity* across unchanged polls (so bound views do not
re-render) and exposing `newCertificates$` separately for the live region.

---

## Layout

The watchlist is a band across the top, not a column beside the results. As a
column it took 20rem the table needed, which forced the table into horizontal
scrolling at ordinary laptop widths, and a table you have to scroll sideways is
a table you cannot scan. The table now fits without a scrollbar down to 900px,
shedding the issuer and logged-at columns below 1150px and the watched-domain
column below 860px; all three are still in the detail card.

Because every line the band occupies is a row of results nobody sees, its parts
are ranked by how often they are used: what is watched stays visible, the form
to add something is one click away, and with nothing watched yet the form opens
because it is then the only thing worth doing.

## Accessibility

The requirement that shaped the most code: **a keyboard user reading row 12 must
not be disrupted when new certificates arrive.**

- **Updates are held, not imposed.** While focus is inside the results table,
  newly recorded alerts are held back; a button says how many are waiting, and
  pressing it is the only thing that inserts them. When focus is elsewhere they
  apply on their own.
- **Order is stable.** Applying fresh data never re-ranks a list already on
  screen (`preserveOrder`); marking row 3 benign does not make rows 4–12 jump.
  Triage updates a row in place.
- **One polite live region**, carrying a sentence, such as "3 new certificates matched
  your watchlist. Highest risk: critical." Announcing the table itself on every
  poll would be unusable; announcing nothing would hide the point of the app.
- **Focus is moved exactly once**, when the user opens a row, to the detail
  heading. Nothing in the background ever takes focus.
- **Risk is never colour alone**: the level is spelled out, the score is a
  number out of 100, the glyph differs per level, and the row's left border
  thickens with severity. Colour merely agrees with all four.
- **Semantics**: a real `<table>` with a caption, `th[scope]` row headers, a
  radio group for triage (arrow keys, "2 of 4" announcements), `aria-invalid` +
  `aria-describedby` on the form, `aria-expanded`/`aria-controls` on the details
  toggle, landmarks, and a skip link.
- **Contrast is a test.** [`palette.spec.ts`](src/app/ui/palette.spec.ts) reads
  the real stylesheet and fails the build if any token pair drops below WCAG AA.
  The background photograph is decorative and sits under a scrim and over a
  solid colour, so nothing is ever measured against the image.
- **Selected text is inverted deliberately**   near-black on bright cyan,
  11.4:1. The browser default is a translucent blue that all but vanishes on a
  dark teal panel, and the text people select here is evidence they are about
  to paste somewhere.
- `prefers-reduced-motion` is respected; focus outlines are never removed.

---

## Running and testing

```bash
npm start          # dev server, offline fixtures
npm run build      # production bundle (~99 kB transferred)
npm test           # Vitest: 422 unit tests over domain/ and data/
npm run e2e        # Playwright: the add → match → triage → persist journey
npm run typecheck  # tsc --noEmit, strict
```

Unit tests cover the core logic (the scorer, punycode/IDN handling, homoglyph
folding, typosquat detectors, retry/backoff, the polling stream, the store and
the GraphQL layer) and deliberately not trivial components; the component
behaviour that matters is covered end to end instead.

### URL switches

| Parameter | Effect |
| --- | --- |
| *(none)* | Bundled fixtures. No network, no keys. |
| `?live=1` | Poll the real crt.sh endpoint (2-minute interval). |
| `?poll=<ms>` | Shorten the polling interval, floored at 1s. Used by the e2e suite. |

Hitting a third-party service is always an explicit, user-initiated choice.

### Fixtures

The offline source injects faults on purpose, so the states that only appear
when something goes wrong are reviewable without unplugging anything: a slow
query every 17 requests (which makes a cycle *partial*), and a full feed outage
every 9th cycle (which produces the error frame, the stale banner and the retry
copy). Both are named in the message text, so a simulated failure never reads
as a real one.

[`seed-data.ts`](src/app/data/fixtures/seed-data.ts) ships three watched domains
and eighteen certificates covering every rule, plus benign certificates (your
own) and unrelated noise, so the demo shows a realistic signal-to-noise ratio
rather than a wall of red. The domains are fictional on purpose: the file
describes attack *shapes*, and naming a real bank would be both misleading and
unkind to that bank. Internationalised names are stored as A-labels exactly as a
CT log holds them, so the decode path stays exercised offline.

Triage state persists in `localStorage`, guarded on every access: private
browsing, quota limits and absent storage all degrade to memory rather than
taking the app down.

### The background image

Drop any wide, dark image at `public/background.jpg`. It is optional by
construction: a teal gradient and a solid colour sit underneath it, so the
interface keeps its contrast whether the image is present, missing, or still
loading.

---

## Where this would go next

- **certstream instead of crt.sh** for the coverage gap described above. The
  `CtSource` interface is the seam; nothing above it changes.
- **A real backend** behind the same SDL. `HttpGraphQLClient` already exists and
  is tested; it is a one-line swap at the composition root.
- **Weights from feedback.** Every triage decision is a label. "Analysts marked
  91% of TLD-swap alerts benign" is exactly the signal needed to retune the
  weights, and the audit trail already records it.
