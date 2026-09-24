import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveTarget, explainFailure, describeCandidate } from "../src/locator.js";
import { Target } from "../src/schema.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const target = (candidates: unknown[]) => Target.parse({ candidates });

describe("resolveTarget", () => {
  it("resolves a role+name candidate to exactly one element", async () => {
    await page.setContent(`<button>Transfer</button><button>Cancel</button>`);
    const r = await resolveTarget(page, target([{ strategy: "role", role: "button", name: "Transfer" }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(await r.locator.innerText()).toBe("Transfer");
  });

  it("reports not_found when nothing matches", async () => {
    await page.setContent(`<button>Cancel</button>`);
    const r = await resolveTarget(page, target([{ strategy: "role", role: "button", name: "Transfer" }]), {
      timeoutMs: 500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("reports ambiguous when several visible elements match, and never picks one", async () => {
    // The failure mode that matters most: three identical Delete buttons. Choosing the first
    // would act on the wrong record and report success.
    await page.setContent(`<button>Delete</button><button>Delete</button><button>Delete</button>`);
    const r = await resolveTarget(page, target([{ strategy: "role", role: "button", name: "Delete" }]), {
      timeoutMs: 500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous");
  });

  it("ignores matches that are present but not visible", async () => {
    // DAY0-FINDINGS §3: ParaBank keeps error markup in the DOM of healthy pages. Counting DOM
    // matches rather than visible ones would resolve to controls no operator can see.
    await page.setContent(`
      <button style="display:none">Transfer</button>
      <button>Transfer</button>
    `);
    const r = await resolveTarget(page, target([{ strategy: "role", role: "button", name: "Transfer" }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(await r.locator.isVisible()).toBe(true);
  });

  it("treats an all-hidden match as not found", async () => {
    await page.setContent(`<button style="display:none">Transfer</button>`);
    const r = await resolveTarget(page, target([{ strategy: "role", role: "button", name: "Transfer" }]), {
      timeoutMs: 500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("falls through to a later candidate when the first finds nothing", async () => {
    await page.setContent(`<input id="amount" />`);
    const r = await resolveTarget(
      page,
      target([
        { strategy: "role", role: "textbox", name: "Amount" },
        { strategy: "css", value: "#amount" },
      ]),
      { timeoutMs: 500 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidateIndex).toBe(1);
  });

  it("falls through when an earlier candidate is ambiguous, rather than guessing", async () => {
    await page.setContent(`
      <button class="go">Submit</button>
      <button class="go">Submit</button>
      <button id="primary">Submit</button>
    `);
    const r = await resolveTarget(
      page,
      target([
        { strategy: "css", value: "button.go" },
        { strategy: "css", value: "#primary" },
      ]),
      { timeoutMs: 500 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidateIndex).toBe(1);
  });

  it("prefers ambiguous over not_found when reporting, since they need different fixes", async () => {
    // An ambiguous target means the recorded flow is under-specified. A not-found target means
    // the page is not where we expected. Conflating them sends the reader down the wrong path.
    await page.setContent(`<button>Go</button><button>Go</button>`);
    const r = await resolveTarget(
      page,
      target([
        { strategy: "role", role: "button", name: "Go" },
        { strategy: "css", value: "#nope" },
      ]),
      { timeoutMs: 500 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous");
  });

  it("refuses to resolve a coordinate candidate at all", async () => {
    await page.setContent(`<button>Transfer</button>`);
    const r = await resolveTarget(page, target([{ strategy: "coordinates", x: 5, y: 5 }]), {
      timeoutMs: 500,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.attempts[0]?.error).toContain("not resolvable");
  });

  it("survives a malformed CSS selector by disqualifying only that candidate", async () => {
    await page.setContent(`<button id="ok">Go</button>`);
    const r = await resolveTarget(
      page,
      target([
        { strategy: "css", value: "button[" },
        { strategy: "css", value: "#ok" },
      ]),
      { timeoutMs: 500 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidateIndex).toBe(1);
  });

  it("records every attempt so a failure can be debugged", async () => {
    await page.setContent(`<div>nothing here</div>`);
    const t = target([
      { strategy: "role", role: "button", name: "Transfer" },
      { strategy: "css", value: "#missing" },
    ]);
    const r = await resolveTarget(page, t, { timeoutMs: 500 });
    expect(r.attempts).toHaveLength(2);
    const explanation = explainFailure(t, r.attempts);
    expect(explanation).toContain("role=button");
    expect(explanation).toContain("#missing");
  });
});

describe("describeCandidate", () => {
  it("renders every strategy without leaking page content", () => {
    expect(describeCandidate({ strategy: "role", role: "button", name: "Go", exact: true }))
      .toBe('role=button name="Go" (exact)');
    expect(describeCandidate({ strategy: "css", value: "#a" })).toBe('css="#a"');
    expect(describeCandidate({ strategy: "coordinates", x: 1, y: 2 })).toBe("coordinates=(1, 2)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions from PR2 review.
// ─────────────────────────────────────────────────────────────────────────────

describe("returns the visible element, not the first DOM match (review #2)", () => {
  it("skips a hidden duplicate that precedes the visible one", async () => {
    // Counting visible matches but returning first() reported ok:true and handed back an
    // element that can never be clicked. Hidden duplicates ahead of the real control are
    // ordinary in legacy markup, so this failed as a mysterious timeout rather than a refusal.
    await page.setContent(`
      <button class="go" style="display:none">hidden</button>
      <button class="go">visible</button>
    `);
    const r = await resolveTarget(page, target([{ strategy: "css", value: "button.go" }]), {
      timeoutMs: 500,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(await r.locator.innerText()).toBe("visible");
      expect(await r.locator.isVisible()).toBe(true);
      // The real assertion: the returned locator is actually usable.
      await r.locator.click({ timeout: 2_000 });
    }
  });

  it("finds the visible match when several hidden ones precede it", async () => {
    await page.setContent(`
      <a class="x" style="display:none">one</a>
      <a class="x" style="visibility:hidden">two</a>
      <a class="x" href="#">three</a>
    `);
    const r = await resolveTarget(page, target([{ strategy: "css", value: "a.x" }]), {
      timeoutMs: 500,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(await r.locator.innerText()).toBe("three");
  });
});

describe("polls the whole candidate chain until the deadline (review #3)", () => {
  it("waits for a control that is attached but not yet visible", async () => {
    // waitFor({state:"attached"}) returned immediately for an already-attached hidden control,
    // so a target that was about to become usable was rejected on the spot.
    await page.setContent(`<button id="late" style="display:none">Later</button>`);
    setTimeout(() => {
      void page.evaluate(() => {
        document.getElementById("late")!.style.display = "block";
      });
    }, 400);

    const r = await resolveTarget(page, target([{ strategy: "css", value: "#late" }]), {
      timeoutMs: 3_000,
    });
    expect(r.ok).toBe(true);
    expect(r.passes).toBeGreaterThan(1);
  });

  it("observes a later candidate that only appears mid-timeout", async () => {
    // Previously only the first candidate ever waited, so a fallback rendered by a late AJAX
    // response was never seen.
    await page.setContent(`<div id="host"></div>`);
    setTimeout(() => {
      void page.evaluate(() => {
        document.getElementById("host")!.innerHTML = '<button id="fallback">Go</button>';
      });
    }, 400);

    const r = await resolveTarget(
      page,
      target([
        { strategy: "role", role: "button", name: "Never appears" },
        { strategy: "css", value: "#fallback" },
      ]),
      { timeoutMs: 3_000 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidateIndex).toBe(1);
  });

  it("still gives up at the deadline rather than hanging", async () => {
    await page.setContent(`<div>nothing</div>`);
    const started = Date.now();
    const r = await resolveTarget(page, target([{ strategy: "css", value: "#never" }]), {
      timeoutMs: 600,
    });
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
