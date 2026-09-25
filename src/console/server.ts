/**
 * A local operator console.
 *
 * Four jobs, matching the four things a person actually needs to do with this system: see what
 * capabilities exist, run one, record a new one, and take over when a run stops for a human.
 *
 * What it deliberately is not: a co-browsing surface. When a run hands over, the operator acts
 * in the real application's browser window — the same live session the automation was using,
 * which is the whole point of the handoff. This console carries the context and the decision,
 * not the pixels.
 *
 * Binds to 127.0.0.1 and has no authentication. It is a local development and demo surface, and
 * it can start browser sessions and read the evidence directory, so it must not be exposed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { config, defaultPolicy } from "../config.js";
import { loadCatalog } from "../catalog.js";
import { replay } from "../replay.js";
import { discover } from "../discovery.js";
import { loginToParabank } from "../parabank.js";
import { RunRegistry, WebInterventionChannel } from "./runs.js";

const CAPABILITIES_DIR = "capabilities";
const EVIDENCE_ROOT = resolvePath("evidence");

export interface ConsoleOptions {
  port?: number;
  host?: string;
}

export async function startConsole(
  options: ConsoleOptions = {},
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const registry = new RunRegistry();
  const port = options.port ?? Number(process.env.CONSOLE_PORT ?? 17080);
  const host = options.host ?? "127.0.0.1";
  const page = await readFile(new URL("./app.html", import.meta.url), "utf8");

  const server = createServer((req, res) => {
    void route(req, res, registry, page).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((ready) => server.listen(port, host, ready));

  // The bound port, not the requested one: port 0 means "let the OS choose", and returning the
  // request would hand the caller an unusable http://host:0.
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${bound}`,
    port: bound,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  registry: RunRegistry,
  page: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }

  if (path === "/api/capabilities") {
    const { entries, invalid } = await loadCatalog(CAPABILITIES_DIR);
    return send(res, 200, {
      capabilities: entries.map((e) => ({
        capabilityId: e.capabilityId,
        version: e.version,
        name: e.name,
        description: e.description,
        status: e.status,
        risk: e.risk,
        path: e.path,
        inputs: e.artifact.inputs,
        outputs: e.artifact.outputs,
        stepCount: e.artifact.steps.length,
        handlerCount: e.artifact.handlers.length,
      })),
      invalid,
    });
  }

  if (path === "/api/runs" && req.method === "GET") {
    return send(res, 200, { runs: registry.list() });
  }

  if (path.startsWith("/api/runs/") && path.endsWith("/events")) {
    const id = path.slice("/api/runs/".length, -"/events".length);
    const run = registry.get(id);
    if (!run) return send(res, 404, { error: "no such run" });
    return send(res, 200, { events: run.events, state: run.state, result: run.result });
  }

  if (path === "/api/stream") {
    return stream(res, registry);
  }

  if (path === "/api/replay" && req.method === "POST") {
    return startReplay(res, registry, await body(req));
  }

  if (path === "/api/discover" && req.method === "POST") {
    return startDiscovery(res, registry, await body(req));
  }

  if (path.startsWith("/api/intervene/") && req.method === "POST") {
    const id = path.slice("/api/intervene/".length);
    const { decision, reason } = await body(req);
    const answered = registry.answer(id, buildDecision(String(decision), reason));
    return send(res, answered ? 200 : 409, { answered });
  }

  if (path.startsWith("/evidence/")) {
    return sendEvidenceFile(res, path.slice("/evidence/".length));
  }

  send(res, 404, { error: "not found" });
}

// ─── Starting runs ─────────────────────────────────────────────────────────────

const secrets = () => ({
  parabankUsername: config.parabank.username,
  parabankPassword: config.parabank.password,
});

async function startReplay(
  res: ServerResponse,
  registry: RunRegistry,
  payload: Record<string, unknown>,
): Promise<void> {
  const capabilityId = String(payload.capabilityId ?? "");
  const inputs = (payload.inputs ?? {}) as Record<string, unknown>;
  const headed = payload.headed !== false;

  const { entries } = await loadCatalog(CAPABILITIES_DIR);
  const entry = entries.find((e) => e.capabilityId === capabilityId);
  if (!entry) return send(res, 404, { error: `no capability "${capabilityId}"` });

  const run = registry.create("replay", `${entry.capabilityId} v${entry.version}`);
  send(res, 202, { runId: run.id });

  // Fire and forget: the browser follows along over the event stream.
  void replay({
    artifact: entry.artifact,
    inputs,
    policy: defaultPolicy(),
    secrets: secrets(),
    // Headed by default, because a run that escalates hands the operator a window to act in.
    // A handoff they cannot see is not a handoff.
    headed,
    reauthenticate: loginToParabank,
    interventionChannel: new WebInterventionChannel(registry, run.id),
    onEvent: (event) => registry.addEvent(run.id, event),
  })
    .then((result) => registry.finish(run.id, { result }))
    .catch((err: unknown) => {
      registry.finish(run.id, { error: err instanceof Error ? err.message : String(err) });
    });
}

async function startDiscovery(
  res: ServerResponse,
  registry: RunRegistry,
  payload: Record<string, unknown>,
): Promise<void> {
  const goal = String(payload.goal ?? "").trim();
  const capabilityId = String(payload.capabilityId ?? "").trim();
  const inputs = (payload.inputs ?? {}) as Record<string, string>;

  if (!goal || !capabilityId) return send(res, 400, { error: "goal and capabilityId are required" });
  if (!/^[a-z][a-z0-9_]*$/.test(capabilityId)) {
    return send(res, 400, { error: "capabilityId must be lower_snake_case" });
  }
  if (!config.anthropicApiKey) {
    return send(res, 400, { error: "ANTHROPIC_API_KEY is not set — add it to .env" });
  }

  const run = registry.create("discovery", capabilityId);
  send(res, 202, { runId: run.id });

  const out = join(CAPABILITIES_DIR, `${capabilityId}.v1.json`);

  void discover({
    goal,
    capabilityId,
    baseUrl: config.parabank.baseUrl,
    policy: defaultPolicy(),
    inputs,
    secrets: secrets(),
    headed: payload.headed !== false,
    apiKey: config.anthropicApiKey,
    interventionChannel: new WebInterventionChannel(registry, run.id),
    onEvent: (event) => registry.addEvent(run.id, event),
  })
    .then(async (result) => {
      if (result.status === "recorded") {
        await writeFile(out, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");
        registry.finish(run.id, { result: { ...result, artifactPath: out } });
      } else {
        registry.finish(run.id, { result });
      }
    })
    .catch((err: unknown) => {
      registry.finish(run.id, { error: err instanceof Error ? err.message : String(err) });
    });
}

function buildDecision(decision: string, reason: unknown) {
  if (decision === "proceed") return { decision: "proceed" as const };
  if (decision === "completed_by_human") return { decision: "completed_by_human" as const };
  return {
    decision: "abort" as const,
    ...(typeof reason === "string" && reason ? { reason } : {}),
  };
}

// ─── Transport helpers ─────────────────────────────────────────────────────────

/** Server-sent events: one long-lived response per browser tab. */
function stream(res: ServerResponse, registry: RunRegistry): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", runs: registry.list() })}\n\n`);

  const unsubscribe = registry.subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  // Proxies and browsers drop an idle stream; a comment frame is enough to keep it open.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/**
 * Serves a file from the evidence directory, and only from there.
 *
 * The path comes from a URL, so it is resolved and then checked to still be inside the evidence
 * root — `../../.env` would otherwise be a perfectly good request.
 */
async function sendEvidenceFile(res: ServerResponse, relative: string): Promise<void> {
  const target = resolvePath(EVIDENCE_ROOT, normalize(decodeURIComponent(relative)));
  if (target !== EVIDENCE_ROOT && !target.startsWith(EVIDENCE_ROOT + sep)) {
    return send(res, 403, { error: "outside the evidence directory" });
  }

  const types: Record<string, string> = {
    ".png": "image/png",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
  };
  const type = types[extname(target)];
  if (!type) return send(res, 415, { error: "unsupported file type" });

  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  } catch {
    send(res, 404, { error: "no such evidence file" });
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
