/**
 * Policy enforcement.
 *
 * The guard answers one question — "is the agent permitted to do this?" — and it answers it the
 * same way for discovery and for replay. Discovery is where an LLM proposes actions and is
 * therefore where a guard matters most, but a replay of a *recorded* flow is not self-evidently
 * safe either: the artifact may predate a policy change, or have been recorded against a
 * different tenant.
 *
 * Two layers, deliberately:
 *
 *   Advisory checks run before each action and refuse anything the policy disallows. They are
 *   precise and produce good errors, but they only see what the engine is about to do.
 *
 *   A network guard aborts document navigations to origins outside the allowlist at the
 *   browser level. This catches what the advisory layer structurally cannot — a click on a link
 *   that leaves the allowed application, a server-side redirect, a meta refresh. Checking the
 *   URL only after the fact would mean the browser had already been there.
 */
import type {
  Action,
  ActionType,
  Condition,
  Observation,
  Policy,
  RiskClass,
  Target,
} from "./schema.js";
import type { ActionOutcome, CoordinateClickOutcome, Surface } from "./surface.js";
import { globToRegExp } from "./surface.js";

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

const ALLOWED: PolicyDecision = { allowed: true };

export class PolicyGuard {
  private readonly pathPatterns: RegExp[];
  private started = Date.now();
  private steps = 0;

  constructor(readonly policy: Policy) {
    this.pathPatterns = policy.allowedPaths.map(globToRegExp);
  }

  /** Restarts the budget clock. Called when a run actually begins. */
  begin(): void {
    this.started = Date.now();
    this.steps = 0;
  }

  /**
   * Whether a URL is inside the allowlist.
   *
   * Origin comparison is exact and canonical — the allowlist is parsed into origins by the
   * schema, so "https://bank.test" never matches "https://bank.test.evil.com". Path matching is
   * glob-based and only applies when patterns are configured; no patterns means any path under
   * an allowed origin.
   */
  checkUrl(url: string): PolicyDecision {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: `not a valid URL: ${url}` };
    }

    if (!this.policy.allowedOrigins.includes(parsed.origin)) {
      return {
        allowed: false,
        reason: `origin ${parsed.origin} is not in the allowlist (${this.policy.allowedOrigins.join(", ")})`,
      };
    }

    if (this.pathPatterns.length > 0 && !this.pathPatterns.some((re) => re.test(parsed.pathname))) {
      return {
        allowed: false,
        reason: `path ${parsed.pathname} does not match any allowed route (${this.policy.allowedPaths.join(", ")})`,
      };
    }

    return ALLOWED;
  }

  /** Whether an action type is permitted at all. Blocked wins over allowed. */
  checkActionType(type: ActionType): PolicyDecision {
    if (this.policy.blockedActions.includes(type)) {
      return { allowed: false, reason: `action type "${type}" is blocked by policy` };
    }
    if (!this.policy.allowedActions.includes(type)) {
      return { allowed: false, reason: `action type "${type}" is not in the allowed set` };
    }
    return ALLOWED;
  }

  /**
   * Full check for one resolved action.
   *
   * `resolvedUrl` is the post-template URL for a navigate. It is checked here rather than
   * relying on the network guard alone, so a disallowed destination is refused with a precise
   * message instead of surfacing as an aborted request.
   */
  checkAction(action: Action, resolvedUrl?: string): PolicyDecision {
    const type = this.checkActionType(action.action);
    if (!type.allowed) return type;

    if (action.action === "navigate" && resolvedUrl !== undefined) {
      return this.checkUrl(resolvedUrl);
    }
    return ALLOWED;
  }

  /**
   * Whether a risk classification requires a human before the step runs.
   *
   * Policy decides this, not the engine. A tenant that wants every write gated can add "safe"
   * to `requireApprovalFor`; one that trusts an approved capability can empty the list. The
   * engine hardcoding "approval_required" would have made the policy field decorative.
   */
  requiresApproval(risk: RiskClass): boolean {
    return this.policy.requireApprovalFor.includes(risk);
  }

  /**
   * Classifies a control the model is about to act on.
   *
   * Replay learns risk from the artifact. Discovery is *producing* the artifact, so it has no
   * such declaration — this is the only thing standing between an exploring model and an
   * irreversible transaction. Matched case-insensitively against whatever identifies the
   * control: its accessible name, its description, or its selector.
   */
  classifyControl(descriptors: ReadonlyArray<string | undefined>): RiskClass {
    for (const pattern of this.policy.riskyControls) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        continue; // Validated at policy load; a survivor here is not worth crashing a run for.
      }
      for (const descriptor of descriptors) {
        if (descriptor && re.test(descriptor)) return "approval_required";
      }
    }
    return "safe";
  }

  /** Counts a step and enforces the step ceiling. */
  countStep(): PolicyDecision {
    this.steps++;
    if (this.steps > this.policy.maxSteps) {
      return {
        allowed: false,
        reason: `step budget exhausted (${this.policy.maxSteps} steps)`,
      };
    }
    return ALLOWED;
  }

  /** How much of the run's wall-clock budget is left. Never negative. */
  remainingMs(): number {
    return Math.max(0, this.policy.runTimeoutMs - (Date.now() - this.started));
  }

  /** Enforces the wall-clock ceiling for a whole run. */
  checkDeadline(): PolicyDecision {
    const elapsed = Date.now() - this.started;
    if (elapsed > this.policy.runTimeoutMs) {
      return {
        allowed: false,
        reason: `run timeout exceeded (${this.policy.runTimeoutMs}ms)`,
      };
    }
    return ALLOWED;
  }

  /**
   * Checked before a run starts: an artifact longer than the step ceiling can never complete,
   * and finding that out on step 41 wastes a live session.
   */
  checkArtifactFits(stepCount: number): PolicyDecision {
    if (stepCount > this.policy.maxSteps) {
      return {
        allowed: false,
        reason: `artifact has ${stepCount} steps but policy allows ${this.policy.maxSteps}`,
      };
    }
    return ALLOWED;
  }

  /**
   * The predicate handed to the browser-level guard.
   *
   * Deliberately narrower than `checkUrl`: it gates *document navigation* only. Blocking
   * sub-resources would break pages that legitimately load styles or images from elsewhere,
   * and the threat this addresses is the session going somewhere it should not — not a
   * stylesheet. Documented as a limit in REPORT.md rather than silently assumed.
   */
  navigationAllowed = (url: string): boolean => this.checkUrl(url).allowed;
}

/** Builds a guard from policy, with the ParaBank-shaped default living in config.ts. */
export function createGuard(policy: Policy): PolicyGuard {
  return new PolicyGuard(policy);
}

// ─── Guarded surface ───────────────────────────────────────────────────────────

/**
 * A Surface that refuses anything policy disallows.
 *
 * Putting the checks in a wrapper rather than in the replay loop is what makes them
 * unavoidable. The loop is not the only thing that drives the browser: a `dismiss` remedy
 * clicks, a re-authentication callback navigates and types, and output collection extracts.
 * Each of those is a real action against a real application, and each was reaching the browser
 * without passing a single check while the loop above it was carefully guarded.
 *
 * Anything holding one of these cannot act outside the policy, whoever wrote it.
 */
export class GuardedSurface implements Surface {
  constructor(
    private readonly inner: Surface,
    private readonly guard: PolicyGuard,
    /** Called whenever something is refused, so the run log records why. */
    private readonly onDenied?: (reason: string) => void,
  ) {}

  private deny(reason: string): ActionOutcome {
    this.onDenied?.(reason);
    return { ok: false, errorCode: "POLICY_DENIED", error: reason };
  }

  /** Type check plus the run deadline, applied to every action that touches the browser. */
  private precheck(type: ActionType): ActionOutcome | undefined {
    const allowed = this.guard.checkActionType(type);
    if (!allowed.allowed) return this.deny(allowed.reason ?? `action "${type}" refused`);

    // Checked here, not only in the step loop, so a long chain of remedies or output reads
    // cannot run past the ceiling unobserved.
    const deadline = this.guard.checkDeadline();
    if (!deadline.allowed) return this.deny(deadline.reason ?? "run timeout exceeded");

    return undefined;
  }

  /**
   * Re-checks the address after an action.
   *
   * The browser-level guard only sees document requests. A single-page app that routes with
   * `history.pushState()` issues none, so a click could move from an allowed route to /admin
   * and every later step would run there, inside the allowlist as far as the network was
   * concerned. ParaBank is server-rendered and never does this; the check exists because the
   * design claim is about surfaces in general, not about ParaBank.
   */
  private checkLanding(): ActionOutcome | undefined {
    // A surface whose locations are opaque cannot be policed by an origin allowlist. Skipping
    // is not a loophole: `checkUrl` still rejects anything non-http on a `url` surface, so a
    // browser cannot reach `data:` or `javascript:` by claiming to be opaque.
    if (this.inner.locationKind !== "url") return undefined;

    const url = this.inner.currentUrl();
    if (url === "about:blank") return undefined;
    const decision = this.guard.checkUrl(url);
    if (decision.allowed) return undefined;
    return this.deny(`after acting, the session was at ${url}: ${decision.reason}`);
  }

  async navigate(url: string): Promise<ActionOutcome> {
    const refused = this.precheck("navigate");
    if (refused) return refused;

    // The destination is checked before the request, so a disallowed URL produces a precise
    // refusal rather than an aborted-request error from the network guard.
    const target = this.guard.checkUrl(url);
    if (!target.allowed) return this.deny(target.reason ?? `navigation to ${url} refused`);

    const result = await this.inner.navigate(url);
    return this.checkLanding() ?? result;
  }

  async click(target: Target): Promise<ActionOutcome> {
    const refused = this.precheck("click");
    if (refused) return refused;
    const result = await this.inner.click(target);
    return this.checkLanding() ?? result;
  }

  async fill(target: Target, value: string): Promise<ActionOutcome> {
    const refused = this.precheck("fill");
    if (refused) return refused;
    const result = await this.inner.fill(target, value);
    return this.checkLanding() ?? result;
  }

  async select(target: Target, value: string): Promise<ActionOutcome> {
    const refused = this.precheck("select");
    if (refused) return refused;
    const result = await this.inner.select(target, value);
    return this.checkLanding() ?? result;
  }

  async waitFor(condition: Condition, timeoutMs: number): Promise<ActionOutcome> {
    const refused = this.precheck("wait");
    if (refused) return refused;
    // Never wait past the run's own ceiling.
    return this.inner.waitFor(condition, Math.max(0, Math.min(timeoutMs, this.guard.remainingMs())));
  }

  async extract(target: Target, attribute?: string): Promise<ActionOutcome> {
    // Output collection reads through this too, so "extract is blocked" cannot be sidestepped
    // by declaring a locator-backed output instead of an extract step.
    const refused = this.precheck("extract");
    if (refused) return refused;
    return attribute === undefined
      ? this.inner.extract(target)
      : this.inner.extract(target, attribute);
  }

  async verify(condition: Condition): Promise<boolean> {
    return this.inner.verify(condition);
  }

  get locationKind(): "url" | "opaque" {
    return this.inner.locationKind;
  }

  currentUrl(): string {
    return this.inner.currentUrl();
  }

  takeBlockedNavigations(): string[] {
    return this.inner.takeBlockedNavigations();
  }

  /** Passed through: capturing evidence is neither a policy decision nor a mutation. */
  async screenshot(mask?: readonly string[]): Promise<Buffer> {
    return mask === undefined ? this.inner.screenshot() : this.inner.screenshot(mask);
  }

  async clickAt(x: number, y: number): Promise<CoordinateClickOutcome> {
    const refused = this.precheck("click");
    if (refused) return refused;
    const result = await this.inner.clickAt(x, y);
    const landing = this.checkLanding();
    return landing ? { ...landing } : result;
  }

  async observe(step: number): Promise<Observation> {
    return this.inner.observe(step);
  }

  async close(): Promise<string | undefined> {
    return this.inner.close();
  }
}
