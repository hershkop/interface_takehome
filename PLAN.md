# Computer-Use Automation System — Implementation Plan

## 1. Goal

Build a small end-to-end system that:

1. Accepts a natural-language goal for ParaBank.
2. Uses an LLM to observe and operate the real ParaBank UI through Playwright.
3. Records a successful discovery run as a typed, reviewable capability artifact.
4. Replays the artifact deterministically without an LLM making decisions.
5. Classifies successful results, expected business outcomes, and failures.
6. Pauses and transfers the same live browser session to a human when approval or assistance is required.
7. Produces redacted logs, screenshots, and a Playwright trace as evidence.

The implementation should remain a modular monolith. The durable artifact and replay path must not depend on the selected model provider or discovery implementation.

## 2. Chosen approach

| Concern | Choice |
|---|---|
| Language | TypeScript on Node.js |
| Browser automation | Playwright |
| Model integration | Vercel AI SDK with structured output |
| Runtime validation | Zod |
| Target application | ParaBank, started locally through Docker Compose |
| Discovery observation | Minimal hybrid: screenshot plus compact interactive-element list |
| Saved capability | Versioned, linear JSON artifact |
| Production execution | Deterministic artifact interpreter; no LLM decisions |
| Human handoff | CLI intervention prompt plus the same headed browser session |
| Evidence | JSONL events, screenshots, saved artifacts, structured results, and Playwright traces |
| Persistence | Filesystem only |

### Why this combination

- ParaBank provides a banking-relevant, non-trivial UI without requiring us to write a target application.
- Playwright provides browser control, locator APIs, persistent browser contexts, traces, screenshots, and a visible browser for human takeover.
- The Vercel AI SDK removes model-provider plumbing while remaining isolated behind a discovery interface.
- A linear artifact keeps replay understandable and makes success and failure behavior easy to audit.
- Filesystem persistence is sufficient for a focused single-process demonstration.

## 3. Explicit non-goals

- No distributed services, job queue, database, or event broker.
- No remote co-browsing or production operator dashboard.
- No desktop automation implementation.
- No open-ended LLM recovery during replay.
- No visual embeddings, OCR pipeline, or image-matching engine.
- No general workflow DAG, loops, or conditional branches in artifact version 1.
- No implementation of real multi-tenant infrastructure.
- No attempt to support every Playwright action.

## 4. System shape

```text
CLI
 ├── discover <goal>
 │     └── DiscoveryEngine
 │           ├── Observer
 │           ├── Vercel AI SDK
 │           └── ActionExecutor
 │                    │
 │                    ▼
 │             PlaywrightSurface
 │                    │
 │                    ▼
 │            CapabilityRecorder
 │                    │
 │                    ▼
 │          capability.v1.json
 │
 └── replay <artifact> <inputs>
       └── ReplayEngine
             ├── PolicyGuard
             ├── SessionController ←→ human operator
             ├── PlaywrightSurface
             └── EvidenceRecorder
                      │
                      ▼
             structured run result
```

The system shares one action vocabulary and one `Surface` port between discovery and replay. Discovery decides which action to take; replay only interprets already-recorded actions.

## 5. Proposed repository layout

```text
.
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── REPORT.md
├── PLAN.md
├── src/
│   ├── cli.ts
│   ├── config.ts
│   ├── domain/
│   │   ├── action.ts
│   │   ├── artifact.ts
│   │   ├── observation.ts
│   │   ├── policy.ts
│   │   └── result.ts
│   ├── discovery/
│   │   ├── discovery-engine.ts
│   │   ├── model-adapter.ts
│   │   ├── prompt.ts
│   │   └── recorder.ts
│   ├── replay/
│   │   ├── replay-engine.ts
│   │   ├── locator-resolver.ts
│   │   └── outcome-detector.ts
│   ├── surface/
│   │   ├── surface.ts
│   │   ├── playwright-surface.ts
│   │   └── observe-page.ts
│   ├── safety/
│   │   ├── policy-guard.ts
│   │   └── redactor.ts
│   ├── handoff/
│   │   ├── session-controller.ts
│   │   └── human-event-recorder.ts
│   └── evidence/
│       └── evidence-recorder.ts
├── capabilities/
├── evidence/
└── test/
    ├── artifact.test.ts
    ├── policy.test.ts
    ├── replay.test.ts
    └── redaction.test.ts
```

Files may be combined when an abstraction contains very little code. The directory structure expresses boundaries, not a target file count.

## 6. Core ports

### Surface

```ts
interface Surface {
  observe(): Promise<Observation>;
  execute(action: ResolvedAction): Promise<ActionResult>;
  verify(condition: Condition): Promise<VerificationResult>;
  captureEvidence(label: string): Promise<EvidenceRef>;
}
```

`PlaywrightSurface` is the only version-one implementation. A future desktop adapter would implement the same intent-level contract while using OS accessibility and input APIs internally.

### Discovery engine

```ts
interface DiscoveryEngine {
  discover(request: DiscoveryRequest): Promise<DiscoveryResult>;
}
```

The Vercel AI SDK implementation stays behind this interface. Replacing the model or adopting an agent framework later must not change saved artifacts or replay.

### Session control

```ts
type SessionOwner = "automation" | "human";

interface SessionController {
  readonly owner: SessionOwner;
  requestIntervention(request: InterventionRequest): Promise<void>;
  resumeAutomation(): Promise<void>;
}
```

The action executor must refuse automation actions while the session owner is `human`.

## 7. Minimal hybrid observation

Each discovery step creates one observation containing:

- Current URL and page title.
- A screenshot reference.
- Visible text, capped to a reasonable length.
- Visible interactive elements with temporary references such as `e1` and `e2`.
- Visible alerts, dialogs, and validation messages.
- A short recent-action history.

Example:

```json
{
  "url": "http://localhost:8080/parabank/transfer.htm",
  "title": "ParaBank | Transfer Funds",
  "screenshot": "evidence/discovery-001/step-03.png",
  "elements": [
    {
      "ref": "e1",
      "tag": "input",
      "role": "textbox",
      "name": "Amount"
    },
    {
      "ref": "e2",
      "tag": "input",
      "role": "button",
      "name": "Transfer"
    }
  ]
}
```

The model sees the screenshot and compact element list, then returns exactly one Zod-validated action or a terminal decision.

```ts
type DiscoveryDecision =
  | { type: "act"; action: DiscoveryAction; rationale: string }
  | { type: "complete"; outputs: Record<string, unknown> }
  | { type: "stuck"; reason: string };
```

Coordinate clicks are allowed only as a discovery fallback. After a coordinate click, the adapter uses `document.elementFromPoint()` and attempts to derive a stable locator. If it cannot, the recorded capability is marked `draft` and unsuitable for unattended replay.

## 8. Action vocabulary

Artifact version 1 supports only:

- `navigate`
- `click`
- `fill`
- `select`
- `wait`
- `extract`
- `assert`

Every model-produced action is parsed with Zod, checked by the policy guard, and only then executed.

Values support parameter templates:

```json
{
  "action": "fill",
  "target": { "label": "Amount" },
  "value": "{{inputs.amount}}"
}
```

Secrets use runtime references and are never resolved into the artifact:

```json
{
  "action": "fill",
  "target": { "label": "Password" },
  "value": "{{secrets.parabankPassword}}"
}
```

## 9. Capability artifact

The artifact is declarative JSON validated by a versioned Zod schema.

```ts
interface CapabilityArtifactV1 {
  schemaVersion: "1.0";
  metadata: {
    name: string;
    description: string;
    revision: number;
    status: "draft" | "approved";
    risk: "safe" | "approval_required" | "blocked";
    recordedAt: string;
  };
  target: {
    app: string;
    appVersion?: string;
    baseUrl: string;
  };
  inputs: Record<string, InputDefinition>;
  outputs: Record<string, OutputDefinition>;
  steps: ArtifactStep[];
  outcomes: OutcomeDefinition[];
  checkpoint: Condition;
}
```

Each step contains:

- Stable step ID.
- One typed action.
- Locator definition when the action targets a control.
- Optional retry policy.
- Optional risk override.
- Optional expected postcondition.

### Locator strategy

A target contains an ordered list of candidates rather than a raw model reference:

```json
{
  "candidates": [
    { "strategy": "role", "role": "button", "name": "Transfer" },
    { "strategy": "text", "value": "Transfer" },
    { "strategy": "css", "value": "input[value='Transfer']" }
  ]
}
```

Replay tries candidates in order and requires exactly one visible match. Zero matches and ambiguous matches are failures; replay does not guess.

Prefer locators in this order:

1. Accessible role and name.
2. Associated label.
3. Stable visible text.
4. Stable form name or ID.
5. Structural CSS as a last DOM-level fallback.
6. Coordinates only for draft artifacts requiring review.

## 10. Deterministic replay

Replay performs the following sequence:

1. Parse and validate the artifact.
2. Parse invocation inputs against the declared input definitions.
3. Confirm the target and policy configuration.
4. Start one browser context and evidence recorder.
5. Resolve templates immediately before each step.
6. Check the action against the policy allowlist.
7. Resolve exactly one target control.
8. Execute the action using explicit waits and bounded retries.
9. Check the step postcondition when present.
10. Detect declared business outcomes and known recoverable conditions.
11. Extract declared outputs.
12. Verify the final checkpoint.
13. Return a structured result and close the trace.

The replay engine never calls the model to decide what to do.

## 11. Result and error taxonomy

The caller receives one of three top-level result types:

```ts
type RunResult =
  | {
      status: "success";
      outputs: Record<string, unknown>;
      evidence: EvidenceSummary;
    }
  | {
      status: "business_outcome";
      outcome: string;
      details?: Record<string, unknown>;
      evidence: EvidenceSummary;
    }
  | {
      status: "failure";
      error: RunError;
      evidence: EvidenceSummary;
    };
```

`RunError` includes:

- Error code.
- Failed step ID and index.
- Recoverability flag.
- Expected state.
- Sanitized observed state.
- Screenshot and trace references.
- Attempt count.

Initial error codes:

- `TARGET_NOT_FOUND`
- `TARGET_AMBIGUOUS`
- `STEP_TIMEOUT`
- `CHECKPOINT_FAILED`
- `POLICY_DENIED`
- `SESSION_EXPIRED`
- `UNEXPECTED_DIALOG`
- `INPUT_INVALID`
- `HUMAN_ABORTED`

Retries are bounded and only apply to declared recoverable operations such as navigation, waiting, or transient target absence. Validation errors and policy denials are never blindly retried.

## 12. Safety policy

Policy configuration contains:

- Allowed origins.
- Optional allowed path patterns.
- Allowed action types.
- Blocked action types or targets.
- Rules that require approval.
- Maximum steps and run timeout.

The guard runs for both discovery and replay. Redirects are checked after navigation so the browser cannot silently leave the allowlisted origin.

Risk classes:

| Class | Behavior |
|---|---|
| `safe` | Execute automatically |
| `approval_required` | Pause and hand control to a human |
| `blocked` | Stop with `POLICY_DENIED` |

For the demo, submitting a funds transfer is `approval_required`. The human manually performs or declines the final action in the same browser session.

### Data handling

- Credentials enter through environment variables or runtime secret values.
- Artifact templates retain secret references, never resolved values.
- Prompt observations redact password fields and configured sensitive patterns.
- Logs pass through a central redactor before being written.
- Human-input events record target metadata but redact sensitive values.
- Screenshots containing sensitive data must either be avoided, masked before capture, or clearly use synthetic demo data.

## 13. Human escalation and control transfer

An intervention request contains:

```ts
interface InterventionRequest {
  runId: string;
  capability?: string;
  goal?: string;
  step?: { id: string; index: number };
  reason: "approval_required" | "agent_stuck" | "replay_blocked";
  message: string;
  screenshot: string;
  observedState: Record<string, unknown>;
}
```

Minimal version-one handoff:

1. Pause the automation loop.
2. Change session ownership to `human`.
3. Save the intervention request and screenshot.
4. Print the intervention context in the CLI.
5. Leave the same headed Playwright browser open.
6. Let the human operate the page directly.
7. Capture sanitized browser click/change events while human ownership is active.
8. Wait for the operator to press Enter or abort.
9. Take a fresh observation and screenshot.
10. Return ownership to `automation`.
11. Verify the next postcondition or final checkpoint.

Production evolution would replace the CLI and local window with an intervention queue and remote session streaming without changing the ownership contract.

## 14. Evidence model

Each run writes to its own directory:

```text
evidence/<run-id>/
├── run.json
├── events.jsonl
├── result.json
├── trace.zip
├── step-001-before.png
├── step-001-after.png
└── intervention.json
```

Each event includes:

- Timestamp and run ID.
- Phase: `discovery`, `replay`, or `human`.
- Step ID.
- Action type and sanitized arguments.
- Discovery rationale when applicable.
- Duration.
- Result or error code.
- Evidence references.

The repository should include committed example evidence for:

1. One real LLM discovery run.
2. One successful deterministic replay.
3. One replay producing a business outcome or injected recoverable condition.
4. One human handoff during a risky step.

## 15. Initial ParaBank capability

### `transfer_funds`

Goal example:

> Transfer 25 dollars from account 12345 to account 67890 and confirm the result.

Inputs:

- `fromAccount: string`
- `toAccount: string`
- `amount: number`, greater than zero

Outputs:

- `confirmationMessage: string`
- `transferredAmount?: number`

Checkpoint:

- The transfer confirmation heading or confirmation text is visible.

Potential business outcomes will be based on actual ParaBank behavior observed during implementation. We should not invent unsupported messages in advance.

Risk behavior:

- Navigating and filling the transfer form are safe.
- Submitting the transfer requires human control.
- During discovery, the operator may approve and perform the submission.
- During replay, the same approval boundary is enforced from the artifact and policy.

## 16. Docker Compose target

Use the official ParaBank image and pin it to an immutable digest after verifying it locally.

```yaml
services:
  parabank:
    image: parasoft/parabank:baseline
    ports:
      - "8080:8080"
```

Expected lifecycle:

```bash
docker compose up -d
docker compose down
docker compose down -v # deliberate clean reset
```

Add a health check if the image exposes a reliable endpoint. The CLI should fail clearly when ParaBank is unavailable rather than consuming agent steps.

## 17. CLI contract

Target commands:

```bash
# Start ParaBank
docker compose up -d

# Run genuine LLM discovery and save an artifact
npm run cli -- discover \
  --goal "Transfer 25 dollars between the configured demo accounts" \
  --target parabank \
  --output capabilities/transfer-funds.v1.json \
  --headed

# Replay without model decisions
npm run cli -- replay \
  --artifact capabilities/transfer-funds.v1.json \
  --input fromAccount=12345 \
  --input toAccount=67890 \
  --input amount=25 \
  --headed

# Validate an artifact without running it
npm run cli -- validate capabilities/transfer-funds.v1.json
```

Exact account values will be documented after inspecting the pinned ParaBank instance. Credentials belong in `.env`, with safe placeholders in `.env.example`.

## 18. Implementation sequence

### Phase 1 — Bootstrap and contracts

- Initialize the TypeScript project.
- Add Playwright, Vercel AI SDK, selected provider adapter, Zod, and a small CLI parser.
- Add Docker Compose for ParaBank.
- Define Zod schemas for actions, artifacts, policies, observations, interventions, and run results.
- Implement config loading and environment validation.
- Write schema and redaction unit tests first.

Exit condition: ParaBank starts locally, the CLI loads configuration, and example artifacts can be validated.

### Phase 2 — Playwright surface and evidence

- Launch a persistent headed or headless browser context.
- Implement compact interactive-element extraction.
- Capture screenshots and Playwright traces.
- Resolve locator candidates with strict uniqueness checks.
- Implement the shared action executor.
- Emit redacted JSONL events.

Exit condition: A hard-coded typed action sequence can navigate ParaBank and produce evidence.

### Phase 3 — Deterministic replay

- Implement parameter and secret-template resolution.
- Implement the linear artifact interpreter.
- Add step postconditions, outcome detection, bounded retries, and final checkpoint verification.
- Return the structured three-way result contract.
- Test replay using a small hand-authored artifact before involving the LLM.

Exit condition: A hand-authored transfer capability reaches the approval boundary deterministically and reports structured failures.

### Phase 4 — Safety and human handoff

- Add origin, route, and action allowlists.
- Classify transfer submission as `approval_required`.
- Implement the session-owner state and CLI intervention prompt.
- Record sanitized human browser events.
- Re-observe and verify after control returns.

Exit condition: Replay pauses, a person acts in the same browser, and replay resumes or completes with continuous evidence.

### Phase 5 — LLM discovery and recording

- Implement the Vercel AI SDK adapter with structured model output.
- Build the bounded observe-decide-act loop.
- Run policy validation before every action.
- Convert temporary element references into durable locator candidates.
- Parameterize known invocation values instead of persisting concrete values.
- Emit a draft capability from a successful discovery run.

Exit condition: One real model-driven ParaBank run creates an artifact that the deterministic engine can replay.

### Phase 6 — Failure scenarios, documentation, and evidence

- Capture a successful discovery run and replay.
- Capture one known business outcome or validation error.
- Inject one transient delay or failed request through Playwright routing and demonstrate bounded recovery if useful.
- Complete `README.md` with exact setup and demo commands.
- Complete `REPORT.md` using the seven required headings.
- Explain deliberate cuts and the seams for desktop surfaces and tenant overrides.

Exit condition: A reviewer can clone the repository, start ParaBank, run discovery, replay the artifact, inspect evidence, and understand all tradeoffs.

## 19. Testing strategy

Keep tests concentrated on logic with the highest consequence.

### Unit tests

- Artifact schema accepts valid version-one files and rejects invalid actions.
- Input values are correctly typed and template-resolved.
- Secret references never serialize resolved values.
- Redaction covers configured secrets, passwords, and sensitive input fields.
- Policy blocks disallowed origins and actions.
- Result classification preserves the difference between business outcomes and failures.

### Integration tests

- Locator resolution fails on zero or multiple matches.
- Replay stops at an approval-required step.
- Automation cannot act while the human owns the session.
- Returning control triggers a fresh observation before continuing.
- A failed checkpoint produces step-level evidence.
- A transient delay gets only the configured number of retries.

### Manual end-to-end acceptance

1. Start ParaBank with Docker Compose.
2. Run discovery with a real model.
3. Confirm that the saved artifact contains parameters and no secrets.
4. Replay with different valid inputs and verify no model decision call occurs.
5. Observe the transfer approval handoff.
6. Complete the action manually in the same browser.
7. Return control and verify the structured result.
8. Run an invalid input or failure scenario and inspect its evidence.

## 20. Heterogeneity and multi-tenant design seam

Do not build these features, but preserve two extension points:

### Surface heterogeneity

- Artifacts express intent-level actions and locator candidates.
- `PlaywrightSurface` translates those actions to web operations.
- A desktop surface could translate the same actions to accessibility-tree nodes, OCR targets, or coordinates.
- Surface-specific locator candidates can be discriminated by type without changing the capability contract.

### Multi-tenant reuse

- Treat the main capability as a vendor/app-level definition.
- Resolve `baseUrl`, credentials, and allowed routes from tenant configuration.
- Allow a small tenant/version override map for locator candidates, not full artifact copies.
- Record the target app/version and replay history so drift can be detected.
- Never silently promote a tenant-specific fallback into the shared base artifact.

## 21. Likely implementation risks

| Risk | Mitigation |
|---|---|
| ParaBank startup or seeded data differs by image version | Pin an immutable image digest and document known demo state |
| Model emits malformed or unsafe actions | Require structured output, Zod parsing, and policy validation |
| Model-selected temporary references do not yield stable locators | Generate candidates from the actual element and mark unresolved artifacts as draft |
| Replay appears deterministic but relies on implicit timing | Use explicit conditions, strict locators, and bounded waits |
| Human activity leaks typed values | Record event metadata through the redactor; never log secret-field contents |
| The handoff is only cosmetic | Enforce an ownership lock that prevents automation actions while human control is active |
| Error handling becomes app-specific | Keep generic engine errors separate from artifact-declared business outcomes |
| Framework replacement affects replay | Restrict model and agent dependencies to `DiscoveryEngine` |

## 22. Definition of done

- ParaBank starts with one Docker Compose command.
- A real LLM-driven discovery run completes against its live UI.
- Discovery emits a valid, versioned, parameterized artifact.
- The artifact contains no credentials or raw sensitive values.
- Replay executes the artifact without LLM decision calls.
- Replay verifies a checkpoint and returns declared outputs.
- At least one business outcome or failure is reported distinctly and with useful evidence.
- A risky step transfers control to a human using the same live browser session.
- Human actions are captured in sanitized form and control can return to automation.
- Domain and action allowlists are enforced during both discovery and replay.
- Example evidence exists for discovery and replay.
- `README.md` contains exact setup and demo commands.
- `REPORT.md` contains the seven headings required by the assignment.

## 23. First implementation task

Begin with the deterministic foundation rather than the LLM loop:

1. Create the TypeScript project and Docker Compose file.
2. Start and inspect the pinned ParaBank image.
3. Define the Zod contracts.
4. Hand-author the smallest valid `transfer_funds` artifact.
5. Make Playwright replay it up to the approval boundary.

Once that works, add handoff and evidence, then place LLM discovery in front of the same action and artifact contracts. This order prevents model behavior from obscuring problems in the replay design.
