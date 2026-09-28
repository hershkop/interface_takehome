import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceRecorder } from "../src/evidence.js";
import { createRedactor } from "../src/redact.js";
import { auditRuns } from "../src/audit.js";
import { priceRun } from "../src/config.js";

/**
 * The audit exists to answer "what did this cost", and the ways that answer goes wrong are all
 * quiet ones: a run that spent money and reports nothing, a run that reports zero because
 * nothing measured it, a price silently invented for a model nobody has rates for. Each is a
 * case below, because none of them would show up as a failure anywhere else.
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "audit-test-"));
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

const redact = createRedactor({ literals: [], patterns: [] });

describe("usage recording", () => {
  it("accumulates every response's tokens and writes them next to the run", async () => {
    const root = join(workDir, "acc");
    const recorder = new EvidenceRecorder({
      runId: "discover-acc",
      phase: "discovery",
      redact,
      rootDir: root,
    });

    recorder.recordModelCall();
    recorder.recordUsage({ input_tokens: 1000, output_tokens: 200 });
    recorder.recordModelCall();
    recorder.recordUsage({
      input_tokens: 1500,
      output_tokens: 300,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 400,
    });
    await recorder.writeUsage();

    const written = JSON.parse(
      await readFile(join(root, "discover-acc", "usage.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(written["modelCalls"]).toBe(2);
    expect(written["tokens"]).toEqual({
      input: 2500,
      output: 500,
      cacheRead: 800,
      cacheWrite: 400,
    });
    expect(recorder.summary().tokens).toEqual({
      input: 2500,
      output: 500,
      cacheRead: 800,
      cacheWrite: 400,
    });
  });

  it("omits tokens entirely when no model was called, rather than reporting zeros", async () => {
    const root = join(workDir, "none");
    const recorder = new EvidenceRecorder({
      runId: "replay-none",
      phase: "replay",
      redact,
      rootDir: root,
    });

    await recorder.writeUsage();

    // A replay's zero is asserted by its result contract. An absent usage file has to mean
    // "no model calls" and never "not measured", or the audit cannot tell the two apart.
    await expect(readFile(join(root, "replay-none", "usage.json"), "utf8")).rejects.toThrow();
    expect(recorder.summary().tokens).toBeUndefined();
    expect(recorder.summary().modelCalls).toBe(0);
  });
});

describe("pricing", () => {
  it("prices a known model from its recorded tokens", () => {
    // 1M input at $5 + 1M output at $25 + 1M cache reads at $0.50 + 1M cache writes at $6.25.
    const cost = priceRun("claude-opus-5", {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    });
    expect(cost).toBeCloseTo(36.75, 10);
  });

  it("refuses to price a model it has no rate for", () => {
    const tokens = { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };
    expect(priceRun("some-model-we-never-priced", tokens)).toBeUndefined();
    expect(priceRun("claude-opus-5", undefined)).toBeUndefined();
    expect(priceRun(undefined, tokens)).toBeUndefined();
  });
});

/** Writes the files a run of each shape leaves behind. */
async function fakeRun(
  root: string,
  dir: string,
  files: Record<string, unknown | string>,
): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(
      join(root, dir, name),
      typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`,
      "utf8",
    );
  }
}

describe("auditRuns", () => {
  it("separates a run that cost nothing from one that was never measured", async () => {
    const root = join(workDir, "ledger");

    await fakeRun(root, "discover-priced", {
      "run.json": {
        runId: "discover-priced",
        phase: "discovery",
        capabilityId: "lookup_balance",
        model: "claude-opus-5",
        startedAt: "2026-09-28T10:00:00.000Z",
      },
      "usage.json": {
        modelCalls: 3,
        tokens: { input: 40_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
        finishedAt: "2026-09-28T10:01:00.000Z",
      },
      "events.jsonl": `${JSON.stringify({ timestamp: "2026-09-28T10:00:59.000Z", type: "discovery.complete" })}\n`,
    });

    await fakeRun(root, "discover-legacy", {
      "run.json": {
        runId: "discover-legacy",
        phase: "discovery",
        model: "claude-opus-5",
        startedAt: "2026-09-20T10:00:00.000Z",
      },
      "events.jsonl": `${JSON.stringify({ timestamp: "2026-09-20T10:00:30.000Z", type: "discovery.stuck" })}\n`,
    });

    await fakeRun(root, "replay-free", {
      "run.json": { runId: "replay-free", phase: "replay", capabilityId: "lookup_balance" },
      "result.json": {
        status: "business_outcome",
        outcome: "account_not_found",
        detail: {},
        evidence: {
          runId: "replay-free",
          directory: "evidence/replay-free",
          eventLog: "evidence/replay-free/events.jsonl",
          traceUnredacted: false,
          screenshots: [],
          modelCalls: 0,
        },
      },
      "events.jsonl": "",
    });

    const report = await auditRuns(root);
    const byDir = new Map(report.rows.map((r) => [r.dir, r]));

    const priced = byDir.get("discover-priced")!;
    expect(priced.outcome).toBe("recorded");
    expect(priced.modelCalls).toBe(3);
    // 40k input at $5/MTok + 2k output at $25/MTok.
    expect(priced.costUsd).toBeCloseTo(0.25, 10);
    expect(priced.durationMs).toBe(60_000);

    const legacy = byDir.get("discover-legacy")!;
    expect(legacy.outcome).toBe("stuck");
    expect(legacy.modelCalls).toBeUndefined();
    expect(legacy.costUsd).toBeUndefined();

    const free = byDir.get("replay-free")!;
    expect(free.outcome).toBe("business_outcome:account_not_found");
    expect(free.modelCalls).toBe(0);
    expect(free.costUsd).toBeUndefined();

    expect(report.totals.runs).toBe(3);
    expect(report.totals.modelCalls).toBe(3);
    expect(report.totals.costUsd).toBeCloseTo(0.25, 10);
    // The unmeasured run is counted separately instead of being averaged into a total that
    // would then read as complete.
    expect(report.totals.unaccounted).toBe(1);
  });

  it("reports a run whose result never landed as incomplete, not as a success", async () => {
    const root = join(workDir, "crashed");
    await fakeRun(root, "replay-crashed", {
      "run.json": { runId: "replay-crashed", phase: "replay", capabilityId: "transfer_funds" },
      "events.jsonl": `${JSON.stringify({ timestamp: "2026-09-28T10:00:05.000Z", type: "step.start" })}\n`,
    });

    const report = await auditRuns(root);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.outcome).toBe("incomplete");
  });

  it("walks committed example runs alongside ordinary ones", async () => {
    const root = join(workDir, "with-examples");
    await fakeRun(root, "replay-plain", {
      "run.json": { runId: "replay-plain", phase: "replay" },
      "events.jsonl": "",
    });
    await fakeRun(root, join("examples", "01-discovery-llm-run"), {
      "run.json": { runId: "discover-original", phase: "discovery", model: "claude-opus-5" },
      "events.jsonl": `${JSON.stringify({ timestamp: "2026-09-24T15:05:24.221Z", type: "discovery.complete" })}\n`,
    });

    const report = await auditRuns(root);
    const example = report.rows.find((r) => r.dir === join("examples", "01-discovery-llm-run"));

    expect(report.rows).toHaveLength(2);
    expect(example).toBeDefined();
    // A committed copy keeps the original's runId, so the directory is what identifies a row.
    expect(example!.runId).toBe("discover-original");
    expect(example!.outcome).toBe("recorded");
  });
});
