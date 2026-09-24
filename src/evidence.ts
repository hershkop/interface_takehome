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
import type { Page } from "playwright";
import type { EvidenceSummary, RunResult } from "./schema.js";
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
}

export class EvidenceRecorder {
  readonly runId: string;
  readonly directory: string;
  readonly eventLogPath: string;

  private readonly phase: RunPhase;
  private readonly redact: Redactor;
  private readonly screenshots: string[] = [];
  private modelCalls = 0;
  private tracePath: string | undefined;
  private screenshotSeq = 0;
  private ready: Promise<void>;

  constructor(options: EvidenceRecorderOptions) {
    this.runId = options.runId;
    this.phase = options.phase;
    this.redact = options.redact;
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
    await appendFile(this.eventLogPath, `${JSON.stringify(redactDeep(full, this.redact))}\n`, "utf8");
  }

  /**
   * Full-page screenshot. Named with a monotonic sequence so the files sort in execution order
   * even when several share a step.
   */
  async screenshot(page: Page, label: string): Promise<string> {
    await this.ready;
    const seq = String(++this.screenshotSeq).padStart(3, "0");
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60);
    const path = join(this.directory, `${seq}-${safeLabel}.png`);
    await page.screenshot({ path, fullPage: true });
    this.screenshots.push(path);
    return path;
  }

  /** Records where the Playwright trace was written, so the summary can point at it. */
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
      screenshots: [...this.screenshots],
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
