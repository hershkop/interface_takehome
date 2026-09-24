# Computer-Use Automation System

An LLM discovers how to drive a legacy web UI once; the run is recorded as a **typed, versioned
capability artifact**; that artifact then replays **deterministically, with no model in the
decision loop**, returning typed outputs — or a business outcome, an escalation to a human, or a
debuggable failure.

Built against [ParaBank](https://github.com/parasoft/parabank), a JSP banking demo app, as a
stand-in for the back-office systems this is really aimed at. Design rationale is in
[PLAN.md](PLAN.md); the assignment write-up will be in `REPORT.md`.

> **Status — PR 3 of 6.** The deterministic replay path runs end to end. The safety layer,
> human handoff, and LLM discovery land in later PRs.

## Setup

Requires Node 20+ and Docker.

```bash
npm install
npm run install:browsers    # downloads Chromium — npm install does NOT do this
cp .env.example .env        # optional; the defaults work as-is
docker compose up -d        # starts ParaBank
npm run setup               # seeds it and prints the demo account IDs
```

`npm run install:browsers` is not optional and `npm install` will not do it for you: the
Playwright *package* installs from npm, but the browser binary is a separate download. Without
it, `npm test` and `npm run probe` both fail. On Linux or CI, use
`npx playwright install --with-deps chromium` to pull the system libraries too.

`npm run setup` resets ParaBank to fixed fixture state via
`POST /services/bank/initializeDB` and verifies the accounts the demo capabilities use. It
polls while Tomcat starts, so it is safe to run immediately after `docker compose up -d`.

Seeded state it produces — stable across resets, which is what makes the committed evidence runs
reproducible:

| | |
|---|---|
| Login | `john` / `demo` |
| Accounts | `12345` CHECKING −2300.00 · `12678` **SAVINGS** −100.00 · 9 more |
| Absent account | `99999` → `business_outcome: account_not_found` |

Seeding is the *only* thing that uses ParaBank's REST API. Every automated task goes through the
UI, which is the whole point of the system.

ParaBank is published on **18080** by default. The container itself always listens on 8080
internally; only the host port moved, because 8080 on a developer machine is usually already
spoken for. To use a different one, set **both** values in `.env` (the base URL is what the
automation actually navigates to, so changing only the port would leave it pointing at the old
address) and re-create the container:

```bash
PARABANK_PORT=19080
PARABANK_BASE_URL=http://localhost:19080/parabank
```

```bash
docker compose up -d --force-recreate
```

`npm run setup` prints this reminder if it can't reach the app.

## Commands

```bash
npm run setup       # reset + verify the target
npm test            # unit + browser tests
npm run typecheck   # tsc --noEmit
npm run probe       # surface-layer harness (development aid, not the product CLI)
```

## Demo — replay a capability

```bash
docker compose up -d && npm run setup

npm run cli -- validate capabilities/lookup_account_balance.v1.json

# Success: typed outputs, no model in the loop
npm run cli -- replay capabilities/lookup_account_balance.v1.json --input accountId=12678
#   SUCCESS
#     accountId   = "12678"
#     accountType = "SAVINGS"
#     balance     = -100
#     model calls : 0

# Business outcome: an answer, not a failure. Exit code 0.
npm run cli -- replay capabilities/lookup_account_balance.v1.json --input accountId=99999
#   BUSINESS OUTCOME  account_not_found
#     requestedAccountId = "99999"

# Hard failure: names the step, what was expected, what was observed
npm run cli -- replay capabilities/lookup_account_balance.v1.json \
  --input accountId=12678 --base-url http://localhost:18080/parabank/nonexistent
#   FAILURE  CHECKPOINT_FAILED
#     postcondition failed after "open_login": role heading named "Customer Login"

# Rejected before a browser even launches (~0.7s)
npm run cli -- replay capabilities/lookup_account_balance.v1.json --input accountId=oops
#   FAILURE  INPUT_INVALID
```

Exit codes let a calling agent branch without parsing output: `0` success **or** business
outcome, `2` escalated, `1` failure. A business outcome is not an error.

### What makes replay deterministic

| | |
|---|---|
| **No model** | Nothing in `src/replay.ts` can call one. Every run records `modelCalls`, and the tests assert `0` on every path |
| **Declared branches only** | Steps in order, handlers with fixed dispositions, one checkpoint. There is no runtime decision to make |
| **Refusal over guessing** | A target must resolve to exactly one visible element. In a back-office banking app, acting on the wrong control is worse than not acting |
| **Waits, never sleeps** | Every wait is on an observable condition with a bounded timeout |
| **Verified, not assumed** | Postconditions prove a step did something; the final checkpoint proves the run reached the state it claims |

### Recovery never re-runs completed work

A recovery matched *before* a step retries it — the step hasn't run. A recovery matched *after*
a step that **succeeded** continues to the next step instead.

That asymmetry is a safety property, not a style choice: re-running a click that already
submitted a funds transfer submits a second one. `test/replay.test.ts` pins it with a fixture
that counts submissions and raises an interstitial only after a successful submit.

`npm run probe` is a development harness, not the product CLI — `discover` and `replay` arrive
with the engine. It exists so this layer can be exercised against the real application rather
than only against synthetic pages, and so you can look at a real evidence directory:

```
evidence/probe-<timestamp>/
├── run.json                 run metadata
├── events.jsonl             redacted structured events
├── result.json              the four-status RunResult
├── 001-overview.png         screenshots, sequence-numbered, sensitive regions masked
└── failure-snapshot.json    redacted ARIA capture — the rich failure signal
```

### Evidence has three sinks, and only one of them is a string

Redaction happens at the sink, but not every sink is text, so each is handled differently.

| Sink | Treatment |
|---|---|
| **Events, results, failure snapshots** | JSON, passed through the redactor before writing |
| **Screenshots** | Masked *at capture time* — a rendered pixel cannot be redacted afterwards. Password inputs and anything marked `data-sensitive` are painted over by Playwright before the PNG exists |
| **Playwright traces** | **Off by default.** Opt in with `npm run probe -- --trace` |

A trace archives request bodies, response bodies, cookies, and serialised DOM snapshots. On
this target that provably includes `username=john&password=demo`, the `JSESSIONID` cookie,
customer names, and balances — and the redactor cannot reach inside a zip. So rather than ship
a sink that quietly defeats the redaction everything else relies on, tracing is opt-in, warns
when enabled, and sets `traceUnredacted: true` in the run record.

The default rich failure signal is `failure-snapshot.json` instead: a redacted ARIA capture,
which is text (so it redacts), and is the same view the agent reasons over (so it is more
useful for debugging a locator failure than a screenshot anyway).

`test/evidence-secrets.test.ts` scans *every* byte of *every* file a run produces for
configured secrets, because the first version of this claim was made by grepping the JSON and
missing the archive.

The `discover` / `replay` / `capabilities` CLI arrives in PRs 3–6.

## What's here now

```
src/schema.ts    every typed contract: conditions, locators, actions, the capability
                 artifact, handlers, policy, observations, interventions, run results
src/replay.ts    the deterministic interpreter: steps, handlers, checkpoints, outputs
src/template.ts  {{inputs|secrets|vars|baseUrl}} resolution and output coercion
src/cli.ts       validate | replay
src/parabank.ts  app-specific glue (re-authentication), injected at the edge
src/surface.ts   the Surface port + PlaywrightSurface + condition evaluation
src/locator.ts   candidate list -> exactly one visible element, or a refusal
src/evidence.ts  JSONL events, screenshots, trace, result.json, model-call counter
src/redact.ts    one redactor, applied at the sink
src/config.ts    env + default policy
scripts/setup.ts target reset and verification
scripts/probe.ts development harness for the surface layer
docs/DAY0-FINDINGS.md   what probing ParaBank actually turned up, and what it changed
```

### The surface seam

Nothing above `src/surface.ts` mentions Playwright, CSS, or a browser. Artifacts and replay
speak in intent — *click the control whose accessible name is "Transfer"*, *is this text
visible* — and `Surface` has seven methods. A desktop adapter would implement the same seven
against OS accessibility APIs, and no artifact would change.

That is also why observation is a Playwright **ARIA snapshot** rather than a DOM dump: role and
accessible name is the one representation a modern web app, a legacy frameset, and a native
desktop app can all produce. It is visibility-aware by construction, far smaller than the DOM,
and it names controls the same way the recorded locators do — so a model reading it naturally
proposes role+name targeting instead of brittle CSS.

### Three schema decisions worth knowing up front

**Conditions default to matching only *visible* content.** ParaBank ships the string
*"An internal error has occurred"* inside a hidden div on every healthy account page. A handler
matching raw DOM text would fire on every successful run. Visibility is the default; matching
hidden content is opt-in. ([DAY0-FINDINGS §3](docs/DAY0-FINDINGS.md))

**Targets are ordered candidate lists, not selectors.** Replay walks the list and requires
*exactly one visible match* — zero matches and ambiguous matches are both failures, because a
replay that guesses is worse than one that stops. Ordering encodes robustness preference:
accessible role+name → label → visible text → stable id → structural CSS → coordinates. A
coordinate target *anywhere* in an artifact — a step, an output locator, or a dismiss handler —
blocks `approved` status, and the error names which one.

**Business outcome, recoverable condition, and hard failure are declared in the artifact, not
branched in the engine.** A `Handler` pairs a match condition with one of three dispositions.
Recovery is never open-ended: a remedy is one of three named verbs with an attempt cap, and
`dismiss` cannot be written without saying what to dismiss. Business outcomes are open strings
(they are app-specific); engine failures are a closed set, so a caller can handle all of them.

**Risk classification is mandatory.** `metadata.risk` has no default. A truncated recorder
output or an incomplete generated artifact must not be able to execute unattended *by omission* —
it fails validation instead. Defaulting to `approval_required` would be the other fail-closed
choice, but it would put a human in front of every read-only lookup.
