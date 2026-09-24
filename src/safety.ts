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
import type { Action, ActionType, Policy, RiskClass } from "./schema.js";
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
