import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay } from "../src/replay.js";
import { Policy } from "../src/schema.js";

/**
 * These run against local fixture pages rather than ParaBank, so the classification rules are
 * pinned independently of one application's behaviour. The ParaBank runs are the end-to-end
 * proof; these are the contract.
 */

let dir: string;
let base: string;
let origin: string;
let evidenceRoot: string;
let server: Server;

/**
 * Fixtures are served over HTTP rather than file://, because the policy allowlist only accepts
 * http(s) origins — deliberately, since an origin allowlist that accepted file: or data: would
 * not be a safety boundary. Serving them makes the tests exercise the same path production does.
 */
function startFixtureServer(root: string): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const name = (req.url ?? "/").split("?")[0]!.replace(/^\//, "") || "index.html";
      readFile(join(root, name), "utf8").then(
        (body) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(body);
        },
        () => {
          res.writeHead(404, { "content-type": "text/html" });
          res.end("<h1>not found</h1>");
        },
      );
    });
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server: s, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/** Permissive by default; individual tests tighten it to prove enforcement. */
function testPolicy(over: Record<string, unknown> = {}) {
  return Policy.parse({ allowedOrigins: [origin], ...over });
}

async function fixture(name: string, body: string): Promise<void> {
  await writeFile(join(dir, name), `<!doctype html><title>Fixture</title>${body}`, "utf8");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-fixtures-"));
  evidenceRoot = await mkdtemp(join(tmpdir(), "replay-evidence-"));
  const started = await startFixtureServer(dir);
  server = started.server;
  origin = started.origin;
  base = origin;

  await fixture("detail.html", `<h1>Account Details</h1><span id="balance">-$100.00</span><span id="type">SAVINGS</span>`);
  await fixture("notfound.html", `<h1>Error!</h1><p>Could not find account # 99999</p>`);
  await fixture("ambiguous.html", `<button>Go</button><button>Go</button>`);
  await fixture("empty.html", `<p>nothing to see</p>`);
  await fixture("offsite-link.html", `
    <h1>Account Details</h1>
    <span id="balance">-$100.00</span>
    <a id="leave" href="https://example.com/">Continue to partner site</a>`);
  await fixture("slow-confirm.html", `
    <h1>Transfer</h1>
    <button id="submit">Submit Transfer</button>
    <p id="count">submissions: 0</p>
    <p id="confirm" style="display:none">Transfer Complete</p>
    <script>
      let n = 0;
      document.getElementById('submit').addEventListener('click', () => {
        n++;
        document.getElementById('count').textContent = 'submissions: ' + n;
        // Confirmation appears only after a delay — or, past the timeout, never.
        setTimeout(() => {
          document.getElementById('confirm').style.display = 'block';
        }, 900);
      });
    </script>`);
  await fixture("never-confirms.html", `
    <h1>Transfer</h1>
    <button id="submit">Submit Transfer</button>
    <p id="count">submissions: 0</p>
    <script>
      let n = 0;
      document.getElementById('submit').addEventListener('click', () => {
        n++;
        document.getElementById('count').textContent = 'submissions: ' + n;
      });
    </script>`);
  await fixture("double-submit.html", `
    <h1>Transfer</h1>
    <button id="submit">Submit Transfer</button>
    <p id="count">submissions: 0</p>
    <div id="notice" style="display:none">Session notice</div>
    <button id="ok" style="display:none">Continue</button>
    <span id="balance" style="display:none">-$100.00</span>
    <script>
      let n = 0;
      document.getElementById('submit').addEventListener('click', () => {
        n++;
        document.getElementById('count').textContent = 'submissions: ' + n;
        // The interstitial appears only AFTER a successful submit.
        document.getElementById('notice').style.display = 'block';
        document.getElementById('ok').style.display = 'inline';
      });
      document.getElementById('ok').addEventListener('click', () => {
        document.getElementById('notice').remove();
        document.getElementById('ok').remove();
        document.getElementById('balance').style.display = 'inline';
      });
    </script>`);
  await fixture("dialog.html", `
    <div id="modal"><p>Session notice</p><button id="ok">Continue</button></div>
    <h1 id="content" style="display:none">Account Details</h1>
    <span id="balance" style="display:none">-$100.00</span>
    <script>
      document.getElementById('ok').addEventListener('click', () => {
        document.getElementById('modal').remove();
        document.getElementById('content').style.display = 'block';
        document.getElementById('balance').style.display = 'inline';
      });
    </script>`);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
  await rm(evidenceRoot, { recursive: true, force: true });
});

/** A minimal artifact; each test overrides what it needs. */
function artifact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    capabilityId: "fixture_capability",
    version: "1.0.0",
    metadata: {
      name: "Fixture",
      description: "Fixture capability",
      status: "approved",
      risk: "safe",
      recordedAt: "2026-09-24T00:00:00.000Z",
      recordedBy: "human",
    },
    target: { app: "fixture", baseUrl: "http://replaced.test" },
    inputs: { page: { type: "string" } },
    outputs: {
      balance: {
        type: "number",
        source: { kind: "variable", name: "balanceText" },
        coerce: "currency",
      },
    },
    steps: [
      { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
      {
        id: "read",
        action: {
          action: "extract",
          as: "balanceText",
          target: { candidates: [{ strategy: "css", value: "#balance" }] },
        },
      },
    ],
    handlers: [
      {
        id: "not_found",
        match: { kind: "text", value: "Could not find account" },
        scope: "global",
        disposition: {
          kind: "business_outcome",
          outcome: "account_not_found",
          detail: { requested: "{{inputs.page}}" },
        },
      },
    ],
    checkpoint: { kind: "text", value: "Account Details" },
    ...over,
  };
}

const run = (over: Record<string, unknown>, inputs: Record<string, unknown>) =>
  replay({ artifact: artifact(over), inputs, baseUrl: base, evidenceRoot, policy: testPolicy() });

describe("replay — the four statuses", () => {
  it("returns success with coerced typed outputs", async () => {
    const result = await run({}, { page: "detail.html" });
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs).toEqual({ balance: -100 });
  }, 60_000);

  it("returns a business outcome, not a failure, when the app answers the question", async () => {
    // The single most important classification in the system. "No such account" is a result
    // the caller needs, and reporting it as a crash is the design mistake the brief calls out.
    const result = await run({}, { page: "notfound.html" });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("account_not_found");
      expect(result.detail).toEqual({ requested: "notfound.html" });
    }
  }, 60_000);

  it("returns a hard failure when the checkpoint is not met", async () => {
    const result = await run(
      {
        outputs: {},
        steps: [{ id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } }],
      },
      { page: "empty.html" },
    );
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("CHECKPOINT_FAILED");
      expect(result.error.expected).toBeDefined();
    }
  }, 60_000);

  it("escalates rather than guessing when a step needs approval and no operator is wired", async () => {
    // Not finished, not failed, no outcome. `escalated` is the only honest answer.
    const result = await run(
      {
        outputs: {},
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "risky",
            risk: "approval_required",
            action: {
              action: "click",
              target: { candidates: [{ strategy: "css", value: "#nothing" }] },
            },
          },
        ],
      },
      { page: "detail.html" },
    );
    expect(result.status).toBe("escalated");
    if (result.status === "escalated") {
      expect(result.intervention.reason).toBe("approval_required");
      expect(result.intervention.resumeToken).toBeTruthy();
    }
  }, 60_000);
});

describe("replay — refusals and classification", () => {
  it("refuses an ambiguous target rather than clicking one of them", async () => {
    const result = await run(
      {
        outputs: {},
        checkpoint: { kind: "text", value: "Go" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "click",
            action: { action: "click", target: { candidates: [{ strategy: "css", value: "button" }] } },
          },
        ],
      },
      { page: "ambiguous.html" },
    );
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("TARGET_AMBIGUOUS");
  }, 60_000);

  it("reports a missing target distinctly from an ambiguous one", async () => {
    const result = await run(
      {
        outputs: {},
        checkpoint: { kind: "text", value: "nothing" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "click",
            action: { action: "click", target: { candidates: [{ strategy: "css", value: "#absent" }] } },
          },
        ],
      },
      { page: "empty.html" },
    );
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("TARGET_NOT_FOUND");
  }, 60_000);

  it("names the failing step so a failure is debuggable", async () => {
    const result = await run(
      {
        outputs: {},
        checkpoint: { kind: "text", value: "nothing" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "the_bad_step",
            action: { action: "click", target: { candidates: [{ strategy: "css", value: "#absent" }] } },
          },
        ],
      },
      { page: "empty.html" },
    );
    if (result.status === "failure") {
      expect(result.error.step?.id).toBe("the_bad_step");
      expect(result.error.step?.index).toBe(1);
    }
  }, 60_000);
});

describe("replay — recovery", () => {
  it("dismisses a known interstitial and continues", async () => {
    const result = await run(
      {
        handlers: [
          {
            id: "dismiss_notice",
            match: { kind: "text", value: "Session notice" },
            scope: "global",
            disposition: {
              kind: "recover",
              remedy: "dismiss",
              target: { candidates: [{ strategy: "css", value: "#ok" }] },
              maxAttempts: 2,
            },
          },
        ],
      },
      { page: "dialog.html" },
    );
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs).toEqual({ balance: -100 });
  }, 60_000);

  it("gives up once a recovery exhausts its cap instead of looping", async () => {
    // The interstitial never goes away: the remedy targets something that does not dismiss it.
    const result = await run(
      {
        outputs: {},
        handlers: [
          {
            id: "dismiss_notice",
            match: { kind: "text", value: "Session notice" },
            scope: "global",
            disposition: {
              kind: "recover",
              remedy: "dismiss",
              target: { candidates: [{ strategy: "css", value: "#modal p" }] },
              maxAttempts: 2,
            },
          },
        ],
      },
      { page: "dialog.html" },
    );
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.message).toContain("exhausted");
  }, 60_000);

  it("never re-executes a step that already succeeded (no double-submit)", async () => {
    // The safety-critical half of recovery. An interstitial that appears AFTER a successful
    // click must be cleared and the run continued — not cause the click to be repeated. On a
    // funds transfer, repeating it is a second transfer.
    const result = await run(
      {
        checkpoint: { kind: "text", value: "submissions: 1" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "submit",
            action: {
              action: "click",
              target: { candidates: [{ strategy: "css", value: "#submit" }] },
            },
          },
          {
            id: "read",
            action: {
              action: "extract",
              as: "balanceText",
              target: { candidates: [{ strategy: "css", value: "#balance" }] },
            },
          },
        ],
        handlers: [
          {
            id: "dismiss_notice",
            match: { kind: "text", value: "Session notice" },
            scope: "global",
            disposition: {
              kind: "recover",
              remedy: "dismiss",
              target: { candidates: [{ strategy: "css", value: "#ok" }] },
              maxAttempts: 3,
            },
          },
        ],
      },
      { page: "double-submit.html" },
    );

    // The checkpoint asserts exactly one submission. Re-running the click would make it two
    // and the checkpoint would fail.
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.outputs).toEqual({ balance: -100 });
  }, 60_000);

  it("fails with the artifact's declared code when a fail handler matches", async () => {
    const result = await run(
      {
        outputs: {},
        handlers: [
          {
            id: "app_broke",
            match: { kind: "text", value: "Could not find account" },
            scope: "global",
            disposition: { kind: "fail", code: "APP_ERROR" },
          },
        ],
      },
      { page: "notfound.html" },
    );
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("APP_ERROR");
  }, 60_000);
});

describe("replay — validation before the browser opens", () => {
  it("rejects an input that fails its declared pattern", async () => {
    const result = await replay({
      artifact: artifact({ inputs: { page: { type: "string", pattern: "^[a-z]+\\.html$" } } }),
      inputs: { page: "../etc/passwd" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("INPUT_INVALID");
  });

  it("rejects an input the capability does not declare", async () => {
    // Almost always a typo in a declared name, which would otherwise read as "missing".
    const result = await replay({
      artifact: artifact(),
      inputs: { page: "detail.html", accountID: "12678" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.message).toContain("unknown input");
  });

  it("rejects a malformed artifact distinctly from a bad invocation", async () => {
    const result = await replay({ artifact: { schemaVersion: "1.0" }, inputs: {}, evidenceRoot, policy: testPolicy() });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("ARTIFACT_INVALID");
  });

  it("refuses to start when a referenced secret was not supplied", async () => {
    const result = await replay({
      artifact: artifact({
        steps: [
          {
            id: "open",
            action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}?t={{secrets.apiToken}}" },
          },
        ],
        outputs: {},
      }),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.message).toContain("apiToken");
  });
});

describe("replay — no model in the decision loop", () => {
  it("records zero model calls on every path", async () => {
    for (const page of ["detail.html", "notfound.html"]) {
      const result = await run({}, { page });
      expect(result.evidence.modelCalls, page).toBe(0);
    }
  }, 60_000);

  it("produces identical outputs across repeated runs", async () => {
    // Determinism is the product claim; this is the cheapest possible check of it.
    const first = await run({}, { page: "detail.html" });
    const second = await run({}, { page: "detail.html" });
    expect(first.status).toBe("success");
    expect(second.status).toBe(first.status);
    if (first.status === "success" && second.status === "success") {
      expect(second.outputs).toEqual(first.outputs);
    }
  }, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions from PR3 review.
// ─────────────────────────────────────────────────────────────────────────────

describe("capability-level risk is inherited (review #1)", () => {
  it("escalates a step with no risk of its own when the capability requires approval", async () => {
    // metadata.risk was written into run.json and then never consulted. A capability marked
    // approval_required executed unattended whenever its steps happened not to restate it,
    // which is the documented inheritance rule doing precisely nothing.
    const result = await run(
      {
        metadata: {
          name: "Risky",
          description: "Capability-level risk only",
          status: "approved",
          risk: "approval_required",
          recordedAt: "2026-09-24T00:00:00.000Z",
          recordedBy: "human",
        },
        outputs: {},
      },
      { page: "detail.html" },
    );
    expect(result.status).toBe("escalated");
  }, 60_000);

  it("lets a step override the capability's classification downward", async () => {
    const result = await run(
      {
        metadata: {
          name: "Risky",
          description: "Capability risky, step explicitly safe",
          status: "approved",
          risk: "approval_required",
          recordedAt: "2026-09-24T00:00:00.000Z",
          recordedBy: "human",
        },
        steps: [
          { id: "open", risk: "safe", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "read",
            risk: "safe",
            action: {
              action: "extract",
              as: "balanceText",
              target: { candidates: [{ strategy: "css", value: "#balance" }] },
            },
          },
        ],
      },
      { page: "detail.html" },
    );
    expect(result.status).toBe("success");
  }, 60_000);

  it("refuses outright when the capability is classified blocked", async () => {
    const result = await run(
      {
        metadata: {
          name: "Blocked",
          description: "Never executes",
          status: "approved",
          risk: "blocked",
          recordedAt: "2026-09-24T00:00:00.000Z",
          recordedBy: "human",
        },
        outputs: {},
      },
      { page: "detail.html" },
    );
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("POLICY_DENIED");
  }, 60_000);
});

describe("inputs declared sensitive are redacted (review #2)", () => {
  it("keeps a sensitive input out of every evidence file", async () => {
    // `sensitive: true` existed in the schema and was read by nothing, so an artifact author
    // declaring a value regulated got no protection at all. A field that makes a promise the
    // system does not keep is worse than no field.
    const secretAccount = "9876543210";
    const result = await replay({
      artifact: artifact({
        inputs: { page: { type: "string" }, ssn: { type: "string", sensitive: true } },
        outputs: {},
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "type_it",
            action: {
              action: "assert",
              condition: { kind: "text", value: "Account Details" },
            },
          },
        ],
      }),
      inputs: { page: "detail.html", ssn: secretAccount },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
    });
    expect(result.status).toBe("success");

    const files = await readdir(result.evidence.directory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(join(result.evidence.directory, file), "utf8");
      expect(text, `${file} leaked the sensitive input`).not.toContain(secretAccount);
    }
  }, 60_000);
});

describe("a successful action is never repeated for its postcondition (review #3)", () => {
  it("waits for a delayed confirmation instead of re-clicking", async () => {
    const result = await run(
      {
        outputs: {},
        checkpoint: { kind: "text", value: "submissions: 1" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "submit",
            action: { action: "click", target: { candidates: [{ strategy: "css", value: "#submit" }] } },
            postcondition: { kind: "text", value: "Transfer Complete" },
            retry: { maxAttempts: 3, delayMs: 100 },
          },
        ],
        handlers: [],
      },
      { page: "slow-confirm.html" },
    );
    // The confirmation arrives at ~900ms; polling finds it, and exactly one submission happened.
    expect(result.status).toBe("success");
  }, 60_000);

  it("stops rather than re-submitting when the confirmation never arrives", async () => {
    // The dangerous case. retry says 3 attempts, but the action already took effect, so
    // repeating it would submit three transfers to satisfy a postcondition.
    const result = await replay({
      artifact: artifact({
        outputs: {},
        checkpoint: { kind: "text", value: "submissions: 1" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "submit",
            action: { action: "click", target: { candidates: [{ strategy: "css", value: "#submit" }] } },
            postcondition: { kind: "text", value: "Transfer Complete" },
            retry: { maxAttempts: 3, delayMs: 100 },
          },
        ],
        handlers: [],
      }),
      inputs: { page: "never-confirms.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
      postconditionTimeoutMs: 800,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("CHECKPOINT_FAILED");
      expect(result.error.step?.id).toBe("submit");
    }

    // The proof that it did not retry: the page still reports a single submission.
    const events = await readFile(join(result.evidence.directory, "events.jsonl"), "utf8");
    expect(events).not.toContain("postcondition_retry");
  }, 60_000);

  it("still retries an idempotent action whose postcondition is unmet", async () => {
    // Re-navigating is safe, so the retry budget is honoured for it.
    const result = await replay({
      artifact: artifact({
        outputs: {},
        checkpoint: { kind: "text", value: "nothing" },
        steps: [
          {
            id: "open",
            action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" },
            postcondition: { kind: "text", value: "never appears" },
            retry: { maxAttempts: 2, delayMs: 50 },
          },
        ],
        handlers: [],
      }),
      inputs: { page: "empty.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
      postconditionTimeoutMs: 300,
    });
    expect(result.status).toBe("failure");
    const events = await readFile(join(result.evidence.directory, "events.jsonl"), "utf8");
    expect(events).toContain("postcondition_retry");
  }, 60_000);
});

describe("lifecycle (review #5, #6)", () => {
  it("reports the trace on a SUCCESSFUL traced run", async () => {
    // The success result used to be assembled inside the try, before the finally block stopped
    // tracing — so a successful --trace run claimed traceUnredacted:false next to a trace.zip
    // that existed on disk.
    const result = await replay({
      artifact: artifact(),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
      trace: "unredacted",
    });
    expect(result.status).toBe("success");
    expect(result.evidence.traceUnredacted).toBe(true);
    expect(result.evidence.trace).toBeTruthy();

    const files = await readdir(result.evidence.directory);
    expect(files).toContain("trace.zip");
  }, 60_000);

  it("turns a browser launch failure into a structured result, not a rejection", async () => {
    // A caller consuming --json must never receive an unhandled exception.
    const result = await replay({
      artifact: artifact(),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
      // No Chromium build exists at this path, so launch throws inside the guarded lifecycle.
      executablePath: "/nonexistent/chromium-binary",
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("APP_ERROR");
    expect(result.evidence.directory).toBeTruthy();
  }, 60_000);
});

describe("reauthentication stays on the invocation's tenant (review #4)", () => {
  it("passes the run's baseUrl and secrets to the callback, not process config", async () => {
    // After a session expiry, a callback reaching for global configuration would log back in to
    // the DEFAULT tenant and the run would continue returning another institution's data —
    // failing as a *successful* run, which is the worst shape a data-segregation bug can take.
    const seen: Array<{ baseUrl: string; secrets: Record<string, string> }> = [];

    await replay({
      artifact: artifact({
        outputs: {},
        checkpoint: { kind: "text", value: "Account Details" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "read",
            action: {
              action: "assert",
              condition: { kind: "text", value: "Account Details" },
            },
          },
        ],
        handlers: [
          {
            id: "session_expired",
            // The fixture always looks "expired" so the remedy is guaranteed to fire once.
            match: { kind: "text", value: "Could not find account" },
            scope: "global",
            disposition: { kind: "recover", remedy: "reauthenticate", maxAttempts: 1 },
          },
        ],
      }),
      inputs: { page: "notfound.html" },
      baseUrl: base,
      secrets: { parabankUsername: "tenant-b-user", parabankPassword: "tenant-b-pass" },
      evidenceRoot,
      policy: testPolicy(),
      reauthenticate: async (_surface, context) => {
        seen.push({ baseUrl: context.baseUrl, secrets: context.secrets });
        return true;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.baseUrl).toBe(base);
    expect(seen[0]?.secrets.parabankUsername).toBe("tenant-b-user");
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// PR4: policy enforcement, end to end through a real browser.
// ─────────────────────────────────────────────────────────────────────────────

describe("policy enforcement", () => {
  it("refuses a navigate whose resolved destination is off the allowlist", async () => {
    const result = await replay({
      artifact: artifact({ outputs: {} }),
      inputs: { page: "detail.html" },
      baseUrl: "http://127.0.0.1:1/",
      evidenceRoot,
      policy: testPolicy(),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("POLICY_DENIED");
      expect(result.error.message).toContain("not in the allowlist");
    }
  }, 60_000);

  it("refuses a route outside the allowed paths", async () => {
    const result = await replay({
      artifact: artifact({ outputs: {} }),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy({ allowedPaths: ["/allowed/**"] }),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("POLICY_DENIED");
      expect(result.error.message).toContain("does not match any allowed route");
    }
  }, 60_000);

  it("refuses an action type the policy blocks", async () => {
    const result = await replay({
      artifact: artifact(),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy({ blockedActions: ["extract"] }),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("POLICY_DENIED");
      expect(result.error.step?.id).toBe("read");
    }
  }, 60_000);

  it("blocks a click that would leave the allowlist, in the browser", async () => {
    // The advisory layer structurally cannot catch this: the engine is told "click a link", not
    // where the link goes. Only the browser-level guard can refuse it, and it must be treated
    // as a denial even though the click itself succeeded.
    const result = await replay({
      artifact: artifact({
        outputs: {},
        checkpoint: { kind: "text", value: "Account Details" },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          {
            id: "leave",
            action: { action: "click", target: { candidates: [{ strategy: "css", value: "#leave" }] } },
          },
        ],
        handlers: [],
      }),
      inputs: { page: "offsite-link.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("POLICY_DENIED");
      expect(result.error.message).toContain("example.com");
    }

    const events = await readFile(join(result.evidence.directory, "events.jsonl"), "utf8");
    expect(events).toContain("policy.navigation_blocked");
  }, 60_000);

  it("refuses an artifact longer than the step ceiling before launching a browser", async () => {
    const started = Date.now();
    const result = await replay({
      artifact: artifact(),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy({ maxSteps: 1 }),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.error.code).toBe("POLICY_DENIED");
      expect(result.error.message).toContain("steps but policy allows");
    }
    // No browser was launched, so this is fast.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("applies policy redact patterns on top of the built-in rules", async () => {
    // A tenant adding its own identifier format must not lose SSN or API-key scrubbing.
    const result = await replay({
      artifact: artifact({
        outputs: {},
        inputs: { page: { type: "string" }, ref: { type: "string" } },
        steps: [
          { id: "open", action: { action: "navigate", url: "{{baseUrl}}/{{inputs.page}}" } },
          { id: "check", action: { action: "assert", condition: { kind: "text", value: "Account Details" } } },
        ],
        handlers: [],
      }),
      inputs: { page: "detail.html", ref: "CUST-4815162342" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy({ redactPatterns: ["CUST-\\d+"] }),
    });
    expect(result.status).toBe("success");

    const header = await readFile(join(result.evidence.directory, "run.json"), "utf8");
    expect(header).not.toContain("CUST-4815162342");
    expect(header).toContain("[REDACTED]");
  }, 60_000);

  it("records the policy that governed the run", async () => {
    // Evidence has to say what the rules were, or a later reader cannot tell whether a denial
    // was correct.
    const result = await run({}, { page: "detail.html" });
    const header = JSON.parse(await readFile(join(result.evidence.directory, "run.json"), "utf8"));
    expect(header.policy.allowedOrigins).toEqual([origin]);
  }, 60_000);
});

describe("policy decides what needs a human (PR4)", () => {
  it("gates a safe step when the tenant's policy is cautious", async () => {
    const result = await replay({
      artifact: artifact({ outputs: {} }),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy({ requireApprovalFor: ["safe", "approval_required"] }),
    });
    expect(result.status).toBe("escalated");
  }, 60_000);

  it("lets a permissive policy run an approval_required capability unattended", async () => {
    // The same artifact that escalates under the default policy completes under this one.
    // Hardcoding "approval_required" in the engine would have made the field decorative.
    const risky = {
      metadata: {
        name: "Risky",
        description: "Capability-level risk",
        status: "approved",
        risk: "approval_required",
        recordedAt: "2026-09-24T00:00:00.000Z",
        recordedBy: "human",
      },
    };
    const escalated = await replay({
      artifact: artifact({ ...risky, outputs: {} }),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy(),
    });
    expect(escalated.status).toBe("escalated");

    const permitted = await replay({
      artifact: artifact(risky),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy({ requireApprovalFor: [] }),
    });
    expect(permitted.status).toBe("success");
  }, 60_000);

  it("never executes a blocked capability, whatever the policy says", async () => {
    // "blocked" is absolute. A policy cannot opt into running it.
    const result = await replay({
      artifact: artifact({
        metadata: {
          name: "Blocked",
          description: "Never runs",
          status: "approved",
          risk: "blocked",
          recordedAt: "2026-09-24T00:00:00.000Z",
          recordedBy: "human",
        },
        outputs: {},
      }),
      inputs: { page: "detail.html" },
      baseUrl: base,
      evidenceRoot,
      policy: testPolicy({ requireApprovalFor: [] }),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.code).toBe("POLICY_DENIED");
  }, 60_000);
});
