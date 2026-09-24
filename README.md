# Computer-Use Automation System

An LLM discovers how to drive a legacy web UI once; the run is recorded as a **typed, versioned
capability artifact**; that artifact then replays **deterministically, with no model in the
decision loop**, returning typed outputs — or a business outcome, an escalation to a human, or a
debuggable failure.

Built against [ParaBank](https://github.com/parasoft/parabank), a JSP banking demo app, as a
stand-in for the back-office systems this is really aimed at. Design rationale is in
[PLAN.md](PLAN.md); the assignment write-up will be in `REPORT.md`.

> **Status — PR 2 of 6.** Contracts, the surface abstraction, locator resolution, and evidence.
> The replay engine, safety layer, handoff, and LLM discovery land in later PRs.

## Setup

Requires Node 20+ and Docker.

```bash
npm install
cp .env.example .env        # optional; the defaults work as-is
docker compose up -d        # starts ParaBank
npm run setup               # seeds it and prints the demo account IDs
```

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
npm run probe       # drive the real app through the surface; writes evidence/
npm run probe -- --headed   # ...and watch it
npm test            # unit + browser tests
npm run typecheck   # tsc --noEmit
```

`npm run probe` is a development harness, not the product CLI — `discover` and `replay` arrive
with the engine. It exists so this layer can be exercised against the real application rather
than only against synthetic pages, and so you can look at a real evidence directory:

```
evidence/probe-<timestamp>/
├── run.json            run metadata
├── events.jsonl        redacted structured events
├── result.json         the four-status RunResult
├── 001-overview.png    screenshots, sequence-numbered
└── trace.zip           Playwright trace
```

The `discover` / `replay` / `capabilities` CLI arrives in PRs 3–6.

## What's here now

```
src/schema.ts    every typed contract: conditions, locators, actions, the capability
                 artifact, handlers, policy, observations, interventions, run results
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
