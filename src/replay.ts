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
  type RiskClass,
  type RunError,
  type RunResult,
} from "./schema.js";
import { EvidenceRecorder, newRunId } from "./evidence.js";
import { PolicyGuard } from "./safety.js";
import { createRedactor, type Redactor } from "./redact.js";
import { PlaywrightSurface, describeCondition } from "./surface.js";
import {
  coerce,
  coerceInput,
  isSensitiveSecretKey,
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
   * Enforced for the whole run. Omitting it is not "no policy" — the caller must supply one,
   * because a guard that can be forgotten is not a guard.
   */
  policy: Policy;
  /**
   * Supplied by the handoff layer in PR5. Until then, a step that needs approval returns
   * `escalated` rather than pretending it could proceed.
   */
  requestApproval?: (context: { stepId: string; stepIndex: number }) => Promise<boolean>;
  /**
   * How to re-authenticate when a handler's remedy calls for it. Login is itself a UI flow and
   * differs per application, so the engine does not invent one — an artifact that declares the
   * remedy without a provider fails loudly instead of silently continuing logged out.
   */
  reauthenticate?: (
    surface: PlaywrightSurface,
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
  surface: PlaywrightSurface;
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
  const sensitiveInputValues = Object.entries(artifact.inputs)
    .filter(([, definition]) => definition.sensitive)
    .map(([name]) => inputs.values[name])
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
  });

  const baseUrl = options.baseUrl ?? artifact.target.baseUrl;
  await recorder.writeRunHeader({
    policy: {
      allowedOrigins: options.policy.allowedOrigins,
      allowedPaths: options.policy.allowedPaths,
      blockedActions: options.policy.blockedActions,
      maxSteps: options.policy.maxSteps,
    },
    capabilityId: artifact.capabilityId,
    capabilityVersion: artifact.version,
    artifactStatus: artifact.metadata.status,
    risk: artifact.metadata.risk,
    baseUrl,
    inputs: inputs.values,
    startedAt: new Date().toISOString(),
  });

  let surface: PlaywrightSurface | undefined;
  let terminal: TerminalOutcome | undefined;
  let outputs: Record<string, unknown> | undefined;

  try {
    // Launching is inside the guarded lifecycle. A missing browser binary or a failed context
    // is exactly the kind of thing a caller consuming --json must receive as a structured
    // failure, not as an unhandled rejection.
    surface = await PlaywrightSurface.launch({
      ...(options.headed === undefined ? {} : { headed: options.headed }),
      trace: options.trace ?? "off",
      traceDir: recorder.directory,
      defaultTimeoutMs: options.stepTimeoutMs ?? 10_000,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      navigationAllowed: guard.navigationAllowed,
    });

    const context: RunContext = {
      surface,
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
    };

    guard.begin();

    terminal = await runSteps(artifact.steps, artifact.handlers, context);

    if (!terminal) {
      // Outputs are read before the checkpoint, so a failed checkpoint can still report what
      // the page actually said — which is usually the thing that explains the failure.
      const collected = await collectOutputs(artifact.outputs, context);
      if ("error" in collected) {
        terminal = { kind: "failure", error: collected.error };
      } else {
        const ok = await context.surface.verify(artifact.checkpoint);
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
    if (surface) {
      const trace = await surface.close();
      if (trace) recorder.setTrace(trace);
    }
  }

  // Every terminal result is assembled AFTER the surface is closed, so the evidence summary can
  // see the trace that closing produced. Building the success result inside the try meant a
  // successful --trace run reported traceUnredacted: false next to a trace.zip that existed.
  const result: RunResult =
    outputs !== undefined
      ? { status: "success", outputs, evidence: recorder.summary() }
      : toRunResult(terminal ?? unexpectedTerminal(), recorder);

  await recorder.finish(result);
  return result;
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
      if (approval) return approval;

      // Budget checks are per attempt, not per step: a retrying step consumes budget, which is
      // what stops a flapping recovery from running for an hour inside a "40 step" policy.
      const budget = context.guard.countStep();
      if (!budget.allowed) return policyDenied(step, index, budget.reason);
      const deadline = context.guard.checkDeadline();
      if (!deadline.allowed) return policyDenied(step, index, deadline.reason);

      const permitted = await checkActionPolicy(step, index, context);
      if (permitted) return permitted;

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

      // Retries are bounded and only apply where the artifact declared them. A validation
      // error or a policy denial is never retried — repeating a rejected action just produces
      // the same rejection more slowly.
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
        const result = await surface.click(action.target);
        return result.ok
          ? { ok: true }
          : fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "click failed");
      }
      case "fill": {
        const result = await surface.fill(action.target, resolve(action.value));
        return result.ok
          ? { ok: true }
          : fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "fill failed");
      }
      case "select": {
        const result = await surface.select(action.target, resolve(action.value));
        return result.ok
          ? { ok: true }
          : fail(step, index, result.errorCode ?? "APP_ERROR", result.error ?? "select failed");
      }
      case "wait": {
        const result = await surface.waitFor(action.condition, action.timeoutMs);
        return result.ok
          ? { ok: true }
          : fail(step, index, "STEP_TIMEOUT", result.error ?? "wait timed out");
      }
      case "extract": {
        const result = await surface.extract(
          action.target,
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
        const ok = await surface.verify(action.condition);
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
  const settled = await context.surface.waitFor(step.postcondition, context.postconditionTimeoutMs);
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


/**
 * Checks the resolved action against policy before it executes.
 *
 * The URL is resolved first so the allowlist sees the destination a template actually produces
 * — checking `{{baseUrl}}/x` as a literal would check nothing.
 */
async function checkActionPolicy(
  step: ArtifactStep,
  index: number,
  context: RunContext,
): Promise<TerminalOutcome | undefined> {
  let resolvedUrl: string | undefined;
  if (step.action.action === "navigate") {
    try {
      resolvedUrl = resolveTemplate(step.action.url, context.scope);
    } catch {
      // An unresolved template is reported by executeStep with a better message.
      resolvedUrl = undefined;
    }
  }

  const decision = context.guard.checkAction(step.action, resolvedUrl);
  if (decision.allowed) return undefined;

  await context.recorder.event({
    type: "policy.denied",
    stepId: step.id,
    stepIndex: index,
    actionType: step.action.action,
    detail: { reason: decision.reason },
  });
  return policyDenied(step, index, decision.reason);
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
    if (!(await context.surface.verify(handler.match))) continue;

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
      type: recovered ? "handler.recovered" : "handler.recovery_failed",
      stepId: step.id,
      stepIndex: index,
      detail: { handler: handler.id, remedy: disposition.remedy, attempt: used + 1 },
    });

    if (!recovered) {
      return {
        kind: "terminate",
        result: {
          kind: "failure",
          error: {
            code: "APP_ERROR",
            message: `recovery "${handler.id}" (${disposition.remedy}) did not succeed`,
            step: { id: step.id, index },
            recoverable: true,
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

async function applyRemedy(
  disposition: Extract<Handler["disposition"], { kind: "recover" }>,
  context: RunContext,
): Promise<boolean> {
  switch (disposition.remedy) {
    case "dismiss": {
      const result = await context.surface.click(disposition.target);
      return result.ok;
    }
    case "retry_step":
      return true;
    case "reauthenticate": {
      if (!context.options.reauthenticate) return false;
      return context.options.reauthenticate(context.surface, {
        baseUrl: context.scope.baseUrl,
        secrets: context.scope.secrets,
      });
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

async function checkApproval(
  step: ArtifactStep,
  index: number,
  context: RunContext,
): Promise<TerminalOutcome | undefined> {
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
  // has not failed, and has not produced an outcome. That is what `escalated` is for.
  if (!context.options.requestApproval) {
    await captureFailureContext(context, `approval-${step.id}`);
    return { kind: "escalated", stepId: step.id, stepIndex: index };
  }

  const approved = await context.options.requestApproval({ stepId: step.id, stepIndex: index });
  if (approved) return undefined;
  return {
    kind: "failure",
    error: {
      code: "HUMAN_ABORTED",
      message: `operator declined step "${step.id}"`,
      step: { id: step.id, index },
      recoverable: false,
      attempts: 1,
    },
  };
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
        definition.source.target,
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
    await context.recorder.screenshot(context.surface.page, `failure-${label}`);
    await context.recorder.failureSnapshot(await context.surface.observe(0), { label });
  } catch {
    // Evidence capture must never be the reason a run reports something other than its
    // actual failure.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
