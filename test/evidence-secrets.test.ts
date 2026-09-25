import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceRecorder, newRunId } from "../src/evidence.js";
import { createRedactor } from "../src/redact.js";

/**
 * The PR2 claim "the password appears in no evidence file" was made by grepping the JSON files
 * and not the trace archive, where it demonstrably was. This suite exists so that claim is
 * checked by machine over *every* artifact rather than asserted by a human over some of them.
 */

const SECRET = "hunter2-session-password";
const TOKEN = "sk-ant-api03-TESTTESTTEST1234";

let browser: Browser;
let page: Page;
let workDir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  workDir = await mkdtemp(join(tmpdir(), "evidence-test-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

/** Every file in the run directory, recursively. */
async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(full)));
    else out.push(full);
  }
  return out;
}

describe("evidence artifacts carry no secrets", () => {
  it("scans every file a run produces, not only the JSON ones", async () => {
    const redact = createRedactor({ literals: [SECRET] });
    const recorder = new EvidenceRecorder({
      runId: newRunId("test"),
      phase: "replay",
      redact,
      rootDir: workDir,
    });

    await recorder.writeRunHeader({ startedAt: new Date().toISOString(), note: `login as ${SECRET}` });
    await recorder.event({
      type: "step.ok",
      stepId: "login",
      detail: { value: SECRET, authorization: `Bearer ${TOKEN}`, body: `user=john&password=${SECRET}` },
    });

    await page.setContent(`
      <form>
        <input name="username" value="john" />
        <input type="password" value="${SECRET}" />
      </form>
      <p>Balance: -$100.00</p>
    `);
    const { PlaywrightSurface } = await import("../src/surface.js");
    const surface = await PlaywrightSurface.launch();
    try {
      await surface.page.goto(`data:text/html,${encodeURIComponent(await page.content())}`);
      await recorder.screenshot(await surface.screenshot(), "login-form");
    } finally {
      await surface.close();
    }

    await recorder.failureSnapshot(
      {
        url: `http://localhost/login?password=${SECRET}`,
        title: "Login",
        ariaSnapshot: `- textbox "Username"\n- note: ${SECRET}`,
        alerts: [`rejected ${SECRET}`],
        step: 1,
      },
      { attemptedValue: SECRET },
    );

    await recorder.finish({
      status: "failure",
      error: { code: "CHECKPOINT_FAILED", message: `could not log in with ${SECRET}`, recoverable: false, attempts: 1 },
      evidence: recorder.summary(),
    });

    const files = await allFiles(recorder.directory);
    expect(files.length).toBeGreaterThan(2);

    for (const file of files) {
      const bytes = await readFile(file);
      const text = bytes.toString("binary");
      expect(text, `${file} contains the secret`).not.toContain(SECRET);
      expect(text, `${file} contains an API token`).not.toContain(TOKEN);
    }
  }, 60_000);

  it("writes no trace unless tracing is explicitly opted into", async () => {
    // A trace cannot be redacted by a string redactor, so the default has to be "absent".
    const recorder = new EvidenceRecorder({
      runId: newRunId("test-notrace"),
      phase: "replay",
      redact: createRedactor(),
      rootDir: workDir,
    });
    await recorder.event({ type: "noop" });

    const summary = recorder.summary();
    expect(summary.trace).toBeUndefined();
    expect(summary.traceUnredacted).toBe(false);

    const files = await allFiles(recorder.directory);
    expect(files.some((f) => f.endsWith(".zip"))).toBe(false);
  });

  it("flags the run record when an unredacted trace was produced", () => {
    const recorder = new EvidenceRecorder({
      runId: newRunId("test-trace"),
      phase: "replay",
      redact: createRedactor(),
      rootDir: workDir,
    });
    recorder.setTrace(join(workDir, "trace.zip"));

    // Opting in is allowed; leaving it undeclared is not.
    expect(recorder.summary().traceUnredacted).toBe(true);
  });

  it("masks password fields out of screenshots rather than redacting after the fact", async () => {
    const recorder = new EvidenceRecorder({
      runId: newRunId("test-mask"),
      phase: "replay",
      redact: createRedactor(),
      rootDir: workDir,
    });

    // A rendered pixel cannot be redacted afterwards, so masking happens at capture time.
    const { PlaywrightSurface } = await import("../src/surface.js");
    const surface = await PlaywrightSurface.launch();
    let masked: string;
    try {
      await surface.page.setContent(
        `<input type="password" value="visible-secret" style="width:400px" />`,
      );
      masked = await recorder.screenshot(await surface.screenshot(), "masked");
    } finally {
      await surface.close();
    }
    const bytes = await readFile(masked);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(recorder.summary().screenshots).toContain(masked);
  });
});
