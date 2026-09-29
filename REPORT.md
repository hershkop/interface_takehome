# Design report

This system lets an LLM learn a UI workflow once, records the result as a typed capability,
and replays that capability deterministically with no model in the runtime decision loop.

The model is a compiler, not the runtime. Discovery turns a goal, authoring guidance,
application memory, and live observations into a versioned JSON artifact. Replay interprets
only that artifact and returns one of four typed outcomes: success, an expected business
outcome, escalation to a person, or failure.

The core claim is demonstrated end to end:

```text
discover account 12678  →  recorded capability, model calls > 0
replay account 12345    →  balance -2300, account type CHECKING, model calls = 0
```

The model never saw account `12345`. The same capability works because account identifiers are
inputs rather than recorded constants. Committed run evidence is under
[`evidence/examples/`](evidence/examples).

## 1. Architecture

```text
skills + application memory + goal + observation
                     │
                     ▼
              discovery compiler
                     │
                     ▼
           typed capability artifact
                     │
        validate → rehearse → approve
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   agent-facing catalog   deterministic replay
                                │
                    ownership + policy wrappers
                                │
                   ┌────────────┴────────────┐
                   ▼                         ▼
          Playwright web surface     desktop helper surface
                   │                         │
                   └────────────┬────────────┘
                                ▼
                 typed result + run evidence
                                │
                         audit + console
```

The TypeScript orchestration is deliberately compact. It uses filesystem persistence instead
of a database or queue, starts Chromium for web runs, and starts a helper child process for
desktop runs. That is enough to make the architectural boundaries executable without adding
scaling infrastructure that would not change them.

The important boundaries are:

- `src/discovery.ts` observes and chooses actions while compiling a capability.
- `src/replay.ts` interprets an existing capability without importing any model client.
- `src/lifecycle.ts` defines what evidence is required before a capability becomes callable.
- `src/catalog.ts` turns approved artifacts into typed agent tools.
- `src/handoff.ts` controls whether automation or a person owns the session.
- `src/safety.ts` decides what the current run is permitted to do.
- `src/surface.ts` and `src/desktop/` implement the shared intent-level surface contract.
- `src/evidence.ts` records runs; `src/audit.ts` reads those records back as a ledger.
- `src/console/` provides the local review, run, recording, handoff, and audit UI.

Discovery and replay share the same action schema and surface interface. Discovery chooses an
action; replay only interprets an action already present in an artifact. A test compares the
compiler's tool vocabulary with replay's action union so a replayable verb cannot quietly
become unrecordable.

Policy and ownership are wrappers around the surface rather than checks embedded only in the
step loop. That matters because steps are not the only code that can act: dismiss handlers,
re-authentication, and output collection also touch the application. `OwnedSurface` wraps
outside `GuardedSurface`, so when a person owns the session automation cannot act even if policy
would otherwise allow the action.

Playwright was chosen over an agent SDK because the valuable output is the artifact. The system
needs to own how proposed actions are validated, risk-gated, converted to durable locators, and
recorded. An agent SDK that owns the loop would hide the part under evaluation.

Discovery currently uses Claude Opus 5 with adaptive thinking and one tool action per turn.
Parallel tool use is disabled because the model must observe the result of one action before it
chooses the next.

## 2. Capability artifact and compiler

A capability is declarative JSON validated by the versioned Zod schema in `src/schema.ts`.

```ts
{
  schemaVersion,
  capabilityId,
  version,
  derivedFrom?,
  metadata: {
    name,
    description,
    status,
    risk,
    recordedAt,
    recordedBy,
    model?,
    compiledWith?,
    notes?
  },
  target: { app, surface, baseUrl, appFingerprint? },
  inputs: Record<string, InputDefinition>,
  outputs: Record<string, OutputDefinition>,
  steps: ArtifactStep[],
  handlers: Handler[],
  checkpoint: Condition
}
```

### Locators and actions

A target is an ordered list of locator candidates, not one selector. Resolution walks the list
and accepts the first candidate that matches exactly one visible element. Zero matches stop the
run; multiple visible matches are ambiguous and also stop it. Choosing the first of several
`Delete` buttons would be a successful action against the wrong record.

Discovery emits candidates in this preference order:

```text
accessible role and name → label → visible text → stable id → structural CSS
```

The artifact owns the order at replay time. A hand-authored artifact can put CSS first, so the
ranking is an authoring convention enforced by discovery and review rather than reordered by
the runtime.

Coordinates are a discovery-only escape hatch. A model may click a point and use the returned
element metadata to derive a durable locator, but replay never resolves a coordinate candidate.
The validation gate scans steps, outputs, and dismiss handlers so coordinates cannot hide in a
less obvious target.

The shared action vocabulary is `navigate`, `click`, `fill`, `select`, `press`, `wait`,
`extract`, and `assert`. `press`, right-clicks, and cell references were added after the Excel
example exposed real gaps: filling a value is not the same as committing it with Enter, context
menus need a right mouse button, and a spreadsheet cell needs an address that survives a value
change.

### Outputs, handlers, and risk

Outputs declare both their type and how to obtain them: from a locator or an extracted variable,
with coercion and missing-value behavior. `currency` coercion exists because ParaBank renders
negative balances as `-$100.00`, which a naive `parseFloat` cannot read.

Handlers keep application-specific branching in data. Each handler matches a declared condition
and produces one of three dispositions:

- an expected business outcome such as `account_not_found`;
- a bounded recovery using `dismiss`, `retry_step`, or `reauthenticate`; or
- a declared hard failure from the engine's closed error enum.

Business outcomes are open strings because applications define them. Engine failures are a
closed set so callers can handle them exhaustively.

Risk is mandatory at capability level and may be overridden per step. A truncated or incomplete
artifact cannot execute unattended because a risk field was omitted. `blocked` is absolute;
other risk classes are interpreted by the run's policy.

### Parameters can hide in three places

The first discovered capability exposed a subtle compiler problem. An input can appear in:

| Location | Example |
|---|---|
| Action value | `fill` with `{{inputs.amount}}` |
| Locator | link named `{{inputs.accountId}}` |
| Condition | wait for text `{{inputs.accountId}}` |

The learned ParaBank flow reaches an account by clicking a link whose accessible name is the
account number. Parameterizing only action values produced an artifact that looked reusable but
was still wired to the discovery account. Template resolution now covers all three locations.

### Skills and application memory are compiler inputs

Versioned Markdown skills provide reusable recording guidance. Their scopes are `generic`,
`surface:web`, `surface:desktop`, or `app:<name>`, ordered from broadest to most specific in the
prompt. Surface scoping is a correctness boundary: telling a desktop recorder to prefer CSS
selectors is actively harmful.

Application memory stores terminology, aliases, dialogs, and observed failure modes. Each entry
is scoped by application, surface, and optionally tenant; carries provenance and an owner; and
can express confidence and expiry. Entries containing configured secret values are refused
rather than scrubbed because the source file itself is committed.

The selected skill and memory versions are written to `metadata.compiledWith`. Neither module is
reachable from replay's import graph, and a test checks that boundary. Guidance may change how
the next artifact is compiled, but it cannot change how an already approved artifact runs.

## 3. Trust lifecycle and agent catalog

The lifecycle separates three claims that a single `approved` flag would otherwise blur:

| State | Claim and evidence |
|---|---|
| `draft` | Recorded, but not trusted yet |
| `validated` | Schema-valid, durable locators, checkpoint, and a reportable result |
| `rehearsed` | Three clean replays of this exact executable fingerprint, with no failures |
| `approved` | A named person decided the capability should be callable |
| `deprecated` | Retired and refused; reachable from any state |

Promotion moves one step at a time. Both the CLI and console call the same gate functions, so
the raw JSON editor is not a side door around lifecycle checks. Only `approved` capabilities
appear in the agent-facing catalog. A `rehearsed` capability has proved it works, but nobody has
yet decided that an agent should be allowed to call it.

Rehearsals are keyed by a canonical fingerprint of executable artifact content, not by
`capabilityId` or a version string supplied by an author. Editing behavior therefore resets the
evidence. The fingerprint excludes review notes and lifecycle status because neither changes
runtime behavior.

The console prevents an approved revision from changing in place. Behavioral edits require a
new version and a return to `draft`; notes may change without a version bump. The catalog rejects
multiple files with the same `capabilityId` rather than letting filename order decide which
revision runs. Superseded revisions remain in git history.

Agent tool definitions are generated from artifact inputs and outputs. The advertised schema and
the schema enforced during invocation therefore share one source. `invoke` refuses non-approved
capabilities unless a caller explicitly opts into a draft, and it never permits a deprecated
capability.

## 4. Deterministic replay and error handling

| Property | Mechanism |
|---|---|
| No model | Replay has no model client and records `modelCalls: 0` |
| Declared control flow | Ordered steps, fixed handlers, and a final checkpoint |
| Refusal over guessing | A target must resolve to exactly one visible element |
| Observable waits | UI readiness and postconditions are polled with bounded timeouts |
| Verified progress | Postconditions verify steps and the checkpoint verifies the result |

Replay returns a discriminated union:

```ts
| { status: "success"; outputs; evidence }
| { status: "business_outcome"; outcome; detail; evidence }
| { status: "escalated"; intervention; evidence }
| { status: "failure"; error; evidence }
```

`escalated` is separate because an unattended caller reaching a human gate has neither
succeeded nor failed. CLI exit codes are `0` for success or business outcome, `2` for escalation,
and `1` for failure.

Handlers are evaluated before and after each step. A condition that appears while the previous
step settles must be handled before the engine acts into the wrong screen. Recovery attempts are
bounded across the whole run.

Nothing that may already have caused a side effect is repeated. A pre-step recovery can retry
the step because it has not run. After a successful step, replay continues forward. If a
postcondition does not become true, only `navigate`, `wait`, `extract`, and `assert` may be
retried. A successful `click`, `fill`, `select`, or `press` stops with
expected-versus-observed context instead of risking a duplicate transfer or submission.

Every execution writes evidence under `evidence/`. The audit reader reconstructs outcomes,
model calls, tokens, duration, and cost from those files. Costs are calculated at read time from
recorded token usage so a price-table change does not rewrite history. Unknown usage stays
unknown rather than being reported as zero, and committed copies of example runs are displayed
but excluded from totals.

## 5. Web, desktop, and tenant variation

### One intent-level surface contract

Nothing in the artifact or replay loop is a Playwright type. `Surface` expresses actions such as
"click the uniquely named control" and observations as an accessibility tree. The interface is
implemented by both `PlaywrightSurface` and `DesktopSurface`, and a non-browser state-machine
test exercises replay through the same port.

`target.surface` is declared as `web` or `desktop`; it is not inferred from `baseUrl`. The launch
path compares the artifact with the supplied surface before taking any action, so a desktop
artifact handed to a browser reports a surface mismatch instead of a misleading locator failure.

ARIA snapshots were chosen over DOM dumps because role and accessible name are meaningful for a
modern web page, a legacy JSP application, and a native accessibility tree. The ParaBank page is
roughly 4.5 KB in that representation, and the model naturally proposes role-and-name locators
from what it sees.

### Desktop helper boundary

`DesktopSurface` talks newline-delimited JSON over stdio to a helper process. The helper focuses
an application, observes its accessibility tree, resolves locator queries, performs mutations,
and captures masked screenshots. It returns every match rather than choosing one, and mutations
use opaque handles issued by resolution so a changing tree cannot be silently re-queried between
uniqueness checking and action.

Every mutating response includes the resulting window. This prevents the safety layer from
being one action behind if a click switches applications. Policy checks application identity and,
for document-oriented tools such as Excel, the document path rather than the mutable window
title.

The repository includes executable banking and Excel reference helpers. They prove the transport,
resolution, action vocabulary, evidence, policy, and replay contract through real child-process
framing, but they drive hand-written trees rather than a real application. A production helper
still needs to bind the protocol to macOS AXUIElement, Windows UI Automation, or AT-SPI2.

### Tenant variation

Runtime inputs, secrets, base-URL overrides, and policy let one artifact operate against
different environments without baking credentials or tenant URLs into its steps. Identity and
lineage fields (`capabilityId`, `version`, `derivedFrom`, and `appFingerprint`) provide the shape
needed for vendor-level artifacts and tenant-specific revisions.

The tenant registry, credential store, override resolver, and automated fingerprint drift
response are not implemented. Candidate chains absorb renamed controls; they do not absorb a
different workflow with an extra confirmation screen. That case needs a new recording linked by
`derivedFrom`.

## 6. Escalation and control transfer

The system can become stuck in three distinct ways:

- During discovery, the model can call `give_up` instead of thrashing or bypassing a guard.
- During replay, a step or handler can require a person.
- Policy can require approval for the step's risk class.

An intervention request contains the capability, goal, step, current location, visible alerts,
and a screenshot captured before handoff. `OwnedSurface` then transfers ownership to the person
and refuses automation mutations until the session has been observed and returned.

The response is deliberately three-valued:

| Decision | Meaning |
|---|---|
| `proceed` | Automation performs the approved step |
| `done` | The person performed it; skip the step and verify the resulting state |
| `abort` | Stop the run |

Anything other than an exact accepted token aborts. Prefix matching once interpreted phrases
such as "please abort" as consent, which is unacceptable for an irreversible action.

For browser handoffs, listeners installed with `page.addInitScript` survive navigation and record
clicks, navigation, and the length—not the contents—of entered values. Editable content is never
used as a label because it may itself be sensitive. Human actions are written separately from
the automation event log.

`InterventionChannel` has terminal, scripted-test, and web-console implementations. The local
console carries context and decisions while the operator acts in the real application window.
Remote co-browsing is not implemented. Unattended escalation returns a resume token identifying
the run and step, but there is no cross-process `resume` command; the browser closes when that
process ends.

## 7. Safety and data handling

### Enforcement

Web containment uses three layers:

1. `GuardedSurface` checks every action, including recovery and output paths.
2. A browser navigation guard blocks document requests to origins outside the allowlist.
3. A landing check after every mutation catches client-side navigation that produces no document
   request.

Desktop containment uses the same guarded surface but checks allowed applications and optional
document globs instead of HTTP origins. Origins are compared canonically; application IDs are
exact; document policy uses the path reported separately from the window title.

`policy` is required by `replay()`. Policies can restrict origins, paths, applications,
documents, action types, risk classes, total steps, runtime, and additional redaction patterns.
Blocked actions win over allowed actions. The complete resolved policy is written to the run
record so an auditor can answer why the action was permitted.

Discovery has no completed artifact from which to read risk, so policy also carries regular
expressions for risky controls. A proposed irreversible action is routed through the same
approval mechanism as replay. Without an intervention channel it is refused and the model is
told why.

### Evidence and secrets

Redaction is applied at each sink:

| Sink | Treatment |
|---|---|
| Events, results, and snapshots | Structured data passes through the redactor before writing |
| Screenshots | Sensitive regions are masked before image bytes are created |
| Playwright traces | Off by default; opt-in traces are marked `traceUnredacted` |

A trace may contain request bodies, cookies, and DOM snapshots that a string redactor cannot
reliably sanitize. The default rich failure signal is a redacted ARIA snapshot instead.

Secrets appear in artifacts as references, never literal values. Inputs declared `sensitive`
are masked by field name in the run record, which also protects short values such as PINs that
literal redaction intentionally ignores. `test/evidence-secrets.test.ts` scans every byte of
every file produced by a test run.

### Known limits

- Web sub-resource requests are not origin-blocked; the guard constrains navigation, not every
  possible data flow.
- Screenshot masking is selector- or accessibility-role-based; sensitive body text may still be
  visible.
- Opt-in Playwright traces are explicitly unredacted.
- Policy is supplied per run rather than declared as requirements on the artifact, so some
  mismatches appear only when execution reaches the relevant action.
- A real desktop helper is part of the trusted computing base and could misreport application,
  document, or accessibility state.
- Lifecycle status and fingerprints are not cryptographic signatures. Direct filesystem edits
  outside the CLI and console are not prevented.
- The console binds to localhost without authentication and is suitable only for local
  development and demonstration.

## 8. Deliberate cuts and next work

### Not built

- **Persisted escalation sessions.** Resume tokens identify a stop but cannot restore a browser
  or desktop session in another process.
- **Production desktop adapters.** The protocol and TypeScript surface are complete; native OS
  accessibility bindings are not.
- **Remote co-browsing.** The console handles context and decisions, not streaming a live remote
  session.
- **Tenant infrastructure.** There is no registry, credential service, or override merge layer.
- **LLM-assisted replay recovery.** Rejected for v1 because it would put a model back into the
  production decision loop.
- **Branches and loops in artifacts.** v1 remains linear; bounded handlers cover exceptional
  paths.
- **Discovered unhappy-path handlers.** A single successful recording cannot honestly infer how
  an unseen application reports every failure.
- **Artifact signing and authenticated review.** Git history and local lifecycle gates provide
  provenance, not tamper resistance or user identity.

### Recommended order

1. Persist sessions so an unattended escalation can genuinely resume.
2. Implement one real platform accessibility helper against the existing desktop protocol.
3. Add tenant-scoped capability resolution, credentials, and override merging.
4. Suggest handlers from failed production runs for human review.
5. Add signed artifacts and authentication before moving the console beyond localhost.

### What implementation and review exposed

The design changed because executable tests and reviews found concrete failures: a locator that
counted visible matches but returned the first DOM match; a postcondition retry that could
repeat a transfer; policy checks bypassed by recovery paths; traces that contradicted the
redaction claim; prefix matching that treated abort text as approval; and lifecycle edits that
could preserve trust earned by an older revision.

The system also found two problems itself. `give_up` exposed a credential-template bug when the
model refused to guess credentials, and replaying a newly discovered capability showed that
parameters can hide in locators and conditions as well as action values. The Excel capability
then exposed missing keys, mouse buttons, cell addressing, and document containment. Those are
the useful results of the prototype: boundaries that survived contact with a second workflow
and failure modes that became tests rather than promises.
