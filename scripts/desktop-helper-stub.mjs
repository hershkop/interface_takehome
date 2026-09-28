#!/usr/bin/env node
/**
 * A reference desktop helper, over a pretend application.
 *
 * The platform half of desktop support is a separate process speaking newline-delimited JSON
 * over stdio — see `src/desktop/protocol.ts`. This is that process, with the accessibility API
 * replaced by a hand-written tree, and it exists for three reasons:
 *
 *   1. It makes the protocol executable rather than documentary. `DesktopSurface` is driven
 *      end to end against it in the test suite, over a real child process and real stdio
 *      framing, so the wire format is proven before anyone writes Swift.
 *   2. It is the specification a real helper is written against. Match these seven responses
 *      against a live accessibility API and the TypeScript side needs no changes.
 *   3. It lets the whole desktop path — policy, replay, evidence, the console — be exercised
 *      on a machine with no accessibility permissions and no GUI, including in CI.
 *
 * It is a stub, not a mock: it holds state, and its screens change when you act on them.
 *
 * Usage:  node scripts/desktop-helper-stub.mjs
 * Speaks: one JSON request per line on stdin, one JSON response per line on stdout.
 */

import { createInterface } from "node:readline";

// ── The pretend application ────────────────────────────────────────────────
//
// Shaped like a small banking desktop app, so the same capability shape the web target uses
// has somewhere to run. A real helper reads this from the platform instead.

const APPLICATION = "com.example.DesktopBank";

const state = { screen: "login", username: "", password: "", find: "", account: undefined };

const screens = {
  login: () => ({
    window: "Sign In",
    tree: {
      role: "window",
      name: "Sign In",
      children: [
        { role: "heading", name: "Customer Login" },
        { role: "textbox", name: "Username", value: state.username },
        { role: "securetextfield", name: "Password", value: state.password, sensitive: true },
        { role: "button", name: "Log In" },
      ],
    },
  }),
  overview: () => ({
    window: "Accounts Overview",
    tree: {
      role: "window",
      name: "Accounts Overview",
      children: [
        { role: "heading", name: "Accounts Overview" },
        // A lookup rather than a list of buttons, so the "no such record" path is reachable
        // the way it is in a real application — by asking for something that is not there.
        { role: "textbox", name: "Account Number", value: state.find },
        { role: "button", name: "Find" },
      ],
    },
  }),
  detail: () => ({
    window: "Account Details",
    tree: {
      role: "window",
      name: "Account Details",
      children: [
        { role: "heading", name: "Account Details" },
        { role: "statictext", name: "Account Number" },
        { role: "textbox", name: "Account Number", value: state.account ?? "" },
        { role: "textbox", name: "Account Type", value: "SAVINGS" },
        { role: "textbox", name: "Balance", value: "-100.00" },
      ],
    },
  }),
  notFound: () => ({
    window: "Account Details",
    tree: {
      role: "window",
      name: "Account Details",
      children: [{ role: "alert", name: "The account number could not be found." }],
    },
  }),
};

const current = () => screens[state.screen]();

const where = () => ({ application: APPLICATION, window: current().window });

// ── Handles ────────────────────────────────────────────────────────────────
//
// `resolve` issues one per match and `click`/`fill` consume it, so a mutation acts on the node
// that was checked for uniqueness rather than on whatever matches when the second request
// lands. Handles are scoped to a generation that bumps whenever the screen changes: a handle
// from before the change refers to a node the caller never verified, so it is refused rather
// than quietly re-matched.

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

/** Any change to what is on screen invalidates every handle issued against the old one. */
function changeScreen(next) {
  if (next !== state.screen) {
    state.screen = next;
    generation++;
    handles.clear();
  }
}

/** Every visible node, flattened — the helper's own view of what it could match. */
function flatten(node, out = []) {
  if (node.visible === false) return out;
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/**
 * Every node matching a query. Deliberately returns all of them: choosing among several is the
 * caller's job, and a helper that returned "the first" would defeat replay's refusal to guess.
 */
function matchAll({ role, name, text, exact }) {
  return flatten(current().tree).filter((node) => {
    if (role !== undefined && node.role.toLowerCase() !== role.toLowerCase()) return false;
    if (name !== undefined) {
      // Substring by default, equality when the candidate asked for it — the artifact's own
      // locator semantics. Always comparing exactly would silently narrow every recorded name.
      const candidate = node.name ?? "";
      if (exact ? candidate !== name : !candidate.includes(name)) return false;
    }
    if (text !== undefined && !`${node.name ?? ""}${node.value ?? ""}`.includes(text)) return false;
    return true;
  });
}

/** Acting on the pretend app: what a click actually does to its state. */
function act(node) {
  if (node.name === "Log In" && state.screen === "login") {
    if (state.username === "" || state.password === "") throw new Error("credentials required");
    changeScreen("overview");
    return;
  }
  if (node.name === "Find" && state.screen === "overview") {
    state.account = state.find;
    changeScreen(state.find === "99999" ? "notFound" : "detail");
  }
}

// ── The protocol ───────────────────────────────────────────────────────────

const handlers = {
  focus({ application }) {
    if (application !== APPLICATION) throw new Error(`no such application: ${application}`);
    return where();
  },
  observe() {
    const { window, tree } = current();
    return { window: { application: APPLICATION, window }, tree };
  },
  resolve(params) {
    // Every match, each with a handle. Choosing among them is the caller's job.
    return { matches: matchAll(params).map((node) => ({ ...node, handle: issueHandle(node) })) };
  },
  click({ handle }) {
    act(nodeFor(handle));
    // The window the click left the session in, so the caller's location is never one action
    // out of date when the policy guard reads it.
    return { window: where() };
  },
  fill({ handle, value }) {
    const node = nodeFor(handle);
    if (node.name === "Username") state.username = value;
    if (node.name === "Password") state.password = value;
    if (node.name === "Account Number" && state.screen === "overview") state.find = value;
    return { window: where() };
  },
  clickAt({ x, y }) {
    // No geometry in the stub: coordinates land on nothing, which is the honest answer and
    // still exercises discovery's "could not derive a locator" path.
    void x;
    void y;
    return { window: where() };
  },
  screenshot({ maskRoles }) {
    // A real helper renders the window with those roles painted over. The stub returns a
    // 1×1 PNG: evidence writing is what is under test here, not image fidelity.
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
    process.stdout.write(`${JSON.stringify({ id: request.id, result: handler(request.params ?? {}) })}\n`);
  } catch (err) {
    // Errors are values, not a dropped connection: "no such control" is an ordinary outcome
    // the system knows how to report, and it must not look like a crashed helper.
    process.stdout.write(`${JSON.stringify({ id: request.id, error: { message: String(err.message ?? err) } })}\n`);
  }
});
