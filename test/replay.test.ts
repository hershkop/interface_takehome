import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { replay } from "../src/replay.js";

/**
 * These run against local fixture pages rather than ParaBank, so the classification rules are
 * pinned independently of one application's behaviour. The ParaBank runs are the end-to-end
 * proof; these are the contract.
 */

let dir: string;
let base: string;
let evidenceRoot: string;

async function fixture(name: string, body: string): Promise<void> {
  await writeFile(join(dir, name), `<!doctype html><title>Fixture</title>${body}`, "utf8");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-fixtures-"));
  evidenceRoot = await mkdtemp(join(tmpdir(), "replay-evidence-"));
  base = pathToFileURL(dir).href;

  await fixture("detail.html", `<h1>Account Details</h1><span id="balance">-$100.00</span><span id="type">SAVINGS</span>`);
  await fixture("notfound.html", `<h1>Error!</h1><p>Could not find account # 99999</p>`);
  await fixture("ambiguous.html", `<button>Go</button><button>Go</button>`);
  await fixture("empty.html", `<p>nothing to see</p>`);
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
  replay({ artifact: artifact(over), inputs, baseUrl: base, evidenceRoot });

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
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.error.message).toContain("unknown input");
  });

  it("rejects a malformed artifact distinctly from a bad invocation", async () => {
    const result = await replay({ artifact: { schemaVersion: "1.0" }, inputs: {}, evidenceRoot });
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
