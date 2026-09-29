/**
 * LLM-driven discovery: the run that produces a capability.
 *
 * The model observes, decides, and acts against a live application until the goal is met. It is
 * used exactly once per capability, and never again — everything it learns is written down as a
 * typed artifact that the deterministic engine replays without it.
 *
 * Three things keep this from being "an agent with a browser":
 *
 *   The model never touches the browser. It emits a structured decision, which is Zod-parsed,
 *   policy-checked, and only then executed by the same guarded surface replay uses. A malformed
 *   or disallowed action is refused, not attempted.
 *
 *   What gets recorded is a durable locator, not the model's reference to an element. The
 *   model reads an ARIA snapshot, so it naturally proposes role+name — which is the most robust
 *   targeting this system has. Anything it cannot express that way is recorded as a fallback
 *   chain, and anything at all recorded by coordinates keeps the artifact a draft.
 *
 *   Observed values become parameters. A run that typed "12678" records
 *   `{{inputs.accountId}}`, so the capability is reusable rather than a recording of one
 *   specific invocation.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  ArtifactStep,
  CapabilityArtifact,
  Handler,
  InputDefinition,
  LocatorCandidate,
  Observation,
  Policy,
  SurfaceKind,
  Target,
} from "./schema.js";
import { Action, CapabilityArtifact as ArtifactSchema } from "./schema.js";
import { EvidenceRecorder, newRunId, type EvidenceEvent } from "./evidence.js";
import { SessionController, type InterventionChannel } from "./handoff.js";
import { createRedactor } from "./redact.js";
import { GuardedSurface, PolicyGuard } from "./safety.js";
import {
  PlaywrightSurface,
  closeSurface,
  describeCondition,
  type Surface,
  type SurfaceFactory,
} from "./surface.js";
import { isSensitiveSecretKey, resolveTemplate, type TemplateScope } from "./template.js";
import { loadSkills, renderSkills, selectSkills } from "./skills.js";
import { loadMemory, renderMemory, selectMemory, sensitiveValues } from "./appmemory.js";

const MODEL = "claude-opus-5";

export interface DiscoveryRequest {
  goal: string;
  capabilityId: string;
  baseUrl: string;
  policy: Policy;
  /** Values the capability should be parameterised by, supplied for this exploratory run. */
  inputs: Record<string, string>;
  secrets: Record<string, string>;
  maxSteps?: number;
  /**
   * Where an irreversible action during exploration is routed. With no channel, such an action
   * is refused outright and the model is told why — an unattended discovery run must not be
   * able to move money simply because nobody was watching.
   */
  interventionChannel?: InterventionChannel;
  /** Watch events as they are recorded. The console streams these to a browser. */
  onEvent?: (event: EvidenceEvent) => void;
  /** How to obtain a surface. Defaults to a browser. The seam a desktop adapter plugs into. */
  createSurface?: SurfaceFactory;
  /**
   * What kind of surface `createSurface` returns, recorded onto the artifact this run produces.
   *
   * Replay checks an artifact's declared surface against what its caller supplies; discovery
   * has no artifact yet — it is writing one — so here the value is an input, not a check. Left
   * unset it is `web`, matching the default browser factory. Getting this wrong produces an
   * artifact that claims the wrong surface, which replay would then refuse, so it is better
   * stated by the caller than guessed from a URL.
   */
  surfaceKind?: SurfaceKind;
  /**
   * Where the skill library and application memory live. Compiler inputs, both of them: they
   * shape this prompt and reach nothing else. Replay imports neither module.
   */
  skillsDir?: string;
  memoryDir?: string;
  /** Which tenant's memory applies. Tenant-scoped entries never leak to another tenant. */
  tenant?: string;
  /** The application these memories are about. Defaults to the artifact's `target.app`. */
  app?: string;
  headed?: boolean;
  evidenceRoot?: string;
  apiKey: string;
}

export type DiscoveryResult =
  | { status: "recorded"; artifact: CapabilityArtifact; evidenceDir: string; modelCalls: number }
  | { status: "stuck"; reason: string; evidenceDir: string; modelCalls: number }
  | { status: "failed"; reason: string; evidenceDir: string; modelCalls: number };

// ─── The model's decision surface ──────────────────────────────────────────────
//
// Three tools rather than one polymorphic call, because the three outcomes are genuinely
// different kinds of thing: act again, declare success, or admit defeat. Making "I am stuck" a
// first-class option it can choose is what stops a model from thrashing at a dead end — and a
// stuck discovery run is a legitimate result that escalates to a human, not a failure to hide.

const ACT_TOOL: Anthropic.Tool = {
  name: "act",
  description:
    "Perform one action on the current screen. Prefer identifying controls by their accessible role and " +
    "name, exactly as they appear in the snapshot — that is what makes the recording durable. " +
    "Use a CSS selector only when the control has no accessible name, and never on a desktop surface.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "fill", "select", "wait", "extract", "assert", "press"],
      },
      rationale: { type: "string", description: "Why this action, in one sentence." },
      role: { type: ["string", "null"], description: "ARIA role of the target control." },
      name: { type: ["string", "null"], description: "Accessible name of the target control." },
      css: { type: ["string", "null"], description: "CSS selector fallback." },
      cell: {
        type: ["string", "null"],
        description:
          "Grid cell reference such as C4, for spreadsheet-like surfaces. Use this rather than " +
          "the cell's name: a cell's accessible name is its value, and it changes the moment " +
          "anything writes to it.",
      },
      button: {
        type: ["string", "null"],
        enum: ["left", "right", null],
        description: "Mouse button for click. Right opens context menus. Defaults to left.",
      },
      keys: {
        type: ["string", "null"],
        description:
          "Key or chord for press, such as Enter, Escape or Control+Shift+ArrowDown. Some " +
          "controls hold what you typed until a key commits it.",
      },
      value: { type: ["string", "null"], description: "Value for fill/select." },
      url: { type: ["string", "null"], description: "Absolute URL for navigate." },
      text: { type: ["string", "null"], description: "Visible text for wait/assert." },
      as: { type: ["string", "null"], description: "Variable name for extract." },
    },
    required: [
      "action",
      "rationale",
      "role",
      "name",
      "css",
      "cell",
      "button",
      "keys",
      "value",
      "url",
      "text",
      "as",
    ],
    additionalProperties: false,
  },
  strict: true,
};

const FINISH_TOOL: Anthropic.Tool = {
  name: "finish",
  description:
    "The goal has been achieved. Declare the text that proves it and the values worth returning.",
  input_schema: {
    type: "object",
    properties: {
      checkpointText: {
        type: "string",
        description: "Visible text that only appears once the goal is reached.",
      },
      outputs: {
        type: "array",
        description: "Values extracted during the run that the caller should receive.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            variable: { type: "string", description: "The `as` name of an extract step." },
            type: {
              type: "string",
              enum: ["string", "number", "boolean"],
              description:
                'Must agree with the coercion: "currency", "int" and "number" all yield a number.',
            },
            coerce: {
              // Described rather than enumerated: a nullable enum is rejected by the API, and
              // an unknown value is caught by the artifact schema before anything replays.
              type: ["string", "null"],
              description: 'One of "trim", "currency", "int", "number", or null.',
            },
          },
          required: ["name", "variable", "type", "coerce"],
          additionalProperties: false,
        },
      },
    },
    required: ["checkpointText", "outputs"],
    additionalProperties: false,
  },
  strict: true,
};

const STUCK_TOOL: Anthropic.Tool = {
  name: "give_up",
  description:
    "The goal cannot be achieved from here. Say what blocked you — this escalates to a human " +
    "rather than failing silently.",
  input_schema: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
    additionalProperties: false,
  },
  strict: true,
};

/**
 * The framing, per surface.
 *
 * Split because the rest of the prompt is technology-neutral and this part cannot be: telling a
 * model driving a spreadsheet that it is operating a web page is not a stylistic mismatch, it
 * is an instruction to reach for CSS selectors that will never resolve. The skill library is
 * already scoped this way; the prompt that frames it was not.
 */
const OPENING: Record<SurfaceKind, string> = {
  web: `You are operating a real web application through its user interface, the way a human
operator would.`,
  desktop: `You are operating a real desktop application through its user interface, the way a
human operator would. There is no page, no URL and no DOM: you are in an application window,
and CSS selectors mean nothing here.`,
};

/** Verbs that only exist, or only matter, on one kind of surface. */
const SURFACE_NOTES: Record<SurfaceKind, string> = {
  web: "",
  desktop: `
Desktop-specific things worth knowing:

- Some controls hold what you typed until a key commits it. A field that takes a range or an
  address is usually one of them: fill it, then \`press\` Enter. A flow that fills and moves on
  looks correct and does nothing.
- Real operations often live behind the right mouse button. If you cannot find a command in a
  menu bar or toolbar, try \`click\` with button "right" on the thing it would act on.
- In a grid, address a cell by its reference — \`cell: "C4"\` — never by its name. A cell's
  accessible name is its current value, so a recording that targets the name breaks the moment
  anything writes to it.
- A window title is not a location. It changes when the application saves or renames, and
  nothing durable should be built on it.`,
};

const SYSTEM_BODY = `You are exploring this application ONCE so the flow can be recorded and
replayed later without you.

You see each screen as an accessibility snapshot: roles and accessible names, the same
representation a screen reader produces. Work from it.

Rules that matter for what gets recorded:

- Identify controls by accessible role and name whenever the snapshot gives you one. That is
  what survives when this flow is replayed next month, or against another institution running
  the same product. Fall back to a CSS selector only when a control genuinely has no accessible
  name, and say so in your rationale.
- Take ONE action per turn and check the result before the next one.
- Use the exact input values you are given. They are placeholders; they will be turned into
  parameters automatically.
- When a page needs a moment, wait for something observable rather than acting blindly.
- Call finish only when the goal is visibly achieved. The text you name as proof must be
  something that appears for EVERY valid invocation of this flow — a heading or a label, not a
  value that changes with the input. "Account Details" proves you arrived; "Balance: -$100.00"
  only proves it for one account.
- If you are blocked, call give_up and say why. That is a legitimate outcome that brings in a
  human — it is not a failure to conceal.`;

/** The whole system prompt for one recording run. */
function systemPrompt(surface: SurfaceKind): string {
  return [OPENING[surface], SYSTEM_BODY, SURFACE_NOTES[surface]]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}

// ─── The loop ──────────────────────────────────────────────────────────────────

export async function discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
  const guard = new PolicyGuard(request.policy);
  const redact = createRedactor({
    literals: Object.entries(request.secrets)
      .filter(([key]) => isSensitiveSecretKey(key))
      .map(([, value]) => value),
  });

  const runId = newRunId("discover");
  const recorder = new EvidenceRecorder({
    runId,
    phase: "discovery",
    redact,
    ...(request.evidenceRoot ? { rootDir: request.evidenceRoot } : {}),
    ...(request.onEvent ? { onEvent: request.onEvent } : {}),
  });

  await recorder.writeRunHeader({
    goal: request.goal,
    capabilityId: request.capabilityId,
    model: MODEL,
    baseUrl: request.baseUrl,
    policy: request.policy,
    startedAt: new Date().toISOString(),
  });

  // ── Compiler inputs ───────────────────────────────────────────────────────
  //
  // Loaded once, here, and folded into the system prompt. Their versions are recorded on the
  // artifact so a later regression in recording quality has a suspect list — two runs of the
  // same goal against the same application can differ purely because the guidance changed.
  const surfaceKind = request.surfaceKind ?? "web";
  const app = request.app ?? "parabank";

  const { skills, invalid: badSkills } = await loadSkills(request.skillsDir ?? "skills");
  const { entries: memories, invalid: badMemory } = await loadMemory(request.memoryDir ?? "memory", {
    secrets: sensitiveValues(request.secrets),
  });

  // Reported, not swallowed. A skill file that silently stopped applying is guidance the model
  // is no longer getting, and nothing about the run would look different.
  for (const bad of [...badSkills, ...badMemory]) {
    await recorder.event({ type: "compiler.input_invalid", detail: { ...bad } });
  }

  const selectedSkills = selectSkills(skills, { surface: surfaceKind, app });
  const selectedMemory = selectMemory(memories, {
    app,
    surface: surfaceKind,
    ...(request.tenant === undefined ? {} : { tenant: request.tenant }),
  });

  const renderedSkills = renderSkills(selectedSkills);
  const renderedMemory = renderMemory(selectedMemory);
  const system = [systemPrompt(surfaceKind), renderedSkills.prompt, renderedMemory.prompt]
    .filter((section) => section !== "")
    .join("\n\n");

  await recorder.event({
    type: "compiler.inputs",
    detail: {
      skills: renderedSkills.provenance,
      memory: renderedMemory.provenance,
    },
  });

  const anthropic = new Anthropic({ apiKey: request.apiKey });
  const maxSteps = Math.min(request.maxSteps ?? 25, request.policy.maxSteps);

  let surface: Surface | undefined;
  const launch: SurfaceFactory = request.createSurface ?? PlaywrightSurface.launch;

  const recorded: RecordedStep[] = [];
  const messages: Anthropic.MessageParam[] = [];
  let modelCalls = 0;

  try {
    // Launching happens inside the guarded lifecycle. A missing browser binary — or a custom
    // surface factory that rejects — is exactly what a caller must receive as a structured
    // result rather than an unhandled rejection. replay() was fixed for this during the PR3
    // review and discovery was not, which PR11 made more likely to bite by allowing any
    // factory to be supplied.
    surface = await launch({
      ...(request.headed === undefined ? {} : { headed: request.headed }),
      navigationAllowed: guard.navigationAllowed,
    });
    const live = surface;

    const guarded = new GuardedSurface(live, guard, (reason) => {
      void recorder.event({ type: "policy.denied", detail: { reason } });
    });
    guard.begin();

    const controller = request.interventionChannel
      ? new SessionController(request.interventionChannel, {
          observe: () => live.observe(0),
          screenshot: async (label) => recorder.screenshot(await live.screenshot(), label),
          record: (type, detail) => recorder.event({ type, detail }),
        })
      : undefined;

    await guarded.navigate(request.baseUrl);

    for (let step = 0; step < maxSteps; step++) {
      const observation = await surface.observe(step);
      await recorder.screenshot(await surface.screenshot(), `step-${String(step).padStart(2, "0")}`);
      await recorder.event({
        type: "observe",
        stepIndex: step,
        detail: { url: observation.url, title: observation.title, alerts: observation.alerts },
      });

      messages.push({ role: "user", content: renderObservation(observation, request, step) });

      recorder.recordModelCall();
      modelCalls++;
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        system,
        tools: [ACT_TOOL, FINISH_TOOL, STUCK_TOOL],
        // One action per turn. The loop observes between actions, so a batch would have the
        // model deciding its second move from a page state it has not seen — exactly the
        // guesswork this design exists to avoid. It also keeps the recorded step sequence a
        // faithful account of what actually happened, in order.
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages,
      });
      recorder.recordUsage(response.usage);
      messages.push({ role: "assistant", content: response.content });

      const calls = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      const call = calls[0];

      // Any tool_use without a matching tool_result is a protocol error on the next request, so
      // extras are acknowledged even though only the first is acted on.
      const surplus: Anthropic.ContentBlockParam[] = calls.slice(1).map((extra) => ({
        type: "tool_result",
        tool_use_id: extra.id,
        content: "Ignored: take one action per turn and observe the result before the next.",
      }));

      if (!call) {
        messages.push({
          role: "user",
          content: "You must call one of the available tools. Take an action, finish, or give up.",
        });
        continue;
      }

      if (call.name === "give_up") {
        const reason = String((call.input as { reason?: string }).reason ?? "unspecified");
        await recorder.event({ type: "discovery.stuck", detail: { reason } });
        await recorder.failureSnapshot(observation, { reason });
        return { status: "stuck", reason, evidenceDir: recorder.directory, modelCalls };
      }

      if (call.name === "finish") {
        const finish = call.input as FinishInput;
        const ok = await guarded.verify({ kind: "text", value: finish.checkpointText, visible: true });
        if (!ok) {
          // The model believes it is done and the page disagrees. Say so and let it continue
          // rather than recording a capability whose checkpoint fails on the first replay.
          messages.push({
            role: "user",
            content: [
              ...toolResult(
                call.id,
                `The text "${finish.checkpointText}" is not visible on this page, so the goal is ` +
                  `not verifiably reached. Keep going or give up.`,
              ),
              ...surplus,
            ],
          });
          continue;
        }

        await recorder.event({ type: "discovery.complete", detail: { steps: recorded.length } });
        const artifact = buildArtifact(request, recorded, finish, {
          app,
          surface: surfaceKind,
          skills: renderedSkills.provenance,
          memory: renderedMemory.provenance,
        });
        return { status: "recorded", artifact, evidenceDir: recorder.directory, modelCalls };
      }

      // ── act ──
      const proposal = call.input as ActInput;
      const built = buildAction(proposal, request);
      if (!built.ok) {
        messages.push({ role: "user", content: [...toolResult(call.id, built.error), ...surplus] });
        continue;
      }

      // ── Risk gate ────────────────────────────────────────────────────────
      //
      // The same gate replay uses, reached by a different route: replay reads the risk off the
      // artifact, discovery infers it from the control. Without this, the default policy
      // permits clicks and an exploring model could submit a transfer because the flow had not
      // been written down yet.
      const gate = await gateRiskyAction(built, proposal, guard, controller, {
        runId: recorder.runId,
        capabilityId: request.capabilityId,
        goal: request.goal,
        step,
      });
      if (gate) {
        await recorder.event({
          type: "discovery.approval",
          stepIndex: step,
          detail: { decision: gate.decision, control: gate.control },
        });
        if (gate.decision !== "proceed") {
          messages.push({
            role: "user",
            content: [...toolResult(call.id, gate.message), ...surplus],
          });
          continue;
        }
      }

      const outcome = await execute(built.action, built.target, guarded, {
        baseUrl: request.baseUrl,
        inputs: request.inputs,
        secrets: request.secrets,
        vars: {},
      });
      await recorder.event({
        type: outcome.ok ? "act.ok" : "act.failed",
        stepIndex: step,
        actionType: proposal.action,
        detail: { rationale: proposal.rationale, error: outcome.error },
        ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
      });

      if (outcome.ok) {
        recorded.push({
          action: built.action,
          ...(built.target === undefined ? {} : { target: built.target }),
          rationale: proposal.rationale,
          ...(built.extractAs === undefined ? {} : { extractAs: built.extractAs }),
        });
      }

      messages.push({
        role: "user",
        content: [
          ...toolResult(
            call.id,
            outcome.ok
              ? `Done.${outcome.value ? ` Read: ${outcome.value}` : ""}`
              : `That failed: ${outcome.error}. Try a different approach.`,
          ),
          ...surplus,
        ],
      });
    }

    const reason = `reached the step limit (${maxSteps}) without achieving the goal`;
    await recorder.event({ type: "discovery.stuck", detail: { reason } });
    return { status: "stuck", reason, evidenceDir: recorder.directory, modelCalls };
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err));
    await recorder.event({ type: "discovery.failed", detail: { reason } });
    return { status: "failed", reason, evidenceDir: recorder.directory, modelCalls };
  } finally {
    // In `finally` because every exit from this function — recorded, stuck, failed, or thrown
    // — spent the same money, and an audit that only accounts for successful runs is the one
    // that understates the bill.
    await recorder.writeUsage().catch(() => {});
    if (surface) {
      const closed = await closeSurface(surface);
      if (!closed.ok) {
        await recorder
          .event({ type: "surface.teardown_failed", detail: { reason: redact(closed.reason) } })
          .catch(() => {});
      }
    }
  }
}


// ─── Observation rendering ─────────────────────────────────────────────────────

function renderObservation(
  observation: Observation,
  request: DiscoveryRequest,
  step: number,
): string {
  const lines = [
    step === 0 ? `GOAL: ${request.goal}` : "",
    step === 0 && Object.keys(request.inputs).length > 0
      ? `VALUES TO USE: ${Object.entries(request.inputs)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`
      : "",
    step === 0 && Object.keys(request.secrets).length > 0
      ? `CREDENTIALS: reference them by name — ${Object.keys(request.secrets).join(", ")}. ` +
        `Type the literal placeholder {{secrets.<name>}} into credential fields.`
      : "",
    "",
    `STEP ${step}`,
    `url:   ${observation.url}`,
    `title: ${observation.title}`,
    observation.alerts.length > 0 ? `alerts: ${observation.alerts.join(" | ")}` : "",
    "",
    "ACCESSIBILITY SNAPSHOT",
    observation.ariaSnapshot.slice(0, 8000),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

function toolResult(id: string, text: string): Anthropic.ContentBlockParam[] {
  return [{ type: "tool_result", tool_use_id: id, content: text }];
}

// ─── Turning a proposal into a typed action ────────────────────────────────────

interface ActInput {
  action: string;
  rationale: string;
  role: string | null;
  name: string | null;
  css: string | null;
  cell: string | null;
  button: "left" | "right" | null;
  keys: string | null;
  value: string | null;
  url: string | null;
  text: string | null;
  as: string | null;
}

interface FinishInput {
  checkpointText: string;
  outputs: Array<{ name: string; variable: string; type: string; coerce: string | null }>;
}

interface RecordedStep {
  action: Action;
  target?: Target;
  rationale: string;
  extractAs?: string;
}

/**
 * Builds locator candidates from what the model proposed.
 *
 * Ordering is not the model's choice: role+name always goes first when it supplied one, because
 * the preference order is a property of this system rather than of any particular suggestion.
 */
function buildTarget(proposal: ActInput): Target | { error: string } {
  const candidates: LocatorCandidate[] = [];
  // First, because it is the most durable thing a grid can offer: a cell's name is its value,
  // and a recording that targeted the name would break the next time anything wrote to it.
  if (proposal.cell) candidates.push({ strategy: "cell", ref: proposal.cell });
  if (proposal.role && proposal.name) {
    candidates.push({ strategy: "role", role: proposal.role, name: proposal.name, exact: false });
  }
  if (proposal.css) candidates.push({ strategy: "css", value: proposal.css });
  if (candidates.length === 0) {
    return { error: "give an accessible role and name, a cell reference, or a CSS selector." };
  }
  return {
    candidates,
    ...(proposal.name ? { description: proposal.name } : proposal.cell ? { description: `cell ${proposal.cell}` } : {}),
  };
}

type BuiltAction =
  | { ok: true; action: Action; target?: Target; extractAs?: string }
  | { ok: false; error: string };

function buildAction(proposal: ActInput, request: DiscoveryRequest): BuiltAction {
  const needsTarget = ["click", "fill", "select", "extract"].includes(proposal.action);
  // `press` is the one action whose target is optional: keys with no target go to whatever
  // has focus, which is how a selection made by an earlier step is acted on.
  const mayHaveTarget =
    needsTarget ||
    (proposal.action === "press" && Boolean(proposal.role ?? proposal.cell ?? proposal.css));
  let target: Target | undefined;

  if (mayHaveTarget) {
    const built = buildTarget(proposal);
    if ("error" in built) return { ok: false, error: built.error };
    target = built;
  }

  const raw: Record<string, unknown> = { action: proposal.action };
  switch (proposal.action) {
    case "navigate": {
      if (!proposal.url) return { ok: false, error: "navigate needs a url." };
      // Resolve any placeholder the model echoed back, so the policy check sees a real URL.
      raw.url = proposal.url;
      break;
    }
    case "click":
      raw.target = target;
      // Carried through, because a right-click reaches operations that have no other route.
      // Dropped here, a model asking for a context menu would silently get a left-click.
      if (proposal.button) raw.button = proposal.button;
      break;
    case "press": {
      if (!proposal.keys) return { ok: false, error: "press needs keys, such as Enter." };
      raw.keys = proposal.keys;
      // Optional: keys with no target go wherever focus already is, which is how a grid is
      // driven after a selection.
      if (target) raw.target = target;
      break;
    }
    case "fill":
    case "select": {
      if (proposal.value === null) return { ok: false, error: `${proposal.action} needs a value.` };
      raw.target = target;
      raw.value = proposal.value;
      break;
    }
    case "wait": {
      if (!proposal.text) return { ok: false, error: "wait needs text to wait for." };
      raw.condition = { kind: "text", value: proposal.text };
      raw.timeoutMs = 10_000;
      break;
    }
    case "assert": {
      if (!proposal.text) return { ok: false, error: "assert needs text." };
      raw.condition = { kind: "text", value: proposal.text };
      break;
    }
    case "extract": {
      if (!proposal.as) return { ok: false, error: "extract needs an `as` name." };
      raw.target = target;
      raw.as = proposal.as;
      break;
    }
    default:
      return { ok: false, error: `unknown action "${proposal.action}".` };
  }

  // Every model-produced action is parsed against the same schema replay uses. A proposal that
  // cannot survive that never reaches the browser.
  const parsed = Action.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  void request;
  return {
    ok: true,
    action: parsed.data,
    ...(target === undefined ? {} : { target }),
    ...(proposal.as === null ? {} : { extractAs: proposal.as }),
  };
}

/**
 * Executes the action the model proposed, with references resolved.
 *
 * The split here is the point of the whole design, and getting it backwards is what the first
 * real discovery run caught: the model is told to type `{{secrets.parabankPassword}}`, and that
 * placeholder is what gets RECORDED — but what reaches the browser has to be the actual
 * credential, or the run simply types the literal text into the password field and login fails.
 *
 * So resolution happens here, at the edge, and nowhere near the recorder. The artifact keeps
 * the reference; the browser gets the value; the value is never written down.
 */
async function execute(
  action: Action,
  target: Target | undefined,
  surface: GuardedSurface,
  scope: TemplateScope,
): Promise<{ ok: boolean; value?: string; error?: string; errorCode?: string }> {
  const resolve = (value: string): string => {
    try {
      return resolveTemplate(value, scope);
    } catch {
      // An unresolvable reference is left as-is; the action then fails visibly rather than
      // silently typing an empty string.
      return value;
    }
  };

  switch (action.action) {
    case "navigate":
      return surface.navigate(resolve(action.url));
    case "click":
      return surface.click(target!);
    case "fill":
      return surface.fill(target!, resolve(action.value));
    case "select":
      return surface.select(target!, resolve(action.value));
    case "wait":
      return surface.waitFor(action.condition, action.timeoutMs);
    case "assert": {
      const ok = await surface.verify(action.condition);
      return ok ? { ok: true } : { ok: false, error: `${describeCondition(action.condition)} is not true` };
    }
    case "extract":
      return surface.extract(target!);
    case "press":
      return surface.press(resolve(action.keys), target);
  }
}


/**
 * Refuses, or escalates, an action aimed at a control the policy calls risky.
 *
 * Returns undefined when the action is ordinary. Otherwise the caller either proceeds (a human
 * said so) or feeds the refusal back to the model, which can then find another route or give up
 * — both better outcomes than an exploring agent committing a transaction nobody approved.
 */
async function gateRiskyAction(
  built: Extract<BuiltAction, { ok: true }>,
  proposal: ActInput,
  guard: PolicyGuard,
  controller: SessionController | undefined,
  context: { runId: string; capabilityId: string; goal: string; step: number },
): Promise<{ decision: string; control: string; message: string } | undefined> {
  // `press` is in the list for the same reason as the rest: Enter on a focused Transfer button
  // moves money exactly as clicking it does, and a risk gate that only watched the mouse would
  // be trivially stepped around by an exploring model that reached for the keyboard.
  const mutating = ["click", "fill", "select", "press"].includes(built.action.action);
  if (!mutating) return undefined;

  const descriptors: Array<string | undefined> = [
    proposal.name ?? undefined,
    proposal.css ?? undefined,
    built.target?.description,
  ];
  const risk = guard.classifyControl(descriptors);
  if (!guard.requiresApproval(risk)) return undefined;

  const control = descriptors.find(Boolean) ?? built.action.action;

  if (!controller) {
    return {
      decision: "refused",
      control,
      message:
        `Refused: "${control}" is classified as an irreversible control by policy, and this ` +
        `exploration is running unattended with no operator to approve it. Reach the goal ` +
        `another way, or call give_up so a human can take over.`,
    };
  }

  const outcome = await controller.handOver({
    runId: context.runId,
    reason: "approval_required",
    message: `Discovery wants to act on "${control}", which policy classifies as irreversible.`,
    capabilityId: context.capabilityId,
    goal: context.goal,
    step: { id: `discovery-step-${context.step}`, index: context.step },
  });

  if (outcome.decision === "proceed") {
    return { decision: "proceed", control, message: "" };
  }
  return {
    decision: outcome.decision,
    control,
    message:
      outcome.decision === "completed_by_human"
        ? `A human performed that action themselves. Continue from the current page state.`
        : `A human declined that action. Reach the goal another way, or call give_up.`,
  };
}

// ─── Recording ─────────────────────────────────────────────────────────────────

/**
 * Turns the run into a reusable capability.
 *
 * The parameterisation pass is what separates a capability from a recording. A run that typed
 * "12678" records `{{inputs.accountId}}`; a run that typed a password records
 * `{{secrets.parabankPassword}}` and the value is never written down at all.
 */
function buildArtifact(
  request: DiscoveryRequest,
  recorded: RecordedStep[],
  finish: FinishInput,
  /** What this compilation was given, recorded on the artifact it produces. */
  compiled: {
    app: string;
    surface: SurfaceKind;
    skills: { id: string; version: string }[];
    memory: { id: string; version: string }[];
  },
): CapabilityArtifact {
  const steps: ArtifactStep[] = recorded.map((entry, index) => ({
    id: `${entry.action.action}_${index}`,
    action: parameteriseAction(entry.action, request),
    rationale: entry.rationale,
  }));

  const inputs: Record<string, InputDefinition> = {};
  for (const name of Object.keys(request.inputs)) {
    inputs[name] = { type: "string", required: true, sensitive: false };
  }

  // A coercion determines the resulting type, so where the model's declaration disagrees the
  // coercion wins. This is normalisation rather than papering over a mistake: "currency" will
  // return a number whatever the artifact claims, and the catalog would otherwise advertise a
  // type the capability never produces. The schema rejects the mismatch; this stops a run being
  // thrown away over a redundant field.
  const YIELDS: Record<string, string> = {
    trim: "string",
    currency: "number",
    int: "number",
    number: "number",
  };

  const outputs: Record<string, unknown> = {};
  for (const output of finish.outputs) {
    const coerce = output.coerce ?? undefined;
    const type = coerce && YIELDS[coerce] ? YIELDS[coerce] : output.type;
    outputs[output.name] = {
      type,
      source: { kind: "variable", name: output.variable },
      ...(coerce ? { coerce } : {}),
      onMissing: "fail",
    };
  }

  // Handlers are not invented here. The model saw one path; claiming to know how this
  // application reports "record not found" from a single happy-path run would be fiction. A
  // reviewer adds them, which is part of why the artifact lands as a draft.
  const handlers: Handler[] = [];

  const candidate = {
    schemaVersion: "1.0",
    capabilityId: request.capabilityId,
    version: "1.0.0",
    metadata: {
      name: request.capabilityId.replace(/_/g, " "),
      description: request.goal,
      // Draft, always. It has replayed zero times and has no error handling yet.
      status: "draft",
      risk: "safe",
      recordedAt: new Date().toISOString(),
      recordedBy: "llm",
      model: MODEL,
      compiledWith: { skills: compiled.skills, memory: compiled.memory },
    },
    target: {
      app: compiled.app,
      surface: compiled.surface,
      baseUrl: request.baseUrl,
    },
    inputs,
    outputs,
    steps,
    handlers,
    checkpoint: { kind: "text", value: finish.checkpointText },
  };

  return ArtifactSchema.parse(candidate);
}

/**
 * Replaces literal values with references, so the flow is reusable rather than a transcript.
 *
 * This has to cover LOCATORS as well as values, which the first successful run made obvious:
 * the model reached the account by clicking a link whose accessible name was "12678". Nothing
 * about that step contains a value — the parameter is hiding in the target — so parameterising
 * only fill/select/navigate left a "reusable" capability wired to one specific account.
 */
function parameteriseTarget(target: Target, request: DiscoveryRequest): Target {
  const swap = (value: string): string => {
    let out = value;
    for (const [name, input] of Object.entries(request.inputs)) {
      if (!input) continue;
      // Substring, not equality: a selector like `a[href*="12678"]` embeds the value rather
      // than being it, and leaving that literal is exactly the silent-wrong-account case.
      if (out.includes(input)) out = out.split(input).join(`{{inputs.${name}}}`);
    }
    return out;
  };

  return {
    ...target,
    ...(target.description ? { description: swap(target.description) } : {}),
    candidates: target.candidates.map((candidate) => {
      // Every strategy that carries a string, not just the preferred one.
      //
      // A role candidate correctly becoming {{inputs.accountId}} while its CSS fallback stays
      // wired to "12678" is the worst outcome this system can produce: if the preferred locator
      // ever stops resolving, replay falls through and silently acts on the wrong account —
      // successfully. A wrong answer reported as success is worse than a refusal.
      switch (candidate.strategy) {
        case "role":
          return { ...candidate, name: swap(candidate.name) };
        case "text":
        case "css":
        case "label":
        case "testId":
          return { ...candidate, value: swap(candidate.value) };
        case "cell":
          // A cell reference is a coordinate in a grid, and parameterising it is exactly as
          // sensible as parameterising a locator's name: `{{inputs.column}}4` is a real thing
          // a recording should produce.
          return { ...candidate, ref: swap(candidate.ref) };
        case "coordinates":
          return candidate;
      }
    }),
  };
}

function parameteriseCondition<T>(condition: T, request: DiscoveryRequest): T {
  const node = condition as unknown as Record<string, unknown>;
  if (!node || typeof node !== "object") return condition;
  const swap = (value: string): string => {
    for (const [name, input] of Object.entries(request.inputs)) {
      if (input && value === input) return `{{inputs.${name}}}`;
    }
    return value;
  };
  if (node.kind === "text" || node.kind === "title") {
    return { ...node, value: swap(String(node.value)) } as T;
  }
  return condition;
}

function parameteriseAction(action: Action, request: DiscoveryRequest): Action {
  const swap = (value: string): string => {
    for (const [name, secret] of Object.entries(request.secrets)) {
      if (value === secret || value === `{{secrets.${name}}}`) return `{{secrets.${name}}}`;
    }
    for (const [name, input] of Object.entries(request.inputs)) {
      if (value === input) return `{{inputs.${name}}}`;
    }
    return value;
  };

  if (action.action === "fill" || action.action === "select") {
    return {
      ...action,
      value: swap(action.value),
      target: parameteriseTarget(action.target, request),
    };
  }
  if (action.action === "click" || action.action === "extract") {
    return { ...action, target: parameteriseTarget(action.target, request) };
  }
  if (action.action === "wait" || action.action === "assert") {
    // Waiting for the literal text "12678" is waiting for one specific account.
    return { ...action, condition: parameteriseCondition(action.condition, request) };
  }
  if (action.action === "navigate") {
    let url = action.url;
    // The base URL becomes a reference so a tenant can point the same capability elsewhere.
    if (url.startsWith(request.baseUrl)) {
      url = `{{baseUrl}}${url.slice(request.baseUrl.length)}`;
    }
    for (const [name, input] of Object.entries(request.inputs)) {
      if (input && url.includes(input)) url = url.split(input).join(`{{inputs.${name}}}`);
    }
    return { ...action, url };
  }
  return action;
}

