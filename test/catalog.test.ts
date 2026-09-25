import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, toToolDefinition } from "../src/catalog.js";

let dir: string;

const artifact = (over: Record<string, unknown> = {}) => ({
  schemaVersion: "1.0",
  capabilityId: "lookup_account_balance",
  version: "1.0.0",
  metadata: {
    name: "Look up account balance",
    description: "Read the balance for one account.",
    status: "approved",
    risk: "safe",
    recordedAt: "2026-09-24T00:00:00.000Z",
    recordedBy: "human",
  },
  target: { app: "parabank", baseUrl: "http://localhost:18080/parabank" },
  inputs: {
    accountId: { type: "string", description: "Account number.", pattern: "^[0-9]+$" },
    note: { type: "string", required: false },
  },
  outputs: { balance: { type: "number", source: { kind: "variable", name: "b" } } },
  steps: [
    {
      id: "read",
      action: {
        action: "extract",
        as: "b",
        target: { candidates: [{ strategy: "css", value: "#balance" }] },
      },
    },
  ],
  handlers: [],
  checkpoint: { kind: "text", value: "Account Details" },
  ...over,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "catalog-"));
  await writeFile(join(dir, "lookup.json"), JSON.stringify(artifact()), "utf8");
  await writeFile(
    join(dir, "risky.json"),
    JSON.stringify(
      artifact({
        capabilityId: "transfer_funds",
        metadata: {
          name: "Transfer funds",
          description: "Move money.",
          status: "draft",
          risk: "approval_required",
          recordedAt: "2026-09-24T00:00:00.000Z",
          recordedBy: "llm",
        },
      }),
    ),
    "utf8",
  );
  await writeFile(join(dir, "broken.json"), '{"schemaVersion":"1.0"}', "utf8");
  await writeFile(join(dir, "notjson.json"), "not json at all", "utf8");
  await writeFile(join(dir, "ignored.txt"), "not a capability", "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadCatalog", () => {
  it("loads valid artifacts and reports invalid ones rather than hiding them", async () => {
    // A capability that silently fails to load is worse than one that loudly does not: an agent
    // would simply not see it, and nobody would know why.
    const { entries, invalid } = await loadCatalog(dir);
    expect(entries.map((e) => e.capabilityId).sort()).toEqual([
      "lookup_account_balance",
      "transfer_funds",
    ]);
    expect(invalid).toHaveLength(2);
    expect(invalid.map((i) => i.path).join()).toContain("broken.json");
    expect(invalid.map((i) => i.path).join()).toContain("notjson.json");
  });

  it("returns an empty catalog for a missing directory rather than throwing", async () => {
    const { entries } = await loadCatalog(join(dir, "nope"));
    expect(entries).toEqual([]);
  });
});

describe("toToolDefinition", () => {
  it("derives the agent-facing schema from the artifact's own inputs", async () => {
    // Generated rather than written alongside, so the advertised contract and the enforced one
    // cannot drift apart.
    const { entries } = await loadCatalog(dir);
    const tool = toToolDefinition(entries.find((e) => e.capabilityId === "lookup_account_balance")!);

    expect(tool.name).toBe("lookup_account_balance");
    const schema = tool.input_schema as {
      properties: Record<string, { type: string; pattern?: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.accountId).toMatchObject({ type: "string", pattern: "^[0-9]+$" });
    expect(schema.required).toEqual(["accountId"]);
    expect(schema.required).not.toContain("note");
    expect(schema.additionalProperties).toBe(false);
  });

  it("tells the agent what it gets back", async () => {
    const { entries } = await loadCatalog(dir);
    const tool = toToolDefinition(entries.find((e) => e.capabilityId === "lookup_account_balance")!);
    expect(tool.description).toContain("balance (number)");
  });

  it("warns the agent when a capability will stop for a human", async () => {
    // An agent choosing between capabilities needs to know which ones block before it commits.
    const { entries } = await loadCatalog(dir);
    const tool = toToolDefinition(entries.find((e) => e.capabilityId === "transfer_funds")!);
    expect(tool.description).toContain("requires a human");
  });

  it("warns that a draft is not approved for unattended use", async () => {
    const { entries } = await loadCatalog(dir);
    const tool = toToolDefinition(entries.find((e) => e.capabilityId === "transfer_funds")!);
    expect(tool.description).toContain("DRAFT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions from PR6 review.
// ─────────────────────────────────────────────────────────────────────────────

describe("drafts are not silently callable (review #2)", () => {
  it("hides drafts from the agent-facing catalog", async () => {
    // A warning in a description is documentation. An agent reads the schema and calls the
    // tool — so a draft it can see is a draft it will call.
    const { entries } = await loadCatalog(dir, { agentFacing: true });
    expect(entries.map((e) => e.capabilityId)).toEqual(["lookup_account_balance"]);
  });

  it("still shows drafts to a human browsing the catalog", async () => {
    // What a person reviewing capabilities should see and what an agent should be handed as
    // callable tools are not the same list.
    const { entries } = await loadCatalog(dir);
    expect(entries.map((e) => e.capabilityId).sort()).toEqual([
      "lookup_account_balance",
      "transfer_funds",
    ]);
  });

  it("refuses to invoke a draft without an explicit opt-in", async () => {
    const { invoke } = await import("../src/catalog.js");
    const { Policy } = await import("../src/schema.js");
    const result = await invoke(
      dir,
      "transfer_funds",
      {},
      { policy: Policy.parse({ allowedOrigins: ["http://localhost:18080"] }) },
    );
    expect(result).toHaveProperty("refused");
    if ("refused" in result) expect(result.refused).toContain("draft");
  });

  it("reports an unknown capability distinctly from a refused one", async () => {
    const { invoke } = await import("../src/catalog.js");
    const { Policy } = await import("../src/schema.js");
    const result = await invoke(
      dir,
      "no_such_capability",
      {},
      { policy: Policy.parse({ allowedOrigins: ["http://localhost:18080"] }) },
    );
    expect(result).toHaveProperty("notFound");
  });
});

describe("a capabilityId is a name, so it must be unique (PR10 review #1)", () => {
  it("rejects every revision when two files claim the same id", async () => {
    // Resolving by first match meant the FILENAME decided which revision an agent ran — an
    // `aaa_*.json` copy silently won over the real one. Refusing to answer is better than
    // answering arbitrarily: a capability that vanishes with a stated reason gets fixed.
    const dir2 = await mkdtemp(join(tmpdir(), "catalog-dup-"));
    try {
      await writeFile(join(dir2, "zzz.json"), JSON.stringify(artifact()), "utf8");
      await writeFile(
        join(dir2, "aaa.json"),
        JSON.stringify(artifact({ version: "2.0.0" })),
        "utf8",
      );

      const { entries, invalid } = await loadCatalog(dir2);
      expect(entries).toHaveLength(0);
      expect(invalid).toHaveLength(2);
      expect(invalid[0]?.reason).toContain("duplicate capabilityId");
      // The message has to name both files, or the reader cannot fix it.
      expect(invalid[0]?.reason).toContain("aaa.json");
      expect(invalid[0]?.reason).toContain("zzz.json");
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("keeps a unique id callable", async () => {
    const { entries } = await loadCatalog(dir);
    expect(entries.map((e) => e.capabilityId)).toContain("lookup_account_balance");
  });

  it("refuses to invoke an ambiguous capability rather than picking one", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "catalog-dup-"));
    try {
      await writeFile(join(dir2, "a.json"), JSON.stringify(artifact()), "utf8");
      await writeFile(join(dir2, "b.json"), JSON.stringify(artifact({ version: "2.0.0" })), "utf8");

      const { invoke } = await import("../src/catalog.js");
      const { Policy } = await import("../src/schema.js");
      const result = await invoke(
        dir2,
        "lookup_account_balance",
        {},
        { policy: Policy.parse({ allowedOrigins: ["http://localhost:18080"] }) },
      );
      expect(result).toHaveProperty("notFound");
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
