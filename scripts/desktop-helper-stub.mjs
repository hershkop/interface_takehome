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
function matchAll({ role, name, text }) {
  return flatten(current().tree).filter((node) => {
    if (role !== undefined && node.role.toLowerCase() !== role.toLowerCase()) return false;
    if (name !== undefined && (node.name ?? "") !== name) return false;
    if (text !== undefined && !`${node.name ?? ""}${node.value ?? ""}`.includes(text)) return false;
    return true;
  });
}

/** Acting on the pretend app: what a click actually does to its state. */
function act(query) {
  const [hit] = matchAll(query);
  if (!hit) throw new Error(`nothing to click for ${JSON.stringify(query)}`);

  if (hit.name === "Log In" && state.screen === "login") {
    if (state.username === "" || state.password === "") throw new Error("credentials required");
    state.screen = "overview";
    return;
  }
  if (hit.name === "Find" && state.screen === "overview") {
    state.account = state.find;
    state.screen = state.find === "99999" ? "notFound" : "detail";
  }
}

// ── The protocol ───────────────────────────────────────────────────────────

const handlers = {
  focus({ application }) {
    if (application !== APPLICATION) throw new Error(`no such application: ${application}`);
    return { application: APPLICATION, window: current().window };
  },
  observe() {
    const { window, tree } = current();
    return { window: { application: APPLICATION, window }, tree };
  },
  resolve(params) {
    return { matches: matchAll(params) };
  },
  click(params) {
    act(params);
    return {};
  },
  fill({ value, ...query }) {
    const [hit] = matchAll(query);
    if (!hit) throw new Error(`nothing to fill for ${JSON.stringify(query)}`);
    if (hit.name === "Username") state.username = value;
    if (hit.name === "Password") state.password = value;
    if (hit.name === "Account Number" && state.screen === "overview") state.find = value;
    return {};
  },
  clickAt({ x, y }) {
    // No geometry in the stub: coordinates land on nothing, which is the honest answer and
    // still exercises discovery's "could not derive a locator" path.
    void x;
    void y;
    return {};
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
