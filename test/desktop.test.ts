import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay } from "../src/replay.js";
import { Policy } from "../src/schema.js";
import { PolicyGuard } from "../src/safety.js";
import { DesktopSurface } from "../src/desktop/surface.js";
import { StdioDesktopTransport } from "../src/desktop/transport.js";
import { renderAxSnapshot, collectAlerts } from "../src/desktop/snapshot.js";
import { applicationOf, desktopLocation, windowOf } from "../src/location.js";

/**
 * Desktop support, exercised over a real child process.
 *
 * The platform half is a stub — `scripts/desktop-helper-stub.mjs` holds a hand-written
 * accessibility tree instead of asking macOS or Windows for one — but everything above it is
 * the production path: real stdio framing, the real `DesktopSurface`, the real policy guard,
 * the real replay engine. What is untested here is one process, and it is the one that has to
 * be written per platform anyway.
 */

const HELPER = ["node", ["scripts/desktop-helper-stub.mjs"]] as const;
const APP = "com.example.DesktopBank";

function desktopSurface(): DesktopSurface {
  return new DesktopSurface({
    transport: new StdioDesktopTransport({ command: HELPER[0], args: HELPER[1] }),
  });
}

/** The same capability shape the web target uses, pointed at the pretend desktop app. */
const artifact = {
  schemaVersion: "1.0",
  capabilityId: "desktop_lookup_balance",
  version: "1.0.0",
  metadata: {
    name: "Look up a balance on the desktop app",
    description: "Sign in and read an account's balance and type.",
    status: "approved",
    risk: "safe",
    recordedAt: "2026-09-28T10:00:00.000Z",
    recordedBy: "human",
  },
  target: { surface: "desktop", app: "DesktopBank", baseUrl: `app://${APP}` },
  inputs: { accountId: { type: "string", required: true } },
  outputs: {
    accountType: { type: "string", source: { kind: "variable", name: "shownType" } },
    balance: { type: "number", coerce: "currency", source: { kind: "variable", name: "shownBalance" } },
  },
  steps: [
    {
      id: "open_app",
      // The same `navigate` verb a web artifact uses. On this surface it focuses or launches
      // an application — which is the point: the vocabulary does not fork per technology.
      action: { action: "navigate", url: "{{baseUrl}}" },
    },
    {
      id: "sign_in_user",
      action: {
        action: "fill",
        target: { candidates: [{ strategy: "role", role: "textbox", name: "Username" }] },
        value: "operator",
      },
    },
    {
      id: "sign_in_password",
      action: {
        action: "fill",
        target: { candidates: [{ strategy: "role", role: "securetextfield", name: "Password" }] },
        value: "{{secrets.appPassword}}",
      },
    },
    {
      id: "submit",
      action: {
        action: "click",
        target: { candidates: [{ strategy: "role", role: "button", name: "Log In" }] },
      },
      postcondition: { kind: "text", value: "Accounts Overview" },
    },
    {
      id: "enter_account",
      action: {
        action: "fill",
        target: { candidates: [{ strategy: "role", role: "textbox", name: "Account Number" }] },
        value: "{{inputs.accountId}}",
      },
    },
    {
      id: "find_account",
      action: {
        action: "click",
        target: { candidates: [{ strategy: "role", role: "button", name: "Find" }] },
      },
    },
    {
      id: "read_type",
      action: {
        action: "extract",
        as: "shownType",
        target: { candidates: [{ strategy: "role", role: "textbox", name: "Account Type" }] },
      },
    },
    {
      id: "read_balance",
      action: {
        action: "extract",
        as: "shownBalance",
        target: { candidates: [{ strategy: "role", role: "textbox", name: "Balance" }] },
      },
    },
  ],
  handlers: [
    {
      id: "not_found",
      match: { kind: "text", value: "could not be found" },
      scope: "global",
      disposition: { kind: "business_outcome", outcome: "account_not_found" },
    },
  ],
  checkpoint: { kind: "text", value: "Account Details" },
};

const policy = Policy.parse({ allowedApplications: [APP] });

let evidenceRoot: string | undefined;
afterEach(async () => {
  if (evidenceRoot) await rm(evidenceRoot, { recursive: true, force: true });
  evidenceRoot = undefined;
});

async function run(over: Record<string, unknown> = {}): Promise<ReturnType<typeof replay>> {
  evidenceRoot = await mkdtemp(join(tmpdir(), "desktop-"));
  return replay({
    artifact,
    inputs: { accountId: "12678" },
    secrets: { appPassword: "hunter2" },
    policy,
    evidenceRoot,
    surfaceKind: "desktop",
    createSurface: async () => desktopSurface(),
    ...over,
  });
}

describe("an accessibility tree renders as a browser observation does", () => {
  it("matches Playwright's ariaSnapshot format exactly", () => {
    // Captured from `page.locator("body").ariaSnapshot()` on the equivalent markup. The format
    // is a contract, not a detail: discovery's prompt teaches a model to read this shape, and
    // the locators it proposes back are shaped by what it read.
    const rendered = renderAxSnapshot({
      role: "main",
      children: [
        { role: "heading", name: "Accounts Overview" },
        { role: "statictext", name: "Username" },
        { role: "textbox", name: "Username" },
        { role: "button", name: "Log In" },
      ],
    });

    expect(rendered).toBe(
      ['- main:', '  - heading "Accounts Overview"', "  - text: Username", '  - textbox "Username"', '  - button "Log In"'].join(
        "\n",
      ),
    );
  });

  it("drops invisible nodes and keeps values out of the observation", () => {
    const rendered = renderAxSnapshot({
      role: "window",
      children: [
        { role: "textbox", name: "Password", value: "hunter2", sensitive: true },
        { role: "button", name: "Hidden", visible: false },
      ],
    });

    // A control the model cannot act on is a control it should not be shown.
    expect(rendered).not.toContain("Hidden");
    // Names identify controls; values are content, and a password is the reason that matters.
    expect(rendered).not.toContain("hunter2");
    expect(rendered).toContain('- textbox "Password"');
  });

  it("lifts alerts out of the tree", () => {
    expect(
      collectAlerts({ role: "window", children: [{ role: "alert", name: "Nope" }] }),
    ).toEqual(["Nope"]);
  });
});

describe("desktop locations are policed by application", () => {
  it("round-trips an application and window", () => {
    const location = desktopLocation(APP, "Accounts Overview");
    expect(applicationOf(location)).toBe(APP);
    expect(windowOf(location)).toBe("Accounts Overview");
  });

  it("allows an allowlisted application and refuses anything else", () => {
    const guard = new PolicyGuard(policy);
    expect(guard.checkApplication(desktopLocation(APP, "Sign In")).allowed).toBe(true);
    expect(guard.checkApplication(desktopLocation("com.evil.Other", "x")).allowed).toBe(false);
  });

  it("refuses a location it cannot identify rather than passing it", () => {
    // Fails closed. Before this existed the opaque path skipped the check entirely, so a
    // desktop surface ran with no location policing at all.
    const guard = new PolicyGuard(policy);
    expect(guard.checkApplication("not-a-location").allowed).toBe(false);
    expect(guard.checkLocation("http://anywhere.test", "url").allowed).toBe(false);
  });

  it("refuses a policy that allows nothing at all", () => {
    const empty = Policy.safeParse({});
    expect(empty.success).toBe(false);
  });

  it("matches on the application, not the window title", () => {
    // A title is content the application controls. Containment that can be renamed past is not
    // containment, so a hostile window title must not buy access.
    const guard = new PolicyGuard(policy);
    expect(guard.checkApplication(desktopLocation("com.evil.Other", APP)).allowed).toBe(false);
  });
});

describe("a capability replays through a real helper process", () => {
  it("signs in, opens an account and returns typed outputs", async () => {
    const result = await run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs).toEqual({ accountType: "SAVINGS", balance: -100 });
    }
    // No model in the loop here either — the surface changed, nothing above it did.
    expect(result.evidence.modelCalls).toBe(0);
  }, 30_000);

  it("returns a business outcome from a handler, not a failure", async () => {
    const result = await run({ inputs: { accountId: "99999" } });

    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") expect(result.outcome).toBe("account_not_found");
  }, 30_000);

  it("refuses an application the policy does not allow", async () => {
    const result = await run({
      policy: Policy.parse({ allowedApplications: ["com.example.SomethingElse"] }),
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("POLICY_DENIED");
  }, 30_000);

  it("keeps the password out of every byte of evidence", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    await run();

    const root = evidenceRoot!;
    const runs = await readdir(root);
    let bytes = "";
    for (const dir of runs) {
      for (const file of await readdir(join(root, dir))) {
        bytes += await readFile(join(root, dir, file), "utf8").catch(() => "");
      }
    }

    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes).not.toContain("hunter2");
  }, 30_000);
});

describe("the surface refuses what it cannot do, by name", () => {
  it("names css and testId as meaningless here rather than reporting not-found", async () => {
    const surface = desktopSurface();
    try {
      const outcome = await surface.click({
        candidates: [
          { strategy: "css", value: "#login" },
          { strategy: "testId", value: "login" },
        ],
      });

      expect(outcome.ok).toBe(false);
      // "not found" would send a reader looking for a missing control that never existed.
      if (!outcome.ok) expect(outcome.error).toContain("no meaning on an accessibility tree");
    } finally {
      await surface.close();
    }
  }, 30_000);

  it("refuses to read a secure field even when an artifact asks", async () => {
    const surface = desktopSurface();
    try {
      await surface.navigate(`app://${APP}`);
      const outcome = await surface.extract({
        candidates: [{ strategy: "role", role: "securetextfield", name: "Password", exact: true }],
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("secure field");
    } finally {
      await surface.close();
    }
  }, 30_000);

  it("fails every in-flight request when the helper dies", async () => {
    // A crashed helper must not look like a slow application: without this, every step waits
    // out its timeout and fails with nothing useful.
    const transport = new StdioDesktopTransport({ command: "node", args: ["-e", "process.exit(1)"] });
    await expect(transport.request("observe", {})).rejects.toThrow(/exited/);
  }, 30_000);
});
