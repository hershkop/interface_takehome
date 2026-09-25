import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay } from "../src/replay.js";
import { Policy, type Condition, type Observation, type Target } from "../src/schema.js";
import type { ActionOutcome, CoordinateClickOutcome, Surface } from "../src/surface.js";

/**
 * Proof that the Surface port is real.
 *
 * REPORT.md claims a non-web surface would implement the same port and change nothing above it.
 * This is a surface with no browser, no DOM, no network and no Playwright — a hand-rolled state
 * machine over named controls, which is roughly the shape a desktop accessibility adapter has.
 * A capability replays through it unchanged.
 *
 * If this test ever needs a change to `replay.ts` to keep passing, the seam has regressed.
 */

/** A pretend application: named controls, a current screen, and values behind them. */
class FakeDesktopSurface implements Surface {
  private screen = "login";
  private readonly values = new Map<string, string>();
  readonly acted: string[] = [];

  private readonly screens: Record<string, { controls: string[]; text: string[] }> = {
    login: { controls: ["Username", "Password", "Log In"], text: ["Customer Login"] },
    overview: { controls: ["Account 12345"], text: ["Accounts Overview"] },
    detail: { controls: [], text: ["Account Details", "CHECKING"] },
  };

  /** The one place a locator is interpreted, exactly as on a real surface. */
  private resolve(target: Target): string | undefined {
    for (const candidate of target.candidates) {
      const name =
        candidate.strategy === "role"
          ? candidate.name
          : "value" in candidate
            ? candidate.value
            : undefined;
      if (name && this.screens[this.screen]!.controls.includes(name)) return name;
    }
    return undefined;
  }

  async navigate(url: string): Promise<ActionOutcome> {
    this.acted.push(`navigate ${url}`);
    this.screen = "login";
    return { ok: true };
  }

  async click(target: Target): Promise<ActionOutcome> {
    const control = this.resolve(target);
    if (!control) return { ok: false, errorCode: "TARGET_NOT_FOUND", error: "no such control" };
    this.acted.push(`click ${control}`);
    if (control === "Log In") this.screen = "overview";
    if (control.startsWith("Account ")) this.screen = "detail";
    return { ok: true };
  }

  async fill(target: Target, value: string): Promise<ActionOutcome> {
    const control = this.resolve(target);
    if (!control) return { ok: false, errorCode: "TARGET_NOT_FOUND", error: "no such control" };
    this.values.set(control, value);
    this.acted.push(`fill ${control}`);
    return { ok: true };
  }

  async select(target: Target, value: string): Promise<ActionOutcome> {
    return this.fill(target, value);
  }

  async extract(): Promise<ActionOutcome> {
    return { ok: true, value: this.screen === "detail" ? "CHECKING" : "" };
  }

  async waitFor(condition: Condition, _timeoutMs: number): Promise<ActionOutcome> {
    return (await this.verify(condition))
      ? { ok: true }
      : { ok: false, errorCode: "STEP_TIMEOUT", error: "never appeared" };
  }

  async verify(condition: Condition): Promise<boolean> {
    const here = this.screens[this.screen]!;
    switch (condition.kind) {
      case "text":
        return here.text.some((t) => t.includes(condition.value));
      case "role":
        return condition.name ? here.controls.includes(condition.name) : false;
      case "title":
        return this.screen.includes(condition.value.toLowerCase());
      case "urlPattern":
        return true;
      case "all":
        for (const c of condition.conditions) if (!(await this.verify(c))) return false;
        return true;
      case "any":
        for (const c of condition.conditions) if (await this.verify(c)) return true;
        return false;
      case "not":
        return !(await this.verify(condition.condition));
    }
  }

  async clickAt(): Promise<CoordinateClickOutcome> {
    return { ok: false, error: "this surface has no coordinates" };
  }

  async observe(step: number): Promise<Observation> {
    const here = this.screens[this.screen]!;
    return {
      url: `app://${this.screen}`,
      title: this.screen,
      // A desktop accessibility tree serialises to the same shape an ARIA snapshot does.
      ariaSnapshot: here.controls.map((c) => `- control "${c}"`).join("\n"),
      alerts: [],
      step,
    };
  }

  // A window name is not an origin. Declaring this is what stops the URL allowlist from
  // rejecting every location this surface reports.
  readonly locationKind = "opaque" as const;

  currentUrl(): string {
    return `app://${this.screen}`;
  }

  takeBlockedNavigations(): string[] {
    return [];
  }

  async screenshot(): Promise<Buffer> {
    // A real adapter would grab the window. A 1x1 PNG is enough to prove evidence flows.
    return Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
  }

  async close(): Promise<string | undefined> {
    return undefined;
  }
}

const artifact = {
  schemaVersion: "1.0",
  capabilityId: "read_account_type",
  version: "1.0.0",
  metadata: {
    name: "Read account type",
    description: "Sign in and read an account's type.",
    status: "approved",
    risk: "safe",
    recordedAt: "2026-09-25T00:00:00.000Z",
    recordedBy: "human",
  },
  target: { app: "legacy-desktop", baseUrl: "http://app.test" },
  inputs: { accountId: { type: "string" } },
  outputs: {
    accountType: { type: "string", source: { kind: "variable", name: "kind" }, coerce: "trim" },
  },
  steps: [
    { id: "open", action: { action: "navigate", url: "{{baseUrl}}/" } },
    {
      id: "user",
      action: {
        action: "fill",
        target: { candidates: [{ strategy: "role", role: "edit", name: "Username" }] },
        value: "{{secrets.user}}",
      },
    },
    {
      id: "signin",
      action: {
        action: "click",
        target: { candidates: [{ strategy: "role", role: "button", name: "Log In" }] },
      },
      postcondition: { kind: "text", value: "Accounts Overview" },
    },
    {
      id: "open_account",
      // The parameter lives in the locator, as it did in the real discovered capability.
      action: {
        action: "click",
        target: { candidates: [{ strategy: "role", role: "link", name: "Account {{inputs.accountId}}" }] },
      },
    },
    {
      id: "read",
      action: {
        action: "extract",
        as: "kind",
        target: { candidates: [{ strategy: "role", role: "text", name: "Type" }] },
      },
    },
  ],
  handlers: [],
  checkpoint: { kind: "text", value: "Account Details" },
};

describe("the Surface port is technology-neutral", () => {
  it("replays a capability through a surface that is not a browser", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "port-"));
    const fake = new FakeDesktopSurface();

    try {
      const result = await replay({
        artifact,
        inputs: { accountId: "12345" },
        secrets: { user: "operator" },
        policy: Policy.parse({ allowedOrigins: ["http://app.test"] }),
        evidenceRoot,
        createSurface: async () => fake,
      });

      expect(result.status).toBe("success");
      if (result.status === "success") expect(result.outputs).toEqual({ accountType: "CHECKING" });

      // Templates resolved in a locator on a surface that has never heard of CSS.
      expect(fake.acted).toContain("click Account 12345");
      expect(result.evidence.modelCalls).toBe(0);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports a failure from a non-browser surface through the same contract", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "port-"));
    try {
      const result = await replay({
        artifact: { ...artifact, inputs: { accountId: { type: "string" } } },
        inputs: { accountId: "99999" }, // no such control on this surface
        secrets: { user: "operator" },
        policy: Policy.parse({ allowedOrigins: ["http://app.test"] }),
        evidenceRoot,
        createSurface: async () => new FakeDesktopSurface(),
      });

      expect(result.status).toBe("failure");
      if (result.status === "failure") {
        expect(result.error.code).toBe("TARGET_NOT_FOUND");
        expect(result.error.step?.id).toBe("open_account");
      }
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
