/**
 * Development harness for the Surface / locator / evidence layer.
 *
 * Not the product CLI — `discover` and `replay` arrive with the engine. This exists so the
 * pieces in this PR can be exercised against the real application rather than only against
 * synthetic pages in tests, and so a reviewer can see an evidence directory for themselves.
 *
 *   npm run probe            headless
 *   npm run probe -- --headed
 */
import { config, defaultPolicy } from "../src/config.js";
import { PlaywrightSurface } from "../src/surface.js";
import { EvidenceRecorder, newRunId } from "../src/evidence.js";
import { createRedactor } from "../src/redact.js";
import { Condition, Target } from "../src/schema.js";

const headed = process.argv.includes("--headed");
const base = config.parabank.baseUrl;

const target = (description: string, candidates: unknown[]) =>
  Target.parse({ description, candidates });

/** Parse, never cast: schema defaults (notably Condition.visible) only exist after parsing. */
const cond = (c: unknown) => Condition.parse(c);

async function main(): Promise<void> {
  const policy = defaultPolicy();
  const runId = newRunId("probe");

  // The password is a literal the redactor scrubs, so it cannot reach the event log even though
  // the fill step legitimately receives it.
  const redact = createRedactor({
    literals: [config.parabank.password],
    patterns: policy.redactPatterns,
  });

  const recorder = new EvidenceRecorder({ runId, phase: "replay", redact });
  await recorder.writeRunHeader({ probe: true, baseUrl: base, startedAt: new Date().toISOString() });

  const surface = await PlaywrightSurface.launch({ headed, traceDir: recorder.directory });
  let failures = 0;

  const check = async (label: string, ok: boolean, detail?: Record<string, unknown>) => {
    if (!ok) failures++;
    process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${label}\n`);
    await recorder.event({ type: ok ? "probe.ok" : "probe.fail", stepId: label, detail });
  };

  try {
    // ── 1. Log in. Exercises fill + click through recorded locator candidates. ──
    await surface.navigate(`${base}/index.htm`);
    await surface.fill(
      target("username field", [
        { strategy: "role", role: "textbox", name: "Username" },
        { strategy: "css", value: 'input[name="username"]' },
      ]),
      config.parabank.username,
    );
    await surface.fill(
      target("password field", [{ strategy: "css", value: 'input[name="password"]' }]),
      config.parabank.password,
    );
    const login = await surface.click(
      target("log in button", [
        { strategy: "role", role: "button", name: "Log In" },
        { strategy: "css", value: 'input[value="Log In"]' },
      ]),
    );
    await check("login click resolved a unique control", login.ok, { error: login.error });

    await surface.waitFor(cond({ kind: "title", value: "Accounts Overview" }), 10_000);
    await check(
      "reached Accounts Overview",
      await surface.verify(cond({ kind: "title", value: "Accounts Overview" })),
    );
    await recorder.screenshot(surface.page, "overview");

    // ── 2. ARIA snapshot is non-trivial on a JS-rendered page. ──
    const observation = await surface.observe(1);
    await check("ARIA snapshot is populated", observation.ariaSnapshot.length > 200, {
      chars: observation.ariaSnapshot.length,
      alerts: observation.alerts.length,
    });
    process.stdout.write(
      `        snapshot ${observation.ariaSnapshot.length} chars, ${observation.alerts.length} visible alert(s)\n`,
    );

    // ── 3. The hidden-error trap, on the real page rather than a fixture. ──
    await surface.navigate(`${base}/activity.htm?id=12678`);
    const healthyPageLooksBroken = await surface.verify(
      cond({ kind: "text", value: "An internal error has occurred", visible: false }),
    );
    const healthyPageLooksHealthy = !(await surface.verify(
      cond({ kind: "text", value: "An internal error has occurred" }),
    ));
    await check("error text IS present in the DOM of a healthy page", healthyPageLooksBroken);
    await check("...and visible-only matching correctly ignores it", healthyPageLooksHealthy);

    // ── 4. The real business-outcome signal. ──
    await surface.navigate(`${base}/activity.htm?id=99999`);
    await check(
      "absent account shows 'Could not find account'",
      await surface.verify(cond({ kind: "text", value: "Could not find account" })),
    );
    await recorder.screenshot(surface.page, "account-not-found");

    // ── 5. Ambiguity is refused rather than guessed. ──
    const ambiguous = await surface.click(
      target("deliberately ambiguous", [{ strategy: "css", value: "a" }]),
    );
    await check("ambiguous target refused", ambiguous.errorCode === "TARGET_AMBIGUOUS", {
      errorCode: ambiguous.errorCode,
    });

    const missing = await surface.click(
      target("deliberately absent", [{ strategy: "css", value: "#does-not-exist" }]),
    );
    await check("absent target reported as not found", missing.errorCode === "TARGET_NOT_FOUND", {
      errorCode: missing.errorCode,
    });
  } finally {
    const trace = await surface.close();
    if (trace) recorder.setTrace(trace);
  }

  // No model was involved anywhere in this harness.
  await check("no model calls recorded", recorder.modelCallCount === 0);

  await recorder.finish({
    status: failures === 0 ? "success" : "failure",
    ...(failures === 0
      ? { outputs: {} }
      : { error: { code: "APP_ERROR" as const, message: `${failures} probe check(s) failed`, recoverable: false, attempts: 1 } }),
    evidence: recorder.summary(),
  } as never);

  process.stdout.write(`\nevidence: ${recorder.directory}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
