#!/usr/bin/env node
/**
 * A reference desktop helper shaped like Excel.
 *
 * The second helper, and the one that argues the protocol is real: a login form exercises seven
 * verbs politely, a spreadsheet does not. This models the parts of Excel that a capability
 * actually has to drive — a ribbon, a Name Box, a grid, a context menu, a modal dialog — with
 * the accessibility API replaced by a hand-written model.
 *
 * What it is here to demonstrate, beyond "it runs":
 *
 *   **A grid is not a tree you can hand to a model.** `observe` reports the *used range*, not
 *   the addressable one. A sheet addresses ~17 billion cells; reporting them is a denial of
 *   service on the caller's own context window. A real helper reads UIA's GridPattern or AX's
 *   AXTable and does the same.
 *
 *   **A cell is not a named control.** Its accessible name is usually its value, which changes
 *   the moment anything writes to it. Cells answer the `cell` locator strategy by reference,
 *   which is the only durable way to say which one.
 *
 *   **Real work lives behind keys and right-clicks.** The Name Box holds what you type until
 *   Enter. Column Width is on a context menu as well as the ribbon. Both paths are modelled,
 *   because a capability recorded against one should be able to fall back to the other.
 *
 *   **The document is not the window title.** `observe` reports `document` separately, because
 *   policy is written against the file being changed and titles are decoration.
 *
 * Usage:  node scripts/excel-helper-stub.mjs [--document PATH]
 */

import { createInterface } from "node:readline";

const APPLICATION = "com.microsoft.Excel";

const documentArg = process.argv.indexOf("--document");
const DOCUMENT = documentArg === -1 ? "/fixtures/Q3-report.xlsx" : process.argv[documentArg + 1];

// ── The workbook ───────────────────────────────────────────────────────────

const state = {
  /** Used range only. A real helper reads this from the grid pattern. */
  cells: {
    A1: "Region", B1: "Units", C1: "Revenue",
    A2: "North",  B2: "1200",  C2: "48000",
    A3: "South",  B3: "980",   C3: "39200",
    A4: "East",   B4: "1430",  C4: "57200",
  },
  columnWidths: { A: 8.43, B: 8.43, C: 8.43 },
  /** What the Name Box currently holds, which is not the same as what is selected. */
  nameBoxDraft: "",
  selection: "A1",
  /** "grid" | "contextMenu" | "columnWidthDialog" */
  screen: "grid",
  ribbonTab: "Home",
  dirty: false,
  saved: false,
};

const columnOf = (ref) => /^([A-Z]+)/.exec(ref)?.[1] ?? "A";

/** The ribbon for the active tab. Stable roles and names — the easy half of Excel. */
function ribbon() {
  const tabs = ["Home", "Insert", "Data"].map((name) => ({
    role: "tab",
    name,
    selected: name === state.ribbonTab,
  }));

  const home = [
    { role: "button", name: "Bold" },
    { role: "button", name: "Format" },
    { role: "button", name: "Save" },
  ];

  return {
    role: "toolbar",
    name: "Ribbon",
    children: [...tabs, ...(state.ribbonTab === "Home" ? home : [])],
  };
}

/**
 * The grid, as the used range.
 *
 * Every cell carries `ref`, which is what the `cell` locator strategy matches on. Its `name` is
 * its displayed value, deliberately — that is what an accessibility API reports, and it is
 * exactly why targeting a cell by name is a trap worth having a strategy against.
 */
function grid() {
  const refs = Object.keys(state.cells).sort();
  return {
    role: "table",
    name: `Sheet1 (used range ${refs[0]}:${refs[refs.length - 1]})`,
    children: refs.map((ref) => ({
      role: "cell",
      name: state.cells[ref],
      value: state.cells[ref],
      ref,
      selected: ref === state.selection || columnOf(ref) === state.selection.replace(/:.*$/, ""),
    })),
  };
}

function screens() {
  const base = [
    ribbon(),
    { role: "textbox", name: "Name Box", value: state.nameBoxDraft },
    { role: "statictext", name: `Selected: ${state.selection}` },
    grid(),
  ];

  if (state.screen === "contextMenu") {
    return [
      ...base,
      {
        role: "menu",
        name: "Column",
        children: [
          { role: "menuitem", name: "Insert" },
          { role: "menuitem", name: "Delete" },
          { role: "menuitem", name: "Column Width…" },
        ],
      },
    ];
  }

  if (state.screen === "columnWidthDialog") {
    return [
      ...base,
      {
        role: "dialog",
        name: "Column Width",
        children: [
          { role: "textbox", name: "Column width", value: String(currentWidth()) },
          { role: "button", name: "OK" },
          { role: "button", name: "Cancel" },
        ],
      },
    ];
  }

  return base;
}

const selectedColumn = () => columnOf(state.selection);
const currentWidth = () => state.columnWidths[selectedColumn()] ?? 8.43;

const windowTitle = () =>
  `${DOCUMENT.split("/").pop()}${state.dirty ? "" : " — Saved"} — Excel`;

const where = () => ({ application: APPLICATION, window: windowTitle(), document: DOCUMENT });

const tree = () => ({ role: "window", name: windowTitle(), children: screens() });

// ── Handles ────────────────────────────────────────────────────────────────

let generation = 0;
let handleSeq = 0;
const handles = new Map();

function issueHandle(node) {
  const handle = `h${generation}:${++handleSeq}`;
  handles.set(handle, { generation, node });
  return handle;
}

function nodeFor(handle) {
  const entry = handles.get(handle);
  if (!entry) throw new Error(`unknown handle: ${handle}`);
  if (entry.generation !== generation) {
    throw new Error(`stale handle: ${handle} (the screen changed after it was resolved)`);
  }
  return entry.node;
}

/** Anything that changes what is on screen invalidates outstanding handles. */
function changed() {
  generation++;
  handles.clear();
}

function flatten(node, out = []) {
  if (node.visible === false) return out;
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

function matchAll({ role, name, text, cell, exact }) {
  return flatten(tree()).filter((node) => {
    if (cell !== undefined && node.ref !== cell) return false;
    if (role !== undefined && node.role.toLowerCase() !== role.toLowerCase()) return false;
    if (name !== undefined) {
      const candidate = node.name ?? "";
      if (exact ? candidate !== name : !candidate.includes(name)) return false;
    }
    if (text !== undefined && !`${node.name ?? ""}${node.value ?? ""}`.includes(text)) return false;
    return true;
  });
}

// ── Behaviour ──────────────────────────────────────────────────────────────

function click(node, button) {
  if (button === "right") {
    // Right-clicking a cell or a column opens the column menu. This is the path a recording
    // takes when the ribbon layout differs between Excel versions.
    if (node.role === "cell" || node.role === "columnheader") {
      state.selection = node.ref ?? state.selection;
      state.screen = "contextMenu";
      changed();
    }
    return;
  }

  if (node.role === "tab") {
    state.ribbonTab = node.name;
    changed();
    return;
  }
  if (node.name === "Format" && state.screen === "grid") {
    state.screen = "columnWidthDialog";
    changed();
    return;
  }
  if (node.name === "Column Width…" && state.screen === "contextMenu") {
    state.screen = "columnWidthDialog";
    changed();
    return;
  }
  if (node.name === "OK" && state.screen === "columnWidthDialog") {
    state.screen = "grid";
    state.dirty = true;
    changed();
    return;
  }
  if (node.name === "Cancel") {
    state.screen = "grid";
    changed();
    return;
  }
  if (node.name === "Save") {
    // Modelled so the risk gate has something irreversible to refuse. Writing over a workbook
    // is the step a person should approve, not the column width that preceded it.
    state.saved = true;
    state.dirty = false;
    changed();
    return;
  }
  if (node.role === "cell") {
    state.selection = node.ref;
    changed();
  }
}

function fill(node, value) {
  if (node.name === "Name Box") {
    // Held as a draft. Typing a range into the Name Box selects nothing until Enter, which is
    // the whole reason `press` had to exist as a verb.
    state.nameBoxDraft = value;
    return;
  }
  if (node.role === "textbox" && node.name === "Column width") {
    state.columnWidths[selectedColumn()] = Number(value);
    changed();
    return;
  }
  if (node.role === "cell") {
    state.cells[node.ref] = value;
    state.dirty = true;
    changed();
  }
}

function key(node, keys) {
  if (keys === "Enter" && (node?.name === "Name Box" || state.nameBoxDraft !== "")) {
    state.selection = state.nameBoxDraft || state.selection;
    state.nameBoxDraft = "";
    changed();
    return;
  }
  if (keys === "Escape") {
    state.screen = "grid";
    changed();
  }
}

// ── The protocol ───────────────────────────────────────────────────────────

const handlers = {
  focus({ application }) {
    if (application !== APPLICATION) throw new Error(`no such application: ${application}`);
    return where();
  },
  observe({ scope }) {
    const root = scope === undefined ? tree() : nodeFor(scope);
    return { window: where(), tree: root };
  },
  resolve(params) {
    return { matches: matchAll(params).map((node) => ({ ...node, handle: issueHandle(node) })) };
  },
  click({ handle, button }) {
    click(nodeFor(handle), button ?? "left");
    return { window: where() };
  },
  fill({ handle, value }) {
    fill(nodeFor(handle), value);
    return { window: where() };
  },
  key({ handle, keys }) {
    key(handle === undefined ? undefined : nodeFor(handle), keys);
    return { window: where() };
  },
  clickAt({ x, y }) {
    void x;
    void y;
    return { window: where() };
  },
  screenshot({ maskRoles }) {
    void maskRoles;
    return {
      pngBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    };
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const handler = handlers[request.method];
    if (!handler) throw new Error(`unknown method: ${request.method}`);
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: handler(request.params ?? {}) })}\n`,
    );
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, error: { message: String(err.message ?? err) } })}\n`,
    );
  }
});
