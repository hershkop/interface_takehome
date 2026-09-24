/**
 * Every typed contract in the system lives here: conditions, locators, actions, the capability
 * artifact, handlers, policy, observations, interventions, and run results.
 *
 * One file on purpose. These types are read together — a reviewer assessing the artifact schema
 * should not have to open seven files to see what a step can contain.
 */
import { z } from "zod";

// ─── Conditions ────────────────────────────────────────────────────────────────
//
// Visibility defaults to TRUE and that default is load-bearing. ParaBank ships hidden error
// divs inside healthy pages ("An internal error has occurred" sits in the DOM of every
// successful account view — docs/DAY0-FINDINGS.md §3). A condition that matched raw DOM text
// would fire on every clean run. Matching hidden content is possible but must be deliberate.

export const TextCondition = z.object({
  kind: z.literal("text"),
  value: z.string().min(1),
  visible: z.boolean().default(true),
});

/**
 * Note the absence of a `visible` flag, unlike TextCondition.
 *
 * Role matching resolves against the accessibility tree, and elements hidden with `display:none`,
 * `visibility:hidden`, or `aria-hidden` are not in that tree at all. A `visible: false` here
 * could not do anything — it would be a field that silently never worked. Leaving it out makes
 * the meaningless combination unrepresentable instead of merely ineffective.
 *
 * If you need to assert on hidden content, match its text.
 */
export const RoleCondition = z.object({
  kind: z.literal("role"),
  role: z.string().min(1),
  name: z.string().optional(),
});

export const UrlCondition = z.object({
  kind: z.literal("urlPattern"),
  /** Glob, matched against the full URL. e.g. "**\/activity.htm*" */
  value: z.string().min(1),
});

export const TitleCondition = z.object({
  kind: z.literal("title"),
  value: z.string().min(1),
});

const LeafCondition = z.discriminatedUnion("kind", [
  TextCondition,
  RoleCondition,
  UrlCondition,
  TitleCondition,
]);
export type LeafCondition = z.infer<typeof LeafCondition>;

/**
 * Checkpoints usually need more than one clause ("confirmation heading visible AND no error
 * banner"), so conditions compose. Recursion is kept to two combinators — `all` and `not` —
 * because a checkpoint that needs more than that is a sign the flow should be split.
 */
export type Condition =
  | LeafCondition
  | { kind: "all"; conditions: Condition[] }
  | { kind: "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    LeafCondition,
    z.object({ kind: z.literal("all"), conditions: z.array(Condition).min(1) }),
    /**
     * `any` was deliberately left out of the first cut and added when a real flow needed it:
     * after navigating to an account, the page settles into EITHER the detail screen or the
     * not-found screen. Waiting only for the detail screen would burn the whole timeout on the
     * not-found path before the handlers ever got to classify it — turning a legitimate
     * business outcome into a timeout. Waiting for "either screen has settled" is the honest
     * condition, and it needs a disjunction.
     */
    z.object({ kind: z.literal("any"), conditions: z.array(Condition).min(1) }),
    z.object({ kind: z.literal("not"), condition: Condition }),
  ]),
);

// ─── Locators ──────────────────────────────────────────────────────────────────
//
// A target is an ORDERED candidate list, never a single selector and never a raw model-assigned
// element reference. Replay walks the list and requires exactly one visible match; zero matches
// and ambiguous matches are both failures. Ordering encodes the robustness preference:
// accessible role+name → label → visible text → stable id/name → structural CSS → coordinates.

export const LocatorCandidate = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("role"),
    role: z.string().min(1),
    name: z.string().min(1),
    exact: z.boolean().default(false),
  }),
  z.object({ strategy: z.literal("label"), value: z.string().min(1) }),
  z.object({ strategy: z.literal("text"), value: z.string().min(1) }),
  z.object({ strategy: z.literal("testId"), value: z.string().min(1) }),
  z.object({ strategy: z.literal("css"), value: z.string().min(1) }),
  /**
   * Coordinates are a discovery fallback only. Any artifact containing one cannot leave
   * `status: "draft"` — enforced in CapabilityArtifact's refinement below.
   */
  z.object({ strategy: z.literal("coordinates"), x: z.number(), y: z.number() }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

export const Target = z.object({
  /** Human-readable, for review and for error messages. Not used for matching. */
  description: z.string().optional(),
  candidates: z.array(LocatorCandidate).min(1),
});
export type Target = z.infer<typeof Target>;

// ─── Values and coercion ───────────────────────────────────────────────────────

/** `{{inputs.accountId}}` / `{{secrets.password}}` / `{{vars.capturedBalance}}` or a literal. */
export const TemplateString = z.string();

export const Coercion = z.enum(["trim", "currency", "int", "number"]);
export type Coercion = z.infer<typeof Coercion>;

// ─── Actions ───────────────────────────────────────────────────────────────────

export const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: TemplateString }),
  z.object({ action: z.literal("click"), target: Target }),
  z.object({ action: z.literal("fill"), target: Target, value: TemplateString }),
  z.object({ action: z.literal("select"), target: Target, value: TemplateString }),
  z.object({ action: z.literal("wait"), condition: Condition, timeoutMs: z.number().int().positive().default(10_000) }),
  z.object({
    action: z.literal("extract"),
    target: Target,
    /** Name this lands under in the run's variable bag, referenced as {{vars.<name>}}. */
    as: z.string().min(1),
    attribute: z.string().optional(),
    coerce: Coercion.optional(),
  }),
  z.object({ action: z.literal("assert"), condition: Condition }),
]);
export type Action = z.infer<typeof Action>;

export const ActionType = z.enum([
  "navigate", "click", "fill", "select", "wait", "extract", "assert",
]);
export type ActionType = z.infer<typeof ActionType>;

// ─── Engine error codes ────────────────────────────────────────────────────────
//
// Defined here, above the handlers that reference them, so an artifact cannot declare a failure
// the result contract is unable to represent. Business outcomes are open strings (they are
// app-specific and the caller switches on them); engine failures are a closed set, because the
// caller has to be able to handle every one of them.

export const ErrorCode = z.enum([
  "TARGET_NOT_FOUND",
  "TARGET_AMBIGUOUS",
  "STEP_TIMEOUT",
  "CHECKPOINT_FAILED",
  "POLICY_DENIED",
  "APP_ERROR",
  "HUMAN_ABORTED",
  /**
   * Caller supplied inputs the capability does not accept. PR1 dropped this on the reasoning
   * that it is caught before the run starts — which is true, and beside the point: being
   * rejected early still has to be *reported*, and reporting it as APP_ERROR would blame the
   * application for the caller's mistake.
   */
  "INPUT_INVALID",
  /** The artifact itself does not satisfy the schema. Distinct from a bad invocation. */
  "ARTIFACT_INVALID",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

// ─── Risk ──────────────────────────────────────────────────────────────────────

export const RiskClass = z.enum(["safe", "approval_required", "blocked"]);
export type RiskClass = z.infer<typeof RiskClass>;

// ─── Handlers: the outcome / error model ───────────────────────────────────────
//
// The brief's central distinction is between an expected business outcome, a recoverable
// condition, and a hard failure. That distinction is DATA in the artifact, not branching in the
// engine, for three reasons:
//   1. A reviewer can see what a capability treats as "normal but not success".
//   2. Recovery can never be open-ended — a remedy is one of three named verbs with a cap.
//   3. A tenant running a differently-branded build of the same app can add a handler as an
//      override without forking the flow.
// Handlers are evaluated before AND after every step, not only at the end.

const MaxAttempts = z.number().int().min(1).max(5).default(1);

/**
 * Keyed by `remedy` rather than carrying an optional target for every variant, so that
 * `dismiss` — the only remedy that needs to know what to click — cannot be written without one.
 * A recovery instruction the interpreter cannot deterministically execute should not parse.
 */
export const RecoverDisposition = z.discriminatedUnion("remedy", [
  z.object({
    kind: z.literal("recover"),
    remedy: z.literal("dismiss"),
    target: Target,
    maxAttempts: MaxAttempts,
  }),
  z.object({ kind: z.literal("recover"), remedy: z.literal("retry_step"), maxAttempts: MaxAttempts }),
  z.object({
    kind: z.literal("recover"),
    remedy: z.literal("reauthenticate"),
    maxAttempts: MaxAttempts,
  }),
]);

export const HandlerDisposition = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("business_outcome"),
    /** Machine-readable name the caller switches on, e.g. "account_not_found". */
    outcome: z.string().min(1),
    detail: z.record(z.string(), z.string()).optional(),
  }),
  RecoverDisposition,
  /** Closed set: an artifact must not declare a failure RunError cannot carry. */
  z.object({ kind: z.literal("fail"), code: ErrorCode }),
]);
export type HandlerDisposition = z.infer<typeof HandlerDisposition>;

export const Handler = z.object({
  id: z.string().min(1),
  match: Condition,
  /** "global" = checked around every step. Otherwise only around the listed step ids. */
  scope: z.union([z.literal("global"), z.array(z.string().min(1)).min(1)]).default("global"),
  disposition: HandlerDisposition,
  note: z.string().optional(),
});
export type Handler = z.infer<typeof Handler>;

// ─── Inputs and outputs: the callable contract ─────────────────────────────────

export const InputDefinition = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  required: z.boolean().default(true),
  pattern: z.string().optional(),
  default: z.unknown().optional(),
  /** Redact this value everywhere it would otherwise be logged or screenshotted. */
  sensitive: z.boolean().default(false),
}).superRefine((input, ctx) => {
  // Otherwise an artifact validates, then dies at execution time when an omitted input falls
  // back to a default of the wrong type.
  if (input.default === undefined) return;
  const actual = typeof input.default;
  if (actual !== input.type) {
    ctx.addIssue({
      code: "custom",
      message: `default for a "${input.type}" input is a ${actual}`,
      path: ["default"],
    });
  }
});
export type InputDefinition = z.infer<typeof InputDefinition>;

/**
 * Outputs declare HOW they are obtained, not just their type — otherwise "typed outputs" is
 * aspirational. Either read from the page at the end, or from a variable an `extract` step
 * captured earlier (necessary when the flow navigates away from where the value was visible).
 */
export const OutputSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("locator"), target: Target, attribute: z.string().optional() }),
  z.object({ kind: z.literal("variable"), name: z.string().min(1) }),
]);

/** What each coercion actually produces. A declaration that disagrees is a lie in the contract. */
const COERCION_YIELDS: Record<string, "string" | "number"> = {
  trim: "string",
  currency: "number",
  int: "number",
  number: "number",
};

export const OutputDefinition = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    description: z.string().optional(),
    source: OutputSource,
    coerce: Coercion.optional(),
    /** A missing output is usually a bug, so failing is the default. */
    onMissing: z.enum(["fail", "null"]).default("fail"),
  })
  .superRefine((output, ctx) => {
    // `currency` returns a number whatever the declaration says, so an output declared
    // `string` with `coerce: "currency"` advertises a type it will never return — and the
    // catalog repeats that lie to every calling agent. Caught here rather than in the
    // recorder, so a hand-authored artifact cannot make the same mistake.
    if (!output.coerce) return;
    const produced = COERCION_YIELDS[output.coerce];
    if (produced && produced !== output.type) {
      ctx.addIssue({
        code: "custom",
        message: `coerce "${output.coerce}" produces a ${produced}, but the output is declared ${output.type}`,
        path: ["type"],
      });
    }
  });
export type OutputDefinition = z.infer<typeof OutputDefinition>;

// ─── Steps ─────────────────────────────────────────────────────────────────────

export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  delayMs: z.number().int().min(0).max(10_000).default(500),
});

export const ArtifactStep = z.object({
  id: z.string().min(1),
  action: Action,
  /** Asserted after the action. This is what makes a click *verified* rather than assumed. */
  postcondition: Condition.optional(),
  /** Overrides the capability-level risk for this step. */
  risk: RiskClass.optional(),
  retry: RetryPolicy.optional(),
  /** Why the model took this step. Carried for review; never used for control flow. */
  rationale: z.string().optional(),
});
export type ArtifactStep = z.infer<typeof ArtifactStep>;

// ─── The capability artifact ───────────────────────────────────────────────────

/** Shape of an artifact before refinement — what the traversal helper below walks. */
type ArtifactShape = {
  steps: ArtifactStep[];
  outputs: Record<string, OutputDefinition>;
  handlers: Handler[];
};

/**
 * Every place a Target can appear, in one place. Any rule about targeting (today: coordinates
 * block approval) applies uniformly rather than to whichever locations someone remembered.
 */
export function collectTargets(artifact: ArtifactShape): Array<{ where: string; target: Target }> {
  const found: Array<{ where: string; target: Target }> = [];

  for (const [i, step] of artifact.steps.entries()) {
    if ("target" in step.action) {
      found.push({ where: `steps[${i}] "${step.id}"`, target: step.action.target });
    }
  }
  for (const [name, output] of Object.entries(artifact.outputs)) {
    if (output.source.kind === "locator") {
      found.push({ where: `outputs.${name}`, target: output.source.target });
    }
  }
  for (const handler of artifact.handlers) {
    const d = handler.disposition;
    if (d.kind === "recover" && d.remedy === "dismiss") {
      found.push({ where: `handlers.${handler.id}`, target: d.target });
    }
  }
  return found;
}
// ─── The capability artifact ───────────────────────────────────────────────────

export const CapabilityArtifact = z
  .object({
    schemaVersion: z.literal("1.0"),

    /** Stable across revisions — what a calling agent invokes by. */
    capabilityId: z.string().regex(/^[a-z][a-z0-9_]*$/, "lower_snake_case"),
    /** Semver of THIS capability's flow. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Set when this artifact specialises another (e.g. a per-tenant override). */
    derivedFrom: z
      .object({ capabilityId: z.string(), version: z.string() })
      .optional(),

    metadata: z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      status: z.enum(["draft", "approved"]).default("draft"),
      /**
       * Required, with no default. A recorder bug or a truncated generated artifact must not be
       * able to produce something that executes unattended by omission. Defaulting to
       * `approval_required` instead would be the other fail-closed choice, but it would put a
       * human in front of every read-only lookup and defeat the unattended replay path — so the
       * classification is simply mandatory. Step-level `risk` stays optional and inherits this.
       */
      risk: RiskClass,
      recordedAt: z.iso.datetime(),
      recordedBy: z.enum(["llm", "human"]),
      /** Present when recordedBy === "llm". Kept for provenance, not for replay. */
      model: z.string().optional(),
    }),

    target: z.object({
      app: z.string().min(1),
      /**
       * Observed version/branding marker. Not used for matching — it is the drift signal:
       * a replay against a different fingerprint is worth flagging before it silently misbehaves.
       */
      appFingerprint: z.string().optional(),
      /** Resolved from tenant config at invoke time; the recorded value is only a default. */
      baseUrl: z.string().url(),
    }),

    inputs: z.record(z.string(), InputDefinition).default({}),
    outputs: z.record(z.string(), OutputDefinition).default({}),
    steps: z.array(ArtifactStep).min(1),
    handlers: z.array(Handler).default([]),
    /** Asserted at the end. Without this, "it replayed" only means "nothing threw". */
    checkpoint: Condition,
  })
  .superRefine((artifact, ctx) => {
    const seen = new Set<string>();
    for (const step of artifact.steps) {
      if (seen.has(step.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate step id: ${step.id}`, path: ["steps"] });
      }
      seen.add(step.id);
    }

    for (const handler of artifact.handlers) {
      if (handler.scope === "global") continue;
      for (const stepId of handler.scope) {
        if (!seen.has(stepId)) {
          ctx.addIssue({
            code: "custom",
            message: `handler "${handler.id}" scopes to unknown step "${stepId}"`,
            path: ["handlers"],
          });
        }
      }
    }

    // Outputs sourced from a variable need a step that actually captures it.
    const captured = new Set(
      artifact.steps.flatMap((s) => (s.action.action === "extract" ? [s.action.as] : [])),
    );
    for (const [name, output] of Object.entries(artifact.outputs)) {
      if (output.source.kind === "variable" && !captured.has(output.source.name)) {
        ctx.addIssue({
          code: "custom",
          message: `output "${name}" reads {{vars.${output.source.name}}} but no extract step sets it`,
          path: ["outputs"],
        });
      }
    }

    // Coordinates are inherently unreviewable. An artifact holding one anywhere stays a draft.
    // Checking only steps would miss output locators and dismiss-handler targets, which are
    // just as much part of what replay executes.
    if (artifact.metadata.status === "approved") {
      for (const { where, target } of collectTargets(artifact)) {
        if (target.candidates.some((c) => c.strategy === "coordinates")) {
          ctx.addIssue({
            code: "custom",
            message:
              `coordinate targeting at ${where} cannot be approved for unattended replay`,
            path: ["metadata", "status"],
          });
        }
      }
    }
  });
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

// ─── Policy ────────────────────────────────────────────────────────────────────
//
// `z.url()` is far too permissive for a safety boundary: it accepts `javascript:alert(1)`,
// `data:` URLs, embedded credentials, and full paths with query strings. An allowlist entry has
// to be a canonical HTTP(S) origin and nothing else, so it is parsed and normalised here.

export const HttpOrigin = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: `not a URL: ${value}` });
    return z.NEVER;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: `origin must be http(s), got ${url.protocol}` });
    return z.NEVER;
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: "custom", message: "origin must not embed credentials" });
    return z.NEVER;
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    ctx.addIssue({
      code: "custom",
      message: `origin must not carry a path, query, or fragment: ${value}`,
    });
    return z.NEVER;
  }
  return url.origin;
});

export const Policy = z.object({
  allowedOrigins: z.array(HttpOrigin).min(1),
  /** Globs matched against pathname. Empty = any path under an allowed origin. */
  allowedPaths: z.array(z.string()).default([]),
  allowedActions: z.array(ActionType).default([...ActionType.options]),
  blockedActions: z.array(ActionType).default([]),
  /** Steps whose risk resolves to this class escalate instead of executing. */
  requireApprovalFor: z.array(RiskClass).default(["approval_required"]),
  /**
   * Regexes matched against a control's accessible name, description, or selector.
   *
   * Replay learns an action's risk from the artifact. Discovery has no artifact yet — it is
   * producing one — so without this it has no way to know that the button it is about to click
   * moves money. An exploring model operating a bank's back office must not be able to commit
   * an irreversible transaction because nobody had written the flow down yet.
   *
   * A match classifies the proposed action `approval_required`, which then goes through exactly
   * the same gate replay uses.
   */
  riskyControls: z
    .array(z.string())
    .default([])
    .superRefine((patterns, ctx) => {
      for (const [index, pattern] of patterns.entries()) {
        try {
          new RegExp(pattern, "i");
        } catch (err) {
          ctx.addIssue({
            code: "custom",
            message: `riskyControls[${index}] is not a valid regular expression: ${
              err instanceof Error ? err.message : String(err)
            }`,
            path: [index],
          });
        }
      }
    }),
  maxSteps: z.number().int().positive().default(40),
  runTimeoutMs: z.number().int().positive().default(300_000),
  /**
   * Extra regexes scrubbed from logs and evidence, on top of the built-ins.
   *
   * Validated here, at policy load, rather than where redaction happens. A malformed pattern
   * that is merely skipped at runtime fails OPEN: the tenant believes a value is being scrubbed
   * and it is written verbatim instead. A redaction rule that cannot compile has to stop the
   * run, not be quietly ignored.
   */
  redactPatterns: z
    .array(z.string())
    .default([])
    .superRefine((patterns, ctx) => {
      for (const [index, pattern] of patterns.entries()) {
        try {
          new RegExp(pattern);
        } catch (err) {
          ctx.addIssue({
            code: "custom",
            message: `redactPattern[${index}] is not a valid regular expression: ${
              err instanceof Error ? err.message : String(err)
            }`,
            path: [index],
          });
        }
      }
    }),
});
export type Policy = z.infer<typeof Policy>;

// ─── Observation (discovery input) ─────────────────────────────────────────────

export const Observation = z.object({
  url: z.string(),
  title: z.string(),
  /** Playwright ARIA snapshot — role+name tree, visibility-aware. The primary signal. */
  ariaSnapshot: z.string(),
  screenshot: z.string().optional(),
  /** Visible alerts / validation messages, lifted out so the model cannot miss them. */
  alerts: z.array(z.string()).default([]),
  step: z.number().int().nonnegative(),
});
export type Observation = z.infer<typeof Observation>;

// ─── Human escalation ──────────────────────────────────────────────────────────

export const InterventionReason = z.enum(["approval_required", "agent_stuck", "replay_blocked"]);
export type InterventionReason = z.infer<typeof InterventionReason>;

export const InterventionRequest = z.object({
  interventionId: z.string().min(1),
  runId: z.string().min(1),
  capabilityId: z.string().optional(),
  goal: z.string().optional(),
  step: z.object({ id: z.string(), index: z.number().int() }).optional(),
  reason: InterventionReason,
  message: z.string(),
  screenshot: z.string().optional(),
  observedState: z.record(z.string(), z.unknown()).default({}),
  requestedAt: z.iso.datetime(),
});
export type InterventionRequest = z.infer<typeof InterventionRequest>;

export const SessionOwner = z.enum(["automation", "human"]);
export type SessionOwner = z.infer<typeof SessionOwner>;

// ─── Run results ───────────────────────────────────────────────────────────────

export const RunError = z.object({
  code: ErrorCode,
  message: z.string(),
  step: z.object({ id: z.string(), index: z.number().int() }).optional(),
  recoverable: z.boolean().default(false),
  expected: z.string().optional(),
  /** Already passed through the redactor. */
  observed: z.string().optional(),
  attempts: z.number().int().min(1).default(1),
});
export type RunError = z.infer<typeof RunError>;

export const EvidenceSummary = z.object({
  runId: z.string(),
  directory: z.string(),
  eventLog: z.string(),
  trace: z.string().optional(),
  /**
   * True when a raw Playwright trace was written. Traces capture request bodies, cookies, and
   * DOM snapshots, and the redactor cannot reach inside the archive — so producing one is an
   * explicit opt-in and the run record says so rather than leaving it implied.
   */
  traceUnredacted: z.boolean().default(false),
  screenshots: z.array(z.string()).default([]),
  /** Redacted ARIA/URL/alert capture written on failure. The default rich failure signal. */
  failureSnapshot: z.string().optional(),
  /** Present when a human held the session during this run. */
  humanActions: z.string().optional(),
  /**
   * Replay asserts this is 0. It turns "no LLM in the decision loop" from a claim in the
   * write-up into a fact in the run record.
   */
  modelCalls: z.number().int().min(0),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummary>;

/**
 * Four statuses, not three. `escalated` exists because an unattended caller hitting an
 * approval gate has no honest home in success/outcome/failure — and making it part of the
 * result contract is what keeps control transfer a first-class concept rather than a CLI detail.
 */
export const RunResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    outputs: z.record(z.string(), z.unknown()),
    evidence: EvidenceSummary,
  }),
  z.object({
    status: z.literal("business_outcome"),
    outcome: z.string(),
    detail: z.record(z.string(), z.unknown()).default({}),
    evidence: EvidenceSummary,
  }),
  z.object({
    status: z.literal("escalated"),
    intervention: z.object({
      interventionId: z.string(),
      reason: InterventionReason,
      /** Presented back to resume this run on the same live session. */
      resumeToken: z.string(),
    }),
    evidence: EvidenceSummary,
  }),
  z.object({
    status: z.literal("failure"),
    error: RunError,
    evidence: EvidenceSummary,
  }),
]);
export type RunResult = z.infer<typeof RunResult>;
