/**
 * A local operator console.
 *
 * Five jobs, matching what a person actually needs to do with this system: see what
 * capabilities exist, run one, record a new one, take over when a run stops for a human, and
 * account for what all of it has cost.
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
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { config, defaultPolicy } from "../config.js";
import { executableFingerprint, loadCatalog } from "../catalog.js";
import { CapabilityArtifact, Policy } from "../schema.js";
import { createRedactor } from "../redact.js";
import { isSensitiveSecretKey } from "../template.js";
import { replay } from "../replay.js";
import { discover } from "../discovery.js";
import { loginToParabank } from "../parabank.js";
import { RunRegistry, WebInterventionChannel } from "./runs.js";
import { auditRuns, rehearsalsFor } from "../audit.js";
import { checkPromotion, nextStatus } from "../lifecycle.js";
import { PLAYWRIGHT_SURFACE_KIND, unsupportedSurfaceReason } from "../surface.js";
import { DesktopSurface } from "../desktop/surface.js";
import { StdioDesktopTransport } from "../desktop/transport.js";
import { loadHelpers } from "./helpers.js";

/**
 * Where capabilities live, by default.
 *
 * Overridable per server so a test can point one at its own copy. Tests used to write into
 * this directory and restore it afterwards, which worked right up until another suite read a
 * file mid-rewrite — vitest runs files in parallel, so "restore carefully" was never the fix.
 * Not sharing is.
 */
const DEFAULT_CAPABILITIES_DIR = "capabilities";
const EVIDENCE_ROOT = resolvePath("evidence");

export interface ConsoleOptions {
  /** Directory holding capability artifacts. Defaults to `capabilities/`. */
  capabilitiesDir?: string;
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
  const stylesheet = await readFile(new URL("./app.css", import.meta.url));
  const capabilitiesDir = options.capabilitiesDir ?? DEFAULT_CAPABILITIES_DIR;

  const server = createServer((req, res) => {
    void route(req, res, registry, page, stylesheet, capabilitiesDir).catch((err: unknown) => {
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
  stylesheet: Buffer,
  CAPABILITIES_DIR: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }

  if (path === "/app.css") {
    res.writeHead(200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(stylesheet);
    return;
  }

  if (path === "/api/capabilities") {
    const { entries, invalid } = await loadCatalog(CAPABILITIES_DIR);

    // Evaluated here rather than in the browser: the gates read replay history off disk, and a
    // UI that guessed at them would eventually disagree with the server that enforces them.
    const gates = new Map<string, { ok: boolean; reason: string }>();
    for (const e of entries) {
      const to = nextStatus(e.status);
      if (to === undefined) continue;
      const rehearsals = await rehearsalsFor(executableFingerprint(e.artifact));
      // `approvedBy` is supplied at the moment of approval, so the gate shown here reports
      // what is still outstanding rather than pretending a signature already exists.
      gates.set(e.capabilityId, checkPromotion(e.artifact, to, { rehearsals }));
    }
    return send(res, 200, {
      capabilities: entries.map((e) => ({
        capabilityId: e.capabilityId,
        version: e.version,
        name: e.name,
        description: e.description,
        status: e.status,
        risk: e.risk,
        surface: e.surface,
        nextStatus: e.status === "deprecated" ? undefined : nextStatus(e.status),
        gate: gates.get(e.capabilityId),
        path: e.path,
        inputs: e.artifact.inputs,
        outputs: e.artifact.outputs,
        notes: e.artifact.metadata.notes ?? "",
        stepCount: e.artifact.steps.length,
        handlerCount: e.artifact.handlers.length,
        artifact: e.artifact,
      })),
      invalid,
    });
  }

  if (path === "/api/audit" && req.method === "GET") {
    // Read from disk on every request rather than kept in memory: the console's own run list
    // holds what this process started, and the point of the ledger is that it accounts for
    // every run in the directory — including the ones a CLI invocation left there.
    return send(res, 200, await auditRuns(EVIDENCE_ROOT));
  }

  if (path === "/api/helpers") {
    const { helpers, invalid } = await loadHelpers();
    // Names and descriptions only. The command is deliberately not sent: the page has no use
    // for it, and anything the page can see is something a reader will assume it can also set.
    return send(res, 200, {
      helpers: helpers.map((h) => ({
        name: h.name,
        title: h.title,
        description: h.description,
        // Which capability this helper is for, so the page can offer the right one rather
        // than every one. Not a security boundary — the lookup above is.
        ...(h.app === undefined ? {} : { app: h.app }),
      })),
      ...(invalid === undefined ? {} : { invalid }),
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
    return startReplay(res, registry, await body(req), CAPABILITIES_DIR);
  }

  if (path === "/api/discover" && req.method === "POST") {
    return startDiscovery(res, registry, await body(req), CAPABILITIES_DIR);
  }

  if (path.startsWith("/api/intervene/") && req.method === "POST") {
    const id = path.slice("/api/intervene/".length);
    const { decision, reason } = await body(req);
    const answered = registry.answer(id, buildDecision(String(decision), reason));
    return send(res, answered ? 200 : 409, { answered });
  }

  if (path.startsWith("/api/capabilities/") && req.method === "PUT") {
    return saveCapability(
      res,
      decodeURIComponent(path.slice("/api/capabilities/".length)),
      await body(req),
      CAPABILITIES_DIR,
    );
  }

  if (path.startsWith("/api/capabilities/") && req.method === "DELETE") {
    return deleteCapability(
      res,
      decodeURIComponent(path.slice("/api/capabilities/".length)),
      CAPABILITIES_DIR,
    );
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
  CAPABILITIES_DIR: string,
): Promise<void> {
  const capabilityId = String(payload.capabilityId ?? "");
  const inputs = (payload.inputs ?? {}) as Record<string, unknown>;
  const headed = payload.headed !== false;

  const { entries } = await loadCatalog(CAPABILITIES_DIR);
  const entry = entries.find((e) => e.capabilityId === capabilityId);
  if (!entry) return send(res, 404, { error: `no capability "${capabilityId}"` });

  // Retirement means retired, whoever is asking. `invoke` refuses a deprecated capability
  // without an override, and a console that ran it anyway would make that guarantee depend on
  // which button you happened to press. The diagnostic escape hatch is the CLI replaying an
  // artifact file directly, which does not go through the catalog at all.
  if (entry.status === "deprecated") {
    return send(res, 409, {
      error:
        `"${capabilityId}" v${entry.version} is deprecated and will not run. ` +
        `If something still needs this flow, record a new version of it.`,
    });
  }

  // ── Which surface this run gets ──────────────────────────────────────────
  //
  // A desktop capability needs a helper, and the request names one rather than describing it.
  // The lookup is the security boundary: the page sends "excel-stub", the server finds the
  // command in helpers.json, and a request carrying a command of its own has nothing to act on.
  const requestedHelper = typeof payload.helper === "string" ? payload.helper : "";
  const { helpers } = await loadHelpers();
  const helper = helpers.find((h) => h.name === requestedHelper);

  if (requestedHelper !== "" && helper === undefined) {
    return send(res, 400, {
      error:
        `no desktop helper named "${requestedHelper}". Helpers are declared in helpers.json ` +
        `on the machine running this console, not chosen from here.`,
    });
  }

  const surfaceOptions = helper
    ? {
        surfaceKind: "desktop" as const,
        createSurface: async () =>
          new DesktopSurface({
            transport: new StdioDesktopTransport({ command: helper.command, args: helper.args }),
          }),
      }
    : {};

  // Refused before a run record exists: a capability this build cannot drive should not leave
  // a failed run in the ledger, because nothing about the attempt was informative.
  const unsupported = unsupportedSurfaceReason(
    entry.artifact,
    helper ? "desktop" : PLAYWRIGHT_SURFACE_KIND,
  );
  if (unsupported) {
    return send(res, 422, {
      error: helpers.length === 0
        ? `${unsupported}. No desktop helper is declared in helpers.json on this machine — ` +
          `add one, or replay it from the CLI with --desktop-helper "<command>".`
        : `${unsupported}. Choose a desktop helper before replaying it.`,
    });
  }

  const run = registry.create("replay", `${entry.capabilityId} v${entry.version}`);
  send(res, 202, { runId: run.id });

  // Fire and forget: the browser follows along over the event stream.
  // A desktop helper brings its own policy: the console's default governs the web target and
  // allows no applications at all, so using it here would refuse every desktop run for a
  // reason that reads like a bug rather than a decision.
  const policy = helper?.policy
    ? Policy.parse(JSON.parse(await readFile(helper.policy, "utf8")))
    : defaultPolicy();

  void replay({
    ...surfaceOptions,
    artifact: entry.artifact,
    inputs,
    policy,
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
  CAPABILITIES_DIR: string,
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

  // ── Which surface this recording explores ────────────────────────────────
  //
  // A replay reads its entry point from the artifact; a recording is *producing* one, so it
  // has to be told where to begin — and, for desktop, what to begin it with. Both come from
  // the named helper rather than from the request, for the same reason the command does.
  const requestedHelper = typeof payload.helper === "string" ? payload.helper : "";
  const { helpers } = await loadHelpers();
  const helper = helpers.find((h) => h.name === requestedHelper);

  if (requestedHelper !== "" && helper === undefined) {
    return send(res, 400, {
      error:
        `no desktop helper named "${requestedHelper}". Helpers are declared in helpers.json ` +
        `on the machine running this console, not chosen from here.`,
    });
  }
  if (helper && helper.baseUrl === undefined) {
    return send(res, 400, {
      error:
        `helper "${helper.name}" declares no baseUrl, so a recording has nowhere to start. ` +
        `Add one (app://<application>) to helpers.json.`,
    });
  }

  const policy = helper?.policy
    ? Policy.parse(JSON.parse(await readFile(helper.policy, "utf8")))
    : defaultPolicy();

  const surfaceOptions = helper
    ? {
        surfaceKind: "desktop" as const,
        createSurface: async () =>
          new DesktopSurface({
            transport: new StdioDesktopTransport({ command: helper.command, args: helper.args }),
          }),
        // Recorded onto the artifact, so the capability declares the application it drives and
        // the surface check refuses it on a browser later.
        ...(helper.app === undefined ? {} : { app: helper.app }),
      }
    : {};

  const run = registry.create("discovery", capabilityId);
  send(res, 202, { runId: run.id });

  const out = join(CAPABILITIES_DIR, `${capabilityId}.v1.json`);

  void discover({
    ...surfaceOptions,
    goal,
    capabilityId,
    baseUrl: helper?.baseUrl ?? config.parabank.baseUrl,
    policy,
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


// ─── Editing and deleting capabilities ─────────────────────────────────────────

/**
 * Finds a capability's file by its id rather than building a path from the URL.
 *
 * The id reaches us from a URL and ends up naming a file, so it is never concatenated into a
 * path. The catalog already knows where each artifact lives; looking the entry up means a
 * crafted id matches nothing instead of escaping the directory.
 */
async function locate(capabilityId: string, CAPABILITIES_DIR: string) {
  const { entries } = await loadCatalog(CAPABILITIES_DIR);
  return entries.find((e) => e.capabilityId === capabilityId);
}

/**
 * Replaces an artifact, but only with something that still validates.
 *
 * The console is where a reviewer promotes a draft, and an editor that can save a broken
 * capability turns review into a way to break things. The same Zod schema replay uses is the
 * gate, and its issues come back to the editor verbatim so a mistake is legible.
 */
async function saveCapability(
  res: ServerResponse,
  capabilityId: string,
  payload: Record<string, unknown>,
  CAPABILITIES_DIR: string,
): Promise<void> {
  const entry = await locate(capabilityId, CAPABILITIES_DIR);
  if (!entry) return send(res, 404, { error: `no capability "${capabilityId}"` });

  const parsed = CapabilityArtifact.safeParse(payload.artifact);
  if (!parsed.success) {
    return send(res, 422, {
      error: "the edited artifact does not validate",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
      })),
    });
  }

  // Renaming a capability would orphan the file it was loaded from and could collide with
  // another; rename is a separate operation and is not offered here.
  if (parsed.data.capabilityId !== capabilityId) {
    return send(res, 409, {
      error: `capabilityId cannot be changed here (was "${capabilityId}", got "${parsed.data.capabilityId}")`,
    });
  }

  // ── An approved version does not change under you ────────────────────────
  //
  // Approval is a statement that this exact behaviour was reviewed. Editing the steps of an
  // approved capability while leaving its version alone makes that statement false for every
  // agent already calling it by name, and leaves no signal anywhere that it happened — the
  // capability an operator approved on Tuesday is not the one running on Wednesday.
  //
  // The rule is therefore not "approved artifacts are read-only" but "a change to what an
  // approved capability DOES must be visible as a new version". The catalog allows exactly one
  // live revision per capabilityId (two files claiming the name are both rejected), so the
  // superseded revision lives in git history — which is where this repository already keeps
  // them. A version bump is what makes the supersession legible.
  const submitted = parsed.data;
  const stored = entry.artifact;

  // ── Status changes go through the same gates as `promote` ────────────────
  //
  // `status` is deliberately outside the immutability fingerprint, because promoting is not a
  // behavioural change. That leaves this editor as a way to write any status onto any artifact
  // — draft straight to approved, skipping every gate — unless the transition is checked here
  // too. A ladder with a side door is not a ladder.
  const changed = executableFingerprint(stored) !== executableFingerprint(submitted);

  // ── A change to behaviour starts the ladder again ────────────────────────
  //
  // Every state above `draft` is a claim about a specific revision: that *this* artifact
  // validates, that *this* fingerprint replayed cleanly three times, that a person read *this*
  // and signed it. Change what the capability does and all three claims are about something
  // that no longer exists — so the new revision starts at draft and re-earns them.
  //
  // Without this, bumping the version was enough to put new, unreviewed behaviour straight
  // into the agent-facing catalog while carrying the old revision's approval: exactly the hole
  // the version-bump rule was added to close, entered from the other side.
  if (changed) {
    if (stored.metadata.status === "approved" && submitted.version === stored.version) {
      return send(res, 409, {
        error:
          `"${capabilityId}" v${stored.version} is approved, and this edit changes what it does. ` +
          `Raise the version to supersede it — the approved revision stays in git history. ` +
          `A reviewer note can be edited without a version change.`,
      });
    }

    if (submitted.metadata.status !== "draft") {
      return send(res, 409, {
        error:
          stored.metadata.status === "draft"
            ? // Promoting in the same save as an edit: the gates would read evidence for the
              // revision being replaced, and hand it to the one replacing it.
              `this save both changes what "${capabilityId}" does and promotes it to ` +
              `${submitted.metadata.status}. Save the change first, then promote — a gate has ` +
              `to be answered by the revision it is letting through.`
            : `this edit changes what "${capabilityId}" does, so the new revision starts at ` +
              `draft and re-earns validation, rehearsal and approval. Set metadata.status to ` +
              `"draft" (it was ${stored.metadata.status}) and save again.`,
      });
    }
  }

  // ── Status changes go through the same gates as `promote` ────────────────
  //
  // `status` is deliberately outside the immutability fingerprint, because promoting is not a
  // behavioural change. That leaves this editor as a way to write any status onto any artifact
  // — draft straight to approved, skipping every gate — unless the transition is checked here
  // too. A ladder with a side door is not a ladder.
  //
  // Applied only when the content is unchanged. A changed one has already been forced back to
  // draft above, and that reset is not a promotion — it is a new revision beginning, so the
  // ladder's "no going backwards" rule does not govern it. Running the gate on a reset would
  // refuse the very supersession the rule above just demanded.
  //
  // Which also means the evidence gathered below cannot belong to a different revision than
  // the one being written. The gate is still handed the SUBMITTED content with the STORED
  // status: the transition is from where it is, about what is being saved.
  if (!changed && submitted.metadata.status !== stored.metadata.status) {
    const rehearsals = await rehearsalsFor(executableFingerprint(submitted));
    const approvedBy = typeof payload.approvedBy === "string" ? payload.approvedBy : "";
    const gate = checkPromotion(
      { ...submitted, metadata: { ...submitted.metadata, status: stored.metadata.status } },
      submitted.metadata.status,
      { rehearsals, ...(approvedBy ? { approvedBy } : {}) },
    );

    if (!gate.ok) {
      return send(res, 409, {
        error: `${stored.metadata.status} -> ${submitted.metadata.status} refused: ${gate.reason}`,
      });
    }
  }

  // A reviewer note is free text a human pasted in, which makes it the likeliest place for a
  // credential or an SSN to enter a git-versioned artifact. It is the one field here that has
  // not already been through the redaction boundary, so it goes through it now. The rest of the
  // artifact is left alone: redacting a locator would corrupt it.
  const redact = createRedactor({
    literals: Object.entries({
      parabankUsername: config.parabank.username,
      parabankPassword: config.parabank.password,
    })
      .filter(([key]) => isSensitiveSecretKey(key))
      .map(([, value]) => value),
  });

  const artifact = submitted;
  const submittedNote = artifact.metadata.notes;
  if (submittedNote) {
    artifact.metadata.notes = redact(submittedNote);
  }
  // Captured before the mutation: `artifact` IS `parsed.data`, so comparing them afterwards
  // always says nothing changed. A reviewer whose note was altered has to be told.
  const notesRedacted = submittedNote !== undefined && artifact.metadata.notes !== submittedNote;

  await writeAtomically(entry.path, `${JSON.stringify(artifact, null, 2)}\n`);
  send(res, 200, {
    saved: entry.path,
    status: artifact.metadata.status,
    ...(notesRedacted ? { notesRedacted: true } : {}),
  });
}

/**
 * Deletes by moving to `capabilities/.trash/`, not by unlinking.
 *
 * A discovered capability can represent a real model run that has not been committed yet, and
 * the console offers deletion one click behind a confirmation. Making it recoverable costs a
 * rename; making it irreversible costs someone their run.
 */
async function deleteCapability(
  res: ServerResponse,
  capabilityId: string,
  CAPABILITIES_DIR: string,
): Promise<void> {
  const entry = await locate(capabilityId, CAPABILITIES_DIR);
  if (!entry) return send(res, 404, { error: `no capability "${capabilityId}"` });

  const trash = join(CAPABILITIES_DIR, ".trash");
  await mkdir(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(trash, `${capabilityId}.${stamp}.json`);

  await rename(entry.path, destination);
  send(res, 200, { deleted: entry.path, recoverableAt: destination });
}


/**
 * Writes via a temporary file in the same directory, then renames over the target.
 *
 * `writeFile` truncates before it writes, so a crash — or a catalog read, which happens on
 * every console request — can see a half-written artifact. Rename within a directory is atomic,
 * so a reader sees either the old file or the new one and never a partial one. The temp file is
 * cleaned up if the rename fails, rather than left as debris beside the real artifact.
 */
async function writeAtomically(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, target);
  } catch (err) {
    await unlink(temporary).catch(() => {});
    throw err;
  }
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
