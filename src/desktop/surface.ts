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
import { globToRegExp, type ActionOutcome, type CoordinateClickOutcome, type Surface } from "../surface.js";
import type { AxNode, DesktopTransport, DesktopWindow } from "./protocol.js";
import { collectAlerts, flatten, flattenAll, renderAxSnapshot } from "./snapshot.js";

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
  /**
   * How long the whole candidate chain is retried before a target is called unresolvable.
   * Mirrors the browser resolver's default, so the two surfaces tolerate the same amount of
   * an application being slow to repaint.
   */
  resolveTimeoutMs?: number;
}

const DEFAULT_MASK_ROLES = ["securetextfield", "passwordtextbox"] as const;

/** A query the helper and the local matcher both understand. */
interface NodeQuery {
  role?: string;
  name?: string;
  text?: string;
  /** A grid cell reference. Only a surface with a grid behind it can answer one. */
  cell?: string;
  /** Carried from the candidate. Names match as substrings unless the artifact says otherwise. */
  exact?: boolean;
}

/** What a resolution attempt found, for an error message that names the way it failed. */
interface Attempt {
  describe: string;
  matches: number;
  error?: string;
}

const ok = (value?: string): ActionOutcome =>
  value === undefined ? { ok: true } : { ok: true, value };
const fail = (error: string): ActionOutcome => ({ ok: false, error });

export class DesktopSurface implements Surface {
  readonly locationKind = "opaque" as const;

  private readonly transport: DesktopTransport;
  private readonly maskRoles: readonly string[];
  private readonly defaultTimeoutMs: number;
  private readonly resolveTimeoutMs: number;
  private where: DesktopWindow | undefined;

  constructor(options: DesktopSurfaceOptions) {
    this.transport = options.transport;
    this.maskRoles = options.maskRoles ?? DEFAULT_MASK_ROLES;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? 5_000;
  }

  // ── Observation ───────────────────────────────────────────────────────────

  async observe(step: number): Promise<Observation> {
    const { window, tree } = await this.transport.request("observe", {});
    this.where = window;
    return {
      url: this.locationOf(window),
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
    return this.locationOf(this.where);
  }

  /**
   * The location the policy guard sees: application, then the *document* if there is one.
   *
   * The document rather than the window title, because that is what an allowlist has to be
   * written against. A title is decoration an application renames at will — "Q3-report.xlsx —
   * Excel", then "Q3-report.xlsx — Saved" — and containment that a rename can walk past is
   * not containment. The title stays in `Observation.title`, where it is evidence.
   */
  private locationOf(window: DesktopWindow): string {
    return desktopLocation(window.application, window.document ?? window.window);
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

  async click(target: Target, button: "left" | "right" = "left"): Promise<ActionOutcome> {
    const resolved = await this.resolveTarget(target);
    if ("error" in resolved) return fail(resolved.error);

    try {
      // Addressed by the handle the resolution issued, not by re-sending the query. Sending
      // the query again would let the helper act on whatever matches *now*, which is the same
      // wrong click the uniqueness check was there to prevent, arriving a moment later.
      const { window } = await this.transport.request("click", {
        handle: resolved.handle,
        button,
      });
      this.where = window;
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Keys, optionally to a focused node.
   *
   * With no target they go wherever focus already is, which is how a grid is driven: select a
   * range, then send Control+Shift+ArrowDown without naming anything.
   */
  async press(keys: string, target?: Target): Promise<ActionOutcome> {
    let handle: string | undefined;
    if (target !== undefined) {
      const resolved = await this.resolveTarget(target);
      if ("error" in resolved) return fail(resolved.error);
      handle = resolved.handle;
    }

    try {
      const { window } = await this.transport.request("key", {
        ...(handle === undefined ? {} : { handle }),
        keys,
      });
      this.where = window;
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  async fill(target: Target, value: string): Promise<ActionOutcome> {
    const resolved = await this.resolveTarget(target);
    if ("error" in resolved) return fail(resolved.error);

    try {
      const { window } = await this.transport.request("fill", {
        handle: resolved.handle,
        value,
      });
      this.where = window;
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
    const resolved = await this.resolveTarget(target);
    if ("error" in resolved) return fail(resolved.error);

    const node = resolved.node;
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
      const { hit, window } = await this.transport.request("clickAt", { x, y });
      // A coordinate click can land anywhere, which is exactly why the location it left the
      // session in has to be recorded before the guard checks it.
      if (window) this.where = window;
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
    const { tree, window } = await this.transport.request("observe", {});
    // Kept current while waiting: a condition that only becomes true after the application
    // moves would otherwise be judged against where the session used to be.
    this.where = window;
    return this.matches(condition, tree, window);
  }

  async waitFor(condition: Condition, timeoutMs: number): Promise<ActionOutcome> {
    const deadline = Date.now() + (timeoutMs || this.defaultTimeoutMs);
    for (;;) {
      if (await this.verify(condition)) return ok();
      if (Date.now() >= deadline) return fail(`timed out waiting for ${condition.kind}`);
      await new Promise((resume) => setTimeout(resume, 100));
    }
  }

  /**
   * The same condition semantics the browser evaluator implements, over an accessibility tree.
   *
   * All of them, including the composites. `all`, `any` and `not` are not exotic: `any` exists
   * because a real flow settles into either a detail screen or a not-found screen, and a
   * surface that answered `false` to every composite would wait out the whole timeout on the
   * second path and report a timeout where the artifact had declared a business outcome.
   */
  private matches(condition: Condition, tree: AxNode, window: DesktopWindow): boolean {
    const nodes = flatten(tree);

    switch (condition.kind) {
      case "text": {
        // `flatten` has already dropped invisible nodes, so the visible-only default holds by
        // construction; `visible: false` opts back in to the whole tree, as on the browser.
        const pool = condition.visible === false ? flattenAll(tree) : nodes;
        return pool.some((n) => `${n.name ?? ""} ${n.value ?? ""}`.includes(condition.value));
      }
      case "role":
        return nodes.some(
          (n) =>
            n.role.toLowerCase() === condition.role.toLowerCase() &&
            (condition.name === undefined || (n.name ?? "").includes(condition.name)),
        );
      case "urlPattern":
        // The same glob matcher the browser path uses, against this surface's own location —
        // so an artifact's expectation is expressed identically whichever surface runs it.
        return globToRegExp(condition.value).test(
          desktopLocation(window.application, window.window),
        );
      case "title":
        return window.window.includes(condition.value);
      case "all":
        return condition.conditions.every((c) => this.matches(c, tree, window));
      case "any":
        return condition.conditions.some((c) => this.matches(c, tree, window));
      case "not":
        return !this.matches(condition.condition, tree, window);
    }
  }

  // ── Locators ──────────────────────────────────────────────────────────────

  /**
   * Walks the candidate list in order and returns the first that resolves to exactly one
   * visible node, with the handle to act on it.
   *
   * The same contract as the browser resolver, and for the same reasons. A candidate that
   * matches nothing does not end the walk — that is what the ordered list is *for*, since a
   * recording encodes a preference, not a single hope. A candidate that matches several does
   * not end it either, but it is remembered, because "I found three" and "I found none" are
   * different findings and a reader needs to know which one they are looking at.
   *
   * The whole chain is retried until a shared deadline: an application repainting after an
   * action is ordinary, and checking each candidate once would reject a target that was about
   * to resolve perfectly well.
   */
  private async resolveTarget(
    target: Target,
  ): Promise<{ node: AxNode; handle: string } | { error: string }> {
    const queries = this.toQueries(target);
    if (queries.usable.length === 0) {
      // Nothing here could ever resolve, so there is nothing to wait for. Retrying an artifact
      // whose every locator is meaningless on this surface just delays the same message.
      return {
        error: `no usable locator candidate for this surface: ${queries.refused.join("; ") || "none supplied"}`,
      };
    }

    const deadline = Date.now() + this.resolveTimeoutMs;
    for (;;) {
      const attempts: Attempt[] = [];
      let sawAmbiguous = false;

      for (const { describe, query } of queries.usable) {
        const { matches } = await this.transport.request("resolve", {
          ...query,
          visibleOnly: true,
        });
        attempts.push({ describe, matches: matches.length });

        if (matches.length === 1) {
          const node = matches[0]!;
          if (node.handle === undefined) {
            // A helper that matches but issues no handle cannot be acted on safely, and
            // falling back to the query would be exactly the race this design removed.
            return { error: `helper returned a match with no handle for ${describe}` };
          }
          return { node, handle: node.handle };
        }
        if (matches.length > 1) sawAmbiguous = true;
      }

      if (Date.now() >= deadline) {
        const detail = attempts.map((a) => `${a.describe} → ${a.matches}`).join("; ");
        return {
          error: sawAmbiguous
            ? `refusing to guess: a candidate matched more than one element (${detail})`
            : `no element matched any candidate (${detail})`,
        };
      }
      await new Promise((resume) => setTimeout(resume, 100));
    }
  }

  /**
   * The candidates this surface can express, in the artifact's own order, plus why the rest
   * were refused.
   *
   * `css` and `testId` are named rather than skipped: a web artifact replayed here should say
   * which of its locators cannot survive the move, not fail with "not found" and send a reader
   * looking for a control that was never missing.
   */
  private toQueries(target: Target): {
    usable: { describe: string; query: NodeQuery }[];
    refused: string[];
  } {
    const usable: { describe: string; query: NodeQuery }[] = [];
    const refused: string[] = [];

    for (const candidate of target.candidates) {
      switch (candidate.strategy) {
        case "role":
          usable.push({
            describe: `role=${candidate.role} name=${JSON.stringify(candidate.name)}${candidate.exact ? " (exact)" : ""}`,
            query: {
              role: candidate.role,
              name: candidate.name,
              // Carried through, not dropped. The schema defaults `exact` to false, so a
              // helper left to assume equality would silently narrow every recorded locator.
              exact: candidate.exact,
            },
          });
          break;
        case "label":
          usable.push({
            describe: `label=${JSON.stringify(candidate.value)}`,
            query: { name: candidate.value },
          });
          break;
        case "text":
          usable.push({
            describe: `text=${JSON.stringify(candidate.value)}`,
            query: { text: candidate.value },
          });
          break;
        case "cell":
          // The surface-specific strategy the design said would be additive rather than a
          // fork. A helper with no grid simply matches nothing, and the walk moves on.
          usable.push({ describe: `cell=${candidate.ref}`, query: { cell: candidate.ref } });
          break;
        case "css":
        case "testId":
          refused.push(`${candidate.strategy} has no meaning on an accessibility tree`);
          break;
        case "coordinates":
          refused.push("coordinates are refused during replay on every surface");
          break;
      }
    }
    return { usable, refused };
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
