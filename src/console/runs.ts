/**
 * In-flight run tracking for the operator console.
 *
 * The console does not reimplement anything. It starts the same `replay` and `discover`
 * functions the CLI does, watches their evidence events, and answers their intervention
 * requests over HTTP instead of over stdin.
 *
 * That last part is the interesting one: `WebInterventionChannel` is a second implementation
 * of the one-method `InterventionChannel` interface. REPORT.md claims that swapping the
 * operator surface "changes no other file" — this is that claim being tested rather than
 * asserted, and it held: nothing in replay.ts, handoff.ts or discovery.ts changed to support it.
 */
import { randomUUID } from "node:crypto";
import type { InterventionRequest } from "../schema.js";
import type { InterventionChannel, InterventionDecision } from "../handoff.js";
import type { EvidenceEvent } from "../evidence.js";

export type RunKind = "replay" | "discovery";
export type RunState = "running" | "awaiting_human" | "finished";

export interface RunRecord {
  id: string;
  kind: RunKind;
  label: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  events: EvidenceEvent[];
  /** The RunResult for a replay, or the discovery outcome. Shape is the caller's. */
  result?: unknown;
  error?: string;
  intervention?: PendingIntervention;
}

export interface PendingIntervention {
  request: InterventionRequest;
  /** Resolved when an operator answers over HTTP. */
  resolve: (decision: InterventionDecision) => void;
}

type Listener = (event: { type: string; runId: string; payload?: unknown }) => void;

/**
 * Holds every run this console has started, plus whoever is watching.
 *
 * Deliberately in memory. Evidence on disk is the durable record; this is a view of what is
 * happening right now, and a console restart losing it is the correct behaviour — the runs it
 * was watching died with the process anyway.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly listeners = new Set<Listener>();

  create(kind: RunKind, label: string): RunRecord {
    const record: RunRecord = {
      id: randomUUID(),
      kind,
      label,
      state: "running",
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.runs.set(record.id, record);
    this.emit({ type: "run.created", runId: record.id, payload: this.summarise(record) });
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** Newest first, and without the event arrays — the list view does not need them. */
  list(): Array<ReturnType<RunRegistry["summarise"]>> {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => this.summarise(r));
  }

  addEvent(id: string, event: EvidenceEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    // Bounded: a long discovery can emit a lot, and the console only ever renders a tail.
    run.events.push(event);
    if (run.events.length > 500) run.events.shift();
    this.emit({ type: "run.event", runId: id, payload: event });
  }

  finish(id: string, outcome: { result?: unknown; error?: string }): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.state = "finished";
    run.finishedAt = new Date().toISOString();
    if (outcome.result !== undefined) run.result = outcome.result;
    if (outcome.error !== undefined) run.error = outcome.error;
    delete run.intervention;
    this.emit({ type: "run.finished", runId: id, payload: this.summarise(run) });
  }

  /** Parks a run until an operator answers. */
  await_human(id: string, request: InterventionRequest): Promise<InterventionDecision> {
    const run = this.runs.get(id);
    if (!run) return Promise.resolve({ decision: "abort", reason: "run is gone" });

    return new Promise<InterventionDecision>((resolve) => {
      run.state = "awaiting_human";
      run.intervention = { request, resolve };
      this.emit({ type: "run.intervention", runId: id, payload: request });
    });
  }

  /**
   * Answers a pending intervention. Returns false when there is nothing waiting, so a stale
   * browser tab clicking an old button cannot silently resolve a different run.
   */
  answer(id: string, decision: InterventionDecision): boolean {
    const run = this.runs.get(id);
    if (!run?.intervention) return false;
    const { resolve } = run.intervention;
    delete run.intervention;
    run.state = "running";
    this.emit({ type: "run.resumed", runId: id, payload: { decision: decision.decision } });
    resolve(decision);
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: { type: string; runId: string; payload?: unknown }): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected browser must not take the run down with it.
      }
    }
  }

  private summarise(run: RunRecord) {
    return {
      id: run.id,
      kind: run.kind,
      label: run.label,
      state: run.state,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      result: run.result,
      error: run.error,
      intervention: run.intervention?.request,
      eventCount: run.events.length,
    };
  }
}

/**
 * Routes an intervention to the browser instead of to stdin.
 *
 * The entire adaptation. Everything about the control-transfer model — the ownership lock, the
 * context captured before handing over, the fresh observation before taking back — lives in
 * `SessionController` and is untouched by which surface answers.
 */
export class WebInterventionChannel implements InterventionChannel {
  constructor(
    private readonly registry: RunRegistry,
    private readonly runId: string,
  ) {}

  async request(request: InterventionRequest): Promise<InterventionDecision> {
    return this.registry.await_human(this.runId, request);
  }
}
