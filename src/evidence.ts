/**
 * Run evidence: a structured event log, screenshots, a Playwright trace, and the final result.
 *
 * Two properties are deliberate.
 *
 * Everything written goes through the redactor. Redaction happens at this sink rather than at
 * each call site, so omitting it requires bypassing the recorder instead of merely forgetting.
 *
 * The recorder counts model calls. Replay asserts the count is zero, which turns "no LLM in the
 * decision loop" from a claim in the write-up into a fact in the run record.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceSummary, Observation, RunResult, TokenUsage } from "./schema.js";
import { redactDeep, type Redactor } from "./redact.js";

export type RunPhase = "discovery" | "replay" | "human";

export interface EvidenceEvent {
  timestamp: string;
  runId: string;
  phase: RunPhase;
  /** e.g. "step.start", "step.ok", "target.resolved", "handler.matched", "human.click" */
  type: string;
  stepId?: string;
  stepIndex?: number;
  actionType?: string;
  /** Redacted before writing. */
  detail?: Record<string, unknown>;
  durationMs?: number;
  errorCode?: string;
  /** Paths to screenshots or other artifacts produced by this event. */
  evidence?: string[];
}

export interface EvidenceRecorderOptions {
  runId: string;
  phase: RunPhase;
  redact: Redactor;
  /** Defaults to `evidence/`. */
  rootDir?: string;
  /**
   * Called with each event as it is written, already redacted.
   *
   * The file on disk stays the record of truth; this only lets something watch a run in
   * flight — the console streams it to a browser. A subscriber that throws must never
   * interfere with evidence being written, so it is invoked defensively.
   */
  onEvent?: (event: EvidenceEvent) => void;
}

export class EvidenceRecorder {
  readonly runId: string;
  readonly directory: string;
  readonly eventLogPath: string;

  private readonly phase: RunPhase;
  private readonly redact: Redactor;
  private readonly onEvent: ((event: EvidenceEvent) => void) | undefined;
  private readonly screenshots: string[] = [];
  private modelCalls = 0;
  private readonly tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** Distinguishes "no usage was reported" from "usage was reported and was zero". */
  private sawUsage = false;
  private tracePath: string | undefined;
  private failureSnapshotPath: string | undefined;
  private humanActionsPath: string | undefined;
  private screenshotSeq = 0;
  private ready: Promise<void>;

  constructor(options: EvidenceRecorderOptions) {
    this.runId = options.runId;
    this.phase = options.phase;
    this.redact = options.redact;
    this.onEvent = options.onEvent;
    this.directory = join(options.rootDir ?? "evidence", options.runId);
    this.eventLogPath = join(this.directory, "events.jsonl");
    this.ready = mkdir(this.directory, { recursive: true }).then(() => undefined);
  }

  /** Appends one redacted event. JSONL so a long run can be tailed and diffed. */
  async event(event: Omit<EvidenceEvent, "timestamp" | "runId" | "phase">): Promise<void> {
    await this.ready;
    const full: EvidenceEvent = {
      timestamp: new Date().toISOString(),
      runId: this.runId,
      phase: this.phase,
      ...event,
    };
    const redacted = redactDeep(full, this.redact);
    await appendFile(this.eventLogPath, `${JSON.stringify(redacted)}\n`, "utf8");
    try {
      this.onEvent?.(redacted);
    } catch {
      // A watcher's failure is not the run's problem.
    }
  }

  /**
   * Writes an already-masked image.
   *
   * The recorder does not capture the screen, because capturing it means knowing what a
   * "screen" is. Masking happens at capture time inside the surface, where the knowledge of
   * which regions are sensitive lives — a screenshot is a sink the string redactor cannot
   * reach, and there is no "after the fact" for a rendered pixel.
   *
   * Named with a monotonic sequence so files sort in execution order even when several share
   * a step.
   */
  async screenshot(image: Buffer, label: string): Promise<string> {
    await this.ready;
    const seq = String(++this.screenshotSeq).padStart(3, "0");
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60);
    const path = join(this.directory, `${seq}-${safeLabel}.png`);
    await writeFile(path, image);
    this.screenshots.push(path);
    return path;
  }

  /**
   * The default rich failure signal: a redacted capture of what the agent could see.
   *
   * This exists so that "produce a richer signal on failure" does not have to mean "persist an
   * unredacted Playwright trace". An ARIA snapshot is text, so it goes through the same
   * redactor as everything else, and it is the same representation the agent reasons over —
   * which makes it more useful for debugging a locator failure than a screenshot anyway.
   */
  async failureSnapshot(observation: Observation, context: Record<string, unknown> = {}): Promise<string> {
    await this.ready;
    const path = join(this.directory, "failure-snapshot.json");
    const payload = {
      capturedAt: new Date().toISOString(),
      url: observation.url,
      title: observation.title,
      alerts: observation.alerts,
      ariaSnapshot: observation.ariaSnapshot,
      ...context,
    };
    await writeFile(path, `${JSON.stringify(redactDeep(payload, this.redact), null, 2)}\n`, "utf8");
    this.failureSnapshotPath = path;
    return path;
  }

  /**
   * Records where a Playwright trace was written. Callers only reach this when tracing was
   * explicitly opted into; the summary flags it as unredacted so nobody has to infer that.
   */
  setTrace(path: string): void {
    this.tracePath = path;
  }

  /**
   * Called by the discovery engine on every model request. Replay never calls it, and asserts
   * the total is zero before reporting success.
   */
  recordModelCall(): void {
    this.modelCalls++;
  }

  /**
   * Called with each model response's reported usage. Separate from `recordModelCall` because
   * the two are recorded at different moments: the call is counted before the request goes out,
   * so a request that throws still shows up in the audit, but only a response carries usage.
   *
   * Counts are accumulated raw. Pricing lives at the display edge — see `priceRun` in config.
   */
  recordUsage(usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  }): void {
    this.tokens.input += usage.input_tokens ?? 0;
    this.tokens.output += usage.output_tokens ?? 0;
    this.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
    this.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    this.sawUsage = true;
  }

  get modelCallCount(): number {
    return this.modelCalls;
  }

  summary(): EvidenceSummary {
    return {
      runId: this.runId,
      directory: this.directory,
      eventLog: this.eventLogPath,
      trace: this.tracePath,
      traceUnredacted: this.tracePath !== undefined,
      screenshots: [...this.screenshots],
      failureSnapshot: this.failureSnapshotPath,
      ...(this.humanActionsPath ? { humanActions: this.humanActionsPath } : {}),
      modelCalls: this.modelCalls,
      ...(this.sawUsage ? { tokens: { ...this.tokens } } : {}),
    };
  }

  /** Writes result.json and returns the summary embedded in it. */
  async finish(result: RunResult): Promise<EvidenceSummary> {
    await this.ready;
    await writeFile(
      join(this.directory, "result.json"),
      `${JSON.stringify(redactDeep(result, this.redact), null, 2)}\n`,
      "utf8",
    );
    return result.evidence;
  }

  /**
   * What the human did while they held the session, as its own file.
   *
   * Separate from the event log because it answers a different question. The event log is "what
   * did the system do"; this is "what did a person do to this institution's data, and when".
   * An auditor asking the second question should not have to grep the first.
   */
  async writeHumanActions(actions: readonly unknown[]): Promise<void> {
    await this.ready;
    await writeFile(
      join(this.directory, "human-actions.json"),
      `${JSON.stringify(redactDeep({ count: actions.length, actions }, this.redact), null, 2)}\n`,
      "utf8",
    );
    this.humanActionsPath = join(this.directory, "human-actions.json");
  }

  /**
   * Token accounting, written as its own file at the end of a run.
   *
   * Discovery returns an artifact rather than a `RunResult`, so it never writes `result.json`
   * — and without this the only runs carrying a usage record would be the replays, which by
   * construction cost nothing. Written only when the model was actually called, so the file's
   * absence means "no model calls", never "not measured".
   *
   * Not passed through the redactor: it is four integers and a timestamp, and routing numbers
   * through a string redactor to look consistent would be theatre.
   */
  async writeUsage(): Promise<void> {
    if (this.modelCalls === 0) return;
    await this.ready;
    await writeFile(
      join(this.directory, "usage.json"),
      `${JSON.stringify(
        {
          modelCalls: this.modelCalls,
          tokens: { ...this.tokens },
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  /** Run-level metadata, written once at the start so a crashed run still leaves a trail. */
  async writeRunHeader(header: Record<string, unknown>): Promise<void> {
    await this.ready;
    await writeFile(
      join(this.directory, "run.json"),
      `${JSON.stringify(redactDeep({ runId: this.runId, phase: this.phase, ...header }, this.redact), null, 2)}\n`,
      "utf8",
    );
  }
}

/** Sortable, readable, and unique enough for a filesystem-backed demo. */
export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${stamp}-${rand}`;
}
