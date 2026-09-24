import { describe, expect, it } from "vitest";
import { PolicyGuard } from "../src/safety.js";
import { Policy } from "../src/schema.js";

const guard = (over: Record<string, unknown> = {}) =>
  new PolicyGuard(Policy.parse({ allowedOrigins: ["http://bank.test:8080"], ...over }));

describe("origin allowlist", () => {
  it("admits a URL on an allowed origin", () => {
    expect(guard().checkUrl("http://bank.test:8080/parabank/overview.htm").allowed).toBe(true);
  });

  it("refuses a different origin", () => {
    const d = guard().checkUrl("https://evil.example.com/parabank/overview.htm");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("not in the allowlist");
  });

  it("is not fooled by a suffix that merely starts with an allowed host", () => {
    // The classic allowlist bug: substring matching lets bank.test.evil.com through. Origins
    // are compared exactly, and the schema canonicalises them, so this cannot regress into a
    // prefix check without the comparison itself changing.
    for (const url of [
      "http://bank.test.evil.com/parabank/x",
      "http://evil.com/?q=http://bank.test:8080",
      "http://bank.test:9999/parabank/x",
      "https://bank.test:8080/parabank/x",
    ]) {
      expect(guard().checkUrl(url).allowed, url).toBe(false);
    }
  });

  it("refuses a malformed URL rather than assuming it is safe", () => {
    expect(guard().checkUrl("not a url").allowed).toBe(false);
  });
});

describe("path allowlist", () => {
  it("allows any path when no patterns are configured", () => {
    expect(guard().checkUrl("http://bank.test:8080/anything/at/all").allowed).toBe(true);
  });

  it("enforces configured route patterns", () => {
    const g = guard({ allowedPaths: ["/parabank/**"] });
    expect(g.checkUrl("http://bank.test:8080/parabank/overview.htm").allowed).toBe(true);

    const denied = g.checkUrl("http://bank.test:8080/admin/console");
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("does not match any allowed route");
  });
});

describe("action types", () => {
  it("permits the declared set by default", () => {
    expect(guard().checkActionType("click").allowed).toBe(true);
  });

  it("refuses a blocked type", () => {
    const g = guard({ blockedActions: ["click"] });
    expect(g.checkActionType("click").allowed).toBe(false);
    expect(g.checkActionType("extract").allowed).toBe(true);
  });

  it("lets a block override an allow rather than the other way round", () => {
    // If the two lists disagree, the safe reading has to win, or a blocklist is decorative.
    const g = guard({ allowedActions: ["click"], blockedActions: ["click"] });
    expect(g.checkActionType("click").allowed).toBe(false);
  });

  it("refuses a type outside a narrowed allow list", () => {
    const g = guard({ allowedActions: ["navigate", "extract", "assert", "wait"] });
    expect(g.checkActionType("fill").allowed).toBe(false);
    expect(g.checkActionType("extract").allowed).toBe(true);
  });
});

describe("checkAction", () => {
  it("checks a navigate's resolved destination, not its template", () => {
    const g = guard({ allowedPaths: ["/parabank/**"] });
    const action = { action: "navigate", url: "{{baseUrl}}/admin.htm" } as const;
    expect(g.checkAction(action, "http://bank.test:8080/admin.htm").allowed).toBe(false);
    expect(g.checkAction(action, "http://bank.test:8080/parabank/x.htm").allowed).toBe(true);
  });
});

describe("budgets", () => {
  it("stops once the step ceiling is passed", () => {
    const g = guard({ maxSteps: 2 });
    g.begin();
    expect(g.countStep().allowed).toBe(true);
    expect(g.countStep().allowed).toBe(true);
    const third = g.countStep();
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain("step budget");
  });

  it("refuses an artifact that cannot fit the ceiling before the run starts", () => {
    // Discovering this on step 41 wastes a live session.
    const d = guard({ maxSteps: 10 }).checkArtifactFits(25);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("25 steps but policy allows 10");
  });

  it("enforces the wall-clock ceiling", async () => {
    const g = guard({ runTimeoutMs: 40 });
    g.begin();
    expect(g.checkDeadline().allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 70));
    expect(g.checkDeadline().allowed).toBe(false);
  });

  it("resets budgets on begin()", () => {
    const g = guard({ maxSteps: 1 });
    g.begin();
    g.countStep();
    expect(g.countStep().allowed).toBe(false);
    g.begin();
    expect(g.countStep().allowed).toBe(true);
  });
});

describe("navigationAllowed predicate", () => {
  it("mirrors checkUrl and is safe to pass as a bare function", () => {
    // It is handed to the browser as a callback, so it must not depend on `this` binding.
    const { navigationAllowed } = guard({ allowedPaths: ["/parabank/**"] });
    expect(navigationAllowed("http://bank.test:8080/parabank/x")).toBe(true);
    expect(navigationAllowed("https://evil.example.com/")).toBe(false);
  });
});

describe("requireApprovalFor is policy's decision, not the engine's", () => {
  it("gates approval_required by default", () => {
    expect(guard().requiresApproval("approval_required")).toBe(true);
    expect(guard().requiresApproval("safe")).toBe(false);
  });

  it("lets a cautious tenant gate everything", () => {
    const g = guard({ requireApprovalFor: ["safe", "approval_required"] });
    expect(g.requiresApproval("safe")).toBe(true);
  });

  it("lets a tenant that trusts approved capabilities gate nothing", () => {
    const g = guard({ requireApprovalFor: [] });
    expect(g.requiresApproval("approval_required")).toBe(false);
  });
});

describe("classifyControl gates discovery's irreversible actions (review #1)", () => {
  const risky = () =>
    guard({ riskyControls: ["^transfer$", "^submit", "confirm", "^delete"] });

  it("flags a control whose name names an irreversible operation", () => {
    // Replay learns risk from the artifact. Discovery is producing the artifact, so without
    // this it has no way to know the button it is about to click moves money.
    expect(risky().classifyControl(["Transfer"])).toBe("approval_required");
    expect(risky().classifyControl(["Submit Payment"])).toBe("approval_required");
    expect(risky().classifyControl([undefined, "#confirm-btn"])).toBe("approval_required");
  });

  it("is case-insensitive, because accessible names are written by humans", () => {
    expect(risky().classifyControl(["TRANSFER"])).toBe("approval_required");
    expect(risky().classifyControl(["transfer"])).toBe("approval_required");
  });

  it("leaves ordinary controls alone", () => {
    for (const name of ["Accounts Overview", "Log In", "Username", "Find Transactions"]) {
      expect(risky().classifyControl([name]), name).toBe("safe");
    }
  });

  it("classifies nothing when a tenant declares no risky controls", () => {
    expect(guard().classifyControl(["Transfer"])).toBe("safe");
  });

  it("rejects a policy whose riskyControls pattern does not compile", () => {
    const parsed = Policy.safeParse({
      allowedOrigins: ["http://a.test"],
      riskyControls: ["([unclosed"],
    });
    expect(parsed.success).toBe(false);
  });
});
