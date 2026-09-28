/**
 * An accessibility tree, rendered in the same shape a browser observation has.
 *
 * This is the load-bearing piece of desktop support, and it is worth being explicit about why.
 * `Observation.ariaSnapshot` is just a string, so nothing would *stop* a desktop surface
 * emitting its own format — but the discovery prompt teaches a model to read that shape, and
 * the locator candidates the model proposes back are shaped by what it read. Emit a different
 * format and the model starts proposing targets `locator.ts` cannot resolve, which shows up as
 * a puzzling drop in recording quality rather than as an error.
 *
 * So the renderer matches Playwright's `ariaSnapshot` exactly, down to the indentation:
 *
 *     - main:
 *       - heading "Accounts Overview" [level=1]
 *       - text: Username
 *       - textbox "Username"
 *       - button "Log In"
 *
 * Which is also the argument that the ARIA-first choice was right. A browser and an OS
 * accessibility API are different producers of the same role-and-name tree, so this file is a
 * renderer, not a translation layer.
 */
import type { AxNode } from "./protocol.js";

/** Roles rendered as `- text: value` rather than `- role "name"`, matching the browser. */
const TEXT_ROLES = new Set(["text", "statictext", "label"]);

function quote(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderNode(node: AxNode, depth: number, out: string[]): void {
  // Invisible nodes are dropped rather than marked. The browser snapshot is visibility-aware
  // by construction, and a model shown controls it cannot act on will try to act on them.
  if (node.visible === false) return;

  const indent = "  ".repeat(depth);
  const children = (node.children ?? []).filter((child) => child.visible !== false);
  const role = node.role.toLowerCase();

  if (TEXT_ROLES.has(role)) {
    const text = node.name ?? node.value ?? "";
    if (text !== "") out.push(`${indent}- text: ${text}`);
    return;
  }

  // Values are deliberately absent, exactly as in the browser snapshot: a name identifies a
  // control, a value is content. Keeping content out of the observation is also what keeps a
  // password field from reaching a prompt because someone forgot to mark it sensitive.
  const head = node.name === undefined || node.name === "" ? `- ${role}` : `- ${role} ${quote(node.name)}`;

  if (children.length === 0) {
    out.push(indent + head);
    return;
  }

  out.push(`${indent}${head}:`);
  for (const child of children) renderNode(child, depth + 1, out);
}

/** Renders a tree. The root is included, as `body` is in a browser snapshot. */
export function renderAxSnapshot(root: AxNode): string {
  const out: string[] = [];
  renderNode(root, 0, out);
  return out.join("\n");
}

/**
 * Text a run should treat as an alert, lifted out of the tree so a model cannot miss it.
 *
 * The same job the browser surface does by reading alert roles: a validation message the model
 * scrolls past is a step that looks like it worked.
 */
export function collectAlerts(root: AxNode): string[] {
  const alerts: string[] = [];
  const walk = (node: AxNode): void => {
    if (node.visible === false) return;
    const role = node.role.toLowerCase();
    if (role === "alert" || role === "alertdialog") {
      const text = node.name ?? node.value;
      if (text !== undefined && text !== "") alerts.push(text);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return alerts;
}

/**
 * Every node in the tree, flattened, invisible ones included.
 *
 * Only for the one condition that opts into hidden content. Everything else uses `flatten`,
 * because a surface that let hidden text satisfy a condition would report screens that were
 * never shown — which is how a handler for "an internal error occurred" fires on a page that
 * ships that string in a hidden div on every healthy run.
 */
export function flattenAll(root: AxNode): AxNode[] {
  const all: AxNode[] = [];
  const walk = (node: AxNode): void => {
    all.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return all;
}

/**
 * Every node in the tree, flattened, with invisible ones dropped.
 *
 * Used by locator resolution, which has to count matches before choosing one — the caller
 * refuses both "no match" and "several", and cannot do that from a helper that already picked.
 */
export function flatten(root: AxNode): AxNode[] {
  const all: AxNode[] = [];
  const walk = (node: AxNode): void => {
    if (node.visible === false) return;
    all.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return all;
}
