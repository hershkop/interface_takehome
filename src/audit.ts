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
  /** The revision that ran, by content. Absent on runs recorded before it was written. */
  fingerprint: string | undefined;
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
  /**
   * True when fewer responses reported usage than calls were made — a request threw. `tokens`
   * and `costUsd` are then a floor, not the bill.
   */
  tokensPartial: boolean;
  /**
   * Zero for a run that made no model calls, undefined when genuinely unknown or unpriced.
   * The column renders those differently on purpose: `$0.0000` is a result, `—` is a gap.
   */
  costUsd: number | undefined;
  events: number;
  /**
   * Set when this row repeats a runId an earlier row already carries — a committed copy under
   * `examples/`. Shown, but excluded from the totals so one execution is billed once.
   */
  duplicateOf: string | undefined;
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
    /** Counted, but a request threw before reporting usage, so the figures are a floor. */
    partial: number;
    /** Rows excluded as copies of an execution already counted. */
    duplicates: number;
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

interface LoggedEvent {
  timestamp?: string;
  type?: string;
}

/** Every parseable event, in order. Logs are per-run and small. */
function parseEvents(log: string): LoggedEvent[] {
  const out: LoggedEvent[] = [];
  for (const line of log.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as LoggedEvent);
    } catch {
      // A truncated last line is what a killed process leaves behind. Skipping it loses one
      // event; refusing the whole run would lose the evidence that it was killed.
    }
  }
  return out;
}

/**
 * How a discovery run ended.
 *
 * Discovery has no result contract to read — it returns an artifact — so its terminal state is
 * recovered from the last event it wrote. A run whose log ends on none of the three terminal
 * events did not finish: that is reported as `incomplete` rather than folded into `failed`,
 * because "the process died" and "the model gave up" are different findings.
 */
const DISCOVERY_TERMINAL: Readonly<Record<string, string>> = {
  "discovery.complete": "recorded",
  "discovery.stuck": "stuck",
  "discovery.failed": "failed",
};

function discoveryOutcome(events: readonly LoggedEvent[]): string {
  // Searched backward rather than read off the last line: discovery writes its terminal event
  // and then tears the surface down, and a teardown that fails appends after it. Reading only
  // the last event would report a completed run as incomplete because the browser closed badly.
  for (let i = events.length - 1; i >= 0; i--) {
    const outcome = DISCOVERY_TERMINAL[events[i]?.type ?? ""];
    if (outcome !== undefined) return outcome;
  }
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
  const events = parseEvents(log);
  const last = events[events.length - 1];

  // A run's own usage record wins over the one embedded in its result: discovery writes only
  // the former, replay only the latter, and a run that somehow has both wrote usage.json last.
  const usage = (await readJson(path("usage.json")).catch(() => undefined)) as
    | { modelCalls?: number; modelResponses?: number; tokens?: unknown; finishedAt?: string }
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
        ? discoveryOutcome(events)
        : // A replay whose result.json is missing or unparseable never reported an outcome.
          "incomplete";

  const startedAt = typeof header["startedAt"] === "string" ? header["startedAt"] : undefined;
  const finishedAt = usage?.finishedAt ?? last?.timestamp;
  const model = typeof header["model"] === "string" ? header["model"] : undefined;

  const modelCalls = usage?.modelCalls ?? evidence?.modelCalls;
  const modelResponses = usage?.modelResponses ?? evidence?.modelResponses;

  return {
    dir,
    fingerprint:
      typeof header["capabilityFingerprint"] === "string"
        ? header["capabilityFingerprint"]
        : undefined,
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
    modelCalls,
    tokens,
    tokensPartial:
      modelCalls !== undefined && modelResponses !== undefined && modelResponses < modelCalls,
    // A run that never called the model cost nothing, and that is knowable without a rate
    // card or a token record — it follows from the result contract asserting zero calls.
    costUsd: modelCalls === 0 ? 0 : priceRun(model, tokens),
    events: events.length,
    duplicateOf: undefined,
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
  const copies: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "examples") {
      const nested = await readdir(join(rootDir, entry.name), { withFileTypes: true });
      for (const child of nested)
        if (child.isDirectory()) copies.push(join(entry.name, child.name));
      continue;
    }
    dirs.push(entry.name);
  }
  dirs.sort();
  // Appended after the ordinary runs so that when a copy and its original tie on start time,
  // the original is the row that carries the execution.
  dirs.push(...copies.sort());

  const rows: AuditRow[] = [];
  const skipped: { dir: string; reason: string }[] = [];
  for (const dir of dirs) {
    try {
      rows.push(await readRun(rootDir, dir));
    } catch (err) {
      skipped.push({ dir, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // A committed example is a copy of a run that is also on disk under its own id, so the two
  // rows are one execution. Both are shown — the copies are the evidence a reader is pointed
  // at — but only one is billed, or the ledger charges for the same model calls twice.
  //
  // Done here, in walk order, rather than after the sort below: the walk appends examples/
  // last, so the run under its own id is the one that carries the execution. Deduplicating
  // after sorting would hand that role to whichever row won an arbitrary tie-break on equal
  // timestamps — which is how the copy came to own it the first time.
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.runId)) row.duplicateOf = row.runId;
    else seen.add(row.runId);
  }

  // Chronological, not alphabetical. Sorting directory names groups by the `discover` /
  // `probe` / `replay` prefix and interleaves the day's runs by phase, which reads as a
  // history that never happened. Runs with no recorded start sort last, by directory, so the
  // order is at least stable across invocations.
  rows.sort((a, b) => {
    if (a.startedAt !== undefined && b.startedAt !== undefined) {
      return a.startedAt.localeCompare(b.startedAt) || a.dir.localeCompare(b.dir);
    }
    if (a.startedAt !== undefined) return -1;
    if (b.startedAt !== undefined) return 1;
    return a.dir.localeCompare(b.dir);
  });

  const totals = rows.reduce(
    (acc, row) => {
      if (row.duplicateOf !== undefined) {
        acc.duplicates++;
        return acc;
      }
      acc.runs++;
      if (row.tokensPartial) acc.partial++;
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
      partial: 0,
      duplicates: 0,
    },
  );

  return { rows, skipped, totals };
}

/** `$0.0412`, or `—` for a run with nothing to price. Four places: these runs are cents. */
export function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? "—" : `$${costUsd.toFixed(4)}`;
}

/**
 * How many times one revision has replayed, cleanly and otherwise.
 *
 * Counted by fingerprint, so an edited capability starts over. That is the point: the whole
 * value of a rehearsal record is that it belongs to the thing that ran, and a version number is
 * a claim someone typed. Confidence must not be inheritable.
 *
 * `escalated` is neither: the run stopped for a person and never reached a verdict, so counting
 * it as a success would credit a rehearsal to something that did not finish, and counting it as
 * a failure would punish a capability for being correctly cautious.
 */
export async function rehearsalsFor(
  fingerprint: string,
  rootDir = "evidence",
): Promise<{ successes: number; failures: number }> {
  const { rows } = await auditRuns(rootDir);
  let successes = 0;
  let failures = 0;

  for (const row of rows) {
    // Copies under examples/ are the same execution as the run they were copied from; counting
    // both would let committing an example earn a rehearsal.
    if (row.fingerprint !== fingerprint || row.duplicateOf !== undefined) continue;
    if (row.outcome === "success" || row.outcome.startsWith("business_outcome")) successes++;
    else if (row.outcome.startsWith("failure")) failures++;
  }

  return { successes, failures };
}
