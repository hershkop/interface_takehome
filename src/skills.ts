/**
 * The skill library: versioned guidance that shapes how the model compiles a capability.
 *
 * Skills are compiler inputs, not runtime ones. They reach the discovery prompt and nothing
 * else — replay never loads this module, and a test asserts it. That separation is the whole
 * design: guidance is allowed to change, and if it could reach replay then two runs of the same
 * approved capability could differ because someone edited a markdown file.
 *
 * Each skill is a markdown file with a small frontmatter block:
 *
 *     ---
 *     id: durable-locators
 *     version: 1.0.0
 *     scope: generic
 *     title: Prefer durable locators
 *     ---
 *     Prose the model reads.
 *
 * `scope` decides which runs see it: `generic`, `surface:web`, `surface:desktop`, or
 * `app:<name>`. Scoping is not an optimisation — a desktop recording told to prefer CSS
 * selectors is being actively misled, and generic guidance that quietly carries one
 * application's conventions is how a skill library turns into folklore.
 */
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import type { SurfaceKind } from "./schema.js";

export const SkillScope = z
  .string()
  .regex(/^(generic|surface:(web|desktop)|app:[a-z0-9_-]+)$/, "generic | surface:<kind> | app:<name>");

export const SkillFrontmatter = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "lower-kebab-case"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  scope: SkillScope,
  title: z.string().min(1),
});

export interface Skill {
  id: string;
  version: string;
  scope: string;
  title: string;
  /** The prose the model actually reads. */
  body: string;
  path: string;
}

/** Skills whose frontmatter did not parse, reported rather than skipped. */
export interface SkillProblem {
  path: string;
  reason: string;
}

/**
 * Parses `--- key: value --- body`.
 *
 * Deliberately not YAML. A skill's frontmatter is four scalar fields, and taking a YAML parser
 * as a dependency to read them would buy anchors, references and multi-document files —
 * none of which anyone should be writing here, all of which someone eventually would.
 */
function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim());
  if (!match) return undefined;

  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { fields, body: (match[2] ?? "").trim() };
}

export async function loadSkills(
  directory = "skills",
): Promise<{ skills: Skill[]; invalid: SkillProblem[] }> {
  const skills: Skill[] = [];
  const invalid: SkillProblem[] = [];

  const files = await readdir(directory).catch(() => [] as string[]);
  for (const file of files.sort()) {
    if (extname(file) !== ".md") continue;
    const path = join(directory, file);
    const split = splitFrontmatter(await readFile(path, "utf8"));
    if (!split) {
      invalid.push({ path, reason: "no frontmatter block" });
      continue;
    }

    const parsed = SkillFrontmatter.safeParse(split.fields);
    if (!parsed.success) {
      invalid.push({
        path,
        reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    if (split.body === "") {
      invalid.push({ path, reason: "no body — a skill with no guidance teaches nothing" });
      continue;
    }

    skills.push({ ...parsed.data, body: split.body, path });
  }

  // Two files claiming one id is an ambiguity, not a versioning scheme — the same reasoning
  // the capability catalog applies. Both are refused rather than one winning by filename.
  const byId = new Map<string, Skill[]>();
  for (const skill of skills) byId.set(skill.id, [...(byId.get(skill.id) ?? []), skill]);

  const unique: Skill[] = [];
  for (const [id, group] of byId) {
    if (group.length === 1) {
      unique.push(group[0]!);
      continue;
    }
    for (const duplicate of group) {
      invalid.push({
        path: duplicate.path,
        reason: `duplicate skill id "${id}" — also declared by ${group
          .filter((s) => s !== duplicate)
          .map((s) => s.path)
          .join(", ")}`,
      });
    }
  }

  return { skills: unique, invalid };
}

/**
 * The skills that apply to one recording run.
 *
 * Generic first, then surface, then application — narrowest last, so the most specific guidance
 * is the closest thing to the task in the prompt.
 */
export function selectSkills(
  skills: readonly Skill[],
  target: { surface: SurfaceKind; app: string },
): Skill[] {
  const rank = (scope: string): number =>
    scope === "generic" ? 0 : scope.startsWith("surface:") ? 1 : 2;

  return skills
    .filter(
      (skill) =>
        skill.scope === "generic" ||
        skill.scope === `surface:${target.surface}` ||
        skill.scope === `app:${target.app}`,
    )
    .sort((a, b) => rank(a.scope) - rank(b.scope) || a.id.localeCompare(b.id));
}

/** The selected skills as one prompt section, and the provenance to record on the artifact. */
export function renderSkills(skills: readonly Skill[]): {
  prompt: string;
  provenance: { id: string; version: string }[];
} {
  if (skills.length === 0) return { prompt: "", provenance: [] };

  const prompt = [
    "# Authoring guidance",
    "",
    "How to record a capability that will survive replay. This is guidance for you, now —",
    "it is not part of the capability you produce and nothing reads it at replay time.",
    "",
    ...skills.map((skill) => `## ${skill.title} (${skill.id} v${skill.version})\n\n${skill.body}`),
  ].join("\n");

  return {
    prompt,
    provenance: skills.map((skill) => ({ id: skill.id, version: skill.version })),
  };
}
