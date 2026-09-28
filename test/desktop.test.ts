import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay } from "../src/replay.js";
import { invoke } from "../src/catalog.js";
import { Policy } from "../src/schema.js";
import { PolicyGuard } from "../src/safety.js";
import { DesktopSurface } from "../src/desktop/surface.js";
import { StdioDesktopTransport } from "../src/desktop/transport.js";
import type { DesktopTransport } from "../src/desktop/protocol.js";
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

/**
 * A helper whose screen can be made to change between two requests, so the gap between
 * resolving a node and acting on it is actually exercised rather than assumed away.
 */
class ScriptedTransport implements DesktopTransport {
  readonly sent: string[] = [];
  constructor(
    private readonly answers: Partial<Record<string, (params: any) => unknown>>,
  ) {}
  async request(method: string, params: unknown): Promise<any> {
    this.sent.push(method);
    const answer = this.answers[method];
    if (!answer) throw new Error(`unscripted: ${method}`);
    return answer(params);
  }
  async close(): Promise<void> {}
}

describe("resolution and the action it authorises stay tied together", () => {
  it("acts on the handle it resolved, never on the query again", async () => {
    const transport = new ScriptedTransport({
      resolve: () => ({ matches: [{ role: "button", name: "Log In", handle: "h1" }] }),
      click: (params: { handle: string }) => {
        // The whole point: the mutation carries the identity of the node that was checked for
        // uniqueness. A query here would be re-matched against a tree that may have changed.
        expect(params).toEqual({ handle: "h1" });
        return { window: { application: APP, window: "Accounts Overview" } };
      },
    });

    const surface = new DesktopSurface({ transport });
    const outcome = await surface.click({
      candidates: [{ strategy: "role", role: "button", name: "Log In", exact: true }],
    });

    expect(outcome.ok).toBe(true);
  });

  it("refuses a handle the helper has invalidated rather than re-matching", async () => {
    const transport = new ScriptedTransport({
      resolve: () => ({ matches: [{ role: "button", name: "Go", handle: "h1" }] }),
      click: () => {
        throw new Error("stale handle: h1 (the screen changed after it was resolved)");
      },
    });

    const outcome = await new DesktopSurface({ transport }).click({
      candidates: [{ strategy: "role", role: "button", name: "Go", exact: true }],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("stale handle");
  });

  it("reports the application an action left it in, not the one it started in", async () => {
    // The reviewer's case: an allowed application whose button switches to another one. If the
    // surface still reports the old location, the landing check passes on a stale answer and
    // the run continues inside an application nobody allowed.
    const transport = new ScriptedTransport({
      observe: () => ({
        window: { application: APP, window: "Sign In" },
        tree: { role: "window", name: "Sign In", children: [] },
      }),
      resolve: () => ({ matches: [{ role: "button", name: "Go", handle: "h1" }] }),
      click: () => ({ window: { application: "com.evil.Other", window: "Gotcha" } }),
    });

    const surface = new DesktopSurface({ transport });
    await surface.observe(0);
    expect(applicationOf(surface.currentUrl())).toBe(APP);

    await surface.click({
      candidates: [{ strategy: "role", role: "button", name: "Go", exact: true }],
    });

    expect(applicationOf(surface.currentUrl())).toBe("com.evil.Other");
    // And that is what the guard would now refuse.
    expect(new PolicyGuard(policy).checkApplication(surface.currentUrl()).allowed).toBe(false);
  });
});

describe("the candidate list is walked, not sampled", () => {
  const target = {
    candidates: [
      { strategy: "role" as const, role: "button" as const, name: "Missing", exact: true },
      { strategy: "role" as const, role: "button" as const, name: "Ambiguous", exact: true },
      { strategy: "label" as const, value: "Works" },
    ],
  };

  it("falls through zero and ambiguous matches to a candidate that resolves", async () => {
    const transport = new ScriptedTransport({
      resolve: (p: { name?: string }) =>
        p.name === "Missing"
          ? { matches: [] }
          : p.name === "Ambiguous"
            ? { matches: [{ role: "button", handle: "a" }, { role: "button", handle: "b" }] }
            : { matches: [{ role: "button", name: "Works", handle: "c" }] },
      click: (p: { handle: string }) => {
        // The third candidate, which is what an ordered preference list is for.
        expect(p.handle).toBe("c");
        return { window: { application: APP, window: "w" } };
      },
    });

    expect((await new DesktopSurface({ transport }).click(target)).ok).toBe(true);
  });

  it("distinguishes ambiguity from absence when nothing resolves", async () => {
    const ambiguous = new ScriptedTransport({
      resolve: () => ({ matches: [{ handle: "a" }, { handle: "b" }] }),
    });
    const absent = new ScriptedTransport({ resolve: () => ({ matches: [] }) });

    const a = await new DesktopSurface({ transport: ambiguous, resolveTimeoutMs: 0 }).click(target);
    const b = await new DesktopSurface({ transport: absent, resolveTimeoutMs: 0 }).click(target);

    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toContain("refusing to guess");
    expect(b.ok).toBe(false);
    // "found none" and "found three" are different findings and must read differently.
    if (!b.ok) expect(b.error).toContain("no element matched");
  });

  it("carries `exact` through instead of letting the helper assume equality", async () => {
    const seen: unknown[] = [];
    const transport = new ScriptedTransport({
      resolve: (p) => {
        seen.push(p);
        return { matches: [{ handle: "h", name: "x" }] };
      },
      click: () => ({ window: { application: APP, window: "w" } }),
    });

    await new DesktopSurface({ transport }).click({
      candidates: [{ strategy: "role", role: "button", name: "Log", exact: false }],
    });

    // The schema defaults `exact` to false. Dropped, a substring locator becomes an equality
    // one and every recorded name silently narrows.
    expect(seen[0]).toMatchObject({ role: "button", name: "Log", exact: false });
  });
});

describe("conditions mean the same thing on both surfaces", () => {
  const tree = {
    role: "window",
    name: "Account Details",
    children: [
      { role: "heading", name: "Account Details" },
      { role: "textbox", name: "Balance", value: "-100.00" },
      { role: "button", name: "Hidden thing", visible: false },
    ],
  };

  const surfaceFor = () =>
    new DesktopSurface({
      transport: new ScriptedTransport({
        observe: () => ({ window: { application: APP, window: "Account Details" }, tree }),
      }),
    });

  it("evaluates title, all, any and not — not just text and role", async () => {
    const surface = surfaceFor();

    expect(await surface.verify({ kind: "title", value: "Account Details" })).toBe(true);
    expect(await surface.verify({ kind: "title", value: "Sign In" })).toBe(false);

    // These are in real approved artifacts. Answering `false` to every composite makes a
    // checkpoint wait out its timeout and a handler miss a business outcome it declared.
    expect(
      await surface.verify({
        kind: "all",
        conditions: [
          { kind: "text", value: "Account Details", visible: true },
          { kind: "role", role: "textbox", name: "Balance" },
        ],
      }),
    ).toBe(true);
    expect(
      await surface.verify({
        kind: "any",
        conditions: [
          { kind: "text", value: "could not be found", visible: true },
          { kind: "text", value: "Account Details", visible: true },
        ],
      }),
    ).toBe(true);
    expect(
      await surface.verify({ kind: "not", condition: { kind: "text", value: "Sign In", visible: true } }),
    ).toBe(true);
  });

  it("matches a urlPattern against the location, with the same glob matcher", async () => {
    expect(await surfaceFor().verify({ kind: "urlPattern", value: `app://${APP}/**` })).toBe(true);
    expect(await surfaceFor().verify({ kind: "urlPattern", value: "app://other/**" })).toBe(false);
  });

  it("keeps hidden content out of a condition unless it opts in", async () => {
    // The default that stops a handler firing on text an application ships hidden on every
    // healthy screen.
    expect(await surfaceFor().verify({ kind: "text", value: "Hidden thing", visible: true })).toBe(false);
    expect(
      await surfaceFor().verify({ kind: "text", value: "Hidden thing", visible: false }),
    ).toBe(true);
  });
});

describe("the agent-facing entry point can run what it lists", () => {
  it("invokes an approved desktop capability given a helper", async () => {
    // `invoke` is what an agent calls. A capability it can see in the catalog and cannot run
    // is worse than one it cannot see at all, and the CLI used to parse --desktop-helper
    // globally while only the direct `replay` path acted on it.
    const evidence = await mkdtemp(join(tmpdir(), "desktop-invoke-"));
    try {
      const result = await invoke(
        "capabilities",
        "desktop_lookup_balance",
        { accountId: "12678" },
        {
          policy: Policy.parse({ allowedApplications: [APP] }),
          secrets: { appPassword: "hunter2" },
          evidenceRoot: evidence,
          surfaceKind: "desktop",
          createSurface: async () => desktopSurface(),
        },
      );

      expect("status" in result && result.status).toBe("success");
      if ("status" in result && result.status === "success") {
        expect(result.outputs).toEqual({ accountType: "SAVINGS", balance: -100 });
      }
    } finally {
      await rm(evidence, { recursive: true, force: true });
    }
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

  it("rejects rather than crashing the process when the helper cannot be spawned", async () => {
    // Node treats an unhandled `error` on a child as an uncaught exception, so a mistyped
    // --desktop-helper used to take the whole run down with `spawn ENOENT` instead of
    // returning a result the caller could read.
    const transport = new StdioDesktopTransport({
      command: "definitely-not-a-real-helper-binary",
      args: [],
    });

    await expect(transport.request("observe", {})).rejects.toThrow(/could not be started/);
    await transport.close();
  }, 30_000);

  it("turns an unspawnable helper into a structured run failure", async () => {
    const result = await run({
      createSurface: async () =>
        new DesktopSurface({
          transport: new StdioDesktopTransport({ command: "no-such-helper-binary", args: [] }),
        }),
    });

    // The contract holds all the way out: a caller consuming --json gets a result, not a stack.
    expect(result.status).toBe("failure");
  }, 30_000);
});
