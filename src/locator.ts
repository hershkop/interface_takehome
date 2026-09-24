/**
 * Turning a recorded Target into exactly one element on the page.
 *
 * The contract replay depends on: a target resolves only when some candidate matches exactly
 * one *visible* element. Zero matches and ambiguous matches are both refusals. A replay that
 * picks the first of three matching buttons is worse than one that stops, because it fails
 * silently and in production that means it did the wrong thing to somebody's account.
 */
import type { Locator, Page } from "playwright";
import type { LocatorCandidate, Target } from "./schema.js";

export type ResolutionOutcome =
  | { ok: true; locator: Locator; candidate: LocatorCandidate; candidateIndex: number; attempts: AttemptLog[] }
  | { ok: false; reason: "not_found" | "ambiguous"; attempts: AttemptLog[] };

export interface AttemptLog {
  candidateIndex: number;
  strategy: LocatorCandidate["strategy"];
  /** How the candidate is written, for the error message. Never contains page content. */
  describe: string;
  visibleMatches: number;
  error?: string;
}

/** Human-readable form of a candidate, used in logs and failure messages. */
export function describeCandidate(c: LocatorCandidate): string {
  switch (c.strategy) {
    case "role":
      return `role=${c.role} name=${JSON.stringify(c.name)}${c.exact ? " (exact)" : ""}`;
    case "label":
      return `label=${JSON.stringify(c.value)}`;
    case "text":
      return `text=${JSON.stringify(c.value)}`;
    case "testId":
      return `testId=${JSON.stringify(c.value)}`;
    case "css":
      return `css=${JSON.stringify(c.value)}`;
    case "coordinates":
      return `coordinates=(${c.x}, ${c.y})`;
  }
}

/** Builds the Playwright locator for a candidate. Coordinates have no locator form. */
function buildLocator(page: Page, c: LocatorCandidate): Locator | null {
  switch (c.strategy) {
    case "role":
      // Playwright's role selector is the closest thing to how an operator identifies a
      // control, and it is the representation a desktop accessibility adapter would also expose.
      return page.getByRole(c.role as Parameters<Page["getByRole"]>[0], {
        name: c.name,
        exact: c.exact,
      });
    case "label":
      return page.getByLabel(c.value);
    case "text":
      return page.getByText(c.value);
    case "testId":
      return page.getByTestId(c.value);
    case "css":
      return page.locator(c.value);
    case "coordinates":
      return null;
  }
}

/**
 * Counts how many matches are actually visible.
 *
 * Visibility is not cosmetic here. ParaBank keeps an "An internal error has occurred" div in the
 * DOM of every healthy page, and legacy apps routinely keep whole hidden form sections around.
 * Counting DOM matches rather than visible ones would resolve to elements a human operator
 * cannot see, which is exactly what this system is supposed to imitate.
 */
async function countVisible(locator: Locator): Promise<number> {
  const total = await locator.count();
  if (total === 0) return 0;

  let visible = 0;
  for (let i = 0; i < total; i++) {
    if (await locator.nth(i).isVisible()) visible++;
    // Two is already ambiguous; no need to price the rest.
    if (visible > 1) return visible;
  }
  return visible;
}

/**
 * Walks the candidate list in order and returns the first candidate matching exactly one
 * visible element.
 *
 * A candidate matching zero or several elements is skipped rather than fatal — that is the
 * entire point of recording a fallback chain. But no candidate is ever allowed to *choose*
 * among its own matches. If nothing resolves cleanly, the caller is told which failure mode it
 * was: `ambiguous` when some candidate matched several elements (the flow is under-specified),
 * `not_found` when nothing matched at all (the page is not where we thought it was). Those two
 * want different fixes, so they are different errors.
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  options: { timeoutMs?: number } = {},
): Promise<ResolutionOutcome> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const attempts: AttemptLog[] = [];
  let sawAmbiguous = false;

  for (const [candidateIndex, candidate] of target.candidates.entries()) {
    const describe = describeCandidate(candidate);

    if (candidate.strategy === "coordinates") {
      // Coordinates cannot be verified — there is no way to ask "is this the right control?".
      // The schema already bars them from approved artifacts; the resolver refuses to treat
      // them as a resolution at all, so a draft replay fails loudly rather than mis-clicking.
      attempts.push({
        candidateIndex,
        strategy: candidate.strategy,
        describe,
        visibleMatches: 0,
        error: "coordinate targeting is not resolvable; re-record this step",
      });
      continue;
    }

    const locator = buildLocator(page, candidate);
    if (!locator) continue;

    try {
      // Give the first candidate a chance to appear; later ones are checked immediately, since
      // by then we have already waited once for this target.
      if (candidateIndex === 0) {
        await locator.first().waitFor({ state: "attached", timeout: timeoutMs }).catch(() => {});
      }
      const visibleMatches = await countVisible(locator);
      attempts.push({ candidateIndex, strategy: candidate.strategy, describe, visibleMatches });

      if (visibleMatches === 1) {
        return { ok: true, locator: locator.first(), candidate, candidateIndex, attempts };
      }
      if (visibleMatches > 1) sawAmbiguous = true;
    } catch (err) {
      // A malformed CSS selector or an unknown ARIA role lands here. It disqualifies the
      // candidate, not the target.
      attempts.push({
        candidateIndex,
        strategy: candidate.strategy,
        describe,
        visibleMatches: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: false, reason: sawAmbiguous ? "ambiguous" : "not_found", attempts };
}

/** One-line summary of why a target did not resolve, safe to put in a RunError. */
export function explainFailure(target: Target, attempts: AttemptLog[]): string {
  const label = target.description ? `${target.description}: ` : "";
  const tried = attempts
    .map((a) => `[${a.candidateIndex}] ${a.describe} -> ${a.error ?? `${a.visibleMatches} visible`}`)
    .join("; ");
  return `${label}no candidate resolved to exactly one visible element. Tried: ${tried}`;
}
