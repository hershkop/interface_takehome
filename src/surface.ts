/**
 * The Surface port and its one v1 implementation.
 *
 * The seam this file defines is the whole heterogeneity story. Everything above it — artifacts,
 * replay, discovery — speaks in *intent*: "click the control whose accessible name is Transfer",
 * "is text X visible". Nothing above it mentions Playwright, CSS, or a browser. A desktop
 * adapter would implement the same four methods against OS accessibility APIs and send real
 * keystrokes, and no artifact would have to change.
 *
 * That is also why observation is an ARIA snapshot rather than a DOM dump: role+name is the one
 * representation a browser, a legacy frameset, and a native desktop app can all produce.
 */
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

/**
 * Masked in every screenshot unless a caller overrides. Password inputs first, plus an opt-in
 * hook (`data-sensitive`) for anything an artifact author knows is regulated on a given screen.
 */
export const DEFAULT_MASK_SELECTORS: readonly string[] = [
  'input[type="password"]',
  "[data-sensitive]",
];
import { join } from "node:path";
import type { Condition, Observation } from "./schema.js";
import { resolveTarget, explainFailure, type AttemptLog } from "./locator.js";
import type { Target } from "./schema.js";

/** What was under the cursor after a coordinate click, so a durable locator can be derived. */
export interface CoordinateClickOutcome extends ActionOutcome {
  element?: {
    tag: string;
    role: string | null;
    name: string | null;
    id: string | null;
    testId: string | null;
    text: string | null;
  };
}

export interface ActionOutcome {
  ok: boolean;
  /** Present when the action read something off the page. */
  value?: string;
  error?: string;
  errorCode?: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "STEP_TIMEOUT" | "POLICY_DENIED";
  attempts?: AttemptLog[];
}

/**
 * Intent-level surface operations. Deliberately small: anything expressible only in terms of
 * one technology does not belong here.
 */
export interface Surface {
  observe(step: number): Promise<Observation>;
  navigate(url: string): Promise<ActionOutcome>;
  click(target: Target): Promise<ActionOutcome>;
  fill(target: Target, value: string): Promise<ActionOutcome>;
  select(target: Target, value: string): Promise<ActionOutcome>;
  waitFor(condition: Condition, timeoutMs: number): Promise<ActionOutcome>;
  extract(target: Target, attribute?: string): Promise<ActionOutcome>;
  /**
   * Click raw viewport coordinates, then report what was under the cursor.
   *
   * This is the discovery escape hatch, and it is deliberately not reachable from replay: the
   * resolver refuses coordinate candidates outright. The asymmetry is the point. A model
   * working from a screenshot sometimes has no other way to act on a control, so discovery
   * needs to be *able* to click a point — but what gets recorded must be a real locator, which
   * is why this returns the element's role, name, and id rather than just succeeding.
   * Discovery converts that into locator candidates; if it cannot, the artifact stays a draft.
   */
  clickAt(x: number, y: number): Promise<CoordinateClickOutcome>;
  verify(condition: Condition): Promise<boolean>;
  currentUrl(): string;
  /**
   * Whether `currentUrl()` is a navigable web location or an opaque identifier.
   *
   * The origin allowlist is defined in terms of http(s) origins, so it can only police a
   * surface whose locations are URLs. A desktop window has a name, not an origin — policing it
   * with a URL allowlist would reject every location it ever reports.
   *
   * Declared by the surface rather than sniffed from the string, because "does this need an
   * origin check" is a fact about the technology, and a surface that quietly returned something
   * unparseable would silently disable a safety check instead of announcing it needs a
   * different one. An `opaque` surface needs its own containment story — see REPORT.md §4.
   */
  readonly locationKind: "url" | "opaque";
  /** URLs the navigation guard refused since this was last called. */
  takeBlockedNavigations(): string[];
  /**
   * The screen, as bytes, with sensitive regions already masked.
   *
   * Masking belongs here rather than in the evidence recorder: *which* regions are sensitive is
   * a fact about how this surface is perceived — CSS selectors on a page, accessibility roles
   * on a desktop — and a rendered pixel cannot be redacted after the fact. Returning bytes
   * rather than taking a Page is what lets anything above this file stay technology-neutral.
   */
  screenshot(mask?: readonly string[]): Promise<Buffer>;
  /** Returns the trace path when tracing was enabled, so the caller can record it. */
  close(): Promise<string | undefined>;
}

// ─── Condition evaluation ──────────────────────────────────────────────────────

/** Minimal glob → RegExp. Supports `**`, `*`, and `?`; enough for URL patterns. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += ".";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Evaluates a condition against the live page.
 *
 * `visible: true` (the default) requires a *visible* match. `visible: false` means "match even
 * if hidden" — opt-in, never the default, because ParaBank keeps error text in the DOM of every
 * healthy page and the naive reading would report a failure on every successful run.
 */
export async function evaluateCondition(page: Page, condition: Condition): Promise<boolean> {
  switch (condition.kind) {
    case "text": {
      const locator = page.getByText(condition.value);
      // `!== false` rather than a truthiness check. A condition that reached here without
      // passing through Zod has `visible === undefined`, and a truthiness test would silently
      // flip it to hidden-matching — the exact failure this default exists to prevent. The
      // safe reading must not depend on where the object came from.
      const requireVisible = condition.visible !== false;
      if (!requireVisible) return (await locator.count()) > 0;
      return anyVisible(locator);
    }
    case "role": {
      // getByRole is already accessibility-tree scoped, so hidden elements never appear here.
      // The visibility filter still earns its place: an element can be in the tree with a
      // zero-size box, which a human operator cannot interact with either.
      const locator = page.getByRole(
        condition.role as Parameters<Page["getByRole"]>[0],
        condition.name === undefined ? {} : { name: condition.name },
      );
      return anyVisible(locator);
    }
    case "urlPattern":
      return globToRegExp(condition.value).test(page.url());
    case "title":
      return (await page.title()).includes(condition.value);
    case "all": {
      for (const c of condition.conditions) {
        if (!(await evaluateCondition(page, c))) return false;
      }
      return true;
    }
    case "any": {
      for (const c of condition.conditions) {
        if (await evaluateCondition(page, c)) return true;
      }
      return false;
    }
    case "not":
      return !(await evaluateCondition(page, condition.condition));
  }
}

async function anyVisible(locator: ReturnType<Page["getByText"]>): Promise<boolean> {
  const total = await locator.count();
  for (let i = 0; i < total; i++) {
    if (await locator.nth(i).isVisible()) return true;
  }
  return false;
}

/** Readable form of a condition for logs and failure messages. */
export function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case "text":
      return `text ${JSON.stringify(condition.value)}${condition.visible === false ? " (hidden ok)" : ""}`;
    case "role":
      return `role ${condition.role}${condition.name ? ` named ${JSON.stringify(condition.name)}` : ""}`;
    case "urlPattern":
      return `url matching ${condition.value}`;
    case "title":
      return `title containing ${JSON.stringify(condition.value)}`;
    case "all":
      return condition.conditions.map(describeCondition).join(" AND ");
    case "any":
      return `(${condition.conditions.map(describeCondition).join(" OR ")})`;
    case "not":
      return `NOT (${describeCondition(condition.condition)})`;
  }
}

// ─── Playwright implementation ─────────────────────────────────────────────────

/**
 * What any surface can be asked for at launch.
 *
 * A superset, deliberately: an adapter ignores what does not apply to it. A desktop surface has
 * no navigation to guard and no trace to write, and that is fine — the alternative is a lowest
 * common denominator that makes the browser adapter awkward for no gain.
 */
export interface SurfaceLaunchOptions {
  headed?: boolean;
  defaultTimeoutMs?: number;
  navigationAllowed?: (url: string) => boolean;
  onHumanEvent?: (event: RawHumanEvent) => void;
  traceDir?: string;
  trace?: "off" | "unredacted";
  executablePath?: string;
}

/** How a caller obtains a surface without naming an implementation. */
export type SurfaceFactory = (options: SurfaceLaunchOptions) => Promise<Surface>;

export interface PlaywrightSurfaceOptions extends SurfaceLaunchOptions {}

/** Shape emitted by the in-page listeners. Deliberately free of typed content. */
export interface RawHumanEvent {
  type: "click" | "input" | "change" | "submit" | "navigate";
  url: string;
  tag?: string;
  role?: string;
  name?: string;
  id?: string;
  valueLength?: number;
}

export class PlaywrightSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly traceDir: string | undefined,
    private readonly defaultTimeoutMs: number,
    /** Navigations the browser-level guard refused. Surfaced so a failure can name them. */
    private readonly blockedNavigations: string[],
  ) {}

  /** URLs the navigation guard aborted during this session. */
  takeBlockedNavigations(): string[] {
    return this.blockedNavigations.splice(0, this.blockedNavigations.length);
  }

  static async launch(options: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({
      headless: !options.headed,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });
    const context = await browser.newContext();
    if (options.onHumanEvent) {
      await installHumanEventCapture(context, options.onHumanEvent);
    }

    // Navigation is reported from here rather than in-page: a document being torn down cannot
    // reliably announce its own departure, and an operator who navigates away mid-handoff is a
    // material part of the audit trail. Automation's own navigations fire this too and are
    // filtered out by the ownership check in the sink.
    const reportNavigation = options.onHumanEvent;
    if (reportNavigation) {
      context.on("page", (opened) => {
        opened.on("framenavigated", (frame) => {
          if (frame.parentFrame() === null) {
            reportNavigation({ type: "navigate", url: frame.url() });
          }
        });
      });
    }

    const blockedNavigations: string[] = [];
    if (options.navigationAllowed) {
      const allowed = options.navigationAllowed;
      await context.route("**/*", async (route, request) => {
        // Only document navigations are gated. Blocking sub-resources would break pages that
        // legitimately load styles or images from elsewhere, and the threat being addressed is
        // the session going somewhere it should not — not a stylesheet.
        if (request.resourceType() !== "document") return route.continue();
        if (allowed(request.url())) return route.continue();
        blockedNavigations.push(request.url());
        return route.abort("blockedbyclient");
      });
    }

    const tracing = options.trace === "unredacted" && Boolean(options.traceDir);
    if (tracing) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const page = await context.newPage();
    const timeout = options.defaultTimeoutMs ?? 10_000;
    page.setDefaultTimeout(timeout);
    return new PlaywrightSurface(
      browser,
      context,
      page,
      tracing ? options.traceDir : undefined,
      timeout,
      blockedNavigations,
    );
  }

  /**
   * One observation: where we are, what a screen reader would report, and any visible alert.
   *
   * The ARIA snapshot is the primary signal. It is visibility-aware, an order of magnitude
   * smaller than the DOM, and it names controls the way the recorded locators do — so a model
   * reading it naturally proposes role+name targeting rather than brittle CSS.
   */
  /** Masks at capture time; there is no "after the fact" for a rendered pixel. */
  async screenshot(mask: readonly string[] = DEFAULT_MASK_SELECTORS): Promise<Buffer> {
    return this.page.screenshot({
      fullPage: true,
      mask: mask.map((selector) => this.page.locator(selector)),
      maskColor: "#000000",
    });
  }

  async observe(step: number): Promise<Observation> {
    const [url, title, ariaSnapshot] = await Promise.all([
      Promise.resolve(this.page.url()),
      this.page.title(),
      this.page.locator("body").ariaSnapshot().catch(() => ""),
    ]);
    return {
      url,
      title,
      ariaSnapshot,
      alerts: await this.visibleAlerts(),
      step,
    };
  }

  /**
   * Alerts are lifted out of the snapshot because they are the thing most likely to matter and
   * most easily lost in a long tree — a validation message, a "record not found", a permission
   * denial. Hidden ones are excluded for the reason in DAY0-FINDINGS §3.
   */
  private async visibleAlerts(): Promise<string[]> {
    const locator = this.page.locator('[role="alert"], .error, .alert, #showError');
    const out: string[] = [];
    const total = await locator.count();
    for (let i = 0; i < Math.min(total, 10); i++) {
      const item = locator.nth(i);
      if (!(await item.isVisible())) continue;
      const text = (await item.innerText().catch(() => ""))?.trim();
      if (text) out.push(text.slice(0, 300));
    }
    return out;
  }

  async navigate(url: string): Promise<ActionOutcome> {
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded" });
      return { ok: true };
    } catch (err) {
      return { ok: false, errorCode: "STEP_TIMEOUT", error: message(err) };
    }
  }

  async click(target: Target): Promise<ActionOutcome> {
    return this.withTarget(target, async (locator) => {
      await locator.click({ timeout: this.defaultTimeoutMs });
      return { ok: true };
    });
  }

  async fill(target: Target, value: string): Promise<ActionOutcome> {
    return this.withTarget(target, async (locator) => {
      await locator.fill(value, { timeout: this.defaultTimeoutMs });
      return { ok: true };
    });
  }

  async select(target: Target, value: string): Promise<ActionOutcome> {
    return this.withTarget(target, async (locator) => {
      await locator.selectOption(value, { timeout: this.defaultTimeoutMs });
      return { ok: true };
    });
  }

  async extract(target: Target, attribute?: string): Promise<ActionOutcome> {
    return this.withTarget(target, async (locator) => {
      const value = attribute
        ? await locator.getAttribute(attribute)
        : (await locator.innerText()).trim();
      return { ok: true, value: value ?? undefined };
    });
  }

  async waitFor(condition: Condition, timeoutMs: number): Promise<ActionOutcome> {
    const deadline = Date.now() + timeoutMs;
    // Polled rather than event-driven because a Condition is arbitrary (including `not`), and a
    // bounded poll is easier to reason about than a composed set of waiters.
    while (Date.now() < deadline) {
      if (await evaluateCondition(this.page, condition)) return { ok: true };
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      ok: false,
      errorCode: "STEP_TIMEOUT",
      error: `timed out after ${timeoutMs}ms waiting for ${describeCondition(condition)}`,
    };
  }

  async verify(condition: Condition): Promise<boolean> {
    return evaluateCondition(this.page, condition);
  }

  readonly locationKind = "url" as const;

  currentUrl(): string {
    return this.page.url();
  }

  /** Resolves the target, then runs the operation. Resolution failures never reach the caller
   *  as a generic exception — they carry which failure mode it was and what was tried. */
  private async withTarget(
    target: Target,
    operation: (locator: Locator) => Promise<ActionOutcome>,
  ): Promise<ActionOutcome> {
    const resolution = await resolveTarget(this.page, target, { timeoutMs: this.defaultTimeoutMs });
    if (!resolution.ok) {
      return {
        ok: false,
        errorCode: resolution.reason === "ambiguous" ? "TARGET_AMBIGUOUS" : "TARGET_NOT_FOUND",
        error: explainFailure(target, resolution.attempts),
        attempts: resolution.attempts,
      };
    }
    try {
      const outcome = await operation(resolution.locator);
      return { ...outcome, attempts: resolution.attempts };
    } catch (err) {
      return {
        ok: false,
        errorCode: "STEP_TIMEOUT",
        error: message(err),
        attempts: resolution.attempts,
      };
    }
  }

  /**
   * Coordinate click. See the interface docs for why this exists and why replay cannot use it.
   *
   * The element description comes from `document.elementFromPoint`, read in the page. Role is
   * approximated from the explicit `role` attribute or the tag, which is enough for discovery
   * to propose a role+name candidate and let the recorder verify it resolves uniquely.
   */
  async clickAt(x: number, y: number): Promise<CoordinateClickOutcome> {
    try {
      const element = await this.page.evaluate(
        ({ px, py }) => {
          const el = document.elementFromPoint(px, py) as HTMLElement | null;
          if (!el) return null;
          const labelled = el.getAttribute("aria-label") ?? el.getAttribute("title");
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            name: labelled ?? ((el.textContent ?? "").trim().slice(0, 80) || null),
            id: el.id || null,
            testId: el.getAttribute("data-testid"),
            text: ((el.textContent ?? "").trim().slice(0, 80) || null),
          };
        },
        { px: x, py: y },
      );
      await this.page.mouse.click(x, y);
      return { ok: true, element: element ?? undefined };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  }

  /** Stops tracing and tears the browser down. Returns the trace path when one was written. */
  async close(): Promise<string | undefined> {
    let tracePath: string | undefined;
    if (this.traceDir) {
      tracePath = join(this.traceDir, "trace.zip");
      await this.context.tracing.stop({ path: tracePath }).catch(() => {
        tracePath = undefined;
      });
    }
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
    return tracePath;
  }
}


/**
 * Installs in-page listeners that report user interactions.
 *
 * Two details decide whether this works at all.
 *
 * `addInitScript` rather than a one-off `evaluate`: listeners attached to a live document die
 * on the next navigation. A human who clicks anything that loads a page would be recorded for
 * the first click and then silently not at all — the worst kind of failure in an audit trail,
 * because it looks like the person did nothing.
 *
 * The payload carries a value's LENGTH and never its content. What someone types into a bank's
 * back office is precisely the data that must not be persisted, and a field's identity plus the
 * fact that it was filled is what an auditor actually needs.
 */
async function installHumanEventCapture(
  context: BrowserContext,
  sink: (event: RawHumanEvent) => void,
): Promise<void> {
  const BINDING = "__recordHumanEvent__";

  await context.exposeBinding(BINDING, (_source, payload) => {
    sink(payload as RawHumanEvent);
  });

  await context.addInitScript(
    ({ binding }) => {
      /** Last time each element reported an edit, so typing does not emit per keystroke. */
      const lastInput = new WeakMap<Element, number>();
      const INPUT_COALESCE_MS = 400;

      const report = (type: string, target: EventTarget | null): void => {
        const el = target as HTMLElement | null;
        if (!el || typeof el.tagName !== "string") return;

        const fn = (window as unknown as Record<string, unknown>)[binding];
        if (typeof fn !== "function") return;

        const tag = el.tagName.toLowerCase();
        const input = el as HTMLInputElement;
        const hasValue = typeof input.value === "string";

        // An element the user can type into must never contribute its content to the record.
        // For a <button>Transfer</button>, textContent is the label and is exactly what an
        // auditor wants. For a contenteditable div it IS what the person typed — and the
        // redactor cannot recognise arbitrary typed text, so it would be persisted verbatim
        // into both the event log and the human-actions file.
        const editable =
          el.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";

        // Length only, never the characters. contenteditable has no .value, so its length
        // comes from its text — the length is safe, the text is not.
        const valueLength = hasValue
          ? input.value.length
          : el.isContentEditable
            ? (el.textContent ?? "").length
            : undefined;

        if (type === "input") {
          const now = Date.now();
          const previous = lastInput.get(el) ?? 0;
          if (now - previous < INPUT_COALESCE_MS) return;
          lastInput.set(el, now);
        }

        (fn as (p: unknown) => void)({
          type,
          url: location.href,
          tag,
          role: el.getAttribute("role") ?? undefined,
          // Stable identifiers first. A label is only read off the element when nobody can
          // type into it.
          name:
            el.getAttribute("aria-label") ??
            el.getAttribute("name") ??
            (editable ? undefined : (el.textContent ?? "").trim().slice(0, 60) || undefined),
          id: el.id || undefined,
          valueLength,
        });
      };

      document.addEventListener("click", (e) => report("click", e.target), true);
      // `input` as well as `change`: an edit that never blurs — because the operator submits, or
      // the page navigates — fires no change event and would vanish from the audit trail
      // entirely. Coalesced above so typing does not emit one event per keystroke.
      document.addEventListener("input", (e) => report("input", e.target), true);
      document.addEventListener("change", (e) => report("change", e.target), true);
      document.addEventListener("submit", (e) => report("submit", e.target), true);
    },
    { binding: BINDING },
  );
}

/**
 * How long a surface gets to shut down before the run stops waiting on it.
 *
 * Generous for a browser, which normally closes in well under a second, and short enough that a
 * wedged adapter cannot hold a finished run hostage.
 */
export const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * Closes a surface without letting teardown decide the run's outcome.
 *
 * Catching a rejection is only half of it: an adapter that *hangs* traps the computed result in
 * `finally` just as effectively as one that throws, and an unbounded `await` cannot tell the
 * difference between slow and never. So teardown is raced against a deadline.
 *
 * The trade is deliberate. Giving up on a close can leave the underlying process alive — an
 * orphaned browser, which `stop.sh` reaps — whereas waiting forever loses a result that was
 * already correct. A recoverable leak beats an unrecoverable hang.
 *
 * Returns a result instead of recording one, so this stays free of any dependency on evidence.
 */
export async function closeSurface(
  surface: Surface,
  timeoutMs: number = TEARDOWN_TIMEOUT_MS,
): Promise<{ ok: true; trace?: string } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: `teardown did not finish within ${timeoutMs}ms` }),
      timeoutMs,
    );
  });

  const closing = surface
    .close()
    .then((trace) => ({ ok: true as const, ...(trace ? { trace } : {}) }))
    .catch((err: unknown) => ({
      ok: false as const,
      reason: err instanceof Error ? err.message : String(err),
    }));

  try {
    return await Promise.race([closing, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
