# Computer-Use Automation System

An LLM discovers how to drive a legacy web UI once; the run is recorded as a **typed, versioned
capability artifact**; that artifact then replays **deterministically, with no model in the
decision loop**, returning typed outputs — or a business outcome, an escalation to a human, or a
debuggable failure.

Built against [ParaBank](https://github.com/parasoft/parabank), a JSP banking demo app, as a
stand-in for the back-office systems this is really aimed at. Design rationale is in
[PLAN.md](PLAN.md); the assignment write-up will be in `REPORT.md`.

> **Status — PR 1 of 6.** Scaffolding, target verification, and the typed contracts. The surface,
> replay engine, safety layer, handoff, and LLM discovery land in later PRs.

## Setup

Requires Node 20+ and Docker.

```bash
npm install
cp .env.example .env        # optional; defaults work if port 8080 is free
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

If port 8080 is taken, set `PARABANK_PORT` and `PARABANK_BASE_URL` in `.env`.

## Commands

```bash
npm run setup       # reset + verify the target
npm test            # unit tests
npm run typecheck   # tsc --noEmit
```

The `discover` / `replay` / `capabilities` CLI arrives with the engine in PRs 2–6.

## What's here now

```
src/schema.ts   every typed contract: conditions, locators, actions, the capability
                artifact, handlers, policy, observations, interventions, run results
src/config.ts   env + default policy
scripts/setup.ts  target reset and verification
docs/DAY0-FINDINGS.md   what probing ParaBank actually turned up, and what it changed
```

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
