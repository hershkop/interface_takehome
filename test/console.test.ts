import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    // The card shows which surface a capability drives, so the API has to carry it.
    for (const c of catalog.capabilities) expect(["web", "desktop"]).toContain(c.surface);
  });

  it("offers desktop helpers by name, and never by command", async () => {
    const url = await start();
    const { helpers } = await (await fetch(`${url}/api/helpers`)).json();

    expect(helpers.length).toBeGreaterThan(0);
    for (const helper of helpers) {
      expect(helper.name).toMatch(/^[a-z][a-z0-9-]*$/);
      // The command is not sent. Anything the page can see is something a reader will assume
      // it can also set, and a console that ran a supplied command would turn any page the
      // operator has open into code on their machine — it binds to localhost with no auth.
      expect(helper).not.toHaveProperty("command");
      expect(helper).not.toHaveProperty("args");
      expect(helper).not.toHaveProperty("policy");
    }
  });

  it("refuses a helper name it does not know", async () => {
    const url = await start();
    const res = await fetch(`${url}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilityId: "excel_set_column_width", helper: "../../evil" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not chosen from here");
  });

  it("ignores a command the request supplies for itself", async () => {
    // The request names a helper; it cannot describe one. A body carrying a command has
    // nothing to act on, which is the whole reason the lookup is server-side.
    const url = await start();
    const res = await fetch(`${url}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilityId: "excel_set_column_width",
        command: "touch",
        args: ["/tmp/should-never-exist"],
        desktopHelper: "touch /tmp/should-never-exist",
      }),
    });

    // Falls through to "this needs a desktop helper", because no helper was named.
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("desktop surface");
  });

  it("refuses a recording against a helper name it does not know", async () => {
    // Recording needs a starting point and a surface, and both come from the named helper.
    // Same boundary as replay: the page names one, it never describes one.
    const url = await start();
    const res = await fetch(`${url}/api/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "x", capabilityId: "probe_thing", helper: "../../evil" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not chosen from here");
  });

  it("declares a start location for every helper it offers", async () => {
    // A replay reads its entry point from the artifact; a recording is producing one, so a
    // helper with no baseUrl can be replayed against and not recorded against — which is a
    // confusing half-capability to ship.
    const url = await start();
    const { helpers } = await (await fetch(`${url}/api/helpers`)).json();
    for (const helper of helpers) {
      const res = await fetch(`${url}/api/discover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "x", capabilityId: "probe_thing", helper: helper.name }),
      });
      // Either it starts, or it stops for a missing API key — never for a missing baseUrl.
      expect(await res.text()).not.toContain("declares no baseUrl");
    }
  });

  it("serves four tabs, each with the panel it controls", async () => {
    const url = await start();
    const page = await (await fetch(url)).text();

    for (const name of ["audit", "runs", "new", "capabilities"]) {
      expect(page).toContain(`data-tab="${name}"`);
      expect(page).toContain(`id="panel-${name}"`);
      expect(page).toContain(`aria-controls="panel-${name}"`);
    }

    // The handoff banner sits above the tab strip, not inside a panel. A run waiting on a
    // person must be visible whichever tab is open, and nesting it would hide it behind three.
    expect(page.indexOf('id="handoffs"')).toBeLessThan(page.indexOf('class="tabs"'));
  });

  it("serves the ledger over evidence/, totals and all", async () => {
    const url = await start();
    const res = await fetch(`${url}/api/audit`);
    expect(res.status).toBe(200);

    const report = await res.json();
    expect(Array.isArray(report.rows)).toBe(true);
    // The shape the page renders: without these the tiles read `undefined` rather than break.
    expect(report.totals).toMatchObject({
      runs: expect.any(Number),
      modelCalls: expect.any(Number),
      costUsd: expect.any(Number),
      duplicates: expect.any(Number),
      unaccounted: expect.any(Number),
    });
    expect(report.totals.tokens).toMatchObject({ input: expect.any(Number) });
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

  /**
   * Saves that are *allowed* actually write to `capabilities/`, so the originals are put back.
   * A test suite that leaves the repository edited is a test suite people stop running.
   */
  async function withRestoredCapabilities(run: () => Promise<void>): Promise<void> {
    const dir = "capabilities";
    const names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    const before = new Map<string, string>();
    for (const name of names) before.set(name, await readFile(join(dir, name), "utf8"));
    try {
      await run();
    } finally {
      for (const [name, body] of before) await writeFile(join(dir, name), body, "utf8");
    }
  }

  const approvedCapability = async (url: string) => {
    const { capabilities } = await (await fetch(`${url}/api/capabilities`)).json();
    return capabilities.find((c: { status: string }) => c.status === "approved");
  };

  const put = (url: string, id: string, artifact: unknown) =>
    fetch(`${url}/api/capabilities/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact }),
    });

  it("refuses to change what an approved capability does without a new version", async () => {
    // Approval is a statement that this exact behaviour was reviewed. Editing the steps while
    // leaving the version alone makes that statement false for every agent already calling it,
    // and leaves no signal anywhere that it happened.
    const url = await start();
    const approved = await approvedCapability(url);
    if (!approved) return;

    const edited = structuredClone(approved.artifact);
    edited.steps[0].id = `${edited.steps[0].id}_tampered`;

    const res = await put(url, approved.capabilityId, edited);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Raise the version");
  });

  it("allows the same change once the version is raised", async () => {
    await withRestoredCapabilities(async () => {
      const url = await start();
      const approved = await approvedCapability(url);
      if (!approved) return;

      const superseded = structuredClone(approved.artifact);
      superseded.steps[0].id = `${superseded.steps[0].id}_v2`;
      superseded.version = "1.0.1";
      // And back to draft: a new version is necessary but not sufficient, because the old
      // revision's approval was a statement about behaviour that no longer exists.
      superseded.metadata.status = "draft";

      // The rule is not "approved is read-only" — it is "a change to what it does must be
      // visible as a new version, and that version starts again". The superseded revision
      // stays in git history, which is where this repository already keeps older revisions.
      expect((await put(url, approved.capabilityId, superseded)).status).toBe(200);
    });
  });

  it("lets a reviewer annotate an approved capability without a version bump", async () => {
    await withRestoredCapabilities(async () => {
      const url = await start();
      const approved = await approvedCapability(url);
      if (!approved) return;

      const annotated = structuredClone(approved.artifact);
      annotated.metadata.notes = "Checked against the staging tenant on 2026-09-28.";

      // A note changes what a reader knows, never what a run does. Forcing a version for it
      // would make reviewers stop writing them.
      expect((await put(url, approved.capabilityId, annotated)).status).toBe(200);
    });
  });

  it("will not let a changed approved capability stay approved, even with a new version", async () => {
    // The version-bump rule closed one door; this is the same hole entered from the other
    // side. A bumped version with changed steps and status left at `approved` puts new,
    // unreviewed behaviour straight into the agent-facing catalog carrying the old revision's
    // approval — which no gate ever saw.
    const url = await start();
    const approved = await approvedCapability(url);
    if (!approved) return;

    const superseded = structuredClone(approved.artifact);
    superseded.steps[0].id = `${superseded.steps[0].id}_v2`;
    superseded.version = "1.0.1";

    const res = await put(url, approved.capabilityId, superseded);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("starts at draft");
  });

  it("accepts the superseding revision once it starts again at draft", async () => {
    await withRestoredCapabilities(async () => {
      const url = await start();
      const approved = await approvedCapability(url);
      if (!approved) return;

      const superseded = structuredClone(approved.artifact);
      superseded.steps[0].id = `${superseded.steps[0].id}_v2`;
      superseded.version = "1.0.1";
      superseded.metadata.status = "draft";

      expect((await put(url, approved.capabilityId, superseded)).status).toBe(200);
    });
  });

  it("refuses to change behaviour and promote in the same save", async () => {
    // The gates read replay history for a fingerprint. Editing the steps while promoting
    // would have the new revision inherit evidence earned by the one it replaced — the exact
    // thing counting rehearsals by content was supposed to prevent.
    const url = await start();
    const { capabilities } = await (await fetch(`${url}/api/capabilities`)).json();
    const draft = capabilities.find((c: { status: string }) => c.status === "draft");
    if (!draft) return;

    const both = structuredClone(draft.artifact);
    both.steps[0].id = `${both.steps[0].id}_edited`;
    both.metadata.status = "validated";

    const res = await put(url, draft.capabilityId, both);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Save the change first, then promote");
  });

  it("refuses to replay a deprecated capability", async () => {
    await withRestoredCapabilities(async () => {
      const url = await start();
      const approved = await approvedCapability(url);
      if (!approved) return;

      const retired = structuredClone(approved.artifact);
      retired.metadata.status = "deprecated";
      expect((await put(url, approved.capabilityId, retired)).status).toBe(200);

      const res = await fetch(`${url}/api/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capabilityId: approved.capabilityId, inputs: {} }),
      });

      // `invoke` refuses a deprecated capability without an override. A console that ran it
      // anyway would make retirement depend on which button you pressed.
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("deprecated");
    });
  });

  it("refuses to withdraw an approved capability to draft through the editor", async () => {
    // Otherwise this is the way around the rule: withdraw, edit freely, re-approve, same
    // version, no trace anywhere that the behaviour moved.
    const url = await start();
    const approved = await approvedCapability(url);
    if (!approved) return;

    const withdrawn = structuredClone(approved.artifact);
    withdrawn.metadata.status = "draft";

    const res = await put(url, approved.capabilityId, withdrawn);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("does not go back to");
  });

  it("leaves drafts editable in place, which is what a draft is for", async () => {
    await withRestoredCapabilities(async () => {
      const url = await start();
      const { capabilities } = await (await fetch(`${url}/api/capabilities`)).json();
      const draft = capabilities.find((c: { status: string }) => c.status === "draft");
      if (!draft) return;

      const edited = structuredClone(draft.artifact);
      edited.metadata.description = "Reworded while still a draft.";

      expect((await put(url, draft.capabilityId, edited)).status).toBe(200);
    });
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

describe("saving an artifact is safe (PR10 review #2, #3)", () => {
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

  it("redacts sensitive content out of a reviewer note before it is written", async () => {
    // A note is free text a human pasted in, which makes it the likeliest place for a
    // credential to enter a git-versioned artifact. It is the one field that had not been
    // through the redaction boundary.
    const url = await start();
    const { capabilities } = await (await fetch(`${url}/api/capabilities`)).json();
    const target = capabilities.find((c: { status: string }) => c.status === "draft") ?? capabilities[0];
    if (!target) return;

    const original = structuredClone(target.artifact);
    const edited = structuredClone(target.artifact);
    edited.metadata.notes =
      "SSN 123-45-6789, token sk-ant-api03-SHOULDNOTPERSIST, card 4111111111111111, account 12345";

    try {
      const res = await fetch(`${url}/api/capabilities/${target.capabilityId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifact: edited }),
      });
      const payload = await res.json();
      expect(res.status).toBe(200);
      // The reviewer is told their text was altered rather than it happening silently.
      expect(payload.notesRedacted).toBe(true);

      const saved = await readFile(target.path, "utf8");
      expect(saved).not.toContain("123-45-6789");
      expect(saved).not.toContain("sk-ant-api03-SHOULDNOTPERSIST");
      expect(saved).not.toContain("4111111111111111");
      // The account number is the subject of the work, not a regulated identifier.
      expect(saved).toContain("12345");
    } finally {
      await fetch(`${url}/api/capabilities/${target.capabilityId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifact: original }),
      });
    }
  }, 30_000);

  it("leaves no partial file behind when a save fails", async () => {
    // writeFile truncates before it writes, and the catalog is read on every console request.
    // A rejected save must not have touched the artifact at all.
    const url = await start();
    const { capabilities } = await (await fetch(`${url}/api/capabilities`)).json();
    const target = capabilities[0];
    if (!target) return;

    const before = await readFile(target.path, "utf8");

    const broken = structuredClone(target.artifact);
    delete broken.metadata.risk;
    const res = await fetch(`${url}/api/capabilities/${target.capabilityId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact: broken }),
    });
    expect(res.status).toBe(422);

    expect(await readFile(target.path, "utf8")).toBe(before);
    // And no temp debris beside the real artifact.
    const siblings = await readdir("capabilities");
    expect(siblings.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 30_000);
});
