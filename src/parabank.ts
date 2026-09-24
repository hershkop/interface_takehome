/**
 * ParaBank-specific glue, kept out of the engine.
 *
 * The engine is application-neutral by design, but re-authentication is inherently
 * app-specific — there is no generic "log in again". Rather than let that leak into replay.ts,
 * the routine lives here and is injected at the CLI edge, which is the layer that already knows
 * which application it is pointed at.
 */
import { config } from "./config.js";
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

export async function loginToParabank(surface: PlaywrightSurface): Promise<boolean> {
  const navigated = await surface.navigate(`${config.parabank.baseUrl}/index.htm`);
  if (!navigated.ok) return false;

  if (!(await surface.fill(usernameField, config.parabank.username)).ok) return false;
  if (!(await surface.fill(passwordField, config.parabank.password)).ok) return false;
  if (!(await surface.click(loginButton)).ok) return false;

  return surface.verify({ kind: "title", value: "Accounts Overview" });
}
