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
import { join } from "node:path";
import type { Condition, Observation } from "./schema.js";
import { resolveTarget, explainFailure, type AttemptLog } from "./locator.js";
import type { Target } from "./schema.js";

export interface ActionOutcome {
  ok: boolean;
  /** Present when the action read something off the page. */
  value?: string;
  error?: string;
  errorCode?: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "STEP_TIMEOUT";
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
  verify(condition: Condition): Promise<boolean>;
  currentUrl(): string;
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
    case "not":
      return `NOT (${describeCondition(condition.condition)})`;
  }
}

// ─── Playwright implementation ─────────────────────────────────────────────────

export interface PlaywrightSurfaceOptions {
  headed?: boolean;
  /** Directory to write the trace into. Tracing is off when omitted. */
  traceDir?: string;
  defaultTimeoutMs?: number;
}

export class PlaywrightSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly traceDir: string | undefined,
    private readonly defaultTimeoutMs: number,
  ) {}

  static async launch(options: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: !options.headed });
    const context = await browser.newContext();
    if (options.traceDir) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    const page = await context.newPage();
    const timeout = options.defaultTimeoutMs ?? 10_000;
    page.setDefaultTimeout(timeout);
    return new PlaywrightSurface(browser, context, page, options.traceDir, timeout);
  }

  /**
   * One observation: where we are, what a screen reader would report, and any visible alert.
   *
   * The ARIA snapshot is the primary signal. It is visibility-aware, an order of magnitude
   * smaller than the DOM, and it names controls the way the recorded locators do — so a model
   * reading it naturally proposes role+name targeting rather than brittle CSS.
   */
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
