import { describe, expect, it } from "vitest";
import {
  CapabilityArtifact,
  Condition,
  ErrorCode,
  Handler,
  Policy,
  RunError,
  collectTargets,
} from "../src/schema.js";

/** Minimal valid artifact; each test clones and breaks one thing. */
function baseArtifact(): unknown {
  return {
    schemaVersion: "1.0",
    capabilityId: "lookup_account_balance",
    version: "1.0.0",
    metadata: {
      name: "Look up account balance",
      description: "Read the current balance for an account.",
      risk: "safe",
      recordedAt: "2026-09-24T02:00:00.000Z",
      recordedBy: "human",
    },
    target: { app: "parabank", baseUrl: "http://localhost:8080/parabank" },
    inputs: { accountId: { type: "string" } },
    outputs: {
      balance: {
        type: "number",
        source: { kind: "variable", name: "balanceText" },
        coerce: "currency",
      },
    },
    steps: [
      { id: "open", action: { action: "navigate", url: "{{inputs.accountId}}" } },
      {
        id: "read",
        action: {
          action: "extract",
          as: "balanceText",
          target: { candidates: [{ strategy: "role", role: "cell", name: "Balance" }] },
        },
      },
    ],
    handlers: [
      {
        id: "not_found",
        match: { kind: "text", value: "Could not find account" },
        disposition: { kind: "business_outcome", outcome: "account_not_found" },
      },
    ],
    checkpoint: { kind: "text", value: "Account Details" },
  };
}

describe("CapabilityArtifact", () => {
  it("accepts a valid v1 artifact and applies defaults", () => {
    const parsed = CapabilityArtifact.parse(baseArtifact());
    expect(parsed.capabilityId).toBe("lookup_account_balance");
    expect(parsed.metadata.status).toBe("draft");
    expect(parsed.handlers[0]?.scope).toBe("global");
    expect(parsed.outputs.balance?.onMissing).toBe("fail");
  });

  it("rejects an unknown action type", () => {
    const a = baseArtifact() as any;
    a.steps[0].action = { action: "drag", target: { candidates: [] } };
    expect(CapabilityArtifact.safeParse(a).success).toBe(false);
  });

  it("rejects a target with no candidates", () => {
    const a = baseArtifact() as any;
    a.steps[1].action.target.candidates = [];
    expect(CapabilityArtifact.safeParse(a).success).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const a = baseArtifact() as any;
    a.steps[1].id = "open";
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("duplicate step id");
  });

  it("rejects a handler scoped to a step that does not exist", () => {
    const a = baseArtifact() as any;
    a.handlers[0].scope = ["nope"];
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("unknown step");
  });

  it("rejects an output reading a variable no extract step captures", () => {
    const a = baseArtifact() as any;
    a.outputs.balance.source = { kind: "variable", name: "neverSet" };
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("no extract step sets it");
  });

  it("refuses to approve an artifact that targets by coordinates", () => {
    const a = baseArtifact() as any;
    a.metadata.status = "approved";
    a.steps[1].action.target.candidates = [{ strategy: "coordinates", x: 10, y: 20 }];
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("cannot be approved");
  });

  it("allows coordinates while the artifact stays a draft", () => {
    const a = baseArtifact() as any;
    a.steps[1].action.target.candidates = [{ strategy: "coordinates", x: 10, y: 20 }];
    expect(CapabilityArtifact.safeParse(a).success).toBe(true);
  });
});

describe("Condition", () => {
  it("defaults text and role matching to visible-only", () => {
    // ParaBank hides "An internal error has occurred" inside healthy pages, so a handler that
    // matched hidden DOM text would fire on every successful run. See docs/DAY0-FINDINGS.md §3.
    expect(Condition.parse({ kind: "text", value: "x" })).toMatchObject({ visible: true });
    expect(Condition.parse({ kind: "role", role: "alert" })).toMatchObject({ visible: true });
  });

  it("allows opting into hidden matching explicitly", () => {
    expect(Condition.parse({ kind: "text", value: "x", visible: false })).toMatchObject({
      visible: false,
    });
  });

  it("composes with all/not", () => {
    const c = Condition.parse({
      kind: "all",
      conditions: [
        { kind: "text", value: "Account Details" },
        { kind: "not", condition: { kind: "text", value: "Error!" } },
      ],
    });
    expect(c.kind).toBe("all");
  });
});

describe("Handler", () => {
  it("caps recovery attempts rather than allowing open-ended retry", () => {
    const ok = Handler.safeParse({
      id: "h",
      match: { kind: "text", value: "x" },
      disposition: { kind: "recover", remedy: "retry_step", maxAttempts: 3 },
    });
    expect(ok.success).toBe(true);

    const tooMany = Handler.safeParse({
      id: "h",
      match: { kind: "text", value: "x" },
      disposition: { kind: "recover", remedy: "retry_step", maxAttempts: 99 },
    });
    expect(tooMany.success).toBe(false);
  });

  it("rejects an unknown remedy", () => {
    const r = Handler.safeParse({
      id: "h",
      match: { kind: "text", value: "x" },
      disposition: { kind: "recover", remedy: "ask_the_llm" },
    });
    expect(r.success).toBe(false);
  });
});

describe("Policy", () => {
  it("defaults to allowing every declared action type", () => {
    const p = Policy.parse({ allowedOrigins: ["http://localhost:8080"] });
    expect(p.allowedActions).toContain("click");
    expect(p.requireApprovalFor).toEqual(["approval_required"]);
    expect(p.maxSteps).toBe(40);
  });

  it("requires at least one allowed origin", () => {
    expect(Policy.safeParse({ allowedOrigins: [] }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions from PR1 review. Each test names the hole it closes.
// ─────────────────────────────────────────────────────────────────────────────

describe("risk classification cannot be omitted (review #1)", () => {
  it("rejects an artifact whose metadata omits risk", () => {
    const a = baseArtifact() as any;
    delete a.metadata.risk;
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("risk");
  });

  it("cannot silently produce an executable safe artifact by omission", () => {
    // The concrete worry: a truncated recorder output runs a transfer unattended because
    // nobody wrote down that it was risky. Omission must fail validation, not default to safe.
    const a = baseArtifact() as any;
    delete a.metadata.risk;
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect((r as any).data?.metadata?.risk).toBeUndefined();
  });

  it("still accepts every explicit classification", () => {
    for (const risk of ["safe", "approval_required", "blocked"]) {
      const a = baseArtifact() as any;
      a.metadata.risk = risk;
      expect(CapabilityArtifact.safeParse(a).success).toBe(true);
    }
  });
});

describe("handler fail codes match the result contract (review #2)", () => {
  it("rejects a fail disposition carrying a code RunError cannot represent", () => {
    const r = Handler.safeParse({
      id: "h",
      match: { kind: "text", value: "x" },
      disposition: { kind: "fail", code: "POLCY_DENID" },
    });
    expect(r.success).toBe(false);
  });

  it("accepts every ErrorCode the result contract declares", () => {
    for (const code of ErrorCode.options) {
      const r = Handler.safeParse({
        id: "h",
        match: { kind: "text", value: "x" },
        disposition: { kind: "fail", code },
      });
      expect(r.success, code).toBe(true);
      // Round-trip: anything an artifact may declare, a RunError must be able to carry.
      expect(RunError.safeParse({ code, message: "m" }).success, code).toBe(true);
    }
  });

  it("leaves business outcomes as open strings", () => {
    // Business outcomes are app-specific; only engine failures are a closed set.
    const r = Handler.safeParse({
      id: "h",
      match: { kind: "text", value: "x" },
      disposition: { kind: "business_outcome", outcome: "anything_the_app_does" },
    });
    expect(r.success).toBe(true);
  });
});

describe("coordinate guard covers every target location (review #3)", () => {
  it("blocks approval for a coordinate target in an output locator", () => {
    const a = baseArtifact() as any;
    a.metadata.status = "approved";
    a.outputs.balance.source = {
      kind: "locator",
      target: { candidates: [{ strategy: "coordinates", x: 1, y: 2 }] },
    };
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("outputs.balance");
  });

  it("blocks approval for a coordinate target in a dismiss handler", () => {
    const a = baseArtifact() as any;
    a.metadata.status = "approved";
    a.handlers.push({
      id: "popup",
      match: { kind: "text", value: "Continue" },
      disposition: {
        kind: "recover",
        remedy: "dismiss",
        target: { candidates: [{ strategy: "coordinates", x: 5, y: 5 }] },
      },
    });
    const r = CapabilityArtifact.safeParse(a);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("handlers.popup");
  });

  it("names the offending location so it can be fixed", () => {
    const a = baseArtifact() as any;
    a.metadata.status = "approved";
    a.steps[1].action.target.candidates = [{ strategy: "coordinates", x: 1, y: 1 }];
    const r = CapabilityArtifact.safeParse(a);
    const message = r.error?.issues.map((i) => i.message).join(" ") ?? "";
    expect(message).toContain("steps[1]");
    expect(message).toContain("read");
  });

  it("collectTargets finds targets in steps, outputs, and dismiss handlers", () => {
    const a = baseArtifact() as any;
    a.outputs.balance.source = {
      kind: "locator",
      target: { candidates: [{ strategy: "text", value: "Balance" }] },
    };
    a.handlers.push({
      id: "popup",
      match: { kind: "text", value: "Continue" },
      disposition: {
        kind: "recover",
        remedy: "dismiss",
        target: { candidates: [{ strategy: "role", role: "button", name: "OK" }] },
      },
    });
    const parsed = CapabilityArtifact.parse(a);
    const where = collectTargets(parsed).map((t) => t.where);
    expect(where).toEqual(
      expect.arrayContaining([expect.stringContaining("read"), "outputs.balance", "handlers.popup"]),
    );
  });
});

describe("dismiss recovery must say what to dismiss (review #4)", () => {
  it("rejects dismiss with no target", () => {
    const r = Handler.safeParse({
      id: "h",
      match: { kind: "text", value: "x" },
      disposition: { kind: "recover", remedy: "dismiss" },
    });
    expect(r.success).toBe(false);
  });

  it("accepts dismiss with a target", () => {
    const r = Handler.safeParse({
      id: "h",
      match: { kind: "text", value: "x" },
      disposition: {
        kind: "recover",
        remedy: "dismiss",
        target: { candidates: [{ strategy: "role", role: "button", name: "OK" }] },
      },
    });
    expect(r.success).toBe(true);
  });

  it("does not require a target for remedies that do not need one", () => {
    for (const remedy of ["retry_step", "reauthenticate"]) {
      const r = Handler.safeParse({
        id: "h",
        match: { kind: "text", value: "x" },
        disposition: { kind: "recover", remedy },
      });
      expect(r.success, remedy).toBe(true);
    }
  });
});

describe("allowedOrigins is a real origin allowlist (review #5)", () => {
  const origins = (v: string) => Policy.safeParse({ allowedOrigins: [v] });

  it("rejects non-http(s) schemes", () => {
    expect(origins("javascript:alert(1)").success).toBe(false);
    expect(origins("data:text/plain,hello").success).toBe(false);
    expect(origins("file:///etc/passwd").success).toBe(false);
  });

  it("rejects embedded credentials", () => {
    expect(origins("https://user:pw@example.com").success).toBe(false);
  });

  it("rejects anything carrying a path, query, or fragment", () => {
    expect(origins("https://example.com/path?x=1").success).toBe(false);
    expect(origins("https://example.com/admin").success).toBe(false);
    expect(origins("https://example.com/#f").success).toBe(false);
  });

  it("canonicalises what it accepts", () => {
    const p = Policy.parse({ allowedOrigins: ["http://localhost:8080/"] });
    expect(p.allowedOrigins).toEqual(["http://localhost:8080"]);
  });
});

describe("input defaults match their declared type (review #6)", () => {
  it("rejects a default of the wrong type", () => {
    for (const bad of [
      { type: "number", default: "oops" },
      { type: "boolean", default: 123 },
      { type: "string", default: false },
    ]) {
      const a = baseArtifact() as any;
      a.inputs.accountId = bad;
      expect(CapabilityArtifact.safeParse(a).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts a well-typed default, and no default at all", () => {
    const a = baseArtifact() as any;
    a.inputs.accountId = { type: "string", default: "12345" };
    expect(CapabilityArtifact.safeParse(a).success).toBe(true);
    a.inputs.accountId = { type: "string" };
    expect(CapabilityArtifact.safeParse(a).success).toBe(true);
  });
});
