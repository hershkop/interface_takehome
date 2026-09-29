import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay } from "../src/replay.js";
import { CapabilityArtifact, Policy } from "../src/schema.js";
import { PolicyGuard } from "../src/safety.js";
import { DesktopSurface } from "../src/desktop/surface.js";
import { StdioDesktopTransport } from "../src/desktop/transport.js";
import { desktopLocation } from "../src/location.js";

/**
 * A capability driving a spreadsheet, over the reference Excel helper.
 *
 * The login form the first desktop helper modelled exercises the protocol politely. A
 * spreadsheet does not: it needs a keystroke to commit a selection, a right-click to reach an
 * operation, a cell addressed by reference rather than by name, and a grid too large to hand to
 * a model whole. Each of those was a gap, and each one below is the test that it closed.
 */

const helper = (document?: string) =>
  new StdioDesktopTransport({
    command: "node",
    args: ["scripts/excel-helper-stub.mjs", ...(document ? ["--document", document] : [])],
  });

const surface = (document?: string) => new DesktopSurface({ transport: helper(document) });

const policy = (over: Record<string, unknown> = {}) =>
  Policy.parse({
    allowedApplications: ["com.microsoft.Excel"],
    allowedDocuments: ["/fixtures/**"],
    allowedActions: ["navigate", "click", "fill", "select", "wait", "extract", "assert", "press"],
    ...over,
  });

let evidenceRoot: string | undefined;
afterEach(async () => {
  if (evidenceRoot) await rm(evidenceRoot, { recursive: true, force: true });
  evidenceRoot = undefined;
});

async function run(over: Record<string, unknown> = {}): Promise<ReturnType<typeof replay>> {
  evidenceRoot = await mkdtemp(join(tmpdir(), "excel-"));
  const artifact = CapabilityArtifact.parse(
    JSON.parse(await readFile("capabilities/excel_set_column_width.v1.json", "utf8")),
  );
  return replay({
    artifact,
    inputs: { column: "C", width: "20" },
    secrets: {},
    policy: policy(),
    evidenceRoot,
    surfaceKind: "desktop",
    createSurface: async () => surface(),
    ...over,
  });
}

describe("a spreadsheet capability replays", () => {
  it("selects a column, resizes it, and reports what was applied", async () => {
    const result = await run();

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs).toEqual({ appliedWidth: 20, selection: "Selected: C1" });
    }
    // The surface changed; nothing above it did.
    expect(result.evidence.modelCalls).toBe(0);
  }, 30_000);

  it("resizes a different column on the same artifact", async () => {
    // The point of parameterising: the cell reference `{{inputs.column}}1` is a parameter like
    // any other, and a capability that only ever resizes C is a capability that works once.
    const result = await run({ inputs: { column: "B", width: "14" } });

    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs.appliedWidth).toBe(14);
  }, 30_000);
});

describe("the verbs a spreadsheet needed", () => {
  it("commits a typed range only on Enter", async () => {
    const s = surface();
    try {
      await s.navigate("app://com.microsoft.Excel");
      const nameBox = {
        candidates: [{ strategy: "role" as const, role: "textbox", name: "Name Box", exact: true }],
      };

      await s.fill(nameBox, "C:C");
      // Typing into the Name Box selects nothing. A flow that filled it and moved on would
      // read correctly and act on the wrong cells — which is why `press` is a verb and not a
      // flag on `fill`.
      expect(await s.verify({ kind: "text", value: "Selected: A1", visible: true })).toBe(true);

      await s.press("Enter", nameBox);
      expect(await s.verify({ kind: "text", value: "Selected: C:C", visible: true })).toBe(true);
    } finally {
      await s.close();
    }
  }, 30_000);

  it("reaches an operation that only exists behind the right button", async () => {
    const s = surface();
    try {
      await s.navigate("app://com.microsoft.Excel");
      const cell = { candidates: [{ strategy: "cell" as const, ref: "C1" }] };

      await s.click(cell, "left");
      expect(await s.verify({ kind: "role", role: "menu", name: "Column" })).toBe(false);

      await s.click(cell, "right");
      // Dropped anywhere along the chain, a recorded right-click replays as a left-click: it
      // resolves, it succeeds, and it does something else entirely.
      expect(await s.verify({ kind: "role", role: "menu", name: "Column" })).toBe(true);
    } finally {
      await s.close();
    }
  }, 30_000);

  it("addresses a cell by reference, not by the value it happens to hold", async () => {
    const s = surface();
    try {
      await s.navigate("app://com.microsoft.Excel");

      // A cell's accessible name is its displayed value, which changes the moment anything
      // writes to it. The reference is the only durable way to say which cell.
      const byRef = { candidates: [{ strategy: "cell" as const, ref: "B2" }] };
      expect((await s.extract(byRef)).ok).toBe(true);
      expect((await s.extract(byRef)).value).toBe("1200");

      await s.fill(byRef, "1500");
      expect((await s.extract(byRef)).value).toBe("1500");
      // Same cell, different name. A name-based locator would now be pointing at nothing.
      expect((await s.extract({ candidates: [{ strategy: "cell" as const, ref: "B2" }] })).value).toBe(
        "1500",
      );
    } finally {
      await s.close();
    }
  }, 30_000);

  it("reports the used range rather than every addressable cell", async () => {
    const s = surface();
    try {
      const observation = await s.observe(0);
      // A sheet addresses billions of cells. Reporting them is a denial of service on the
      // caller's own context window, so a helper reports what is in use.
      expect(observation.ariaSnapshot).toContain("used range A1:C4");
      expect(observation.ariaSnapshot.split("\n").length).toBeLessThan(40);
    } finally {
      await s.close();
    }
  }, 30_000);
});

describe("a document allowlist is not an application allowlist", () => {
  it("refuses the same application editing a workbook outside the policy", async () => {
    const result = await run({ createSurface: async () => surface("/home/private/salaries.xlsx") });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("POLICY_DENIED");
      // "May drive Excel" is not "may edit this workbook", and a capability that can open a
      // file dialog can reach every spreadsheet on the machine while staying inside an
      // application allowlist.
      expect(result.error.message).toContain("does not match any allowed document");
    }
  }, 30_000);

  it("matches the document, never the window title", () => {
    const guard = new PolicyGuard(policy());

    // The helper reports "Q3-report.xlsx — Saved — Excel" as its title and renames it on save.
    // Containment a rename can walk past is not containment.
    expect(
      guard.checkApplication(desktopLocation("com.microsoft.Excel", "/fixtures/Q3-report.xlsx"), {
        requireDocument: true,
      }).allowed,
    ).toBe(true);
    expect(
      guard.checkApplication(
        desktopLocation("com.microsoft.Excel", "Q3-report.xlsx — Saved — Excel"),
        { requireDocument: true },
      ).allowed,
    ).toBe(false);
  });

  it("lets a run enter an application before it can name a document", () => {
    // "Focus Excel" cannot say which workbook — that is what focusing it decides. The demand
    // belongs at the landing check, where the answer exists.
    const guard = new PolicyGuard(policy());
    expect(guard.checkApplication("app://com.microsoft.Excel").allowed).toBe(true);
    expect(
      guard.checkApplication("app://com.microsoft.Excel", { requireDocument: true }).allowed,
    ).toBe(false);
  });
});
