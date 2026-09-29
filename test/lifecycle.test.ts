import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityArtifact } from "../src/schema.js";
import { checkPromotion, checkRehearsed, checkValidated, nextStatus } from "../src/lifecycle.js";
import { invoke, loadCatalog } from "../src/catalog.js";
import { Policy } from "../src/schema.js";

/**
 * The promotion gates.
 *
 * Each state exists because it is earned by different evidence, so each test here is about one
 * kind of evidence being demanded — and, more importantly, about the ways a capability could
 * otherwise arrive at `approved` without having earned it.
 */

const base = {
  schemaVersion: "1.0",
  capabilityId: "lookup_balance",
  version: "1.0.0",
  metadata: {
    name: "Look up a balance",
    description: "Read an account's balance.",
    status: "draft",
    risk: "safe",
    recordedAt: "2026-09-28T10:00:00.000Z",
    recordedBy: "human",
  },
  target: { app: "bank", surface: "web", baseUrl: "http://bank.test" },
  inputs: {},
  outputs: { balance: { type: "number", source: { kind: "variable", name: "shown" } } },
  steps: [
    {
      id: "read",
      action: {
        action: "extract",
        as: "shown",
        target: { candidates: [{ strategy: "role", role: "textbox", name: "Balance" }] },
      },
    },
  ],
  handlers: [],
  checkpoint: { kind: "text", value: "Account Details" },
};

const artifact = (over: Record<string, unknown> = {}) =>
  CapabilityArtifact.parse({ ...base, ...over });

const clean = { successes: 3, failures: 0 };

describe("validated — does the artifact hold up on its own terms", () => {
  it("passes an artifact with durable locators, a checkpoint and a declared result", () => {
    expect(checkValidated(artifact()).ok).toBe(true);
  });

  it("refuses a coordinate locator, naming the step", () => {
    // Replay refuses coordinates outright, so an artifact carrying one has a step that cannot
    // run. Catching it here costs nothing; catching it at rehearsal costs a browser session.
    const withCoordinates = artifact({
      // The extract step stays: the schema already refuses an output with no step producing
      // it, so the fixture has to be otherwise coherent for this gate to be what fails.
      steps: [
        {
          id: "click_somewhere",
          action: {
            action: "click",
            target: { candidates: [{ strategy: "coordinates", x: 100, y: 200 }] },
          },
        },
        ...base.steps,
      ],
    });

    const gate = checkValidated(withCoordinates);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("click_somewhere");
  });

  it("refuses an artifact that reports nothing at all", () => {
    // No outputs and no business outcome: a run of this cannot be told from a silent no-op.
    const silent = artifact({ outputs: {}, handlers: [] });
    expect(checkValidated(silent).ok).toBe(false);
    expect(checkValidated(silent).reason).toContain("reports nothing");
  });

  it("accepts a business outcome as a reported result", () => {
    const outcomeOnly = artifact({
      outputs: {},
      handlers: [
        {
          id: "not_found",
          match: { kind: "text", value: "no such account", visible: true },
          scope: "global",
          disposition: { kind: "business_outcome", outcome: "account_not_found" },
        },
      ],
    });
    expect(checkValidated(outcomeOnly).ok).toBe(true);
  });
});

describe("rehearsed — has this exact revision actually run", () => {
  it("counts up to the threshold before letting it through", () => {
    expect(checkRehearsed({ successes: 2, failures: 0 }).ok).toBe(false);
    expect(checkRehearsed({ successes: 3, failures: 0 }).ok).toBe(true);
  });

  it("refuses a revision that has ever failed, however often it has passed", () => {
    // A capability that works four times in five is the worst kind to call unattended: it
    // looks fine until it is the one that matters.
    const flaky = checkRehearsed({ successes: 9, failures: 1 });
    expect(flaky.ok).toBe(false);
    expect(flaky.reason).toContain("failed replay");
  });
});

describe("promotion moves one step at a time", () => {
  it("knows the order", () => {
    expect(nextStatus("draft")).toBe("validated");
    expect(nextStatus("validated")).toBe("rehearsed");
    expect(nextStatus("rehearsed")).toBe("approved");
    expect(nextStatus("approved")).toBeUndefined();
  });

  it("refuses to skip a gate", () => {
    // The whole point of the ladder: arriving at `approved` without passing through the
    // evidence is exactly what the old two-state model allowed.
    const gate = checkPromotion(artifact(), "approved", { rehearsals: clean });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("one step at a time");
  });

  it("will not approve without a person attached", () => {
    const rehearsed = artifact({ metadata: { ...base.metadata, status: "rehearsed" } });

    expect(checkPromotion(rehearsed, "approved", { rehearsals: clean }).ok).toBe(false);
    // An approval nobody is attached to is an unsigned one.
    expect(checkPromotion(rehearsed, "approved", { rehearsals: clean, approvedBy: "sam" }).ok).toBe(
      true,
    );
  });

  it("lets anything be retired, and refuses to revive it", () => {
    // Retirement is never gated: a gate on withdrawal keeps a known-bad capability callable.
    expect(checkPromotion(artifact(), "deprecated", { rehearsals: clean }).ok).toBe(true);

    const dead = artifact({ metadata: { ...base.metadata, status: "deprecated" } });
    const revived = checkPromotion(dead, "validated", { rehearsals: clean });
    expect(revived.ok).toBe(false);
    expect(revived.reason).toContain("supersede it with a new version");
  });
});

describe("what an agent is allowed to see and call", () => {
  const write = async (dir: string, status: string) => {
    await writeFile(
      join(dir, "cap.json"),
      JSON.stringify(artifact({ metadata: { ...base.metadata, status } })),
      "utf8",
    );
  };

  it("hides everything short of approved, and deprecated too", async () => {
    for (const status of ["draft", "validated", "rehearsed", "deprecated"]) {
      const dir = await mkdtemp(join(tmpdir(), "lifecycle-"));
      try {
        await write(dir, status);
        const { entries } = await loadCatalog(dir, { agentFacing: true });
        // `deprecated` is past every gate there is and must still never be offered — which is
        // why the filter names `approved` rather than testing "far enough along".
        expect(entries, status).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    const dir = await mkdtemp(join(tmpdir(), "lifecycle-"));
    try {
      await write(dir, "approved");
      expect((await loadCatalog(dir, { agentFacing: true })).entries).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a deprecated capability even when the caller asks to override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-"));
    try {
      await write(dir, "deprecated");
      const result = await invoke(dir, "lookup_balance", {}, {
        policy: Policy.parse({ allowedOrigins: ["http://bank.test"] }),
        allowDraft: true,
      });

      // Every other refusal is a "not yet". This one is a decision already made, and an
      // escape hatch would make deprecation advisory.
      expect("refused" in result && result.refused).toContain("deprecated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a rehearsed capability, which works but nobody has blessed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lifecycle-"));
    try {
      await write(dir, "rehearsed");
      const result = await invoke(dir, "lookup_balance", {}, {
        policy: Policy.parse({ allowedOrigins: ["http://bank.test"] }),
      });
      expect("refused" in result && result.refused).toContain("rehearsed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
