/**
 * The agent-facing surface: saved artifacts as a catalog of callable capabilities.
 *
 * This is the brief's through-line made concrete — "the artifact becomes a reusable capability
 * an AI agent can call". An agent discovers what exists, reads a typed contract for each, and
 * invokes one by name with typed arguments. It never sees a step list, a locator, or a browser.
 *
 * The tool schema is generated from the artifact rather than written alongside it, so a
 * capability cannot drift out of sync with how it is advertised.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { CapabilityArtifact, type Policy, type RunResult } from "./schema.js";
import { replay, type ReplayOptions } from "./replay.js";

export interface CatalogEntry {
  capabilityId: string;
  version: string;
  name: string;
  description: string;
  status: "draft" | "approved";
  risk: "safe" | "approval_required" | "blocked";
  path: string;
  artifact: CapabilityArtifact;
}

/**
 * Loads every valid artifact in a directory. Invalid ones are reported, not silently skipped —
 * a capability an agent cannot see and nobody was told about is the worst of both.
 *
 * `agentFacing` drops drafts from the result. What a human browsing the catalog should see and
 * what an agent should be handed as callable tools are not the same list.
 */
export async function loadCatalog(
  directory: string,
  options: { agentFacing?: boolean } = {},
): Promise<{ entries: CatalogEntry[]; invalid: Array<{ path: string; reason: string }> }> {
  const entries: CatalogEntry[] = [];
  const invalid: Array<{ path: string; reason: string }> = [];

  const files = await readdir(directory).catch(() => [] as string[]);
  for (const file of files.sort()) {
    if (extname(file) !== ".json") continue;
    const path = join(directory, file);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      invalid.push({ path, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const parsed = CapabilityArtifact.safeParse(raw);
    if (!parsed.success) {
      invalid.push({
        path,
        reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    entries.push({
      capabilityId: parsed.data.capabilityId,
      version: parsed.data.version,
      name: parsed.data.metadata.name,
      description: parsed.data.metadata.description,
      status: parsed.data.metadata.status,
      risk: parsed.data.metadata.risk,
      path,
      artifact: parsed.data,
    });
  }
  return {
    entries: options.agentFacing ? entries.filter((e) => e.status === "approved") : entries,
    invalid,
  };
}

/**
 * The JSON-Schema tool definition an agent would be given for a capability.
 *
 * Derived from the artifact's own `inputs`, so the advertised contract and the enforced one are
 * the same declaration. The risk class and approval state are part of the description because
 * an agent choosing between capabilities needs to know which ones will stop and wait for a
 * person before it commits to one.
 */
export function toToolDefinition(entry: CatalogEntry): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, definition] of Object.entries(entry.artifact.inputs)) {
    properties[name] = {
      type: definition.type,
      ...(definition.description ? { description: definition.description } : {}),
      ...(definition.pattern ? { pattern: definition.pattern } : {}),
    };
    if (definition.required) required.push(name);
  }

  const notes = [
    entry.description,
    `Returns: ${
      Object.entries(entry.artifact.outputs)
        .map(([name, out]) => `${name} (${out.type})`)
        .join(", ") || "no values"
    }.`,
    entry.risk === "approval_required"
      ? "This capability requires a human to approve a step before it completes."
      : "",
    entry.status === "draft"
      ? "DRAFT: this capability has not been approved for unattended use."
      : "",
  ].filter(Boolean);

  return {
    name: entry.capabilityId,
    description: notes.join(" "),
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

/**
 * Invokes a capability by name.
 *
 * This is the whole production path in one function: look up a name, hand it typed arguments,
 * get back one of four structured results. There is no model in it.
 */
export async function invoke(
  directory: string,
  capabilityId: string,
  args: Record<string, unknown>,
  options: Omit<ReplayOptions, "artifact" | "inputs"> & {
    policy: Policy;
    /** Required to run a draft. Absent, a draft is refused rather than warned about. */
    allowDraft?: boolean;
  },
): Promise<RunResult | { notFound: string[] } | { refused: string }> {
  const { entries } = await loadCatalog(directory);
  const entry = entries.find((e) => e.capabilityId === capabilityId);
  if (!entry) return { notFound: entries.map((e) => e.capabilityId) };

  // `draft` has to mean something. A warning in a description is documentation; an agent reads
  // the schema and calls the tool. A capability that has never been reviewed and has no error
  // handling should not be invocable unattended just because it loaded successfully.
  if (entry.status === "draft" && !options.allowDraft) {
    return {
      refused:
        `"${capabilityId}" is a draft and is not approved for unattended use. ` +
        `Review it, set metadata.status to "approved", or pass allowDraft to run it anyway.`,
    };
  }

  return replay({ ...options, artifact: entry.artifact, inputs: args });
}
