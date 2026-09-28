/**
 * The audit view over `evidence/`: what ran, how it ended, and what it cost.
 *
 * Nothing here records anything. Every field is read back from files a run already wrote —
 * `run.json` for identity, `usage.json` for token counts, `result.json` for a replay's typed
 * result, `events.jsonl` for how a discovery run ended and when. That is the point: an audit
 * that depends on its own bookkeeping can disagree with the evidence, and then neither is
 * trustworthy.
 *
 * Cost is computed here, at read time, from the rates in config. Runs store tokens.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { priceRun } from "./config.js";
import { EvidenceSummary, RunResult, TokenUsage } from "./schema.js";

export interface AuditRow {
  /** Path under `evidence/`. The identity on disk, and unique — a copied run reuses its runId. */
  dir: string;
  runId: string;
  phase: string;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationMs: number | undefined;
  model: string | undefined;
  /** The capability replayed, or the id discovery was recording under. */
  capabilityId: string | undefined;
  /** Terminal state, flattened to one token for a table: `success`, `failure:APP_ERROR`, … */
  outcome: string;
  /**
   * Undefined means unknown, not zero. A replay asserts zero in its result; a discovery run
   * recorded before token accounting existed left no count at all, and reporting that as 0
   * would put a run that spent money into the ledger as free.
   */
  modelCalls: number | undefined;
  tokens: TokenUsage | undefined;
  /** Undefined when the model is unpriced or nothing was measured — never guessed. */
  costUsd: number | undefined;
  events: number;
}

export interface AuditReport {
  rows: AuditRow[];
  /** Directories that could not be read as runs, with why. Reported, never silently dropped. */
  skipped: { dir: string; reason: string }[];
  totals: {
    runs: number;
    modelCalls: number;
    tokens: TokenUsage;
    costUsd: number;
    /** Ran the model under a rate the table does not carry. */
    unpriced: number;
    /** No usage record at all: cost unknown, and missing from every figure above. */
    unaccounted: number;
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/** Last non-empty line of the event log, parsed. Logs are per-run and small. */
function lastEvent(log: string): { timestamp?: string; type?: string } | undefined {
  const lines = log.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last) as { timestamp?: string; type?: string };
  } catch {
    return undefined;
  }
}

/**
 * How a discovery run ended.
 *
 * Discovery has no result contract to read — it returns an artifact — so its terminal state is
 * recovered from the last event it wrote. A run whose log ends on none of the three terminal
 * events did not finish: that is reported as `incomplete` rather than folded into `failed`,
 * because "the process died" and "the model gave up" are different findings.
 */
function discoveryOutcome(type: string | undefined): string {
  if (type === "discovery.complete") return "recorded";
  if (type === "discovery.stuck") return "stuck";
  if (type === "discovery.failed") return "failed";
  return "incomplete";
}

function replayOutcome(result: RunResult): string {
  switch (result.status) {
    case "success":
      return "success";
    case "business_outcome":
      return `business_outcome:${result.outcome}`;
    case "escalated":
      return `escalated:${result.intervention.reason}`;
    case "failure":
      return `failure:${result.error.code}`;
  }
}

async function readRun(rootDir: string, dir: string): Promise<AuditRow> {
  const path = (name: string): string => join(rootDir, dir, name);

  const header = (await readJson(path("run.json")).catch(() => ({}))) as Record<string, unknown>;
  const log = await readFile(path("events.jsonl"), "utf8").catch(() => "");
  const last = lastEvent(log);

  // A run's own usage record wins over the one embedded in its result: discovery writes only
  // the former, replay only the latter, and a run that somehow has both wrote usage.json last.
  const usage = (await readJson(path("usage.json")).catch(() => undefined)) as
    | { modelCalls?: number; tokens?: unknown; finishedAt?: string }
    | undefined;

  const resultRaw = await readJson(path("result.json")).catch(() => undefined);
  const result = resultRaw === undefined ? undefined : RunResult.safeParse(resultRaw);
  const evidence =
    result?.success === true
      ? result.data.evidence
      : ((resultRaw as { evidence?: unknown } | undefined)?.evidence !== undefined
          ? EvidenceSummary.safeParse((resultRaw as { evidence?: unknown }).evidence).data
          : undefined);

  const phase = typeof header["phase"] === "string" ? (header["phase"] as string) : "unknown";
  const tokens = TokenUsage.safeParse(usage?.tokens ?? evidence?.tokens).data;

  const outcome =
    result?.success === true
      ? replayOutcome(result.data)
      : phase === "discovery"
        ? discoveryOutcome(last?.type)
        : // A replay whose result.json is missing or unparseable never reported an outcome.
          "incomplete";

  const startedAt = typeof header["startedAt"] === "string" ? header["startedAt"] : undefined;
  const finishedAt = usage?.finishedAt ?? last?.timestamp;
  const model = typeof header["model"] === "string" ? header["model"] : undefined;

  return {
    dir,
    runId: typeof header["runId"] === "string" ? header["runId"] : dir,
    phase,
    startedAt,
    finishedAt,
    durationMs:
      startedAt !== undefined && finishedAt !== undefined
        ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
        : undefined,
    model,
    capabilityId:
      typeof header["capabilityId"] === "string" ? (header["capabilityId"] as string) : undefined,
    outcome,
    modelCalls: usage?.modelCalls ?? evidence?.modelCalls,
    tokens,
    costUsd: priceRun(model, tokens),
    events: log.split("\n").filter((l) => l.trim() !== "").length,
  };
}

/**
 * Reads every run under `rootDir`, oldest first.
 *
 * `examples/` is walked as well — the committed runs are evidence like any other, and excluding
 * them would make the totals disagree with what a reader can see in the repository.
 */
export async function auditRuns(rootDir = "evidence"): Promise<AuditReport> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "examples") {
      const nested = await readdir(join(rootDir, entry.name), { withFileTypes: true });
      for (const child of nested) if (child.isDirectory()) dirs.push(join(entry.name, child.name));
      continue;
    }
    dirs.push(entry.name);
  }

  const rows: AuditRow[] = [];
  const skipped: { dir: string; reason: string }[] = [];
  for (const dir of dirs.sort()) {
    try {
      rows.push(await readRun(rootDir, dir));
    } catch (err) {
      skipped.push({ dir, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.runs++;
      acc.modelCalls += row.modelCalls ?? 0;
      acc.tokens.input += row.tokens?.input ?? 0;
      acc.tokens.output += row.tokens?.output ?? 0;
      acc.tokens.cacheRead += row.tokens?.cacheRead ?? 0;
      acc.tokens.cacheWrite += row.tokens?.cacheWrite ?? 0;
      acc.costUsd += row.costUsd ?? 0;
      // A run that called the model but could not be priced would otherwise vanish into a
      // total that looks complete. Counted, so the footer can say so.
      if (row.modelCalls === undefined) acc.unaccounted++;
      else if (row.modelCalls > 0 && row.costUsd === undefined) acc.unpriced++;
      return acc;
    },
    {
      runs: 0,
      modelCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      unpriced: 0,
      unaccounted: 0,
    },
  );

  return { rows, skipped, totals };
}

/** `$0.0412`, or `—` for a run with nothing to price. Four places: these runs are cents. */
export function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? "—" : `$${costUsd.toFixed(4)}`;
}
