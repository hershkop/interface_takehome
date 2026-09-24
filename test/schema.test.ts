import { describe, expect, it } from "vitest";
import { CapabilityArtifact, Condition, Handler, Policy } from "../src/schema.js";

/** Minimal valid artifact; each test clones and breaks one thing. */
function baseArtifact(): unknown {
  return {
    schemaVersion: "1.0",
    capabilityId: "lookup_account_balance",
    version: "1.0.0",
    metadata: {
      name: "Look up account balance",
      description: "Read the current balance for an account.",
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
    expect(parsed.metadata.risk).toBe("safe");
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
