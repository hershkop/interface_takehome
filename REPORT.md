# Design write-up

A system that lets an LLM figure out a UI flow **once**, records what it learned as a typed
capability, and then replays that capability deterministically — with no model in the decision
loop — so an AI agent can invoke it by name, cheaply and repeatably.

The whole thesis, demonstrated end to end:

```
$ npm run cli -- discover --goal "Log in, then look up account 12678 and read its balance
                                  and account type" --capability lookup_balance_discovered ...
  RECORDED  lookup_balance_discovered v1.0.0    steps: 9    model calls: 11

$ npm run cli -- replay capabilities/lookup_balance_discovered.v1.json --input accountId=12345
  SUCCESS   balance = -2300   accountType = "CHECKING"   model calls: 0
```

The model saw account `12678`. The recorded capability works for `12345`, `12456`, `13122` —
accounts it never visited — because the run was parameterised as it was recorded. Evidence for
both is in `/evidence/examples/`.

---

## 1. Architecture

A single process, five layers, each depending only on the one below it.

```
  cli.ts ──────────── discover | replay | validate | capabilities | invoke
     │
  discovery.ts        observe → decide → act, once, to produce an artifact
  replay.ts           the production path: interprets an artifact, no model
  catalog.ts          artifacts as agent-callable tools
     │
  handoff.ts          who holds the session  ─┐
  safety.ts           what is permitted       ├─ wrappers around the surface
     │                                        ─┘
  surface.ts ──────── Surface port + PlaywrightSurface
     │
  schema.ts ───────── every typed contract
```

**Discovery and replay share one action vocabulary and one surface.** Discovery decides *which*
action; replay only interprets actions already chosen. That is what makes a recording faithful:
there is no second implementation for the model's actions to diverge from.

**Enforcement lives in wrappers, not in the loop.** `GuardedSurface` (policy) and `OwnedSurface`
(ownership) wrap the surface, and everything that drives the browser goes through them. This was
a correction, not the first design: the checks originally lived in the replay loop, and a review
found three things routing around it — a `dismiss` remedy, a re-authentication callback, and
output collection. Each was a real action against a real application that passed no check. The
loop is not the only thing that drives the browser, so the guard cannot live there.

Ownership wraps *outside* policy: if a person is driving, no question about what policy would
have permitted is even asked.

**Trade-offs.** One process, filesystem persistence, no queue or database. The brief says
building scaling infrastructure is not rewarded, and none of it would change a boundary here —
`InterventionChannel` already has one implementation and would take a queue consumer as another
without touching another file.

Playwright over a CUA/agent SDK: this system's value is the *artifact*, and an agent SDK would
own the loop that produces it. The 100-line loop in `discovery.ts` is the part worth controlling.

Claude Opus 5 with adaptive thinking, tool use, and `disable_parallel_tool_use`. One action per
turn, because the loop observes between actions — a batch would have the model choosing its
second move from a page it has not seen, which is the guesswork this design exists to remove.

---

## 2. Artifact schema

A capability is declarative JSON validated by a versioned Zod schema (`src/schema.ts`).

```ts
{
  schemaVersion, capabilityId, version, derivedFrom?,   // identity and lineage
  metadata: { name, description, status, risk, recordedAt, recordedBy, model? },
  target:   { app, appFingerprint?, baseUrl },
  inputs:   Record<name, InputDefinition>,              // the call contract
  outputs:  Record<name, OutputDefinition>,             // what the caller gets
  steps:    ArtifactStep[],                             // ordered, linear
  handlers: Handler[],                                  // the outcome model
  checkpoint: Condition                                 // proof it worked
}
```

### Why it is shaped this way

**Targets are ordered candidate lists, not selectors.** Replay walks them and requires *exactly
one visible match*; zero and ambiguous are both refusals. Three identical `Delete` buttons is
the case that matters — picking the first acts on the wrong record and reports success.

Preference order is a property of the system, not of whoever recorded it: accessible role+name
→ label → visible text → stable id → structural CSS → coordinates. A coordinate target anywhere
in an artifact — a step, an output locator, a dismiss handler — blocks `approved` status, and
the schema enforces it.

**Handlers make the error taxonomy data, not engine branching.** Each pairs a match condition
with one of three dispositions:

```jsonc
{ "id": "account_not_found",
  "match": { "kind": "text", "value": "Could not find account" },
  "disposition": { "kind": "business_outcome", "outcome": "account_not_found" } }
```

Three payoffs: a reviewer can see what a capability treats as *normal but not success*;
recovery can never be open-ended (three named remedies, capped attempts); and a tenant can add
a handler for a branded interstitial as an override without forking the flow.

**Business outcomes are open strings; engine failures are a closed enum.** The asymmetry is
deliberate. Outcomes are app-specific and the caller switches on them. Failures are a set the
caller must handle exhaustively, so an artifact may not declare one the result contract cannot
carry.

**Outputs declare how they are obtained**, not just their type — a locator or a variable captured
by an earlier `extract`, plus a coercion and a missing-value policy. Otherwise "typed outputs"
is a comment. `currency` exists because ParaBank renders `-$100.00`, and `parseFloat` of that
is `NaN`.

**Risk is mandatory.** `metadata.risk` has no default. A truncated recorder output must not be
able to execute unattended *by omission*; it fails validation instead. Defaulting to
`approval_required` would be the other fail-closed choice, but it would gate every read-only
lookup and defeat unattended replay.

**Four identity fields** — `capabilityId`, `version`, `derivedFrom`, `appFingerprint` — cost
nothing now and are expensive to retrofit. They are the whole cross-tenant story (§4).

### A parameter can hide in three places

Found by replaying a capability the model had just discovered, not by reading code:

| where | example |
|---|---|
| an action value | `fill` → `{{inputs.amount}}` |
| a **locator name** | `click role=link name={{inputs.accountId}}` |
| a **condition** | `wait for text {{inputs.accountId}}` |

The discovered flow reached an account by clicking a link whose accessible name *is* the account
number. Parameterising only values left a "reusable" capability wired to one account. Both
discovery and replay now handle all three.

---

## 3. Determinism & error handling

### What makes replay deterministic

| | |
|---|---|
| **No model** | Nothing in `replay.ts` can call one. Every run records `modelCalls`, and tests assert `0` on every path |
| **Declared branches only** | Steps in order, handlers with fixed dispositions, one checkpoint |
| **Refusal over guessing** | Exactly one visible match, or the run stops |
| **Waits, never sleeps** | Every wait is on an observable condition with a bounded timeout |
| **Verified, not assumed** | Postconditions prove a step did something; the checkpoint proves the run reached the state it claims |

### The result contract has four statuses

```ts
| { status: "success";          outputs, evidence }
| { status: "business_outcome"; outcome, detail, evidence }
| { status: "escalated";        intervention, evidence }
| { status: "failure";          error, evidence }
```

`escalated` exists because an unattended caller hitting an approval gate has no honest home in
success/outcome/failure. Making it part of the contract is what keeps control transfer a
first-class concept rather than a CLI affordance.

Exit codes let an agent branch without parsing output: `0` success **or** business outcome, `2`
escalated, `1` failure. *A business outcome is not an error* — "no such account" is the answer
the caller asked for.

### Handling runtime conditions

The brief's three categories, and how each is detected:

- **Expected business outcomes** — a handler matches and returns `business_outcome` with detail.
  `account_not_found` fires on ParaBank's own *"Could not find account # 99999"*.
- **Recoverable conditions** — a handler applies one of three remedies (`dismiss`, `retry_step`,
  `reauthenticate`) with a per-handler cap across the whole run, so a remedy that keeps matching
  cannot loop by advancing one step at a time.
- **Hard failures** — a closed error enum with the failing step, what was expected, what was
  observed, attempt count, and a redacted ARIA snapshot.

Handlers are evaluated **before and after every step**. An interstitial that appeared while the
previous step settled has to be dealt with before we act into it, not discovered afterwards as a
confusing timeout.

### Nothing that already succeeded is ever re-run

Re-executing a click that already submitted a transfer submits a second one. Two paths could do
that and both are closed:

- **Recovery.** A handler matching *before* a step retries it. A handler matching *after* a step
  that succeeded continues to the next step.
- **Postconditions.** Polled, so a slow confirmation is waited for. If it still does not hold,
  only actions repeatable without side effect (`navigate`, `wait`, `extract`, `assert`) may be
  retried; a `click`, `fill` or `select` that already succeeded stops the run and reports
  expected-vs-observed.

Both are pinned by fixtures that count submissions. I fixed the first and left the second — a
review caught it.

### On UI drift

Secondary, per the brief. The candidate chain degrades gracefully: ParaBank's login fields carry
no accessible name at all (their labels are sibling `<p>` elements), so `role=textbox` matches
nothing and resolution falls through to CSS. The role candidate stays in the artifact
deliberately — it documents intent and would resolve on a better-behaved build of the same
vendor product. `appFingerprint` plus replay history is the drift signal; acting on it is not
built.

---

## 4. Heterogeneity & multi-tenant

### Surface abstraction

Nothing above `surface.ts` mentions Playwright, CSS, or a browser. `Surface` has eleven
intent-level methods — *click the control whose accessible name is "Transfer"*, *is this text
visible*. The seam between "how we perceive and act" and "the recorded flow" is exactly that
interface.

Observation is a Playwright **ARIA snapshot** — role and accessible name — chosen because it is
the one representation a modern web app, a legacy frameset, and a native desktop app can all
produce. It is visibility-aware by construction and about 4.5KB on ParaBank's overview versus a
full DOM.

That choice paid off in the discovery run: reading roles and names, the model proposed
`role=button name="Log In"` and `role=link name="12678"` on its own, and reached for CSS only on
the two fields that genuinely have no accessible name — exactly the preference order the schema
wants.

**A desktop adapter** implements the same eleven methods over OS accessibility APIs. The
observation it produces is the same shape, and locator candidates are a discriminated union, so
a surface-specific strategy is additive rather than a schema change. A *legacy* web app needs no
adapter at all — ParaBank is server-rendered JSP with framesets' worth of nested tables and no
test IDs, and is the surface this was built against.

The honest limit: a surface with no accessibility tree at all (canvas, custom-rendered
terminals) would need screenshot-plus-coordinates. `Surface.clickAt()` exists for that and
returns what was under the cursor so a durable locator can be derived — but replay refuses
coordinate candidates outright, so such a flow stays a draft needing human review.

### Multi-tenant reuse

`capabilityId` + `version` define a vendor/app-level capability. `baseUrl`, credentials, and
allowed routes resolve from tenant configuration **at invoke time** — `--base-url` is that
resolution point, and the recorded value is only a default.

A tenant needing divergence ships an **override**: extra handlers or extra locator candidates
keyed by step id, with `derivedFrom` recording lineage — not a copied artifact. Because handlers
and candidate chains are both lists, an override is additive.

Drift detection is `appFingerprint` plus replay history: a replay against a different
fingerprint is worth flagging before it silently misbehaves. A tenant-specific fallback is never
silently promoted into the base artifact.

**Not built:** the override resolver, a capability registry, per-tenant credential storage. The
schema fields those need are present; the machinery is not, and building it would be the
premature scaling infrastructure the brief warns against.

One thing this design does *not* solve: a tenant whose vendor build differs enough that the flow
itself changes — an extra confirmation screen, a different navigation path. Candidate chains
absorb relabelled controls, not restructured flows. That case needs a re-record against that
tenant, with `derivedFrom` linking it to the base.

---

## 5. Escalation & handoff

### Detecting "stuck"

Three ways, and they are genuinely different:

- **Discovery** — the model can call `give_up`, which is a first-class tool rather than a
  fallthrough. Making "I am blocked" something it can *choose* is what stops it thrashing at a
  dead end. The first real discovery run did exactly this, and its reasoning is in
  `/evidence/examples/` — it had been told to type a credential placeholder, correctly diagnosed
  that the placeholder was reaching the page literally, and refused both to guess demo
  credentials and to bypass the session check by URL. That was a real bug in my engine, found by
  the model declining to work around it.
- **Replay** — a step classified `approval_required` (inherited from the capability unless
  overridden), or a handler with no viable remedy.
- **Policy** — a risk class the tenant's `requireApprovalFor` says needs a person.

### Taking control of the live session

The request carries capability, goal, step, page title and URL, visible alerts, and a screenshot
taken *before* the handover, so the operator sees the state that caused the stop rather than
whatever the page has become.

**The ownership lock is what makes it a handoff rather than a pause.** `OwnedSurface` refuses
every mutating action while a human holds the session. If automation could still click while a
person types into the same form, control was never transferred and the request is just a
message. Reads stay available, because the engine must observe to take the session back
sensibly.

Ownership changes **before** the request is routed. The resumed state is captured **while the
human still holds it** — a person finishing up is still clicking, and automation must not be
eligible to act until the engine has seen where the page ended up. Control returns even if the
operator channel throws, because a crashed console must not leave a session permanently locked.

### Handing control back

The decision is **three-valued**, not approve/deny:

| answer | effect |
|---|---|
| `p` / `proceed` | automation performs the step |
| `d` / `done` | the human performed it; skip the step, then verify where the session ended up |
| `a` / `abort`, **or anything else** | abort |

A person who takes over usually does not merely *authorise* the step — they perform it.
Collapsing that into "approved" makes automation redo work already done, which on a transfer
means transferring twice.

Only exact tokens are accepted. Prefix matching read *"please abort"* as proceed and *"do not
proceed"* as done — authorising an irreversible transfer from an answer that said the opposite.
Any rule that guesses at intent fails open eventually.

### What the human did

Listeners are installed with `page.addInitScript`, so they re-attach on every document. A
one-off injection dies at the first navigation, and an audit trail that silently stops recording
looks exactly like a person who did nothing.

Events carry the field's identity and the **length** of what was entered, never the characters.
Reading a label off an element is safe for a `<button>` and is what an auditor wants — but on a
`contenteditable` that text *is* what the person typed, so nothing editable contributes its
content. `input` is captured as well as `change` (coalesced), because an edit that never blurs
fires no `change` and would vanish. Written to `human-actions.json`, separate from the event
log.

### The seam, and what is mocked

`CliInterventionChannel` is openly a stand-in — a real deployment routes to a queue and streams
the session to a remote console. Swapping it for a queue consumer changes no other file.

Not a stand-in: ownership genuinely transfers on the same live session, the lock is enforced
rather than advised, the request carries enough context to act on, the human's actions are
recorded, and control comes back with a fresh observation.

---

## 6. Safety

### Guardrails

Enforcement is **three layers**, because no one of them covers the ground:

1. **A guarded surface.** Every action — step loop, dismiss remedy, re-auth callback, output
   collection — passes through it. An action type policy blocks cannot be performed by any
   route.
2. **A browser-level navigation guard.** Aborts document requests to origins outside the
   allowlist. The engine is told "click this link", not where the link goes; a refused
   navigation is `POLICY_DENIED` even when the click succeeded.
3. **A landing check after every action.** A single-page app routes with `history.pushState()`
   and issues no document request, so the network guard never sees it.

Origins are compared exactly and canonically — `bank.test` never matches `bank.test.evil.com`.
The allowlist parser rejects non-`http(s)` schemes, embedded credentials, and anything carrying
a path or query, because `z.url()` cheerfully accepts `javascript:alert(1)`.

`policy` is a **required** argument to `replay()`. A guard that can be forgotten is not a guard,
and the type checker enforces that at every call site.

### Risky and irreversible actions

Classified per step, inherited from the capability when a step does not override. `blocked` is
absolute — no policy can opt into running it. Everything else is policy's decision via
`requireApprovalFor`, so a cautious tenant can gate `safe` and a trusting one can gate nothing.

In `transfer_funds`, only the submit step is `approval_required`: everything before it fills a
form and can be abandoned safely. Classification belongs on the step that moves money.

### Data handling

Redaction happens at the **sink**, so omitting it requires bypassing the recorder. But not every
sink is a string, and each is handled on its own terms:

| sink | treatment |
|---|---|
| events, results, snapshots | JSON through the redactor |
| **screenshots** | masked **at capture time** — a rendered pixel cannot be redacted afterwards |
| **traces** | **off by default**; `--trace` warns and sets `traceUnredacted: true` |

A Playwright trace archives request bodies, cookies and DOM snapshots — on this target
demonstrably including `username=john&password=demo` — and a string redactor cannot reach inside
a zip. The honest options were "off" or "declared", not "claimed safe". The default rich failure
signal is instead a redacted ARIA snapshot, which is text and is the same view the agent reasons
over.

Secrets live in artifacts as **references**, never values. Inputs declared `sensitive` are
masked by *name* in the run record, because the redactor deliberately ignores literals under
three characters — scrubbing every `42` from a log destroys it — and a PIN is exactly that
short.

`test/evidence-secrets.test.ts` scans every byte of every file a run produces. That test exists
because the first version of this claim was made by grepping the JSON files and missing the
archive.

### Limits of the guardrail model

- **Sub-resource requests are unguarded.** Blocking them breaks pages that legitimately load
  assets from elsewhere. The allowlist constrains where the *session* goes, not where *data*
  could go; exfiltration via XHR to an allowed-but-unexpected endpoint is not addressed.
- **Screenshot masking is selector-based.** Sensitive data rendered as body text is captured.
- **A trace, once opted into, is unredacted.** Flagged in the record, not sanitised.
- **Policy is per-run, not per-artifact.** An artifact cannot declare "I need these origins", so
  a mismatch surfaces at step N rather than at validate time.
- **No signing.** Nothing prevents an artifact being edited after review; `status: "approved"`
  is an assertion, not a cryptographic one.

---

## 7. Cuts

### Deliberately not built

**Remote operator console.** The scope note permits mocking it. The control-transfer *model* is
real; the surface is a terminal prompt.

**Desktop surface.** Designed for (§4) and not implemented. The eleven-method port is the seam.

**Multi-tenant machinery.** Schema fields for identity, lineage and drift are present; the
override resolver, registry and credential store are not — that is the scaling infrastructure
the brief says is not rewarded.

**LLM-assisted replay recovery.** Explicitly rejected. A bounded single-step fallback is a
listed stretch goal, but it puts a model back in the production decision loop, and the
determinism claim is worth more than the recovered runs.

**A resumable escalation.** `escalated` returns a `resumeToken` that identifies the run and
step — but there is no `resume <token>` command. An unattended escalation ends the process and
the browser closes. Genuine resumption needs session persistence across processes. **This is
the weakest part of the submission**: the token implies a capability that does not exist.

**Branches, loops, conditionals in artifacts.** v1 is linear. Handlers cover the exceptional
paths that matter without a DAG.

**Discovered handlers.** Discovery records zero. A single happy-path run cannot know how an
application reports "record not found", and inventing handlers would be fiction — which is
partly why discovered artifacts land as `draft`.

### What I would build next, in order

1. **Make `escalated` resumable.** Persist the session so an operator can pick up a run started
   by an unattended agent. It is the gap between a demo and a product.
2. **A replay-stability score gating `draft → approved`.** The artifact has `status`; nothing
   earns the transition. Replay N times, record the rate, promote on evidence.
3. **The tenant override resolver.** Base artifact plus a keyed override map, with `derivedFrom`
   lineage — the fields exist, the merge does not.
4. **Handler suggestion from failed runs.** When a replay fails on unrecognised text, propose a
   handler for review. Discovery cannot know the unhappy paths; production does.
5. **A second surface adapter** — even a crude desktop one — to test whether the port is really
   technology-neutral or merely shaped like Playwright.

### What the process caught

Worth recording, because it is the honest account of how this was built. Reviews caught, among
others: a locator that counted *visible* matches and returned the *first DOM* match; a
postcondition retry that re-submitted transfers; unredacted traces next to a claim that nothing
leaked; policy checks the recovery path routed around; prefix matching that read "please abort"
as consent; and three separate schema fields declared but never wired.

Two were found by the system itself rather than by review: the model's `give_up` diagnosed a
credential-substitution bug in my discovery engine, and replaying a freshly discovered
capability exposed that parameters can hide in locators and conditions, not just values.
