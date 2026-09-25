/**
 * Deterministic replay — the production execution path.
 *
 * Given an artifact and a set of inputs, this runs the recorded flow with no model in the
 * decision loop and returns one of four results. It is the half of the system an AI agent
 * actually invokes; discovery exists only to produce its input.
 *
 * Three properties define it:
 *
 *   Nothing is decided at runtime. Every branch the engine can take is declared in the
 *   artifact — steps in order, handlers with fixed dispositions, one checkpoint. There is no
 *   path here that consults a model, and the evidence record proves it by counting.
 *
 *   A refusal is better than a guess. A target that does not resolve to exactly one visible
 *   element stops the run. In a back-office banking app, acting on the wrong control is worse
 *   than not acting.
 *
 *   "Not found" is an answer, not a crash. The distinction between an expected business
 *   outcome, a recoverable condition, and a hard failure is carried by the artifact's handlers,
 *   so this file classifies rather than interprets.
 */
import {
  CapabilityArtifact,
  type ArtifactStep,
  type Condition,
  type ErrorCode,
  type Handler,
  type OutputDefinition,
  type Policy,
  type Target,
  type RiskClass,
  type RunError,
  type RunResult,
} from "./schema.js";
import { EvidenceRecorder, newRunId, type EvidenceEvent } from "./evidence.js";
import { GuardedSurface, PolicyGuard } from "./safety.js";
import {
  OwnedSurface,
  SessionController,
  type HumanEvent,
  type InterventionChannel,
} from "./handoff.js";
import { createRedactor, type Redactor } from "./redact.js";
import {
  PlaywrightSurface,
  closeSurface,
  describeCondition,
  type Surface,
  type SurfaceFactory,
} from "./surface.js";
import {
  coerce,
  coerceInput,
  isSensitiveSecretKey,
  resolveConditionTemplates,
  resolveTargetTemplates,
  resolveTemplate,
  TemplateError,
  type TemplateScope,
} from "./template.js";

export interface ReplayOptions {
  artifact: unknown;
  inputs: Record<string, unknown>;
  secrets?: Record<string, string>;
  /** Overrides the artifact's recorded baseUrl. This is the per-tenant resolution point. */
  baseUrl?: string;
  headed?: boolean;
  trace?: "off" | "unredacted";
  evidenceRoot?: string;
  stepTimeoutMs?: number;
  /** How long a step's postcondition is polled for before it counts as unmet. */
  postconditionTimeoutMs?: number;
  /** Point at a specific Chromium build. */
  executablePath?: string;
  /**
   * How to obtain a surface. Defaults to a browser.
   *
   * This is the seam a non-web surface plugs into. Nothing below it — the step loop, handlers,
   * policy, the ownership lock, evidence — knows or cares what it got back.
   */
  createSurface?: SurfaceFactory;
  /** Watch events as they are recorded. The console streams these to a browser. */
  onEvent?: (event: EvidenceEvent) => void;
  /**
   * Enforced for the whole run. Omitting it is not "no policy" — the caller must supply one,
   * because a guard that can be forgotten is not a guard.
   */
  policy: Policy;
  /**
   * Where an intervention is routed. With no channel, a step needing a human returns
   * `escalated` rather than pretending it could proceed — which is the correct behaviour for an
   * unattended caller, not a limitation.
   */
  interventionChannel?: InterventionChannel;
  /** Carried into the intervention request so an operator knows what was being attempted. */
  goal?: string;
  /**
   * How to re-authenticate when a handler's remedy calls for it. Login is itself a UI flow and
   * differs per application, so the engine does not invent one — an artifact that declares the
   * remedy without a provider fails loudly instead of silently continuing logged out.
   */
  reauthenticate?: (
    /** Policy-guarded: a login routine cannot type or click outside what policy permits. */
    surface: Surface,
    /**
     * Invocation-scoped, not process-scoped. A callback that reached for global configuration
     * would re-authenticate against the DEFAULT tenant after a session expiry, and the run
     * would then continue — silently — against the wrong institution's data.
     */
    context: { baseUrl: string; secrets: Record<string, string> },
  ) => Promise<boolean>;
}

/** Everything the engine needs while a run is in flight. */
interface RunContext {
  /** Policy-guarded. Everything that drives the browser goes through this. */
  surface: Surface;

  recorder: EvidenceRecorder;
  scope: TemplateScope;
  redact: Redactor;
  stepTimeoutMs: number;
  options: ReplayOptions;
  /** Per-handler recovery attempts, so a cap is enforced across the whole run. */
  recoveryAttempts: Map<string, number>;
  /** Inherited by any step that does not declare its own risk. */
  capabilityRisk: RiskClass;
  /** How long a postcondition is polled before it is treated as unmet. */
  postconditionTimeoutMs: number;
  guard: PolicyGuard;
  controller: SessionController | undefined;
  capabilityId: string;
  goal: string | undefined;
}

type StepDisposition =
  | { kind: "continue" }
  | { kind: "retry" }
  | { kind: "terminate"; result: TerminalOutcome };

type TerminalOutcome =
  | { kind: "business_outcome"; outcome: string; detail: Record<string, unknown> }
  | { kind: "failure"; error: RunError }
  | { kind: "escalated"; stepId: string; stepIndex: number };

export async function replay(options: ReplayOptions): Promise<RunResult> {
  // ── Validate before anything expensive happens ──────────────────────────────
  //
  // Artifact and inputs are checked before a browser launches. A bad invocation should cost
  // milliseconds and produce a precise message, not a timeout three steps into a live session.
  const parsed = CapabilityArtifact.safeParse(options.artifact);
  if (!parsed.success) {
    return earlyFailure(
      "ARTIFACT_INVALID",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const artifact = parsed.data;

  const secrets = options.secrets ?? {};
  const inputs = validateInputs(artifact.inputs, options.inputs);
  if ("error" in inputs) return earlyFailure("INPUT_INVALID", inputs.error);

  const missingSecret = missingSecretReference(artifact, secrets);
  if (missingSecret) return earlyFailure("INPUT_INVALID", missingSecret);

  // ── Redaction is configured from secrets AND from inputs declared sensitive ──
  //
  // Secrets are matched by key name, because "username" is not worth scrubbing. Inputs are
  // matched by DECLARATION: an artifact author who writes `sensitive: true` has said this value
  // is regulated, and that statement has to actually do something — otherwise the field is a
  // promise the system does not keep, which is worse than not offering it.
  const sensitiveInputNames = Object.entries(artifact.inputs)
    .filter(([, definition]) => definition.sensitive)
    .map(([name]) => name);

  const sensitiveInputValues = sensitiveInputNames
    .map((name) => inputs.values[name])
    .filter((value): value is string | number => value !== undefined && value !== null)
    .map(String);

  const guard = new PolicyGuard(options.policy);

  const fits = guard.checkArtifactFits(artifact.steps.length);
  if (!fits.allowed) return earlyFailure("POLICY_DENIED", fits.reason ?? "artifact exceeds policy");

  const redact = createRedactor({
    // Policy-configured patterns extend the built-ins rather than replacing them, so a tenant
    // can add its own identifier formats without giving up API-key or SSN scrubbing.
    patterns: options.policy.redactPatterns,
    literals: [
      ...Object.entries(secrets)
        .filter(([key]) => isSensitiveSecretKey(key))
        .map(([, value]) => value),
      ...sensitiveInputValues,
    ],
  });

  const runId = newRunId("replay");
  const recorder = new EvidenceRecorder({
    runId,
    phase: "replay",
    redact,
    ...(options.evidenceRoot ? { rootDir: options.evidenceRoot } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  const baseUrl = options.baseUrl ?? artifact.target.baseUrl;
  await recorder.writeRunHeader({
    // The whole normalised policy. A partial record cannot answer "why was this allowed?" —
    // which is the only question the record exists to answer. It passes through the redactor
    // like everything else, so a pattern that embeds a literal secret is still scrubbed.
    policy: options.policy,
    capabilityId: artifact.capabilityId,
    capabilityVersion: artifact.version,
    artifactStatus: artifact.metadata.status,
    risk: artifact.metadata.risk,
    baseUrl,
    // Masked by NAME, not by matching the value.
    //
    // Literal substitution alone is not enough here: the redactor deliberately ignores literals
    // shorter than three characters, because scrubbing every "42" out of a log destroys it. A
    // PIN declared sensitive is exactly that short, and would have been written verbatim. An
    // explicit declaration deserves a mechanism that does not depend on the value's length or
    // on it coincidentally matching a pattern.
    inputs: maskSensitive(inputs.values, sensitiveInputNames),
    startedAt: new Date().toISOString(),
  });

  let surface: Surface | undefined;
  let terminal: TerminalOutcome | undefined;
  let outputs: Record<string, unknown> | undefined;
  let controller: SessionController | undefined;
  const humanEvents: HumanEvent[] = [];

  try {
    // Launching is inside the guarded lifecycle. A missing browser binary or a failed context
    // is exactly the kind of thing a caller consuming --json must receive as a structured
    // failure, not as an unhandled rejection.
    const launch: SurfaceFactory = options.createSurface ?? PlaywrightSurface.launch;
    surface = await launch({
      ...(options.headed === undefined ? {} : { headed: options.headed }),
      trace: options.trace ?? "off",
      traceDir: recorder.directory,
      defaultTimeoutMs: options.stepTimeoutMs ?? 10_000,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      navigationAllowed: guard.navigationAllowed,
      onHumanEvent: (raw) => {
        // Recorded only while a human actually holds the session; automation's own clicks fire
        // the same listeners and are not "human events".
        if (controller?.owner !== "human") return;
        const event: HumanEvent = { at: new Date().toISOString(), ...raw };
        humanEvents.push(event);
        controller.noteHumanEvent(event);
        void recorder.event({ type: "human.action", detail: { ...event } });
      },
    });

    if (options.interventionChannel) {
      const live = surface;
      controller = new SessionController(options.interventionChannel, {
        observe: () => live.observe(0),
        screenshot: async (label) => recorder.screenshot(await live.screenshot(), label),
        record: (type, detail) => recorder.event({ type, detail }),
      });
    }

    const guardedSurface = new GuardedSurface(surface, guard, (reason) => {
      void recorder.event({ type: "policy.denied", detail: { reason } });
    });

    // Ownership is checked OUTSIDE policy: if a person is driving, no question about what
    // policy would have permitted is even asked.
    const activeSurface = controller
      ? new OwnedSurface(guardedSurface, controller)
      : guardedSurface;

    const context: RunContext = {
      surface: activeSurface,
      recorder,
      redact,
      scope: { baseUrl, inputs: inputs.values, secrets, vars: {} },
      stepTimeoutMs: options.stepTimeoutMs ?? 10_000,
      options,
      recoveryAttempts: new Map(),
      postconditionTimeoutMs: options.postconditionTimeoutMs ?? 10_000,
      // Steps inherit the capability's classification unless they override it. Without this,
      // a capability marked approval_required executed unattended whenever its steps happened
      // not to restate the risk — which is the documented inheritance rule doing nothing.
      capabilityRisk: artifact.metadata.risk,
      guard,
      controller,
      capabilityId: artifact.capabilityId,
      goal: options.goal,
    };

    guard.begin();

    // A true wall-clock ceiling needs three things, because checking between steps is not one.
    //
    //   The guarded surface refuses any action once the deadline has passed, and clamps every
    //   wait to the remaining budget, so the common case never overruns.
    //
    //   The step loop checks between steps, which catches a chain of cheap operations.
    //
    //   This race is the backstop for the case neither covers: one operation that blocks longer
    //   than the whole budget — a locator resolving against a hung page, a postcondition poll, a
    //   remedy that stalls. Without it, `runTimeoutMs` is advisory.
    terminal = await withDeadline(
      runSteps(artifact.steps, artifact.handlers, context),
      guard.remainingMs(),
      () => ({
        kind: "failure" as const,
        error: {
          code: "POLICY_DENIED" as const,
          message: `run exceeded the policy timeout of ${options.policy.runTimeoutMs}ms`,
          recoverable: false,
          attempts: 1,
        },
      }),
    );

    if (!terminal) {
      // Outputs are read before the checkpoint, so a failed checkpoint can still report what
      // the page actually said — which is usually the thing that explains the failure.
      const collected = await collectOutputs(artifact.outputs, context);
      if ("error" in collected) {
        terminal = { kind: "failure", error: collected.error };
      } else {
        const ok = await context.surface.verify(
          resolveConditionTemplates(artifact.checkpoint, context.scope),
        );
        await recorder.event({
          type: ok ? "checkpoint.ok" : "checkpoint.failed",
          detail: { condition: describeCondition(artifact.checkpoint) },
        });
        if (ok) {
          outputs = collected.values;
        } else {
          await captureFailureContext(context, "checkpoint");
          terminal = {
            kind: "failure",
            error: {
              code: "CHECKPOINT_FAILED",
              message: `checkpoint not satisfied: ${describeCondition(artifact.checkpoint)}`,
              recoverable: false,
              expected: describeCondition(artifact.checkpoint),
              observed: redact(`url=${context.surface.currentUrl()}`),
              attempts: 1,
            },
          };
        }
      }
    }
  } catch (err) {
    terminal = {
      kind: "failure",
      error: {
        code: "APP_ERROR",
        message: redact(err instanceof Error ? err.message : String(err)),
        recoverable: false,
        attempts: 1,
      },
    };
  } finally {
    // Unprotected, a rejecting close() threw out of the finally — losing the result that had
    // already been computed and skipping recorder.finish() entirely. A run that produced typed
    // outputs and verified its checkpoint genuinely succeeded; failing to shut the surface down
    // afterwards is a different problem, and is recorded as one rather than replacing the
    // answer the caller asked for.
    if (surface) {
      const closed = await closeSurface(surface);
      if (closed.ok) {
        if (closed.trace) recorder.setTrace(closed.trace);
      } else {
        await recorder
          .event({ type: "surface.teardown_failed", detail: { reason: redact(closed.reason) } })
          .catch(() => {});
      }
    }
  }

  // Every terminal result is assembled AFTER the surface is closed, so the evidence summary can
  // see the trace that closing produced. Building the success result inside the try meant a
  // successful --trace run reported traceUnredacted: false next to a trace.zip that existed.
  if (humanEvents.length > 0) {
    await recorder.writeHumanActions(humanEvents);
  }

  const result: RunResult =
    outputs !== undefined
      ? { status: "success", outputs, evidence: recorder.summary() }
      : toRunResult(terminal ?? unexpectedTerminal(), recorder);

  await recorder.finish(result);
  return result;
}



/**
 * Resolves the work, or the timeout value if the budget runs out first.
 *
 * The losing promise is not cancelled — there is no safe way to abort a Playwright call
 * mid-flight — but the run stops waiting on it and the surface is closed in the caller's
 * `finally`, which tears down whatever it was doing.
 */
async function withDeadline<T>(
  work: Promise<T>,
  budgetMs: number,
  onTimeout: () => T,
): Promise<T> {
  if (budgetMs <= 0) return onTimeout();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), budgetMs);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Replaces declared-sensitive values with a marker, regardless of their length or shape. */
function maskSensitive(
  values: Record<string, unknown>,
  sensitiveNames: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const name of sensitiveNames) {
    if (name in out) out[name] = "[REDACTED]";
  }
  return out;
}

/** Defensive: `terminal` is set on every path that does not produce outputs. */
function unexpectedTerminal(): TerminalOutcome {
  return {
    kind: "failure",
    error: {
      code: "APP_ERROR",
      message: "run ended without producing a result",
      recoverable: false,
      attempts: 1,
    },
  };
}

// ─── Step execution ────────────────────────────────────────────────────────────

async function runSteps(
  steps: ArtifactStep[],
  handlers: Handler[],
  context: RunContext,
): Promise<TerminalOutcome | undefined> {
  for (const [index, step] of steps.entries()) {
    const maxAttempts = step.retry?.maxAttempts ?? 1;
    let attempt = 0;

    for (;;) {
      attempt++;
      const started = Date.now();
      await context.recorder.event({
        type: "step.start",
        stepId: step.id,
        stepIndex: index,
        actionType: step.action.action,
        detail: { attempt },
      });

      // Handlers run BEFORE the step as well as after. An interstitial that appeared while the
      // previous step settled has to be dealt with before we act into it, not discovered
      // afterwards by way of a confusing timeout.
      const before = await applyHandlers(handlers, step, index, context, "before");
      if (before.kind === "terminate") return before.result;
      if (before.kind === "retry") continue;

      const approval = await checkApproval(step, index, context);
      if (approval?.kind === "skip") {
        // The human already performed this step in the live session. Verify where we ended up
        // rather than trusting it, then move on.
        const postcondition = await verifyPostcondition(step, index, context);
        if (postcondition) return postcondition;
        break;
      }
      if (approval) return approval;

      // Budget checks are per attempt, not per step: a retrying step consumes budget, which is
      // what stops a flapping recovery from running for an hour inside a "40 step" policy.
      const budget = context.guard.countStep();
      if (!budget.allowed) return policyDenied(step, index, budget.reason);
      const deadline = context.guard.checkDeadline();
      if (!deadline.allowed) return policyDenied(step, index, deadline.reason);
      void deadline;

      const outcome = await executeStep(step, index, context);

      // Anything the browser-level guard refused is a policy denial even if the action itself
      // reported success — a click that tried to leave the allowlist "worked" as a click.
      const blocked = context.surface.takeBlockedNavigations();
      if (blocked.length > 0) {
        await context.recorder.event({
          type: "policy.navigation_blocked",
          stepId: step.id,
          stepIndex: index,
          detail: { urls: blocked },
        });
        return policyDenied(
          step,
          index,
          `navigation to ${blocked.join(", ")} was blocked by the origin allowlist`,
        );
      }

      // The after-phase needs to know whether the step actually ran, because that decides
      // whether recovery may retry it. See applyHandlers.
      const after = await applyHandlers(handlers, step, index, context, "after", outcome.ok);
      if (after.kind === "terminate") return after.result;
      if (after.kind === "retry") continue;

      if (outcome.ok) {
        const postcondition = await verifyPostcondition(step, index, context);
        if (postcondition) {
          // The action SUCCEEDED and its postcondition still did not hold.
          //
          // Re-running the action here is the same double-submit hazard the handler recovery
          // path guards against: repeating a click that already submitted a funds transfer
          // submits a second one. verifyPostcondition already polls, so a merely slow
          // confirmation has been waited for by this point.
          //
          // Only actions that can be repeated without a side effect may be retried. For
          // anything else the run stops and reports what was expected versus observed, which
          // is the honest outcome — the application did something we cannot verify.
          if (attempt < maxAttempts && isRepeatableAfterSuccess(step.action)) {
            await context.recorder.event({
              type: "step.postcondition_retry",
              stepId: step.id,
              stepIndex: index,
              detail: { attempt, maxAttempts, actionType: step.action.action },
            });
            await delay(step.retry?.delayMs ?? 500);
            continue;
          }
          return postcondition;
        }
        await context.recorder.event({
          type: "step.ok",
          stepId: step.id,
          stepIndex: index,
          actionType: step.action.action,
          durationMs: Date.now() - started,
        });
        break;
      }

      // A policy denial is terminal. Repeating a refused action just produces the same
      // refusal more slowly, and retrying it would misreport a guard decision as flakiness.
      if (outcome.error.code === "POLICY_DENIED") {
        await context.recorder.event({
          type: "policy.denied",
          stepId: step.id,
          stepIndex: index,
          actionType: step.action.action,
          detail: { reason: outcome.error.message },
        });
        return { kind: "failure", error: outcome.error };
      }

      // Retries are bounded and only apply where the artifact declared them. A validation
      // error is never retried either.
      if (attempt < maxAttempts) {
        await context.recorder.event({
          type: "step.retry",
          stepId: step.id,
          stepIndex: index,
          errorCode: outcome.error.code,
          detail: { attempt, maxAttempts },
        });
        await delay(step.retry?.delayMs ?? 500);
        continue;
      }

      await captureFailureContext(context, step.id);
      await context.recorder.event({
        type: "step.failed",
        stepId: step.id,
        stepIndex: index,
        errorCode: outcome.error.code,
        detail: { attempts: attempt },
      });
      return { kind: "failure", error: { ...outcome.error, attempts: attempt } };
    }
  }
  return undefined;
}

type StepOutcome = { ok: true } | { ok: false; error: RunError };

async function executeStep(
  step: ArtifactStep,
  index: number,
  context: RunContext,
): Promise<StepOutcome> {
  const { surface } = context;
  const action = step.action;
  const stepRef = { id: step.id, index };

  const resolve = (value: string): string => resolveTemplate(value, context.scope);
  // Targets are resolved too: a parameter can live in a locator rather than a value.
  const resolveTarget = (target: Target): Target =>
    resolveTargetTemplates(target, context.scope) as Target;
  const resolveCondition = (condition: Condition): Condition =>
    resolveConditionTemplates(condition, context.scope);

  try {
    switch (action.action) {
      case "navigate": {
        const url = resolve(action.url);
        const result = await surface.navigate(url);
        return result.ok
          ? { ok: true }
          : fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "navigation failed");
      }
      case "click": {
        const result = await surface.click(resolveTarget(action.target));
        return result.ok
          ? { ok: true }
          : fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "click failed");
      }
      case "fill": {
        const result = await surface.fill(resolveTarget(action.target), resolve(action.value));
        return result.ok
          ? { ok: true }
          : fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "fill failed");
      }
      case "select": {
        const result = await surface.select(resolveTarget(action.target), resolve(action.value));
        return result.ok
          ? { ok: true }
          : fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "select failed");
      }
      case "wait": {
        const result = await surface.waitFor(resolveCondition(action.condition), action.timeoutMs);
        return result.ok
          ? { ok: true }
          : fail(step, index, "STEP_TIMEOUT", result.error ?? "wait timed out");
      }
      case "extract": {
        const result = await surface.extract(
          resolveTarget(action.target),
          ...(action.attribute === undefined ? [] : [action.attribute]),
        );
        if (!result.ok) {
          return fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "extract failed");
        }
        context.scope.vars[action.as] = result.value ?? "";
        await context.recorder.event({
          type: "extract.ok",
          stepId: step.id,
          stepIndex: index,
          detail: { as: action.as, value: result.value ?? "" },
        });
        return { ok: true };
      }
      case "assert": {
        const ok = await surface.verify(resolveCondition(action.condition));
        return ok
          ? { ok: true }
          : fail(
              step,
              index,
              "CHECKPOINT_FAILED",
              `assertion failed: ${describeCondition(action.condition)}`,
              describeCondition(action.condition),
            );
      }
    }
  } catch (err) {
    if (err instanceof TemplateError) {
      // An unresolved reference is an invocation problem, not an application problem, and the
      // message has to say so or the reader goes looking at the wrong system.
      return fail(step, index, "INPUT_INVALID", err.message);
    }
    return fail(step, index, "APP_ERROR", err instanceof Error ? err.message : String(err));
  }

  void stepRef;
  return { ok: true };
}

function fail(
  step: ArtifactStep,
  index: number,
  code: ErrorCode,
  message: string,
  expected?: string,
): StepOutcome {
  return {
    ok: false,
    error: {
      code,
      message,
      step: { id: step.id, index },
      recoverable: false,
      ...(expected === undefined ? {} : { expected }),
      attempts: 1,
    },
  };
}

/**
 * Whether an action can be performed a second time without doing anything a second time.
 *
 * Navigation, waiting, extraction and assertion are observations or re-entries; repeating them
 * changes nothing that a caller would have to reconcile. `click`, `fill` and `select` can all
 * fire application-side handlers — a click submits, a fill can trigger onChange — so none of
 * them may be repeated once they have already succeeded.
 */
function isRepeatableAfterSuccess(action: ArtifactStep["action"]): boolean {
  switch (action.action) {
    case "navigate":
    case "wait":
    case "extract":
    case "assert":
      return true;
    case "click":
    case "fill":
    case "select":
      return false;
  }
}

async function verifyPostcondition(
  step: ArtifactStep,
  index: number,
  context: RunContext,
): Promise<TerminalOutcome | undefined> {
  if (!step.postcondition) return undefined;

  // Polled, not sampled. A confirmation screen that takes a moment to render is the normal
  // case, and treating "not true yet" as "not true" was what pushed the engine toward
  // re-clicking in the first place.
  const settled = await context.surface.waitFor(
    resolveConditionTemplates(step.postcondition, context.scope),
    context.postconditionTimeoutMs,
  );
  if (settled.ok) return undefined;

  // A postcondition is what makes a click *verified* rather than assumed. Without it a step
  // that silently did nothing looks identical to one that worked.
  await captureFailureContext(context, step.id);
  return {
    kind: "failure",
    error: {
      code: "CHECKPOINT_FAILED",
      message: `postcondition failed after "${step.id}": ${describeCondition(step.postcondition)}`,
      step: { id: step.id, index },
      recoverable: false,
      expected: describeCondition(step.postcondition),
      observed: context.redact(`url=${context.surface.currentUrl()}`),
      attempts: 1,
    },
  };
}


function policyDenied(step: ArtifactStep, index: number, reason: string | undefined): TerminalOutcome {
  return {
    kind: "failure",
    error: {
      code: "POLICY_DENIED",
      message: reason ?? "refused by policy",
      step: { id: step.id, index },
      recoverable: false,
      attempts: 1,
    },
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

async function applyHandlers(
  handlers: Handler[],
  step: ArtifactStep,
  index: number,
  context: RunContext,
  phase: "before" | "after",
  stepSucceeded = false,
): Promise<StepDisposition> {
  for (const handler of handlers) {
    if (!inScope(handler, step.id)) continue;
    if (!(await context.surface.verify(resolveConditionTemplates(handler.match, context.scope))))
      continue;

    await context.recorder.event({
      type: "handler.matched",
      stepId: step.id,
      stepIndex: index,
      detail: { handler: handler.id, phase, disposition: handler.disposition.kind },
    });

    const disposition = handler.disposition;

    if (disposition.kind === "business_outcome") {
      // The caller asked a question and the application answered it. That is a result, not a
      // failure, and conflating the two is the single most common way this design goes wrong.
      const detail = await readOutcomeDetail(disposition.detail, context);
      return {
        kind: "terminate",
        result: { kind: "business_outcome", outcome: disposition.outcome, detail },
      };
    }

    if (disposition.kind === "fail") {
      await captureFailureContext(context, step.id);
      return {
        kind: "terminate",
        result: {
          kind: "failure",
          error: {
            code: disposition.code,
            message: `handler "${handler.id}" matched: ${describeCondition(handler.match)}`,
            step: { id: step.id, index },
            recoverable: false,
            observed: context.redact(`url=${context.surface.currentUrl()}`),
            attempts: 1,
          },
        },
      };
    }

    // Recovery. Attempts are counted per handler across the whole run, not per step, so a
    // remedy that keeps matching cannot loop indefinitely by advancing one step each time.
    const used = context.recoveryAttempts.get(handler.id) ?? 0;
    if (used >= disposition.maxAttempts) {
      await captureFailureContext(context, step.id);
      return {
        kind: "terminate",
        result: {
          kind: "failure",
          error: {
            code: "APP_ERROR",
            message: `recovery "${handler.id}" exhausted after ${used} attempt(s)`,
            step: { id: step.id, index },
            recoverable: true,
            attempts: used,
          },
        },
      };
    }
    context.recoveryAttempts.set(handler.id, used + 1);

    const recovered = await applyRemedy(disposition, context);
    await context.recorder.event({
      type: recovered.ok ? "handler.recovered" : "handler.recovery_failed",
      stepId: step.id,
      stepIndex: index,
      detail: {
        handler: handler.id,
        remedy: disposition.remedy,
        attempt: used + 1,
        ...(recovered.ok ? {} : { reason: recovered.reason }),
      },
    });

    if (!recovered.ok) {
      return {
        kind: "terminate",
        result: {
          kind: "failure",
          error: {
            // A refusal is a policy decision, not a flaky application. Reporting it as
            // APP_ERROR would send the reader looking at the wrong system.
            code: recovered.denied ? "POLICY_DENIED" : "APP_ERROR",
            message: recovered.denied
              ? `recovery "${handler.id}" refused: ${recovered.reason}`
              : `recovery "${handler.id}" (${disposition.remedy}) did not succeed: ${recovered.reason}`,
            step: { id: step.id, index },
            recoverable: !recovered.denied,
            attempts: used + 1,
          },
        },
      };
    }

    // Whether to redo the step after recovering is a safety question, not a style one.
    //
    // If the interruption was found BEFORE the step ran, or the step ran and failed, the step
    // still needs doing — retry.
    //
    // If the step already SUCCEEDED and an interstitial appeared afterwards, retrying would
    // re-execute work that is already done. On a click that submitted a funds transfer, that is
    // a second transfer. Recovery clears the obstruction and the run continues to the next step.
    return { kind: phase === "after" && stepSucceeded ? "continue" : "retry" };
  }
  return { kind: "continue" };
}

function inScope(handler: Handler, stepId: string): boolean {
  return handler.scope === "global" || handler.scope.includes(stepId);
}

/**
 * Outcome of a remedy. A policy refusal is reported distinctly from a remedy that simply did
 * not work: "the interstitial would not dismiss" and "you are not permitted to click" need
 * different responses from whoever reads the run.
 */
type RemedyOutcome =
  | { ok: true }
  | { ok: false; denied: true; reason: string }
  | { ok: false; denied: false; reason: string };

async function applyRemedy(
  disposition: Extract<Handler["disposition"], { kind: "recover" }>,
  context: RunContext,
): Promise<RemedyOutcome> {
  switch (disposition.remedy) {
    case "dismiss": {
      const result = await context.surface.click(
        resolveTargetTemplates(disposition.target, context.scope) as Target,
      );
      if (result.ok) return { ok: true };
      return result.errorCode === "POLICY_DENIED"
        ? { ok: false, denied: true, reason: result.error ?? "refused by policy" }
        : { ok: false, denied: false, reason: result.error ?? "dismiss did not succeed" };
    }
    case "retry_step":
      return { ok: true };
    case "reauthenticate": {
      if (!context.options.reauthenticate) {
        return {
          ok: false,
          denied: false,
          reason: "artifact declares a reauthenticate remedy but no provider was supplied",
        };
      }
      const ok = await context.options.reauthenticate(context.surface, {
        baseUrl: context.scope.baseUrl,
        secrets: context.scope.secrets,
      });
      return ok
        ? { ok: true }
        : { ok: false, denied: false, reason: "re-authentication did not succeed" };
    }
  }
}

async function readOutcomeDetail(
  detail: Record<string, string> | undefined,
  context: RunContext,
): Promise<Record<string, unknown>> {
  if (!detail) return {};
  const out: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(detail)) {
    try {
      out[key] = resolveTemplate(template, context.scope);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

// ─── Approval seam (wired to a human in PR5) ───────────────────────────────────

type ApprovalOutcome = TerminalOutcome | { kind: "skip" };

async function checkApproval(
  step: ArtifactStep,
  index: number,
  context: RunContext,
): Promise<ApprovalOutcome | undefined> {
  // Documented rule: a step without its own classification inherits the capability's.
  const risk = step.risk ?? context.capabilityRisk;

  // "blocked" is absolute and not a policy opinion — nothing may execute it.
  if (risk === "blocked") {
    return {
      kind: "failure",
      error: {
        code: "POLICY_DENIED",
        message: `step "${step.id}" is classified blocked and will not execute`,
        step: { id: step.id, index },
        recoverable: false,
        attempts: 1,
      },
    };
  }

  // Everything else is policy's call, so a tenant can widen or narrow what needs a human.
  if (!context.guard.requiresApproval(risk)) return undefined;

  await context.recorder.event({
    type: "approval.required",
    stepId: step.id,
    stepIndex: index,
  });

  // Without an operator channel there is no honest way to proceed: the run is not finished,
  // has not failed, and has not produced an outcome. That is what `escalated` is for, and it is
  // the correct answer for an unattended caller rather than a limitation.
  if (!context.controller) {
    await captureFailureContext(context, `approval-${step.id}`);
    return { kind: "escalated", stepId: step.id, stepIndex: index };
  }

  const outcome = await context.controller.handOver({
    runId: context.recorder.runId,
    reason: "approval_required",
    message: `Step "${step.id}" is classified ${risk} and needs a person.`,
    capabilityId: context.capabilityId,
    ...(context.goal === undefined ? {} : { goal: context.goal }),
    step: { id: step.id, index },
  });

  switch (outcome.decision) {
    case "proceed":
      // The operator authorised it; automation performs the step.
      return undefined;

    case "completed_by_human":
      // The operator did it themselves. Performing it again would repeat whatever they just
      // did — on a transfer, a second transfer. This is why the decision is three-valued
      // rather than a boolean approve/deny.
      await context.recorder.event({
        type: "step.completed_by_human",
        stepId: step.id,
        stepIndex: index,
        ...(outcome.note === undefined ? {} : { detail: { note: outcome.note } }),
      });
      return { kind: "skip" };

    case "abort":
      return {
        kind: "failure",
        error: {
          code: "HUMAN_ABORTED",
          message: `operator stopped the run at step "${step.id}"${
            outcome.reason ? `: ${outcome.reason}` : ""
          }`,
          step: { id: step.id, index },
          recoverable: false,
          attempts: 1,
        },
      };
  }
}

// ─── Outputs ───────────────────────────────────────────────────────────────────

async function collectOutputs(
  outputs: Record<string, OutputDefinition>,
  context: RunContext,
): Promise<{ values: Record<string, unknown> } | { error: RunError }> {
  const values: Record<string, unknown> = {};

  for (const [name, definition] of Object.entries(outputs)) {
    let raw: string | undefined;

    if (definition.source.kind === "variable") {
      const captured = context.scope.vars[definition.source.name];
      raw = captured === undefined ? undefined : String(captured);
    } else {
      const result = await context.surface.extract(
        resolveTargetTemplates(definition.source.target, context.scope) as Target,
        ...(definition.source.attribute === undefined ? [] : [definition.source.attribute]),
      );
      raw = result.ok ? result.value : undefined;
    }

    if (raw === undefined || raw === "") {
      if (definition.onMissing === "null") {
        values[name] = null;
        continue;
      }
      return {
        error: {
          code: "TARGET_NOT_FOUND",
          message: `output "${name}" could not be read`,
          recoverable: false,
          attempts: 1,
        },
      };
    }

    const coerced = coerce(raw, definition.coerce, definition.type);
    if (!coerced.ok) {
      if (definition.onMissing === "null") {
        values[name] = null;
        continue;
      }
      return {
        error: {
          code: "APP_ERROR",
          message: `output "${name}": ${coerced.reason}`,
          recoverable: false,
          attempts: 1,
        },
      };
    }
    values[name] = coerced.value;
  }

  return { values };
}

// ─── Validation helpers ────────────────────────────────────────────────────────

function validateInputs(
  declared: Record<string, { type: string; required: boolean; default?: unknown; pattern?: string | undefined }>,
  supplied: Record<string, unknown>,
): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [name, definition] of Object.entries(declared)) {
    const raw = supplied[name] ?? definition.default;
    if (raw === undefined) {
      if (definition.required) problems.push(`missing required input "${name}"`);
      continue;
    }
    const coerced = coerceInput(name, raw, definition);
    if (coerced.ok) values[name] = coerced.value;
    else problems.push(coerced.reason);
  }

  // An input the capability does not declare is a caller mistake worth surfacing: it is almost
  // always a typo in the name of one that *is* declared, which would otherwise read as "missing".
  for (const name of Object.keys(supplied)) {
    if (!(name in declared)) problems.push(`unknown input "${name}"`);
  }

  return problems.length > 0 ? { error: problems.join("; ") } : { values };
}

/** Catches `{{secrets.x}}` with no x before the browser opens rather than mid-flow. */
function missingSecretReference(
  artifact: CapabilityArtifact,
  secrets: Record<string, string>,
): string | undefined {
  const missing = new Set<string>();
  const scan = (value: string): void => {
    for (const reference of value.matchAll(/\{\{\s*secrets\.([\w.]+)\s*\}\}/g)) {
      const key = reference[1] as string;
      if (!(key in secrets)) missing.add(key);
    }
  };

  for (const step of artifact.steps) {
    const action = step.action;
    if (action.action === "navigate") scan(action.url);
    if (action.action === "fill" || action.action === "select") scan(action.value);
  }

  return missing.size > 0
    ? `artifact needs secret(s) not supplied: ${[...missing].join(", ")}`
    : undefined;
}

// ─── Result assembly ───────────────────────────────────────────────────────────

function toRunResult(terminal: TerminalOutcome, recorder: EvidenceRecorder): RunResult {
  const evidence = recorder.summary();
  switch (terminal.kind) {
    case "business_outcome":
      return { status: "business_outcome", outcome: terminal.outcome, detail: terminal.detail, evidence };
    case "escalated":
      return {
        status: "escalated",
        intervention: {
          interventionId: `${evidence.runId}-${terminal.stepId}`,
          reason: "approval_required",
          // PR5 replaces this with a real token the operator console redeems.
          resumeToken: `${evidence.runId}:${terminal.stepIndex}`,
        },
        evidence,
      };
    case "failure":
      return { status: "failure", error: terminal.error, evidence };
  }
}

async function finish(recorder: EvidenceRecorder, result: RunResult): Promise<RunResult> {
  await recorder.finish(result);
  return result;
}

/** Failures before a run directory exists still need to return the same shape. */
function earlyFailure(code: ErrorCode, message: string): RunResult {
  return {
    status: "failure",
    error: { code, message, recoverable: false, attempts: 1 },
    evidence: {
      runId: "not-started",
      directory: "",
      eventLog: "",
      traceUnredacted: false,
      screenshots: [],
      modelCalls: 0,
    },
  };
}

async function captureFailureContext(context: RunContext, label: string): Promise<void> {
  try {
    await context.recorder.screenshot(await context.surface.screenshot(), `failure-${label}`);
    await context.recorder.failureSnapshot(await context.surface.observe(0), { label });
  } catch {
    // Evidence capture must never be the reason a run reports something other than its
    // actual failure.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
