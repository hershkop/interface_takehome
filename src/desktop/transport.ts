/**
 * A `DesktopTransport` over a child process speaking newline-delimited JSON on stdio.
 *
 * Chosen over a native Node addon because the platform accessibility APIs — macOS
 * `AXUIElement`, Windows UI Automation, AT-SPI2 — are each most easily reached from their own
 * platform's language, and because a separate process is a containment boundary: the helper is
 * the only thing holding accessibility permission, and it can be killed.
 *
 * Framing is one JSON object per line, correlated by id. Requests may overlap.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type {
  DesktopMethod,
  DesktopRequests,
  DesktopResponse,
  DesktopTransport,
} from "./protocol.js";

export interface StdioTransportOptions {
  /** The helper to run — a platform binary in production, a stub script in tests. */
  command: string;
  args?: readonly string[];
  /** How long a single request may take before it is abandoned. */
  requestTimeoutMs?: number;
}

export class StdioDesktopTransport implements DesktopTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private exited: string | undefined;

  constructor(options: StdioTransportOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.child = spawn(options.command, [...(options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));

    // A helper that dies mid-run must fail every request waiting on it, immediately and with a
    // reason. Left to the per-request timeout instead, a crashed helper would look like a slow
    // application and every step would wait out the clock before failing with nothing useful.
    this.child.on("exit", (code, signal) => {
      this.fatal(`desktop helper exited (${signal ?? `code ${code}`})`);
    });

    // `error` fires when the helper cannot be spawned at all — a missing binary, a file that
    // is not executable, a bad interpreter. Node treats an unhandled `error` on a child as an
    // uncaught exception, so without this a mistyped --desktop-helper takes the whole process
    // down with `spawn ENOENT` instead of returning a structured run failure.
    this.child.on("error", (err) => {
      this.fatal(`desktop helper could not be started: ${err.message}`);
    });

    // A helper that exits while a request is being written makes stdin emit EPIPE, which is
    // the same class of problem arriving down a different pipe.
    this.child.stdin.on("error", (err) => {
      this.fatal(`desktop helper stdin failed: ${err.message}`);
    });

    // stdout/stderr can error the same way, and an unhandled one is equally fatal.
    this.child.stdout.on("error", () => this.fatal("desktop helper stdout failed"));
    this.child.stderr.on("error", () => undefined);
  }

  /**
   * The helper is gone. Fail everything waiting on it now, with a reason.
   *
   * Left to the per-request timeout instead, a dead helper looks like a slow application: every
   * step waits out the clock and then fails saying nothing useful about why.
   */
  private fatal(reason: string): void {
    this.exited ??= reason;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(this.exited));
      this.pending.delete(id);
    }
  }

  /** Whatever the helper wrote to stderr. Diagnostics for a helper that will not start. */
  get stderr(): NodeJS.ReadableStream {
    return this.child.stderr;
  }

  private receive(line: string): void {
    if (line.trim() === "") return;
    let response: DesktopResponse;
    try {
      response = JSON.parse(line) as DesktopResponse;
    } catch {
      // A helper writing non-JSON to stdout is a bug in the helper, not a failed request.
      // Dropping the line keeps one malformed write from rejecting an unrelated call.
      return;
    }

    const waiter = this.pending.get(response.id);
    if (!waiter) return;
    this.pending.delete(response.id);
    clearTimeout(waiter.timer);

    if (response.error) waiter.reject(new Error(response.error.message));
    else waiter.resolve(response.result);
  }

  async request<M extends DesktopMethod>(
    method: M,
    params: DesktopRequests[M]["params"],
  ): Promise<DesktopRequests[M]["result"]> {
    if (this.exited) throw new Error(this.exited);

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`desktop helper did not answer ${method} within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      // Guarded: a write to a closed pipe throws synchronously, and inside a Promise executor
      // that rejects this request — which is right — but the pending entry would leak.
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.lines.close();
    this.child.stdin.end();

    // Given a moment to leave on its own, then killed. A helper holding accessibility
    // permission is exactly the process that should not be left running after a run ends.
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        done();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}
