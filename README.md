# Computer-Use Automation System

An LLM discovers how to drive a legacy web UI once; the run is recorded as a **typed, versioned
capability artifact**; that artifact then replays **deterministically, with no model in the
decision loop**, returning typed outputs — or a business outcome, an escalation to a human, or a
debuggable failure.

Built against [ParaBank](https://github.com/parasoft/parabank), a JSP banking demo app, as a
stand-in for the back-office systems this is really aimed at. Design rationale is in
[PLAN.md](PLAN.md); the assignment write-up will be in `REPORT.md`.

Design rationale and trade-offs: **[REPORT.md](REPORT.md)**. Evidence from real runs:
**[`/evidence/examples/`](evidence/examples)**.

## Setup

Requires Node 20+ and Docker.

```bash
npm install
npm run install:browsers    # downloads Chromium — npm install does NOT do this
cp .env.example .env        # optional; the defaults work as-is
./start.sh                  # ParaBank, seeded, plus the operator console
```

| | |
|---|---|
| `./start.sh` | brings ParaBank up, waits for it to be healthy, seeds the fixture data, and starts the console |
| `./stop.sh` | stops the console and ParaBank, and clears any leftover browser processes |
| `./logs.sh` | follows ParaBank's logs (`--console` for the console's) |

`./start.sh --no-console` skips the console if you only want the CLI. `./stop.sh --clean` also
drops ParaBank's volumes. `./logs.sh --help` lists the rest.

Fixture data is re-seeded on every start, deliberately: demo transfers move real money inside
the container, so balances drift without it. Use `--no-seed` to keep whatever state is there.

<details>
<summary>The equivalent by hand</summary>

```bash
docker compose up -d        # starts ParaBank
npm run setup               # seeds it and prints the demo account IDs
npm run console             # the operator console
```
</details>

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

## Demo — the whole thread

```bash
docker compose up -d && npm run setup

# 1. An LLM works out the flow, once, against the live app
npm run cli -- discover \
  --goal "Log in, then look up account 12678 and read its balance and account type" \
  --capability lookup_balance_discovered \
  --out capabilities/lookup_balance_discovered.v1.json \
  --input accountId=12678
#   RECORDED  lookup_balance_discovered v1.0.0   steps: 8   model calls: 10

# 2. Replay it with an account the model never saw — no model in the loop
npm run cli -- replay capabilities/lookup_balance_discovered.v1.json --input accountId=12345
#   SUCCESS   balance = -2300   accountType = "CHECKING"   model calls: 0
```

`discover` needs `ANTHROPIC_API_KEY` in `.env`. Nothing else does.

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

# Refused by policy: this capability types into fields, and that policy forbids it
npm run cli -- replay capabilities/lookup_account_balance.v1.json \
  --input accountId=12678 --policy policies/read-only.json
#   FAILURE  POLICY_DENIED
#     action type "fill" is blocked by policy
#     at step 1: enter_username
```

## Demo — a step that needs a human

`transfer_funds` moves money. Every step before the submit fills a form and can be abandoned
safely; the submit is irreversible, so it alone is classified `approval_required`.

```bash
# Unattended: the caller gets `escalated`, not a guess and not a failure
npm run cli -- replay capabilities/transfer_funds.v1.json \
  --input fromAccount=12345 --input toAccount=12678 --input amount=25
#   ESCALATED  approval_required
#     intervention : replay-…-submit_transfer
#     resume token : replay-…:9

# With an operator: the live browser is handed over
npm run cli -- replay capabilities/transfer_funds.v1.json \
  --input fromAccount=12345 --input toAccount=12678 --input amount=25 \
  --interactive --headed --goal "move 25 dollars between demo accounts"
```

```
  ┌────────────────────────────────────────────────────────────────
  │ HUMAN INTERVENTION REQUIRED
  ├────────────────────────────────────────────────────────────────
  │ why        : approval_required
  │ Step "submit_transfer" is classified approval_required and needs a person.
  │ capability : transfer_funds
  │ step       : 9 "submit_transfer"
  │ page       : ParaBank | Transfer Funds
  │ url        : http://localhost:18080/parabank/transfer.htm
  │ screenshot : evidence/replay-…/001-intervention-submit_transfer.png
  ├────────────────────────────────────────────────────────────────
  │ The browser window is yours. Automation is locked out until you
  │ hand it back.
  │
  │   [d]one     you performed the step yourself; skip it and continue
  │   [p]roceed  you approve; automation performs the step
  │   [a]bort    stop the run
  └────────────────────────────────────────────────────────────────
```

## The operator console

```bash
npm run console      # http://127.0.0.1:17080
```

A local web console for the four things a person actually needs to do: **see what capabilities
exist**, **run one**, **record a new one**, and **take over when a run stops for a human**.

| | |
|---|---|
| **Capabilities** | every artifact with its status, risk, step and handler counts, and a form generated from its declared inputs |
| **Replay** | fill the inputs, run it, watch the events stream in, see the typed result |
| **Record** | a goal and a capability id start a real discovery run; the recorded draft appears in the list when it finishes |
| **Handoff** | a run that escalates surfaces a card with the reason, the step, the page it stopped on, and the screenshot — plus the three decisions |
| **Review** | filter the list, add a reviewer note, promote a draft to `approved`, edit the raw artifact, or delete it |

It is **not a co-browsing surface**. When a run hands over, the operator acts in the *real
application's* browser window — the same live session the automation was using, which is the
entire point of the handoff. The console carries the context and the decision, not the pixels.

### Reviewing a capability

The console is where a draft becomes trusted, so the review actions live there:

- **Filter** across id, name, description, status, risk and notes.
- **Notes** are stored on the artifact itself (`metadata.notes`), not in a sidecar — the brief
  asks for artifacts to be *reviewable*, and why someone approved a draft is part of what a
  later reader needs. Versioned by git, never used for control flow.
- **Approve / return to draft** flips `metadata.status`. Approving is immediately visible to
  agents: a draft is hidden from `capabilities --json` and refused by `invoke`.
- **Edit** the full artifact as JSON, validated against the same Zod schema replay uses. An
  artifact that would not replay cannot be saved, and the schema's own issues come back to the
  editor verbatim.
- **Delete** takes two clicks and **moves the file to `capabilities/.trash/`** rather than
  unlinking it. A discovered capability can be a real model run that is not committed yet;
  making deletion recoverable costs a rename.

### What it proves

REPORT.md §5 claims that swapping the operator surface "changes no other file". This is that
claim under test rather than asserted: `WebInterventionChannel` is a second implementation of
the same one-method `InterventionChannel` interface, and **nothing in `replay.ts`, `handoff.ts`
or `discovery.ts` changed to support it**. The ownership lock, the context captured before
handing over, and the fresh observation before taking control back are all untouched.

The only addition anywhere else was an optional `onEvent` hook on the evidence recorder, so a
run can be watched while it is in flight. The file on disk is still the record of truth.

### Security

Binds to `127.0.0.1` with **no authentication**. It can start browser sessions and read the
evidence directory, so it is a local development and demo surface and must not be exposed.
Evidence files are served only from under `evidence/` and only as `.png` / `.json` / `.jsonl`;
a path resolving outside that root is refused.

## Demo — capabilities as agent-callable tools

```bash
npm run cli -- capabilities          # human-readable catalog — includes drafts
npm run cli -- capabilities --json   # what an agent is given — approved only
npm run cli -- invoke lookup_account_balance --input accountId=12678
```

**A draft is not callable.** `invoke` refuses a capability still marked `draft` unless
`--allow-draft` is passed, and `--json` omits drafts altogether. A warning in a description is
documentation; an agent reads the schema and calls the tool.

Exit codes are the same for `invoke` as for `replay`: `0` success or business outcome, `2`
escalated, `1` failure.

The tool schema is **generated from the artifact**, so the advertised contract and the enforced
one cannot drift apart. The description tells a calling agent what it gets back, whether the
capability will stop for a human, and whether it is still a draft:

```json
{
  "name": "transfer_funds",
  "description": "Fill the ParaBank transfer form and reach the confirmation screen … Returns:
                  confirmedAmount (string), confirmedFrom (string), confirmedTo (string).
                  This capability requires a human to approve a step before it completes.",
  "input_schema": {
    "type": "object",
    "properties": { "fromAccount": { "type": "string", "pattern": "^[0-9]{1,10}$" }, … },
    "required": ["fromAccount", "toAccount", "amount"],
    "additionalProperties": false
  }
}
```

## Escalation and control transfer

### The decision is three-valued, not approve/deny

A person who takes over a live session usually does not merely *authorise* the step — they
perform it, with judgement the automation did not have. Collapsing that into "approved" makes
automation redo work the person already did, which on a funds transfer means transferring
twice. So `done` skips the step and verifies where the session ended up; `proceed` has
automation perform it; anything unclear, including an empty answer, aborts — on an irreversible
financial action the safe reading of "no clear answer" is not to do it.

### The ownership lock is what makes it a handoff

Exactly one party may act at a time, and the other is *structurally* unable to. `OwnedSurface`
wraps the session and refuses every mutating action while a human holds it — wrapped **outside**
the policy guard, so ownership is decided first: if a person is driving, no question about what
policy would have permitted is even asked.

If automation could still click while someone is typing into the same form, control was never
transferred; the request would just be a message. Reads stay available, because the engine has
to observe in order to take the session back sensibly.

Ownership changes **before** the request is routed, and the resumed state is captured **while
the human still holds it** — a person finishing up is still clicking, and automation must not be
eligible to act until the engine has seen where the page ended up. Only then does control
return, and it returns even if the operator channel throws, because a crashed console must not
leave a session permanently locked.

### What the human did is recorded, without what they typed

Listeners are installed with `page.addInitScript`, so they re-attach on every document. A
one-off injection dies at the first navigation, and an audit trail that silently stops recording
looks exactly like a person who did nothing.

Each event carries the field's identity and the **length** of what was entered, never the
characters. Reading a label off the element is safe for a `<button>Transfer</button>` and is
exactly what an auditor wants — but on a `contenteditable` that text *is* what the person typed,
so nothing editable contributes its content, only its stable attributes and a length.

`input` is captured as well as `change`, coalesced so typing does not emit one event per
keystroke: an edit that never blurs — because the operator submits, or the page navigates —
fires no `change` and would otherwise vanish. Navigation is reported from the driver side,
since a document being torn down cannot announce its own departure.

Written to `human-actions.json`, separate from the event log, because "what did a person do to
this institution's data" is a different question from "what did the system do".

### What is a stand-in, and what is not

The CLI operator surface is openly minimal — a real deployment routes to a queue and streams
the session to a remote console. Swapping `CliInterventionChannel` for a queue consumer changes
no other file.

What is *not* a stand-in: ownership genuinely transfers on the same live session, the request
carries enough context to act on, the lock is enforced rather than advised, the human's actions
are recorded, and control comes back with a fresh observation.

Exit codes let a calling agent branch without parsing output: `0` success **or** business
outcome, `2` escalated, `1` failure. A business outcome is not an error.

## Safety

Every run is governed by a policy. `ReplayOptions.policy` is **required**, not optional — a
guard that can be forgotten is not a guard, and the type checker enforces that at every call
site. Two example policies ship in `policies/`.

### Enforcement is three layers, because no one of them covers the ground

**A guarded surface** wraps the browser. Every action — from the step loop, from a `dismiss`
remedy, from a re-authentication callback, from output collection — passes through it, so an
action type the policy blocks cannot be performed by any route. Putting the checks in the
wrapper rather than in the replay loop is what makes them unavoidable: the loop is not the only
thing that drives the browser.

**A browser-level navigation guard** aborts document requests to origins outside the allowlist.
This catches what a pre-action check structurally cannot: the engine is told "click this link",
not where the link goes. A refused navigation is `POLICY_DENIED` even when the click succeeded.

**A landing check after every action** compares the current URL against the allowlist. A
single-page app routes with `history.pushState()` and issues no document request at all, so the
network guard never sees it — a click could move from an allowed route to `/admin` and every
later step would run there. ParaBank is server-rendered and never does this; the check exists
because the design claim is about surfaces in general.

Scope limit, stated rather than assumed: the network guard gates **document navigation only**.
Blocking sub-resources would break pages that legitimately load styles or images from
elsewhere. Exfiltration via XHR to an allowed-but-unexpected endpoint is not addressed.

### Budgets are real, not advisory

`runTimeoutMs` is enforced three ways, because checking between steps is not a ceiling: the
guarded surface refuses actions once the deadline passes and clamps every wait to the remaining
budget; the step loop checks between steps; and the whole run races a deadline timer, which is
the backstop for a single operation that blocks longer than the entire budget.

### The policy decides; the engine does not

| Field | Effect |
|---|---|
| `allowedOrigins` | Exact, canonical origin match. `bank.test` never matches `bank.test.evil.com` |
| `allowedPaths` | Glob routes. Empty means any path under an allowed origin |
| `allowedActions` / `blockedActions` | Blocked wins over allowed, or a blocklist would be decorative |
| `requireApprovalFor` | Which risk classes need a human. A cautious tenant can gate `safe`; a trusting one can gate nothing |
| `maxSteps` | Checked against the artifact *before* a browser launches, and per attempt during the run |
| `runTimeoutMs` | Wall clock for the whole run |
| `redactPatterns` | Extends the built-in rules; never replaces them. Validated at policy load — a rule that cannot compile stops the run, because silently skipping it would fail *open* |

`risk: "blocked"` is the one thing policy cannot override. Nothing executes it.

The **complete** policy that governed a run is written into its `run.json` — a partial record
cannot answer "why was this allowed?", which is the only question the record exists to answer.

Inputs declared `sensitive: true` are masked by **name** in that record, not by matching their
value. Literal scrubbing alone is not enough: the redactor deliberately ignores literals shorter
than three characters (scrubbing every `42` out of a log destroys it), and a PIN is exactly that
short. An explicit declaration deserves a mechanism that does not depend on the value's length.

### What makes replay deterministic

| | |
|---|---|
| **No model** | Nothing in `src/replay.ts` can call one. Every run records `modelCalls`, and the tests assert `0` on every path |
| **Declared branches only** | Steps in order, handlers with fixed dispositions, one checkpoint. There is no runtime decision to make |
| **Refusal over guessing** | A target must resolve to exactly one visible element. In a back-office banking app, acting on the wrong control is worse than not acting |
| **Waits, never sleeps** | Every wait is on an observable condition with a bounded timeout |
| **Verified, not assumed** | Postconditions prove a step did something; the final checkpoint proves the run reached the state it claims |

### Nothing that already succeeded is ever re-run

Re-executing a click that already submitted a funds transfer submits a second one. There are
two paths that could do that, and both are closed:

- **Recovery.** A handler matching *before* a step retries it — the step hasn't run. A handler
  matching *after* a step that succeeded continues to the next step instead.
- **Postconditions.** A postcondition is *polled*, so a slow confirmation is simply waited for.
  If it still doesn't hold, only actions that can be repeated without a side effect
  (`navigate`, `wait`, `extract`, `assert`) may be retried. A `click`, `fill` or `select` that
  already succeeded stops the run and reports expected-vs-observed, because the application did
  something we cannot verify — and guessing is worse than saying so.

`test/replay.test.ts` pins both with fixtures that count submissions.

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
src/discovery.ts the LLM loop that produces an artifact — used once per capability
src/replay.ts    the deterministic interpreter: steps, handlers, checkpoints, outputs
src/catalog.ts   artifacts as agent-callable tools
src/template.ts  {{inputs|secrets|vars|baseUrl}} resolution and output coercion
src/cli.ts       discover | replay | validate | capabilities | invoke
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
