/**
 * Promotion gates: what a capability has to show before it moves to the next state.
 *
 * The point of splitting `approved` into four states is that each one is earned by *different
 * evidence*, and lumping them together let a capability be trusted for a reason nobody stated.
 * A reviewer can bless something nobody has ever replayed; a flow can replay flawlessly and
 * still be the wrong flow. So each gate below asks one question and says which answer it got.
 *
 * Two of the gates are machine-checkable and one is not, deliberately. `validated` reads the
 * artifact, `rehearsed` reads replay history, and `approved` requires a person — there is no
 * evidence a program can gather that substitutes for someone deciding this capability should
 * be callable unattended. Pretending otherwise would be the whole point, missed.
 */
import { collectTargets } from "./schema.js";
import type { CapabilityArtifact, CapabilityStatus } from "./schema.js";

/** Forward order. `deprecated` is not in it — retirement is reachable from anywhere. */
export const PROMOTION_ORDER: readonly CapabilityStatus[] = [
  "draft",
  "validated",
  "rehearsed",
  "approved",
];

export interface GateResult {
  ok: boolean;
  /** Why it was refused, or what evidence satisfied it. Shown to whoever asked. */
  reason: string;
}

/** How many times a revision must have replayed cleanly before it counts as rehearsed. */
export const DEFAULT_REHEARSALS = 3;

/**
 * Evidence a capability's own revision has accumulated.
 *
 * Counted per *fingerprint*, never per capabilityId: the whole value of a rehearsal record is
 * that it belongs to the revision that ran. Counting by name would let an edited capability
 * inherit the confidence earned by the one it replaced, which is the failure this exists to
 * prevent.
 */
export interface RehearsalRecord {
  successes: number;
  failures: number;
}

/** The next state up, or undefined at the top. */
export function nextStatus(status: CapabilityStatus): CapabilityStatus | undefined {
  const index = PROMOTION_ORDER.indexOf(status);
  if (index === -1 || index === PROMOTION_ORDER.length - 1) return undefined;
  return PROMOTION_ORDER[index + 1];
}

/**
 * Does this artifact hold up on its own terms?
 *
 * Everything here is answerable by reading the artifact, which is exactly what makes it the
 * first gate: it costs nothing to run and it catches the recordings that could never have
 * worked — before anyone spends a browser session finding out.
 */
export function checkValidated(artifact: CapabilityArtifact): GateResult {
  const problems: string[] = [];

  // A coordinate is a screenshot's opinion about where something was. Replay refuses them
  // outright, so an artifact carrying one has a step that cannot run.
  //
  // Walked with `collectTargets`, which is there precisely so a rule about locators applies to
  // every place a locator can appear — step actions, output sources and dismiss handlers —
  // "rather than to whichever locations someone remembered", as its own comment puts it. The
  // first version of this gate remembered steps, and passed an artifact whose *output* was
  // read from a coordinate.
  const coordinates = collectTargets(artifact)
    .filter(({ target }) => target.candidates.some((c) => c.strategy === "coordinates"))
    .map(({ where }) => where);
  if (coordinates.length > 0) {
    problems.push(`coordinate locators at: ${coordinates.join(", ")}`);
  }

  // Without a checkpoint, "it replayed" means only "nothing threw" — which is not a claim
  // anyone should promote.
  if (artifact.checkpoint === undefined) problems.push("no checkpoint");

  // A capability with neither outputs nor a business outcome to report has no observable
  // result, so nothing downstream can tell success from a silent no-op.
  const reportsSomething =
    Object.keys(artifact.outputs).length > 0 ||
    artifact.handlers.some((h) => h.disposition.kind === "business_outcome");
  if (!reportsSomething) {
    problems.push("declares neither outputs nor a business outcome, so a run reports nothing");
  }

  return problems.length === 0
    ? { ok: true, reason: "artifact is schema-valid, uses durable locators, and reports a result" }
    : { ok: false, reason: problems.join("; ") };
}

/**
 * Has this exact revision actually run, enough times to mean something?
 *
 * Read from replay history rather than asserted by whoever is promoting. One successful run
 * proves the flow existed once; the threshold is about flakiness, which is the failure mode
 * that matters here — a capability that works four times in five is not one an agent should
 * call unattended, and nothing in the artifact itself can tell you that.
 */
export function checkRehearsed(
  record: RehearsalRecord,
  required = DEFAULT_REHEARSALS,
): GateResult {
  if (record.successes < required) {
    return {
      ok: false,
      reason:
        `this revision has ${record.successes} clean replay(s); ${required} required. ` +
        `Replay it and try again — rehearsals are counted per revision, so an edit resets them.`,
    };
  }
  if (record.failures > 0) {
    return {
      ok: false,
      reason:
        `this revision has ${record.failures} failed replay(s) alongside ${record.successes} ` +
        `clean one(s). Fix the flake or the flow; a capability that works most of the time is ` +
        `the worst kind to call unattended.`,
    };
  }
  return { ok: true, reason: `${record.successes} clean replays of this revision, no failures` };
}

/**
 * Evaluates the gate guarding a move from `from` to `to`.
 *
 * Every transition goes through here, including the ones from the console, so a gate cannot be
 * bypassed by using a different entry point — which is how the last one was bypassed.
 */
export function checkPromotion(
  artifact: CapabilityArtifact,
  to: CapabilityStatus,
  evidence: { rehearsals: RehearsalRecord; approvedBy?: string; requiredRehearsals?: number },
): GateResult {
  const from = artifact.metadata.status;

  if (to === "deprecated") {
    // Reachable from anywhere and gated by nothing. Retiring something is always allowed:
    // a gate on withdrawal is a gate that keeps a known-bad capability callable.
    return { ok: true, reason: "retired" };
  }

  if (from === "deprecated") {
    return {
      ok: false,
      reason: "a deprecated capability is not revived; supersede it with a new version instead",
    };
  }

  // Backwards is its own refusal, with its own reason. Reported as "there is nothing above
  // approved" it reads as a failed promotion, when what was actually attempted was a
  // withdrawal — and withdrawal is the way around every gate above: step back, edit freely,
  // climb again at the same version, no trace.
  if (PROMOTION_ORDER.indexOf(to) < PROMOTION_ORDER.indexOf(from)) {
    return {
      ok: false,
      reason:
        `"${from}" does not go back to "${to}". Supersede it with a new version, or deprecate it.`,
    };
  }

  const expected = nextStatus(from);
  if (to !== expected) {
    return {
      ok: false,
      reason:
        expected === undefined
          ? `"${from}" is the top of the ladder; there is nothing above it`
          : `promotion moves one step at a time: "${from}" can only become "${expected}"`,
    };
  }

  switch (to) {
    case "validated":
      return checkValidated(artifact);
    case "rehearsed":
      return checkRehearsed(evidence.rehearsals, evidence.requiredRehearsals);
    case "approved":
      // The one gate a program cannot satisfy for you. Naming who approved it is the whole
      // content of the state: an approval nobody is attached to is an unsigned one.
      // Trimmed here rather than at each caller: an approver of "   " is truthy, and the one
      // entry point that forgot to normalise would be the one that let an unsigned approval
      // through. The gate owns the rule.
      return evidence.approvedBy?.trim()
        ? { ok: true, reason: `approved by ${evidence.approvedBy.trim()}` }
        : {
            ok: false,
            reason: "approval needs a person: say who is signing off (--by)",
          };
    default:
      return { ok: false, reason: `nothing promotes to "${to}"` };
  }
}
