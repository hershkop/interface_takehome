/**
 * Desktop helpers the console is allowed to launch.
 *
 * The console can already start a browser and spend money on a model, so it is not a read-only
 * surface — but running an arbitrary command is a different magnitude of thing, and this file
 * exists to make sure the browser never gets to choose one.
 *
 * **The command comes from here, never from the request.** The page sends a *name*; the server
 * looks it up in this file. A `POST /api/replay` carrying `{"command": "rm -rf ~"}` has nothing
 * to act on. That matters more than it looks: this console binds to 127.0.0.1 with no
 * authentication, and a localhost port with no auth is reachable by any page the operator has
 * open — so an endpoint that ran a supplied command would turn "a web page you visited" into
 * "code on your machine".
 *
 * Helpers are declared in `helpers.json`, which is a deployment concern: whoever installs the
 * platform helper for this machine writes the entry, and that decision is reviewable in git
 * rather than typed into a form.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const DesktopHelperEntry = z.object({
  /** Referenced by the page. Lower-kebab-case so it is unambiguous in a URL or a form. */
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lower-kebab-case"),
  title: z.string().min(1),
  description: z.string().default(""),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Policy file governing runs driven by this helper.
   *
   * Declared here because it is the same kind of decision: whoever installs a platform helper
   * for this machine also decides which applications and documents it may touch. Without it
   * the console would fall back to its web policy, which allows no applications at all — so a
   * desktop run would be refused for a reason that reads like a bug rather than a decision.
   */
  policy: z.string().optional(),
  /**
   * The `target.app` this helper drives. Omitted, it is offered for any desktop capability.
   *
   * Without it the console offers every helper for every desktop capability, and picking the
   * spreadsheet helper for the banking capability produces a puzzle rather than a run — the
   * helper answers "no such application" for a choice the console should not have offered.
   */
  app: z.string().optional(),
  /**
   * Where a run starts: the `app://` location of the application this helper drives.
   *
   * Needed for *recording*, not replay — a replay reads its entry point from the artifact,
   * while a recording is producing one and has to be told where to begin. Declared here for
   * the same reason as the command: the page must not be able to name an application.
   */
  baseUrl: z.string().optional(),
});
export type DesktopHelperEntry = z.infer<typeof DesktopHelperEntry>;

export const HelperFile = z.object({ helpers: z.array(DesktopHelperEntry).default([]) });

export async function loadHelpers(
  path = "helpers.json",
): Promise<{ helpers: DesktopHelperEntry[]; invalid: string | undefined }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    // A missing file is the ordinary case — most installations have no desktop helper at all,
    // and the console simply offers none rather than treating it as a fault.
    const message = err instanceof Error ? err.message : String(err);
    return { helpers: [], invalid: message.includes("ENOENT") ? undefined : message };
  }

  const parsed = HelperFile.safeParse(raw);
  if (!parsed.success) {
    return {
      helpers: [],
      invalid: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  // Two entries claiming one name is an ambiguity, and the same reasoning the capability
  // catalog applies: refusing both beats letting file order decide which command runs.
  const seen = new Set<string>();
  const unique = parsed.data.helpers.filter((h) => {
    if (seen.has(h.name)) return false;
    seen.add(h.name);
    return true;
  });

  return { helpers: unique, invalid: undefined };
}
