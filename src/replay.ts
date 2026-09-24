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
  type RunError,
  type RunResult,
} from "./schema.js";
import { EvidenceRecorder, newRunId } from "./evidence.js";
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
  reauthenticate?: (surface: PlaywrightSurface) => Promise<boolean>;
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
    return earlyFailure("ARTIFACT_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const artifact = parsed.data;

  const secrets = options.secrets ?? {};
  const inputs = validateInputs(artifact.inputs, options.inputs);
  if ("error" in inputs) return earlyFailure("INPUT_INVALID", inputs.error);

  const missingSecret = missingSecretReference(artifact, secrets);
  if (missingSecret) return earlyFailure("INPUT_INVALID", missingSecret);

  // ── Redaction is configured from the secrets themselves ─────────────────────
  const redact = createRedactor({
    literals: Object.entries(secrets)
      .filter(([key]) => isSensitiveSecretKey(key))
      .map(([, value]) => value),
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
    capabilityId: artifact.capabilityId,
    capabilityVersion: artifact.version,
    artifactStatus: artifact.metadata.status,
    risk: artifact.metadata.risk,
    baseUrl,
    inputs: inputs.values,
    startedAt: new Date().toISOString(),
  });

  const surface = await PlaywrightSurface.launch({
    ...(options.headed === undefined ? {} : { headed: options.headed }),
    trace: options.trace ?? "off",
    traceDir: recorder.directory,
    defaultTimeoutMs: options.stepTimeoutMs ?? 10_000,
  });

  const context: RunContext = {
    surface,
    recorder,
    redact,
    scope: { baseUrl, inputs: inputs.values, secrets, vars: {} },
    stepTimeoutMs: options.stepTimeoutMs ?? 10_000,
    options,
    recoveryAttempts: new Map(),
  };

  let terminal: TerminalOutcome | undefined;

  try {
    terminal = await runSteps(artifact.steps, artifact.handlers, context);

    if (!terminal) {
      // Outputs are read before the checkpoint, so a failed checkpoint can still report what
      // the page actually said — which is usually the thing that explains the failure.
      const outputs = await collectOutputs(artifact.outputs, context);
      if ("error" in outputs) {
        terminal = { kind: "failure", error: outputs.error };
      } else {
        const ok = await context.surface.verify(artifact.checkpoint);
        await recorder.event({
          type: ok ? "checkpoint.ok" : "checkpoint.failed",
          detail: { condition: describeCondition(artifact.checkpoint) },
        });
        if (!ok) {
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
        } else {
          return await finish(recorder, {
            status: "success",
            outputs: outputs.values,
            evidence: recorder.summary(),
          });
        }
      }
    }
  } catch (err) {
    await captureFailureContext(context, "unexpected");
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
    const trace = await surface.close();
    if (trace) recorder.setTrace(trace);
  }

  return await finish(recorder, toRunResult(terminal, recorder));
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

      const outcome = await executeStep(step, index, context);

      // The after-phase needs to know whether the step actually ran, because that decides
      // whether recovery may retry it. See applyHandlers.
      const after = await applyHandlers(handlers, step, index, context, "after", outcome.ok);
      if (after.kind === "terminate") return after.result;
      if (after.kind === "retry") continue;

      if (outcome.ok) {
        const postcondition = await verifyPostcondition(step, index, context);
        if (postcondition) {
          if (attempt < maxAttempts) {
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

async function verifyPostcondition(
  step: ArtifactStep,
  index: number,
  context: RunContext,
): Promise<TerminalOutcome | undefined> {
  if (!step.postcondition) return undefined;
  const ok = await context.surface.verify(step.postcondition);
  if (ok) return undefined;

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
      return context.options.reauthenticate(context.surface);
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
  const risk = step.risk;
  if (risk !== "approval_required" && risk !== "blocked") return undefined;

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
