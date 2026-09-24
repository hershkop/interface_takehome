import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
