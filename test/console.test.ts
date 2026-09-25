import { afterEach, describe, expect, it } from "vitest";
import { RunRegistry, WebInterventionChannel } from "../src/console/runs.js";
import { startConsole } from "../src/console/server.js";
import type { InterventionRequest } from "../src/schema.js";

const request = (over: Partial<InterventionRequest> = {}): InterventionRequest => ({
  interventionId: "i1",
  runId: "r1",
  reason: "approval_required",
  message: "needs a person",
  observedState: { url: "http://bank.test/t", title: "Transfer Funds" },
  requestedAt: new Date().toISOString(),
  ...over,
});

describe("RunRegistry", () => {
  it("tracks a run from created to finished", () => {
    const registry = new RunRegistry();
    const run = registry.create("replay", "transfer_funds v1.0.0");
    expect(registry.get(run.id)?.state).toBe("running");

    registry.finish(run.id, { result: { status: "success" } });
    expect(registry.get(run.id)?.state).toBe("finished");
    expect(registry.list()[0]?.result).toMatchObject({ status: "success" });
  });

  it("parks a run until an operator answers, then resumes it", async () => {
    const registry = new RunRegistry();
    const run = registry.create("replay", "transfer_funds");

    const waiting = registry.await_human(run.id, request());
    expect(registry.get(run.id)?.state).toBe("awaiting_human");

    expect(registry.answer(run.id, { decision: "proceed" })).toBe(true);
    await expect(waiting).resolves.toEqual({ decision: "proceed" });
    expect(registry.get(run.id)?.state).toBe("running");
  });

  it("refuses to answer a run with nothing pending", () => {
    // A stale browser tab clicking an old button must not resolve a different run.
    const registry = new RunRegistry();
    const run = registry.create("replay", "x");
    expect(registry.answer(run.id, { decision: "proceed" })).toBe(false);
    expect(registry.answer("no-such-run", { decision: "proceed" })).toBe(false);
  });

  it("answers a pending intervention only once", async () => {
    const registry = new RunRegistry();
    const run = registry.create("replay", "x");
    const waiting = registry.await_human(run.id, request());

    expect(registry.answer(run.id, { decision: "proceed" })).toBe(true);
    expect(registry.answer(run.id, { decision: "abort" })).toBe(false);
    await expect(waiting).resolves.toEqual({ decision: "proceed" });
  });

  it("bounds the event buffer so a long run cannot grow without limit", () => {
    const registry = new RunRegistry();
    const run = registry.create("discovery", "x");
    for (let i = 0; i < 600; i++) {
      registry.addEvent(run.id, {
        timestamp: new Date().toISOString(),
        runId: run.id,
        phase: "discovery",
        type: `e${i}`,
      });
    }
    expect(registry.get(run.id)!.events.length).toBeLessThanOrEqual(500);
    // The tail is what a console renders, so it must be the end that survives.
    expect(registry.get(run.id)!.events.at(-1)?.type).toBe("e599");
  });

  it("keeps a failing subscriber from taking the run down", () => {
    const registry = new RunRegistry();
    registry.subscribe(() => {
      throw new Error("browser went away");
    });
    expect(() => registry.create("replay", "x")).not.toThrow();
  });

  it("resolves a pending intervention when the run has vanished", async () => {
    const registry = new RunRegistry();
    await expect(registry.await_human("gone", request())).resolves.toMatchObject({
      decision: "abort",
    });
  });
});

describe("WebInterventionChannel", () => {
  it("is a drop-in for the CLI channel", async () => {
    // REPORT.md claims swapping the operator surface "changes no other file". This is that
    // claim under test: the channel implements the same one-method interface, and the entire
    // control-transfer model — ownership lock, context capture, fresh observation — is
    // untouched by which surface answers.
    const registry = new RunRegistry();
    const run = registry.create("replay", "transfer_funds");
    const channel = new WebInterventionChannel(registry, run.id);

    const asked = channel.request(request());
    registry.answer(run.id, { decision: "completed_by_human" });
    await expect(asked).resolves.toEqual({ decision: "completed_by_human" });
  });
});

describe("console server", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  const start = async () => {
    // Port 0 lets the OS pick, so the suite never collides with a console someone is running.
    const started = await startConsole({ port: 0, host: "127.0.0.1" });
    stop = started.close;
    return started.url;
  };

  it("serves the page and the catalog", async () => {
    const url = await start();
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Capability console");

    const catalog = await (await fetch(`${url}/api/capabilities`)).json();
    expect(Array.isArray(catalog.capabilities)).toBe(true);
  });

  it("refuses to serve anything outside the evidence directory", async () => {
    // The path comes from a URL, so `../../.env` is a perfectly good request to make.
    const url = await start();
    for (const attempt of ["..%2f..%2fpackage.json", "..%2F.env", "%2e%2e%2fpackage.json"]) {
      const res = await fetch(`${url}/evidence/${attempt}`);
      expect([403, 404, 415], attempt).toContain(res.status);
    }
  });

  it("refuses file types that are not evidence", async () => {
    const url = await start();
    const res = await fetch(`${url}/evidence/notes.ts`);
    expect([403, 404, 415]).toContain(res.status);
  });

  it("rejects a discovery request missing its required fields", async () => {
    const url = await start();
    const res = await fetch(`${url}/api/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "", capabilityId: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a capability id that is not lower_snake_case", async () => {
    // It becomes a filename and an agent-facing tool name.
    const url = await start();
    const res = await fetch(`${url}/api/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "do a thing", capabilityId: "../../etc/passwd" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s a replay of a capability that does not exist", async () => {
    const url = await start();
    const res = await fetch(`${url}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilityId: "no_such_capability", inputs: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("409s an intervention answer with nothing waiting", async () => {
    const url = await start();
    const res = await fetch(`${url}/api/intervene/nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "proceed" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("capability management", () => {
  let stop: (() => Promise<void>) | undefined;
  const start = async () => {
    const started = await startConsole({ port: 0, host: "127.0.0.1" });
    stop = started.close;
    return started.url;
  };
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it("refuses to save an artifact that does not validate", async () => {
    // The console is where a reviewer promotes a draft. An editor that can save a broken
    // capability turns review into a way to break things.
    const url = await start();
    const { capabilities } = await (await fetch(`${url}/api/capabilities`)).json();
    const first = capabilities[0];
    if (!first) return; // no artifacts checked out; nothing to assert against

    const broken = structuredClone(first.artifact);
    delete broken.metadata.risk; // risk is mandatory by design

    const res = await fetch(`${url}/api/capabilities/${first.capabilityId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact: broken }),
    });
    expect(res.status).toBe(422);
    const payload = await res.json();
    expect(payload.issues.length).toBeGreaterThan(0);
  });

  it("refuses to rename a capability through the editor", async () => {
    // Renaming would orphan the file it was loaded from and could collide with another.
    const url = await start();
    const { capabilities } = await (await fetch(`${url}/api/capabilities`)).json();
    const first = capabilities[0];
    if (!first) return;

    const renamed = structuredClone(first.artifact);
    renamed.capabilityId = "something_else_entirely";

    const res = await fetch(`${url}/api/capabilities/${first.capabilityId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact: renamed }),
    });
    expect(res.status).toBe(409);
  });

  it("404s edits and deletes of capabilities that do not exist", async () => {
    // The id arrives from a URL and ends up naming a file, so it is looked up in the catalog
    // rather than concatenated into a path — a crafted id matches nothing.
    const url = await start();
    for (const id of ["no_such_capability", "..%2f..%2fpackage.json", "..%2F.env"]) {
      const del = await fetch(`${url}/api/capabilities/${id}`, { method: "DELETE" });
      expect(del.status, `DELETE ${id}`).toBe(404);

      const put = await fetch(`${url}/api/capabilities/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifact: {} }),
      });
      expect(put.status, `PUT ${id}`).toBe(404);
    }
  });
});
