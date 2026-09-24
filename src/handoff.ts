/**
 * Human-in-the-loop escalation and control transfer.
 *
 * The seam this file defines is *who is holding the session*. Automation and a human operate
 * the same live browser — not a copy, not a fresh one — so at any moment exactly one of them is
 * allowed to act, and the other must be structurally unable to.
 *
 * That is the part that has to be real. An intervention request that merely prints a message
 * and waits is theatre: if automation can still click while a person is typing into the same
 * form, control was never transferred. The ownership lock is enforced in the surface wrapper,
 * so an automation action taken while a human holds the session fails rather than races.
 */
import { randomUUID } from "node:crypto";
import type {
  Condition,
  InterventionReason,
  InterventionRequest,
  Observation,
  SessionOwner,
  Target,
} from "./schema.js";
import type { ActionOutcome, CoordinateClickOutcome, Surface } from "./surface.js";

/**
 * What the operator decided.
 *
 * Three outcomes rather than approve/deny, because a human who takes over a live session
 * usually does not just *authorise* the step — they perform it, with judgement the automation
 * did not have. Collapsing that into "approved" would make the automation redo work the person
 * already did, which on a funds transfer means doing it twice.
 */
export type InterventionDecision =
  | { decision: "proceed"; note?: string }
  | { decision: "completed_by_human"; note?: string }
  | { decision: "abort"; reason?: string };

/** How an intervention request reaches a person. The CLI implementation is the v1 stand-in. */
export interface InterventionChannel {
  request(request: InterventionRequest): Promise<InterventionDecision>;
}

/** A sanitised record of something the human did while holding the session. */
export interface HumanEvent {
  at: string;
  type: "click" | "input" | "change" | "submit" | "navigate";
  url: string;
  tag?: string;
  role?: string;
  name?: string;
  id?: string;
  /**
   * Length only, never content.
   *
   * What a person typed into a bank's back office is exactly the class of data that must not be
   * persisted. The length is enough to show that a field was filled and roughly how, which is
   * what an auditor needs; the characters are not.
   */
  valueLength?: number;
}

export class HandoffError extends Error {}

/**
 * Owns the answer to "who may act right now", and the transition between them.
 */
export class SessionController {
  private currentOwner: SessionOwner = "automation";
  private readonly events: HumanEvent[] = [];
  private activeIntervention: string | undefined;

  constructor(
    private readonly channel: InterventionChannel,
    private readonly hooks: {
      /** Fresh observation + screenshot, taken before handing over and again after taking back. */
      observe: () => Promise<Observation>;
      screenshot: (label: string) => Promise<string>;
      record: (type: string, detail: Record<string, unknown>) => Promise<void>;
    },
  ) {}

  get owner(): SessionOwner {
    return this.currentOwner;
  }

  /** Events captured while the human held the session. */
  get humanEvents(): readonly HumanEvent[] {
    return this.events;
  }

  /** Called by the surface's capture hook; ignored unless a human currently holds the session. */
  noteHumanEvent(event: HumanEvent): void {
    if (this.currentOwner !== "human") return;
    this.events.push(event);
  }

  /**
   * Hands the live session to a person, waits for them, and takes it back.
   *
   * The ordering matters and is the whole point: ownership changes *before* the request is
   * routed, so from the instant a person could be looking at the screen, automation is already
   * locked out. It is restored only after a fresh observation, because the page is almost
   * certainly not where automation left it.
   */
  async handOver(context: {
    runId: string;
    reason: InterventionReason;
    message: string;
    capabilityId?: string;
    goal?: string;
    step?: { id: string; index: number };
  }): Promise<InterventionDecision> {
    if (this.currentOwner === "human") {
      throw new HandoffError("session is already held by a human");
    }

    const interventionId = randomUUID();
    this.activeIntervention = interventionId;

    // Context is captured BEFORE handing over, so the operator sees the state that caused the
    // stop rather than whatever the page has become by the time they look.
    const observation = await this.hooks.observe();
    const screenshot = await this.hooks.screenshot(`intervention-${context.step?.id ?? "run"}`);

    this.currentOwner = "human";

    const request: InterventionRequest = {
      interventionId,
      runId: context.runId,
      ...(context.capabilityId === undefined ? {} : { capabilityId: context.capabilityId }),
      ...(context.goal === undefined ? {} : { goal: context.goal }),
      ...(context.step === undefined ? {} : { step: context.step }),
      reason: context.reason,
      message: context.message,
      screenshot,
      observedState: {
        url: observation.url,
        title: observation.title,
        alerts: observation.alerts,
      },
      requestedAt: new Date().toISOString(),
    };

    await this.hooks.record("handoff.requested", {
      interventionId,
      reason: context.reason,
      step: context.step?.id,
      url: observation.url,
    });

    let decision: InterventionDecision;
    try {
      decision = await this.channel.request(request);
    } finally {
      // Control comes back even if the channel threw. A crashed operator console must not leave
      // the session permanently locked with nothing able to act on it.
      this.currentOwner = "automation";
      this.activeIntervention = undefined;
    }

    // Re-observe before automation continues. Whatever the person did, the page has moved.
    const after = await this.hooks.observe();
    await this.hooks.screenshot(`resumed-${context.step?.id ?? "run"}`);

    await this.hooks.record("handoff.returned", {
      interventionId,
      decision: decision.decision,
      humanEvents: this.events.length,
      url: after.url,
    });

    return decision;
  }

  /** The id of the intervention currently in flight, if any. */
  get pendingInterventionId(): string | undefined {
    return this.activeIntervention;
  }
}

// ─── Ownership enforcement ─────────────────────────────────────────────────────

/**
 * A Surface that refuses to act while a human holds the session.
 *
 * Wrapped OUTSIDE the policy guard, so ownership is decided first: if a person is driving, no
 * question about what policy would have permitted is even asked.
 *
 * Reads stay available — the engine has to be able to observe in order to take the session back
 * sensibly — but nothing that changes the page gets through.
 */
export class OwnedSurface implements Surface {
  constructor(
    private readonly inner: Surface,
    private readonly controller: SessionController,
  ) {}

  private locked(action: string): ActionOutcome {
    return {
      ok: false,
      errorCode: "POLICY_DENIED",
      error:
        `automation attempted "${action}" while the session is held by a human ` +
        `(intervention ${this.controller.pendingInterventionId ?? "unknown"})`,
    };
  }

  private get humanHolds(): boolean {
    return this.controller.owner === "human";
  }

  async navigate(url: string): Promise<ActionOutcome> {
    return this.humanHolds ? this.locked("navigate") : this.inner.navigate(url);
  }

  async click(target: Target): Promise<ActionOutcome> {
    return this.humanHolds ? this.locked("click") : this.inner.click(target);
  }

  async fill(target: Target, value: string): Promise<ActionOutcome> {
    return this.humanHolds ? this.locked("fill") : this.inner.fill(target, value);
  }

  async select(target: Target, value: string): Promise<ActionOutcome> {
    return this.humanHolds ? this.locked("select") : this.inner.select(target, value);
  }

  async clickAt(x: number, y: number): Promise<CoordinateClickOutcome> {
    return this.humanHolds ? this.locked("clickAt") : this.inner.clickAt(x, y);
  }

  async waitFor(condition: Condition, timeoutMs: number): Promise<ActionOutcome> {
    return this.inner.waitFor(condition, timeoutMs);
  }

  async extract(target: Target, attribute?: string): Promise<ActionOutcome> {
    return attribute === undefined
      ? this.inner.extract(target)
      : this.inner.extract(target, attribute);
  }

  async verify(condition: Condition): Promise<boolean> {
    return this.inner.verify(condition);
  }

  currentUrl(): string {
    return this.inner.currentUrl();
  }

  takeBlockedNavigations(): string[] {
    return this.inner.takeBlockedNavigations();
  }

  async observe(step: number): Promise<Observation> {
    return this.inner.observe(step);
  }

  async close(): Promise<string | undefined> {
    return this.inner.close();
  }
}

// ─── CLI channel (the v1 operator surface) ─────────────────────────────────────

/**
 * Routes an intervention to whoever is running the command.
 *
 * Deliberately minimal and openly a stand-in: a real deployment routes to a queue and streams
 * the session to a remote console. What is NOT a stand-in is the contract around it — the
 * request carries enough context to act on, ownership genuinely transfers, the human's actions
 * are recorded, and control comes back. Swapping this class for a queue consumer changes no
 * other file.
 */
export class CliInterventionChannel implements InterventionChannel {
  constructor(
    private readonly io: {
      write: (text: string) => void;
      readLine: () => Promise<string>;
    },
  ) {}

  async request(request: InterventionRequest): Promise<InterventionDecision> {
    const { write } = this.io;
    const state = request.observedState as { url?: string; title?: string; alerts?: string[] };

    write("\n");
    write("  ┌────────────────────────────────────────────────────────────────\n");
    write("  │ HUMAN INTERVENTION REQUIRED\n");
    write("  ├────────────────────────────────────────────────────────────────\n");
    write(`  │ why        : ${request.reason}\n`);
    write(`  │ ${request.message}\n`);
    if (request.capabilityId) write(`  │ capability : ${request.capabilityId}\n`);
    if (request.step) write(`  │ step       : ${request.step.index} "${request.step.id}"\n`);
    write(`  │ page       : ${state.title ?? "?"}\n`);
    write(`  │ url        : ${state.url ?? "?"}\n`);
    if (state.alerts?.length) write(`  │ on screen  : ${state.alerts.join(" | ")}\n`);
    write(`  │ screenshot : ${request.screenshot ?? "(none)"}\n`);
    write("  ├────────────────────────────────────────────────────────────────\n");
    write("  │ The browser window is yours. Automation is locked out until you\n");
    write("  │ hand it back.\n");
    write("  │\n");
    write("  │   [d]one   you performed the step yourself; skip it and continue\n");
    write("  │   [p]roceed  you approve; automation performs the step\n");
    write("  │   [a]bort  stop the run\n");
    write("  └────────────────────────────────────────────────────────────────\n");
    write("  > ");

    const answer = (await this.io.readLine()).trim().toLowerCase();

    if (answer.startsWith("p")) return { decision: "proceed" };
    if (answer.startsWith("d")) return { decision: "completed_by_human" };
    // Anything else, including an empty line or a closed stdin, stops the run. The safe reading
    // of "no clear answer" on a financial action is not to perform it.
    return { decision: "abort", reason: answer ? `operator answered "${answer}"` : "no response" };
  }
}

/** Non-interactive channel used by tests and by callers that cannot prompt. */
export class ScriptedInterventionChannel implements InterventionChannel {
  readonly received: InterventionRequest[] = [];

  constructor(private readonly decide: (request: InterventionRequest) => InterventionDecision) {}

  async request(request: InterventionRequest): Promise<InterventionDecision> {
    this.received.push(request);
    return this.decide(request);
  }
}
