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
import type { EvidenceSummary, Observation, RunResult } from "./schema.js";
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
