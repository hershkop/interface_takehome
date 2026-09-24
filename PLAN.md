# Computer-Use Automation System — Implementation Plan

## 0. Guiding constraint

Small, correct, well-argued. The brief rewards judgment and integration, not breadth:
*"Prefer a thin-but-real version of every core requirement over a polished subset."*

So the plan is deliberately sized: **~10 source files, 3 milestones, ~5 tests, 1 stretch goal.**
Depth goes into the three load-bearing pieces only:

1. The **capability artifact schema** — especially its outcome/handler model.
2. **Deterministic replay** and its error taxonomy.
3. The **control-transfer model** for human escalation.

Everything else is a clean, documented seam.

---

## 1. The end-to-end thread

```
goal → real LLM discovery run → capability artifact → deterministic replay
     → (typed outputs | business outcome | failure | escalation)
     → human takes the live session → resume → evidence for all of it
```

Two capabilities carry that thread. **This is the central change from the first draft.**

| Capability | Why it exists |
|---|---|
| `lookup_account_balance` (search → detail → extract) | **The headline.** Discovered autonomously by the LLM. Replays unattended with typed inputs and typed outputs. Has a natural business outcome: account not found. |
| `transfer_funds` (multi-field form → confirmation) | **The risk demo.** Terminal step is `approval_required`; replay escalates and a human completes it in the same live browser. |

Rationale for the split: in the first draft the only capability required a human on the happy
path, which meant (a) the mandatory real LLM discovery run needed a person mid-flight, (b) the
graded "deterministic replay returns outputs" demo never ran to completion unattended, and
(c) there was no clean "no such record" business outcome — the exact distinction the brief's
glossary calls the most common design mistake. Splitting fixes all three and costs almost
nothing, because both capabilities run on the same engine.

---

## 2. Chosen stack

| Concern | Choice |
|---|---|
| Language | TypeScript on Node.js |
| Browser control | Playwright |
| Model | `claude-opus-5` via `@anthropic-ai/sdk`, tool use with `strict: true` for the action schema |
| Runtime validation | Zod |
| Target app | ParaBank, local via Docker Compose |
| Primary observation | **Playwright ARIA snapshot** (role + accessible name tree), screenshot secondary |
| Artifact | Versioned, linear JSON, Zod-validated |
| Replay | Deterministic interpreter; zero model calls |
| Handoff | Ownership lock + headed browser + CLI prompt |
| Persistence | Filesystem |

### Two decisions worth defending

**ARIA snapshot as the primary observation.** `locator.ariaSnapshot()` gives the model a
role/name tree. Three payoffs: the locators the model picks are *already* role+name (first in our
preference order, so ref→locator derivation stops being a risk); it is cheaper and more stable
than a DOM dump; and it is the same representation a desktop accessibility adapter exposes, so
the Section 3.7 heterogeneity answer is a shape we already consume rather than a promise.
Screenshot stays for evidence and for surfaces where the a11y tree is empty (framesets, canvas)
— that caveat goes in REPORT.md.

**Direct Anthropic SDK, not an AI-SDK wrapper.** Tool use gives structured output natively. The
model sits behind `DiscoveryEngine` anyway, so an extra abstraction layer buys nothing on a
project graded for appropriate simplicity.

---

## 3. Explicit non-goals

No services, queue, database, or broker. No remote co-browsing console. No desktop
implementation. No open-ended LLM recovery during replay. No OCR or image matching. No
branches, loops, or DAGs in artifact v1. No real multi-tenant infrastructure. Not every
Playwright action.

---

## 4. Repository layout (~10 source files)

```text
.
├── docker-compose.yml   package.json   tsconfig.json   .env.example
├── README.md   REPORT.md   PLAN.md
├── src/
│   ├── cli.ts              # discover | replay | validate | capabilities | invoke
│   ├── config.ts           # env, policy config, secret resolution
│   ├── schema.ts           # ALL Zod contracts: action, artifact, handler, policy,
│   │                       #   observation, intervention, result
│   ├── surface.ts          # Surface port + PlaywrightSurface + ARIA observation
│   ├── locator.ts          # candidate list → exactly-one-match resolution
│   ├── discovery.ts        # observe→decide→act loop, Anthropic adapter, recorder
│   ├── replay.ts           # deterministic interpreter, handlers, checkpoints
│   ├── safety.ts           # policy guard + redactor
│   ├── handoff.ts          # ownership lock, intervention, human-event capture
│   ├── evidence.ts         # JSONL events, screenshots, trace, run result
│   └── catalog.ts          # stretch goal: list / describe / invoke by name
├── capabilities/   evidence/   test/
```

The directory structure in the first draft (25 files across 7 subdirectories) expressed
boundaries that these 11 files express just as well. Structure is not the deliverable.

---

## 5. Core ports

```ts
interface Surface {
  observe(): Promise<Observation>;            // ARIA tree + url/title + alerts + screenshot ref
  execute(a: ResolvedAction): Promise<ActionResult>;
  verify(c: Condition): Promise<VerificationResult>;
  captureEvidence(label: string): Promise<EvidenceRef>;
}

interface DiscoveryEngine {
  discover(req: DiscoveryRequest): Promise<DiscoveryResult>;
}

type SessionOwner = "automation" | "human";
interface SessionController {
  readonly owner: SessionOwner;
  requestIntervention(r: InterventionRequest): Promise<InterventionOutcome>;
  resume(): Promise<void>;
}
```

`PlaywrightSurface` is the only v1 implementation. A desktop adapter implements the same
*intent-level* contract over OS accessibility + input APIs. **The executor must throw if an
automation action is attempted while `owner === "human"`** — that lock is the difference between
a real handoff and a cosmetic one, and it is one of the five tests.

---

## 6. Action vocabulary

`navigate` · `click` · `fill` · `select` · `wait` · `extract` · `assert`

Every model-produced action is Zod-parsed, then policy-checked, then executed. Values support
templates:

```json
{ "action": "fill", "target": {...}, "value": "{{inputs.accountId}}" }
{ "action": "fill", "target": {...}, "value": "{{secrets.parabankPassword}}" }
```

Secret references are never resolved into the artifact — only at execution time, from env.

---

## 7. Capability artifact

```ts
interface CapabilityArtifactV1 {
  schemaVersion: "1.0";
  capabilityId: string;          // stable identity across revisions
  version: string;               // semver of THIS capability
  derivedFrom?: { capabilityId: string; version: string };  // tenant/variant lineage
  metadata: {
    name: string; description: string;
    status: "draft" | "approved";
    risk: "safe" | "approval_required" | "blocked";
    recordedAt: string; recordedBy: "llm" | "human";
  };
  target: {
    app: string;
    appFingerprint?: string;     // observed version/branding marker → drift detection
    baseUrl: string;             // resolved per tenant at invoke time, not baked in
  };
  inputs:  Record<string, InputDefinition>;
  outputs: Record<string, OutputDefinition>;
  steps:   ArtifactStep[];
  handlers: Handler[];           // see below — the focal point
  checkpoint: Condition;
}
```

`capabilityId` / `version` / `derivedFrom` / `appFingerprint` are four fields that cost nothing
and constitute the entire multi-tenant answer in Section 3.7: identity, lineage, and a drift
signal.

### 7.1 Handlers — the outcome/error model

This is the part the brief says it grades hardest, so it is data in the artifact, not logic in
the engine. Handlers are evaluated **before and after every step**, not only at the end.

```ts
interface Handler {
  id: string;
  match: Condition;                   // role+name | text | url pattern | http status
  scope: "global" | string[];         // all steps, or specific step ids
  disposition:
    | { kind: "business_outcome"; outcome: string; extract?: Record<string, Extraction> }
    | { kind: "recover"; remedy: "dismiss" | "retry_step" | "reauthenticate"; maxAttempts: number }
    | { kind: "fail"; code: ErrorCode };
}
```

Three payoffs for ~50 lines of interpreter:

- It *is* the three-way distinction Section 3.3 demands (business outcome / recoverable / hard
  failure), declared rather than hardcoded.
- Recovery is never open-ended — a remedy is one of three named verbs with an attempt cap.
- A tenant override adds a handler for a branded interstitial without forking the flow.

Example for `lookup_account_balance`:

```json
[
  { "id": "not_found", "match": { "text": "could not be found" }, "scope": "global",
    "disposition": { "kind": "business_outcome", "outcome": "account_not_found" } },
  { "id": "session_expired", "match": { "urlPattern": "**/login.htm" }, "scope": "global",
    "disposition": { "kind": "recover", "remedy": "reauthenticate", "maxAttempts": 1 } },
  { "id": "app_error", "match": { "text": "An internal error has occurred" }, "scope": "global",
    "disposition": { "kind": "fail", "code": "APP_ERROR" } }
]
```

### 7.2 Steps and locators

Each step: stable id, one typed action, target, optional postcondition, optional retry, optional
risk override. A target is an **ordered candidate list**, never a raw model reference:

```json
{ "candidates": [
    { "strategy": "role",  "role": "link", "name": "Accounts Overview" },
    { "strategy": "label", "value": "Account:" },
    { "strategy": "text",  "value": "Accounts Overview" },
    { "strategy": "css",   "value": "#accountId" }
] }
```

Preference order: accessible role+name → associated label → stable visible text → stable form
name/id → structural CSS → coordinates (draft only). Replay tries candidates in order and
requires **exactly one visible match**. Zero matches and ambiguous matches are both failures —
replay never guesses.

### 7.3 Outputs and extraction

Outputs are not aspirational types; each declares how it is obtained and coerced:

```ts
interface OutputDefinition {
  type: "string" | "number" | "boolean";
  from: { target: Target; attribute?: string };
  coerce?: "currency" | "trim" | "int";      // "$1,234.56" → 1234.56
  onMissing: "fail" | "null";
}
```

---

## 8. Result contract — four statuses

```ts
type RunResult =
  | { status: "success";          outputs: Record<string, unknown>; evidence: EvidenceSummary }
  | { status: "business_outcome"; outcome: string; details?: object;  evidence: EvidenceSummary }
  | { status: "escalated";        intervention: InterventionRef;      evidence: EvidenceSummary }
  | { status: "failure";          error: RunError;                    evidence: EvidenceSummary };
```

`escalated` is the second structural change from the first draft. A three-way contract had
nowhere to put "paused, awaiting a human" — so when an agent invokes `transfer_funds`
unattended and hits the approval gate, there was no honest thing to return. Making it a
first-class status means escalation is part of the **contract** rather than a CLI affordance,
which is exactly the control-transfer model the brief says it will focus on. It carries an
intervention id and a resume token.

`RunError` carries: code, failed step id + index, recoverable flag, expected state, sanitized
observed state, screenshot + trace refs, attempt count.

Error codes (trimmed from 9 to 7 — `INPUT_INVALID` is caught before the run starts, and
`SESSION_EXPIRED` is now a handler remedy, not a terminal code):

`TARGET_NOT_FOUND` · `TARGET_AMBIGUOUS` · `STEP_TIMEOUT` · `CHECKPOINT_FAILED` ·
`POLICY_DENIED` · `APP_ERROR` · `HUMAN_ABORTED`

Every run result also records **`modelCalls: 0`** for replay. One line, and it turns "no LLM in
the decision loop" from a claim into evidence.

---

## 9. Deterministic replay

1. Validate artifact; validate inputs against declared `inputs` (fail fast, before the browser).
2. Resolve `baseUrl` + secrets from tenant/env config; confirm policy.
3. Open browser context, start trace and evidence recorder.
4. Per step: evaluate global handlers → resolve templates → policy-check → resolve exactly one
   target → execute with explicit waits and bounded retries → check postcondition → evaluate
   handlers again.
5. A matched handler short-circuits to its disposition (return outcome / apply remedy / fail).
6. Extract declared outputs, verify the final checkpoint, close the trace, return `RunResult`.

Retries apply only to declared-recoverable operations. Validation errors and policy denials are
never retried.

---

## 10. Safety

Policy config: allowed origins, allowed path patterns, allowed action types, blocked
actions/targets, approval rules, max steps, run timeout. Enforced in **both** discovery and
replay. Redirects are re-checked after navigation so the browser cannot silently leave the
allowlist.

| Risk class | Behavior |
|---|---|
| `safe` | execute |
| `approval_required` | escalate → human owns the session |
| `blocked` | stop with `POLICY_DENIED` |

Data handling: credentials via env only; artifacts store secret *references*; observations redact
password fields before they reach the prompt; all logs pass a central redactor; human-input
events record target metadata but never secret-field values; demo data is synthetic.

---

## 11. Escalation and control transfer

```ts
interface InterventionRequest {
  runId: string; interventionId: string;
  capabilityId?: string; goal?: string;
  step?: { id: string; index: number };
  reason: "approval_required" | "agent_stuck" | "replay_blocked";
  message: string; screenshot: string; observedState: object;
}
```

Sequence: pause loop → set `owner = "human"` → persist request + screenshot → print context in
CLI → leave the *same* headed browser open → capture sanitized human events → wait for
resume/abort → fresh observation + screenshot → `owner = "automation"` → verify the next
postcondition or checkpoint.

Two implementation notes that decide whether this is real:

- **Human-event listeners must be installed with `page.addInitScript`**, not injected once.
  Injected listeners die on the first navigation, and you would silently record nothing after
  the human clicks anything that loads a page.
- **The ownership lock is enforced in the executor and tested.** Everything else here is
  presentation.

Documented cut: stdin stands in for an intervention queue, and the headed local window stands in
for remote session streaming. The ownership contract is unchanged by either. *If* milestones 1–3
land early, upgrade to a ~60-line local HTTP operator page (context + screenshot + Resume/Abort,
polling the intervention file) — that makes control transfer an out-of-process contract rather
than a stdin one. Nice-to-have, not scope.

Also documented: the handoff demo requires a headed browser, so it is not headless/CI-runnable.

---

## 12. Evidence

```text
evidence/<run-id>/
├── run.json  events.jsonl  result.json  trace.zip
├── step-00N-{before,after}.png
└── intervention.json
```

Each event: timestamp, run id, phase (`discovery` | `replay` | `human`), step id, action type,
sanitized args, discovery rationale, duration, result/error code, evidence refs.

Committed examples (four runs):

1. Real LLM discovery of `lookup_account_balance`.
2. Successful unattended replay with typed outputs.
3. Replay returning the `account_not_found` business outcome.
4. Replay of `transfer_funds` escalating and a human completing it in the live session.

Failure injection uses Playwright `page.route()` against ParaBank (a 500, a stall, a login
bounce). No second target app is authored — route interception covers Section 3.3 for free.

---

## 13. ParaBank — verify before committing

The first draft assumed seeded account ids (`--input fromAccount=12345`). ParaBank generates
accounts per registration against an in-memory DB, so that assumption would make the reviewer's
replay non-reproducible. Resolve these **first**, in the day-0 spike:

- Which image tag actually exists (`:latest` is the common one; confirm before pinning a digest).
- Whether a deterministic login exists out of the box, and whether the DB resets on restart.
- Whether an admin/init endpoint can seed known state.

Then add an idempotent `npm run setup` that registers a known synthetic user and writes the
resulting account ids to `.env`. Using ParaBank's REST service **for fixture seeding only** is
legitimate and fast — say so explicitly in REPORT.md ("API for setup, UI for the task under
automation"), because it is the obvious reviewer question.

The CLI must fail clearly when ParaBank is unreachable rather than burning agent steps.

---

## 14. CLI

```bash
docker compose up -d && npm run setup

npm run cli -- discover --goal "Look up account <id> and read its balance" \
  --target parabank --out capabilities/lookup-account-balance.v1.json --headed

npm run cli -- replay --artifact capabilities/lookup-account-balance.v1.json \
  --input accountId=13344

npm run cli -- replay --artifact capabilities/lookup-account-balance.v1.json \
  --input accountId=99999            # → business_outcome: account_not_found

npm run cli -- replay --artifact capabilities/transfer-funds.v1.json \
  --input from=13344 --input to=13355 --input amount=25 --headed   # → escalated

npm run cli -- validate capabilities/lookup-account-balance.v1.json

# stretch: agent-facing catalog
npm run cli -- capabilities
npm run cli -- invoke lookup_account_balance --args '{"accountId":"13344"}'
```

---

## 15. Stretch goal — exactly one

**Agent-facing capability catalog** (`capabilities` / `describe` / `invoke <name> --args`).
~40 lines over the replay engine, and it is literally the brief's through-line: *"a capability an
AI agent can call."* It emits each artifact's inputs/outputs as a tool schema, which is the
cheapest possible demonstration that the artifact is a contract and not a step list.

Everything else in Section 8 of the brief is skipped and listed under Cuts.

---

## 16. Milestones (3, not 6)

### Day 0 — de-risk (≤1 hour, throwaway)

Spike the observe→decide→act loop against ParaBank with `claude-opus-5` and confirm the model
can actually drive it from an ARIA snapshot. Confirm the ParaBank questions in §13. Then throw
the spike away.

Rationale: "deterministic core first" is the right build order, but it parks the one
non-negotiable deliverable — a real LLM run against a live surface — behind everything else. An
hour up front removes that risk without changing the order.

### Milestone 1 — contracts + deterministic replay

Zod schemas; ARIA observation; locator resolution with strict uniqueness; action executor;
evidence/JSONL/trace; template + secret resolution; the handler interpreter; checkpoint
verification; the four-status result.

*Exit:* a **hand-authored** `lookup_account_balance` artifact replays end-to-end, returns typed
outputs, and returns `account_not_found` on a bad id — with no model involved.

### Milestone 2 — safety + handoff

Origin/route/action allowlists in both paths; risk classification; ownership lock; intervention
request + persistence + CLI prompt; `addInitScript` human-event capture; re-observe on resume.

*Exit:* `transfer_funds` replay escalates, a person acts in the same browser, control returns,
and evidence is continuous across the seam.

### Milestone 3 — real discovery + evidence + docs

Anthropic adapter with tool-use action schema; bounded discovery loop with policy check before
every action; ref → durable locator-candidate derivation; parameterization of observed values;
artifact emission at `status: "draft"`. Then capture the four evidence runs, write README.md and
REPORT.md (seven required headings), and the catalog stretch if time remains.

*Exit:* a real model-driven run produces an artifact the deterministic engine replays.

---

## 17. Tests — five that matter

1. **Schema round-trip** — valid v1 accepted, invalid action/handler rejected.
2. **Template + secret resolution** — inputs resolve correctly; a resolved secret never
   serializes into an artifact.
3. **Redaction** — passwords, configured patterns, and human-event values are scrubbed from logs.
4. **Locator resolution** — zero matches and multiple matches both fail, distinctly.
5. **Outcome classification** — a handler match returns `business_outcome`, not `failure`; the
   ownership lock rejects an automation action while `owner === "human"`.

The first draft listed twelve. The brief says "tested where it counts." These five cover every
place where a bug would be invisible.

---

## 18. Heterogeneity and multi-tenant — seams, not builds

**Surfaces.** Artifacts carry intent-level actions and locator *candidates*, not Playwright
calls. `PlaywrightSurface` translates to web operations; a desktop surface translates the same
actions to accessibility-tree nodes or coordinates. Because the observation is already an
ARIA/role-name tree, the desktop seam is a different producer of the same shape — not a rewrite.
Candidate strategies are a discriminated union, so a surface-specific strategy is additive.

**Tenants.** `capabilityId` + `version` define a vendor/app-level capability. `baseUrl`,
credentials, and allowed routes resolve from tenant config at invoke time. A tenant needing
divergence ships an **override** — extra handlers or extra locator candidates keyed by step id,
with `derivedFrom` recording lineage — not a copied artifact. `appFingerprint` plus replay
history gives the drift signal. A tenant-specific fallback is never silently promoted into the
base artifact.

---

## 19. Risks

| Risk | Mitigation |
|---|---|
| ParaBank account ids / DB state not reproducible | `npm run setup` seeds a known user; day-0 verification; documented state |
| Model emits malformed or unsafe actions | tool use with `strict: true`, Zod parse, policy check before execute |
| Model's element ref yields no stable locator | ARIA-first observation makes role+name the default; unresolved → `status: "draft"` |
| Replay looks deterministic but depends on timing | explicit conditions, exactly-one-match locators, bounded waits |
| Human event capture silently records nothing | `page.addInitScript`, re-bound per document; asserted in the handoff evidence |
| Handoff is cosmetic | ownership lock enforced in the executor, covered by test 5 |
| Error handling drifts app-specific | generic engine errors vs. artifact-declared handlers, kept separate |

---

## 20. Definition of done

- One Docker Compose command + `npm run setup` yields reproducible state.
- A real `claude-opus-5` discovery run completes against the live ParaBank UI.
- Discovery emits a valid, versioned, parameterized artifact with no credentials in it.
- Replay runs with `modelCalls: 0`, verifies a checkpoint, returns declared typed outputs.
- A bad input returns `business_outcome: account_not_found`, distinctly from any failure.
- A risky step returns `escalated`; a human completes it in the *same* live browser; control
  returns and the run finishes.
- Allowlists enforced in both discovery and replay.
- `/evidence/` holds all four runs.
- README.md has exact setup + demo commands; REPORT.md has the seven required headings,
  including an explicit Cuts section naming: the operator console, desktop surface, tenant
  overrides, LLM-assisted replay recovery, and the four unused stretch goals.

---

## 21. First task

Day-0 spike (§16) — verify ParaBank's image, login, and account seeding, and confirm the model
can drive it from an ARIA snapshot. Then discard the spike and start Milestone 1 with
`schema.ts` and a hand-authored `lookup_account_balance` artifact.
