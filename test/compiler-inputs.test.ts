import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadSkills, renderSkills, selectSkills } from "../src/skills.js";
import { loadMemory, renderMemory, selectMemory, sensitiveValues } from "../src/appmemory.js";

/**
 * Skills and application memory are compiler inputs.
 *
 * Two things have to be true about them, and they pull in opposite directions. They have to
 * reach the model, so recording quality can improve without changing code. And they must never
 * reach replay, or an approved capability's behaviour stops being a function of its artifact —
 * which is the guarantee everything else in this system is built on.
 *
 * The last test in this file is the one that matters most: it walks the import graph.
 */

const skillFile = (over: Record<string, string> = {}) => {
  const fields = {
    id: "durable-locators",
    version: "1.0.0",
    scope: "generic",
    title: "Prefer durable locators",
    ...over,
  };
  return `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\nBody prose the model reads.`;
};

describe("the skill library", () => {
  it("loads frontmatter and body, and reports files that cannot be read as skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-"));
    try {
      await writeFile(join(dir, "good.md"), skillFile(), "utf8");
      await writeFile(join(dir, "no-frontmatter.md"), "just prose", "utf8");
      await writeFile(join(dir, "empty.md"), skillFile({ id: "empty-one" }).split("---\n")[0] + "---\nid: empty-one\nversion: 1.0.0\nscope: generic\ntitle: Empty\n---\n", "utf8");

      const { skills, invalid } = await loadSkills(dir);

      expect(skills.map((s) => s.id)).toEqual(["durable-locators"]);
      expect(skills[0]!.body).toContain("Body prose");
      // Reported rather than skipped: a skill that silently stopped applying is guidance the
      // model is no longer getting, and nothing about a run would look different.
      expect(invalid).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses two files claiming one skill id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skills-"));
    try {
      await writeFile(join(dir, "a.md"), skillFile({ version: "1.0.0" }), "utf8");
      await writeFile(join(dir, "b.md"), skillFile({ version: "2.0.0" }), "utf8");

      const { skills, invalid } = await loadSkills(dir);

      // The same reasoning the capability catalog applies: two files claiming a name is an
      // ambiguity, not a versioning scheme, and letting the filename decide is worse than
      // refusing both.
      expect(skills).toHaveLength(0);
      expect(invalid).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives a run only the guidance that applies to it", () => {
    const skills = [
      { id: "generic", version: "1.0.0", scope: "generic", title: "G", body: "b", path: "g" },
      { id: "web", version: "1.0.0", scope: "surface:web", title: "W", body: "b", path: "w" },
      { id: "desk", version: "1.0.0", scope: "surface:desktop", title: "D", body: "b", path: "d" },
      { id: "bank", version: "1.0.0", scope: "app:parabank", title: "A", body: "b", path: "a" },
      { id: "other", version: "1.0.0", scope: "app:something", title: "O", body: "b", path: "o" },
    ];

    // A desktop recording told to prefer CSS selectors is being actively misled, so scoping is
    // correctness rather than prompt economy.
    expect(selectSkills(skills, { surface: "desktop", app: "parabank" }).map((s) => s.id)).toEqual([
      "generic",
      "desk",
      "bank",
    ]);
    expect(selectSkills(skills, { surface: "web", app: "parabank" }).map((s) => s.id)).toEqual([
      "generic",
      "web",
      "bank",
    ]);
  });

  it("records what it handed the model", () => {
    const { prompt, provenance } = renderSkills([
      { id: "a", version: "1.2.3", scope: "generic", title: "T", body: "B", path: "p" },
    ]);

    expect(prompt).toContain("a v1.2.3");
    // Recorded on the artifact so a later drop in recording quality has a suspect list.
    expect(provenance).toEqual([{ id: "a", version: "1.2.3" }]);
  });

  it("ships a library that actually loads", async () => {
    // The committed skills are prompt input, so a typo in one is a silent quality regression.
    const { skills, invalid } = await loadSkills("skills");
    expect(invalid).toEqual([]);
    expect(skills.length).toBeGreaterThan(0);
  });
});

const entry = (over: Record<string, unknown> = {}) => ({
  id: "hidden-error-div",
  version: "1.0.0",
  fact: "Every page ships a hidden error container.",
  scope: { app: "parabank", surface: "web" as const },
  provenance: { source: "DAY0-FINDINGS", observedAt: "2026-09-24T00:00:00.000Z" },
  owner: "platform-team",
  confidence: "high",
  ...over,
});

async function withMemory(
  entries: unknown[],
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "memory-"));
  try {
    await writeFile(join(dir, "app.json"), JSON.stringify({ entries }), "utf8");
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("application memory", () => {
  it("refuses an entry containing a configured secret rather than scrubbing it", async () => {
    await withMemory([entry({ fact: "Sign in with hunter2 to reach the admin screen." })], async (dir) => {
      const { entries, invalid } = await loadMemory(dir, { secrets: ["hunter2"] });

      // Refused, not redacted: these files are committed, and scrubbing on load would leave
      // the secret sitting in git while the loader reported everything was fine.
      expect(entries).toHaveLength(0);
      expect(invalid[0]!.reason).toContain("secret");
    });
  });

  it("checks only values whose key says they are sensitive", () => {
    // "the fixture seeds accounts for user john" is exactly what memory is for, and it
    // contains the username. Refusing it would make the safety check unusable.
    expect(sensitiveValues({ parabankUsername: "john", parabankPassword: "demo" })).toEqual([
      "demo",
    ]);
  });

  it("drops entries that have expired", async () => {
    await withMemory(
      [
        entry({ id: "stale", expiresAt: "2026-01-01T00:00:00.000Z" }),
        entry({ id: "current", expiresAt: "2099-01-01T00:00:00.000Z" }),
      ],
      async (dir) => {
        const { entries } = await loadMemory(dir, { now: new Date("2026-09-28T00:00:00.000Z") });
        // An entry that cannot expire becomes folklore outliving the screen it described.
        expect(entries.map((e) => e.id)).toEqual(["current"]);
      },
    );
  });

  it("keeps one tenant's memory out of another's recording", () => {
    const entries = [
      { ...entry({ id: "shared" }), scope: { app: "parabank", surface: "web" as const } },
      {
        ...entry({ id: "tenant-a" }),
        scope: { app: "parabank", surface: "web" as const, tenant: "a" },
      },
      {
        ...entry({ id: "tenant-b" }),
        scope: { app: "parabank", surface: "web" as const, tenant: "b" },
      },
    ].map((e) => ({ ...e, confidence: "high" as const }));

    // Cross-tenant contamination is the failure nobody notices, because the wrong memory
    // usually produces a perfectly plausible capability.
    expect(
      selectMemory(entries, { app: "parabank", surface: "web", tenant: "a" }).map((e) => e.id),
    ).toEqual(["shared", "tenant-a"]);
    expect(
      selectMemory(entries, { app: "parabank", surface: "web" }).map((e) => e.id),
    ).toEqual(["shared"]);
  });

  it("does not hand a desktop recording a web application's conventions", () => {
    const entries = [
      { ...entry({ id: "web-note" }), confidence: "high" as const },
      {
        ...entry({ id: "desktop-note" }),
        scope: { app: "parabank", surface: "desktop" as const },
        confidence: "high" as const,
      },
    ];

    expect(
      selectMemory(entries, { app: "parabank", surface: "desktop" }).map((e) => e.id),
    ).toEqual(["desktop-note"]);
  });

  it("tells the model a note may be stale, and how much to trust it", () => {
    const { prompt } = renderMemory([
      { ...entry({ id: "soft" }), confidence: "low" as const } as never,
    ]);

    expect(prompt).toContain("the screen is right and the note is stale");
    expect(prompt).toContain("(confidence: low)");
  });

  it("requires an owner, so a stale entry has someone to retire it", async () => {
    const { owner: _dropped, ...ownerless } = entry();
    await withMemory([ownerless], async (dir) => {
      const { entries, invalid } = await loadMemory(dir);

      // Provenance says where a belief came from; ownership says who to ask when it turns out
      // to be wrong. The failure mode of a memory store is not bad entries arriving, it is
      // stale ones never leaving.
      expect(entries).toHaveLength(0);
      expect(invalid[0]!.reason).toContain("owner");
    });
  });

  it("ships memory that actually loads", async () => {
    const { entries, invalid } = await loadMemory("memory", { secrets: ["hunter2"] });
    expect(invalid).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });
});

/**
 * Walks `import` statements from a file, following only relative paths inside `src/`.
 *
 * Crude on purpose: it reads text rather than building a type-aware graph, which means it
 * cannot be fooled by a dynamic import it does not understand — it just would not see one. The
 * test below therefore checks the thing it can check honestly, and says so.
 */
async function reachableModules(from: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [resolve(from)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = await readFile(file, "utf8").catch(() => "");
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1]!.replace(/\.js$/, ".ts");
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return seen;
}

describe("replay cannot reach a compiler input", () => {
  it("never imports skills or memory, at any depth", async () => {
    const reachable = await reachableModules("src/replay.ts");

    // The determinism claim rests on this. If guidance could reach replay, the same approved
    // capability could behave differently because someone edited a markdown file — and no
    // version, fingerprint or evidence record would show it.
    expect([...reachable].some((f) => f.endsWith("/skills.ts"))).toBe(false);
    expect([...reachable].some((f) => f.endsWith("/appmemory.ts"))).toBe(false);

    // A control: the walker does find things, so a green result above means something.
    expect([...reachable].some((f) => f.endsWith("/schema.ts"))).toBe(true);
    expect([...reachable].some((f) => f.endsWith("/safety.ts"))).toBe(true);
  });

  it("is reachable from discovery, which is the only place it belongs", async () => {
    const reachable = await reachableModules("src/discovery.ts");
    expect([...reachable].some((f) => f.endsWith("/skills.ts"))).toBe(true);
    expect([...reachable].some((f) => f.endsWith("/appmemory.ts"))).toBe(true);
  });
});
