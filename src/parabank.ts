/**
 * ParaBank-specific glue, kept out of the engine.
 *
 * The engine is application-neutral by design, but re-authentication is inherently
 * app-specific — there is no generic "log in again". Rather than let that leak into replay.ts,
 * the routine lives here and is injected at the CLI edge, which is the layer that already knows
 * which application it is pointed at.
 */
import { Target } from "./schema.js";
import type { PlaywrightSurface } from "./surface.js";

const usernameField = Target.parse({
  description: "Username field",
  candidates: [
    { strategy: "role", role: "textbox", name: "Username" },
    { strategy: "css", value: "input[name='username']" },
  ],
});

const passwordField = Target.parse({
  description: "Password field",
  candidates: [{ strategy: "css", value: "input[name='password']" }],
});

const loginButton = Target.parse({
  description: "Log In button",
  candidates: [
    { strategy: "role", role: "button", name: "Log In" },
    { strategy: "css", value: "input[value='Log In']" },
  ],
});

/**
 * Re-authenticate against the tenant THIS RUN is pointed at.
 *
 * Everything here comes from the invocation, never from global configuration. Reading
 * `config.parabank.baseUrl` would mean that a run started with `--base-url` pointing at tenant
 * B, on hitting a session expiry, would log back in to tenant A and carry on returning the
 * wrong institution's account data — a correctness and data-segregation failure that would look
 * like a successful run.
 */
export async function loginToParabank(
  surface: PlaywrightSurface,
  context: { baseUrl: string; secrets: Record<string, string> },
): Promise<boolean> {
  const username = context.secrets.parabankUsername;
  const password = context.secrets.parabankPassword;
  if (!username || !password) return false;

  const navigated = await surface.navigate(`${context.baseUrl}/index.htm`);
  if (!navigated.ok) return false;

  if (!(await surface.fill(usernameField, username)).ok) return false;
  if (!(await surface.fill(passwordField, password)).ok) return false;
  if (!(await surface.click(loginButton)).ok) return false;

  return surface.verify({ kind: "title", value: "Accounts Overview" });
}
