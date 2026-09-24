import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { evaluateCondition, describeCondition, globToRegExp } from "../src/surface.js";
import { Condition } from "../src/schema.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const cond = (c: unknown) => Condition.parse(c);

describe("evaluateCondition — visibility", () => {
  it("does not match text that is present but hidden", async () => {
    // This is the exact shape of the ParaBank trap from DAY0-FINDINGS §3: a healthy page that
    // carries error copy in a hidden div. Matching it would report a failure on every
    // successful run.
    await page.setContent(`
      <div id="showError" style="display:none">Error! An internal error has occurred.</div>
      <h1>Account Details</h1>
    `);
    expect(await evaluateCondition(page, cond({ kind: "text", value: "An internal error" }))).toBe(false);
    expect(await evaluateCondition(page, cond({ kind: "text", value: "Account Details" }))).toBe(true);
  });

  it("matches the same hidden text when hidden matching is explicitly requested", async () => {
    await page.setContent(`<div style="display:none">Error! An internal error has occurred.</div>`);
    expect(
      await evaluateCondition(page, cond({ kind: "text", value: "An internal error", visible: false })),
    ).toBe(true);
  });

  it("matches once the hidden element is revealed", async () => {
    // The other half of the trap: when the error is real, it must be detected.
    await page.setContent(`<div id="e" style="display:none">Could not find account # 99999</div>`);
    expect(await evaluateCondition(page, cond({ kind: "text", value: "Could not find account" }))).toBe(false);
    await page.evaluate(() => {
      document.getElementById("e")!.style.display = "block";
    });
    expect(await evaluateCondition(page, cond({ kind: "text", value: "Could not find account" }))).toBe(true);
  });

  it("never matches a hidden element by role, which is why role has no visibility flag", async () => {
    // Playwright resolves roles against the accessibility tree, and a display:none element is
    // not in it. There is therefore no way to ask for a hidden role match, and the schema does
    // not offer one — an opt-out field here would silently do nothing.
    await page.setContent(`<div role="alert" style="display:none">Validation failed</div>`);
    expect(await evaluateCondition(page, cond({ kind: "role", role: "alert" }))).toBe(false);

    await page.setContent(`<div role="alert">Validation failed</div>`);
    expect(await evaluateCondition(page, cond({ kind: "role", role: "alert" }))).toBe(true);
  });

  it("treats a condition that never passed through Zod as visible-only", async () => {
    // Caught by the probe against the real app. `visible` is a Zod default, so an object built
    // in code and cast to Condition arrives with `visible === undefined`. A truthiness check
    // would read that as "hidden matching allowed" and silently invert the safe default — the
    // evaluator tests `!== false` so the safe reading does not depend on provenance.
    await page.setContent(`<div style="display:none">An internal error has occurred</div>`);
    const unparsed = { kind: "text", value: "An internal error has occurred" };
    expect((unparsed as { visible?: boolean }).visible).toBeUndefined();
    expect(await evaluateCondition(page, unparsed as Condition)).toBe(false);
  });

  it("matches hidden content by text, which is the supported way to assert on it", async () => {
    await page.setContent(`<div role="alert" style="display:none">Validation failed</div>`);
    expect(
      await evaluateCondition(page, cond({ kind: "text", value: "Validation failed", visible: false })),
    ).toBe(true);
  });
});

describe("evaluateCondition — other kinds", () => {
  it("matches role with an accessible name", async () => {
    await page.setContent(`<button>Transfer</button>`);
    expect(await evaluateCondition(page, cond({ kind: "role", role: "button", name: "Transfer" }))).toBe(true);
    expect(await evaluateCondition(page, cond({ kind: "role", role: "button", name: "Cancel" }))).toBe(false);
  });

  it("matches the page title by substring", async () => {
    await page.setContent(`<title>ParaBank | Accounts Overview</title><p>x</p>`);
    expect(await evaluateCondition(page, cond({ kind: "title", value: "Accounts Overview" }))).toBe(true);
    expect(await evaluateCondition(page, cond({ kind: "title", value: "Error" }))).toBe(false);
  });

  it("composes with all and not", async () => {
    await page.setContent(`
      <h1>Account Details</h1>
      <div style="display:none">Error!</div>
    `);
    const checkpoint = cond({
      kind: "all",
      conditions: [
        { kind: "text", value: "Account Details" },
        { kind: "not", condition: { kind: "text", value: "Error!" } },
      ],
    });
    // Passes precisely because the error text is hidden — a realistic checkpoint.
    expect(await evaluateCondition(page, checkpoint)).toBe(true);

    await page.setContent(`<h1>Account Details</h1><div>Error!</div>`);
    expect(await evaluateCondition(page, checkpoint)).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("matches URL patterns the way replay needs", () => {
    expect(globToRegExp("**/activity.htm*").test("http://x/parabank/activity.htm?id=1")).toBe(true);
    expect(globToRegExp("**/login.htm").test("http://x/parabank/login.htm")).toBe(true);
    expect(globToRegExp("**/login.htm").test("http://x/parabank/overview.htm")).toBe(false);
  });

  it("does not let * cross a path segment", () => {
    expect(globToRegExp("http://x/*").test("http://x/a/b")).toBe(false);
    expect(globToRegExp("http://x/**").test("http://x/a/b")).toBe(true);
  });

  it("escapes regex metacharacters in literal parts", () => {
    expect(globToRegExp("http://x/a.htm").test("http://x/aXhtm")).toBe(false);
    expect(globToRegExp("http://x/a.htm").test("http://x/a.htm")).toBe(true);
  });
});

describe("describeCondition", () => {
  it("produces readable text for failure messages", () => {
    expect(describeCondition(cond({ kind: "text", value: "Done" }))).toBe('text "Done"');
    expect(
      describeCondition(
        cond({
          kind: "all",
          conditions: [
            { kind: "title", value: "Overview" },
            { kind: "not", condition: { kind: "text", value: "Error" } },
          ],
        }),
      ),
    ).toBe('title containing "Overview" AND NOT (text "Error")');
  });
});

describe("human event capture (PR5)", () => {
  it("keeps recording after a navigation, and never records typed values", async () => {
    // Two properties, both easy to get wrong.
    //
    // Listeners attached with a one-off evaluate() die on the next navigation, so a person who
    // clicks anything that loads a page is recorded for the first click and then silently not
    // at all — the worst kind of failure in an audit trail, because it looks like they did
    // nothing. addInitScript re-runs per document.
    //
    // And what someone types into a bank's back office must not be persisted. The payload
    // carries a length, never the characters.
    const { PlaywrightSurface } = await import("../src/surface.js");
    const events: Array<Record<string, unknown>> = [];

    const surface = await PlaywrightSurface.launch({
      onHumanEvent: (e) => events.push({ ...e }),
    });

    try {
      const page = surface.page;
      const html = (label: string) =>
        `data:text/html,<body><button id="b">${label}</button>` +
        `<input id="pw" type="password"></body>`;

      await page.goto(html("first"));
      await page.click("#b");
      await page.fill("#pw", "sup3r-s3cret-value");
      await page.dispatchEvent("#pw", "change");

      // Navigate: a one-off listener injection would stop reporting here.
      await page.goto(html("second"));
      await page.click("#b");

      await page.waitForTimeout(150);

      const clicks = events.filter((e) => e.type === "click");
      expect(clicks.length).toBeGreaterThanOrEqual(2);

      const serialised = JSON.stringify(events);
      expect(serialised).not.toContain("sup3r-s3cret-value");

      const changes = events.filter((e) => e.type === "change");
      expect(changes.length).toBeGreaterThan(0);
      expect(changes[0]?.valueLength).toBe("sup3r-s3cret-value".length);
      expect(changes[0]?.id).toBe("pw");
    } finally {
      await surface.close();
    }
  }, 60_000);
});
