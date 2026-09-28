/**
 * A `Surface` over a platform accessibility API.
 *
 * The second implementation of the port, and the point of the port existing. Nothing above
 * `Surface` changes to accommodate it: replay, handlers, policy, the ownership lock and
 * evidence are the same code that drives a browser.
 *
 * What is different, and why:
 *
 * **Locations are opaque.** A desktop session is in an application and a window, not at a URL,
 * so `locationKind` is `"opaque"` and the guard polices it with `allowedApplications` instead
 * of `allowedOrigins`. That dispatch is in `safety.ts`; this file only has to report honestly.
 *
 * **Resolution happens here, not in the helper.** The helper returns every match; this file
 * enforces the same exactly-one-visible-match rule the browser path enforces. A surface that
 * quietly picked the first of three would turn replay's refusal to guess into a wrong click,
 * which is the failure the whole locator design exists to prevent.
 *
 * **Two locator strategies cannot work and say so.** `css` and `testId` mean nothing to an
 * accessibility tree. They are refused by name rather than skipped, because a web artifact
 * whose candidates all fail silently would fall through to whatever matched last.
 */
import { applicationOf, desktopLocation, windowOf } from "../location.js";
import type { Condition, Observation, Target } from "../schema.js";
import type { ActionOutcome, CoordinateClickOutcome, Surface } from "../surface.js";
import type { AxNode, DesktopTransport, DesktopWindow } from "./protocol.js";
import { collectAlerts, flatten, renderAxSnapshot } from "./snapshot.js";

export interface DesktopSurfaceOptions {
  transport: DesktopTransport;
  /**
   * Accessibility roles whose pixels are painted over before a screenshot exists.
   *
   * The desktop counterpart of masking password inputs by CSS selector. Defaults to the roles
   * platforms use for secure entry; a rendered pixel cannot be redacted after the fact, so this
   * has to be right at capture time rather than corrected later.
   */
  maskRoles?: readonly string[];
  defaultTimeoutMs?: number;
}

const DEFAULT_MASK_ROLES = ["securetextfield", "passwordtextbox"] as const;

/** A query the helper and the local matcher both understand. */
interface NodeQuery {
  role?: string;
  name?: string;
  text?: string;
}

const ok = (value?: string): ActionOutcome =>
  value === undefined ? { ok: true } : { ok: true, value };
const fail = (error: string): ActionOutcome => ({ ok: false, error });

export class DesktopSurface implements Surface {
  readonly locationKind = "opaque" as const;

  private readonly transport: DesktopTransport;
  private readonly maskRoles: readonly string[];
  private readonly defaultTimeoutMs: number;
  private where: DesktopWindow | undefined;

  constructor(options: DesktopSurfaceOptions) {
    this.transport = options.transport;
    this.maskRoles = options.maskRoles ?? DEFAULT_MASK_ROLES;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  }

  // ── Observation ───────────────────────────────────────────────────────────

  async observe(step: number): Promise<Observation> {
    const { window, tree } = await this.transport.request("observe", {});
    this.where = window;
    return {
      url: desktopLocation(window.application, window.window),
      title: window.window,
      ariaSnapshot: renderAxSnapshot(tree),
      alerts: collectAlerts(tree),
      step,
    };
  }

  currentUrl(): string {
    // Before the first observation there is no window to name. `about:blank` is what the
    // browser surface reports in the same state, and the landing check already skips it.
    if (!this.where) return "about:blank";
    return desktopLocation(this.where.application, this.where.window);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * "Navigate", on a desktop, is focus-or-launch an application.
   *
   * Takes the same `app://` location the policy allowlist is written against, so the guard
   * above has already decided whether this application may be entered by the time we get here.
   */
  async navigate(location: string): Promise<ActionOutcome> {
    const application = applicationOf(location);
    if (application === undefined) {
      return fail(`not an application location: ${location} (expected app://<application>)`);
    }
    try {
      this.where = await this.transport.request("focus", { application });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  async click(target: Target): Promise<ActionOutcome> {
    const query = this.toQuery(target);
    if ("error" in query) return fail(query.error);

    const resolved = await this.resolveExactlyOne(query.value);
    if ("error" in resolved) return fail(resolved.error);

    try {
      await this.transport.request("click", query.value);
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  async fill(target: Target, value: string): Promise<ActionOutcome> {
    const query = this.toQuery(target);
    if ("error" in query) return fail(query.error);

    const resolved = await this.resolveExactlyOne(query.value);
    if ("error" in resolved) return fail(resolved.error);

    try {
      await this.transport.request("fill", { ...query.value, value });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Selecting from a desktop control is a click on the option, not a separate verb.
   *
   * Platforms differ on whether a popup menu is a value to set or a list to open and click, and
   * the second works on both. The action vocabulary stays the same either way, which is the
   * part that matters to an artifact.
   */
  async select(target: Target, value: string): Promise<ActionOutcome> {
    const opened = await this.click(target);
    if (!opened.ok) return opened;
    return this.click({
      candidates: [{ strategy: "role", role: "option", name: value, exact: true }],
    });
  }

  async extract(target: Target, attribute?: string): Promise<ActionOutcome> {
    const query = this.toQuery(target);
    if ("error" in query) return fail(query.error);

    const resolved = await this.resolveExactlyOne(query.value);
    if ("error" in resolved) return fail(resolved.error);

    const node = resolved.value;
    // A secure field's contents are never read out, whatever the artifact asked for. An
    // extract that quietly returned a password would put it in outputs, evidence and logs at
    // once, and no redactor downstream knows it was supposed to be secret.
    if (node.sensitive === true) {
      return fail(`refusing to read a secure field (${node.role} ${node.name ?? ""})`.trim());
    }

    const value =
      attribute === undefined || attribute === "value"
        ? (node.value ?? node.name ?? "")
        : attribute === "name"
          ? (node.name ?? "")
          : undefined;

    if (value === undefined) {
      return fail(`no attribute "${attribute}" on an accessibility node (try value or name)`);
    }
    return ok(value);
  }

  async clickAt(x: number, y: number): Promise<CoordinateClickOutcome> {
    try {
      const { hit } = await this.transport.request("clickAt", { x, y });
      if (!hit) return { ok: true };
      // Reports what was under the cursor so discovery can turn a coordinate click into a real
      // locator — the same contract the browser surface has, for the same reason.
      return {
        ok: true,
        ...(hit.role === undefined ? {} : { role: hit.role }),
        ...(hit.name === undefined ? {} : { name: hit.name }),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Conditions ────────────────────────────────────────────────────────────

  async verify(condition: Condition): Promise<boolean> {
    const { tree } = await this.transport.request("observe", {});
    return this.matches(condition, tree);
  }

  async waitFor(condition: Condition, timeoutMs: number): Promise<ActionOutcome> {
    const deadline = Date.now() + (timeoutMs || this.defaultTimeoutMs);
    for (;;) {
      if (await this.verify(condition)) return ok();
      if (Date.now() >= deadline) return fail(`timed out waiting for ${condition.kind}`);
      await new Promise((resume) => setTimeout(resume, 100));
    }
  }

  private matches(condition: Condition, tree: AxNode): boolean {
    const nodes = flatten(tree);
    switch (condition.kind) {
      case "text":
        return nodes.some((n) => (n.name ?? n.value ?? "").includes(condition.value));
      case "role":
        return nodes.some(
          (n) =>
            n.role.toLowerCase() === condition.role.toLowerCase() &&
            (condition.name === undefined || (n.name ?? "") === condition.name),
        );
      case "urlPattern": {
        // A window title is the nearest thing a desktop session has to a URL. Matched here and
        // never in the policy guard: this is an artifact asserting where it expects to be,
        // which is a different question from whether it is allowed to be there.
        const location = this.currentUrl();
        return location.includes(condition.value.replace(/\*/g, "")) ||
          (windowOf(location) ?? "").includes(condition.value.replace(/\*/g, ""));
      }
      default:
        return false;
    }
  }

  // ── Locators ──────────────────────────────────────────────────────────────

  /**
   * The first candidate this surface can express, or why it can express none.
   *
   * Walked in the artifact's own order, so the preference the recording encoded — accessible
   * role and name first — is honoured here exactly as it is in a browser.
   */
  private toQuery(target: Target): { value: NodeQuery } | { error: string } {
    const refused: string[] = [];
    for (const candidate of target.candidates) {
      switch (candidate.strategy) {
        case "role":
          return {
            value: {
              role: candidate.role,
              ...(candidate.name === undefined ? {} : { name: candidate.name }),
            },
          };
        case "label":
          return { value: { name: candidate.value } };
        case "text":
          return { value: { text: candidate.value } };
        case "css":
        case "testId":
          // Named rather than skipped: a web artifact replayed on a desktop surface should say
          // which of its locators cannot survive the move, not fail with "not found".
          refused.push(`${candidate.strategy} has no meaning on an accessibility tree`);
          break;
        case "coordinates":
          refused.push("coordinates are refused during replay on every surface");
          break;
      }
    }
    return {
      error: `no usable locator candidate for this surface: ${refused.join("; ") || "none supplied"}`,
    };
  }

  /** Exactly one visible match, or a refusal naming which way it failed. */
  private async resolveExactlyOne(
    query: NodeQuery,
  ): Promise<{ value: AxNode } | { error: string }> {
    const { matches } = await this.transport.request("resolve", { ...query, visibleOnly: true });
    const described = JSON.stringify(query);

    if (matches.length === 0) return { error: `no element matched ${described}` };
    if (matches.length > 1) {
      // Ambiguity is a failure, not a coin toss. Same rule as the browser path.
      return { error: `${matches.length} elements matched ${described}; refusing to guess` };
    }
    return { value: matches[0]! };
  }

  // ── Evidence and lifecycle ────────────────────────────────────────────────

  async screenshot(mask?: readonly string[]): Promise<Buffer> {
    const { pngBase64 } = await this.transport.request("screenshot", {
      // Caller-supplied masks are added to, never replace, the secure-entry roles. An artifact
      // that forgets to ask still does not leak a password into a PNG.
      maskRoles: [...this.maskRoles, ...(mask ?? [])],
    });
    return Buffer.from(pngBase64, "base64");
  }

  /**
   * Nothing to take. The navigation guard is a browser-level mechanism — a desktop run is
   * policed by the landing check after each action instead — so this is always empty rather
   * than pretending to a signal this surface does not produce.
   */
  takeBlockedNavigations(): string[] {
    return [];
  }

  /** No trace: tracing is a Playwright artifact, and inventing an empty one would be a lie. */
  async close(): Promise<string | undefined> {
    await this.transport.close();
    return undefined;
  }
}
