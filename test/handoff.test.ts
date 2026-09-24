import { describe, expect, it, vi } from "vitest";
import {
  CliInterventionChannel,
  HandoffError,
  OwnedSurface,
  ScriptedInterventionChannel,
  SessionController,
  type InterventionDecision,
} from "../src/handoff.js";
import type { Observation, Target } from "../src/schema.js";
import type { ActionOutcome, Surface } from "../src/surface.js";

const observation: Observation = {
  url: "http://bank.test/transfer.htm",
  title: "Transfer Funds",
  ariaSnapshot: '- button "Transfer"',
  alerts: [],
  step: 0,
};

function controllerWith(decide: (r: unknown) => InterventionDecision) {
  const recorded: Array<{ type: string; detail: Record<string, unknown> }> = [];
  const channel = new ScriptedInterventionChannel(decide as never);
  const controller = new SessionController(channel, {
    observe: async () => observation,
    screenshot: async (label) => `shot-${label}.png`,
    record: async (type, detail) => {
      recorded.push({ type, detail });
    },
  });
  return { controller, channel, recorded };
}

const target: Target = { candidates: [{ strategy: "css", value: "#x" }] };

/** A surface that records what actually reached it. */
function spySurface(): { surface: Surface; calls: string[] } {
  const calls: string[] = [];
  const ok = async (name: string): Promise<ActionOutcome> => {
    calls.push(name);
    return { ok: true };
  };
  const surface = {
    navigate: () => ok("navigate"),
    click: () => ok("click"),
    fill: () => ok("fill"),
    select: () => ok("select"),
    clickAt: async () => {
      calls.push("clickAt");
      return { ok: true };
    },
    waitFor: () => ok("waitFor"),
    extract: () => ok("extract"),
    verify: async () => {
      calls.push("verify");
      return true;
    },
    currentUrl: () => "http://bank.test/transfer.htm",
    takeBlockedNavigations: () => [],
    observe: async () => observation,
    close: async () => undefined,
  } as unknown as Surface;
  return { surface, calls };
}

describe("SessionController", () => {
  it("starts with automation holding the session", () => {
    expect(controllerWith(() => ({ decision: "proceed" })).controller.owner).toBe("automation");
  });

  it("transfers ownership before routing the request, and restores it after", async () => {
    // Ordering is the point: from the instant a person could be looking at the screen,
    // automation must already be locked out.
    let ownerDuringRequest: string | undefined;
    const { controller } = controllerWith(() => {
      ownerDuringRequest = controller.owner;
      return { decision: "proceed" };
    });

    await controller.handOver({
      runId: "run-1",
      reason: "approval_required",
      message: "needs a person",
      step: { id: "submit", index: 3 },
    });

    expect(ownerDuringRequest).toBe("human");
    expect(controller.owner).toBe("automation");
  });

  it("captures context before handing over, not after", async () => {
    const observe = vi.fn(async () => observation);
    const channel = new ScriptedInterventionChannel(() => ({ decision: "proceed" }));
    const controller = new SessionController(channel, {
      observe,
      screenshot: async () => "shot.png",
      record: async () => {},
    });

    await controller.handOver({ runId: "r", reason: "agent_stuck", message: "stuck" });

    // Once before handing over (what the operator needs to see), once after taking back.
    expect(observe).toHaveBeenCalledTimes(2);
    expect(channel.received[0]?.observedState).toMatchObject({ title: "Transfer Funds" });
    expect(channel.received[0]?.screenshot).toBeTruthy();
  });

  it("carries enough context for an operator to act", async () => {
    const { controller, channel } = controllerWith(() => ({ decision: "abort" }));
    await controller.handOver({
      runId: "run-7",
      reason: "approval_required",
      message: "irreversible step",
      capabilityId: "transfer_funds",
      goal: "move 25 dollars",
      step: { id: "submit_transfer", index: 9 },
    });

    const request = channel.received[0]!;
    expect(request.runId).toBe("run-7");
    expect(request.capabilityId).toBe("transfer_funds");
    expect(request.goal).toBe("move 25 dollars");
    expect(request.step).toEqual({ id: "submit_transfer", index: 9 });
    expect(request.interventionId).toBeTruthy();
    expect(request.requestedAt).toBeTruthy();
  });

  it("returns control even when the operator channel throws", async () => {
    // A crashed console must not leave the session permanently locked with nothing able to act.
    const channel = { request: async () => { throw new Error("console died"); } };
    const controller = new SessionController(channel, {
      observe: async () => observation,
      screenshot: async () => "s.png",
      record: async () => {},
    });

    await expect(
      controller.handOver({ runId: "r", reason: "replay_blocked", message: "x" }),
    ).rejects.toThrow("console died");
    expect(controller.owner).toBe("automation");
  });

  it("refuses to hand over twice at once", async () => {
    // Two operators cannot hold the same session; a second request while one is in flight is a
    // bug in the caller, not something to silently queue.
    let nested: Promise<unknown> | undefined;
    const controller = new SessionController(
      {
        request: async () => {
          nested = controller.handOver({ runId: "r", reason: "agent_stuck", message: "again" });
          return { decision: "proceed" } as InterventionDecision;
        },
      },
      { observe: async () => observation, screenshot: async () => "s.png", record: async () => {} },
    );

    await controller.handOver({ runId: "r", reason: "approval_required", message: "first" });
    await expect(nested).rejects.toThrow(HandoffError);
  });

  it("records only what a human did, not what automation did", async () => {
    const { controller } = controllerWith(() => ({ decision: "proceed" }));

    // Before handover: automation's own clicks fire the same listeners and are not human events.
    controller.noteHumanEvent({ at: "t0", type: "click", url: "u" });
    expect(controller.humanEvents).toHaveLength(0);
  });
});

describe("OwnedSurface", () => {
  it("lets automation act while it holds the session", async () => {
    const { controller } = controllerWith(() => ({ decision: "proceed" }));
    const { surface, calls } = spySurface();
    const owned = new OwnedSurface(surface, controller);

    expect((await owned.click(target)).ok).toBe(true);
    expect((await owned.fill(target, "x")).ok).toBe(true);
    expect(calls).toEqual(["click", "fill"]);
  });

  it("refuses every mutating action while a human holds the session", async () => {
    // This is what makes the handoff real rather than cosmetic. If automation can still click
    // while a person is typing into the same form, control was never transferred.
    const { surface, calls } = spySurface();
    let owned: OwnedSurface;

    const channel = new ScriptedInterventionChannel(() => {
      // Runs while the human owns the session.
      return { decision: "proceed" };
    });
    const controller = new SessionController(
      {
        request: async () => {
          for (const attempt of [
            owned.navigate("http://bank.test/x"),
            owned.click(target),
            owned.fill(target, "v"),
            owned.select(target, "v"),
            owned.clickAt(1, 1),
          ]) {
            const outcome = await attempt;
            expect(outcome.ok).toBe(false);
            expect(outcome.errorCode).toBe("POLICY_DENIED");
            expect(outcome.error).toContain("held by a human");
          }
          return { decision: "proceed" } as InterventionDecision;
        },
      },
      {
        observe: async () => observation,
        screenshot: async () => "s.png",
        record: async () => {},
      },
    );
    owned = new OwnedSurface(surface, controller);
    void channel;

    await controller.handOver({ runId: "r", reason: "approval_required", message: "m" });

    // Nothing reached the real surface while the human held it.
    expect(calls).toEqual([]);
  });

  it("still permits reads during a handoff", async () => {
    // The engine has to be able to observe in order to take the session back sensibly.
    const { surface, calls } = spySurface();
    let owned: OwnedSurface;
    const controller = new SessionController(
      {
        request: async () => {
          expect(await owned.verify({ kind: "text", value: "x", visible: true })).toBe(true);
          expect((await owned.extract(target)).ok).toBe(true);
          return { decision: "abort" } as InterventionDecision;
        },
      },
      { observe: async () => observation, screenshot: async () => "s.png", record: async () => {} },
    );
    owned = new OwnedSurface(surface, controller);

    await controller.handOver({ runId: "r", reason: "agent_stuck", message: "m" });
    expect(calls).toContain("verify");
    expect(calls).toContain("extract");
  });
});

describe("CliInterventionChannel", () => {
  const run = async (answer: string) => {
    const written: string[] = [];
    const channel = new CliInterventionChannel({
      write: (t) => written.push(t),
      readLine: async () => answer,
    });
    const decision = await channel.request({
      interventionId: "i1",
      runId: "r1",
      reason: "approval_required",
      message: "needs a person",
      observedState: { url: "http://bank.test/t", title: "Transfer Funds", alerts: [] },
      requestedAt: new Date().toISOString(),
    });
    return { decision, text: written.join("") };
  };

  it("maps the three answers", async () => {
    expect((await run("p")).decision).toEqual({ decision: "proceed" });
    expect((await run("done")).decision).toEqual({ decision: "completed_by_human" });
    expect((await run("a")).decision.decision).toBe("abort");
  });

  it("treats an unclear or absent answer as abort", async () => {
    // On an irreversible financial action, the safe reading of "no clear answer" is not to
    // perform it.
    expect((await run("")).decision.decision).toBe("abort");
    expect((await run("maybe?")).decision.decision).toBe("abort");
  });

  it("shows the operator where the session is and what stopped it", async () => {
    const { text } = await run("a");
    expect(text).toContain("needs a person");
    expect(text).toContain("http://bank.test/t");
    expect(text).toContain("Transfer Funds");
    expect(text).toContain("locked out");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions from PR5 review.
// ─────────────────────────────────────────────────────────────────────────────

describe("operator answers are matched exactly (review #1)", () => {
  const ask = async (answer: string) => {
    const channel = new CliInterventionChannel({
      write: () => {},
      readLine: async () => answer,
    });
    return (
      await channel.request({
        interventionId: "i",
        runId: "r",
        reason: "approval_required",
        message: "m",
        observedState: {},
        requestedAt: new Date().toISOString(),
      })
    ).decision;
  };

  it("does not read a refusal as consent", async () => {
    // Prefix matching authorised an irreversible transfer from "please abort", and skipped the
    // step as already-done from "do not proceed". Any rule that guesses at intent fails open
    // eventually, and this gate exists precisely so that it does not.
    expect(await ask("please abort")).toBe("abort");
    expect(await ask("do not proceed")).toBe("abort");
    expect(await ask("don't")).toBe("abort");
    expect(await ask("probably not")).toBe("abort");
    expect(await ask("definitely")).toBe("abort");
  });

  it("accepts the documented tokens, in either short or long form", async () => {
    expect(await ask("p")).toBe("proceed");
    expect(await ask("proceed")).toBe("proceed");
    expect(await ask("d")).toBe("completed_by_human");
    expect(await ask("done")).toBe("completed_by_human");
    expect(await ask("a")).toBe("abort");
    expect(await ask("abort")).toBe("abort");
  });

  it("is case and whitespace insensitive but nothing more", async () => {
    expect(await ask("  PROCEED  ")).toBe("proceed");
    expect(await ask("Done")).toBe("completed_by_human");
    expect(await ask("proceed please")).toBe("abort");
  });

  it("says why it refused, so the operator can answer again", async () => {
    const channel = new CliInterventionChannel({ write: () => {}, readLine: async () => "yes" });
    const decision = await channel.request({
      interventionId: "i",
      runId: "r",
      reason: "approval_required",
      message: "m",
      observedState: {},
      requestedAt: new Date().toISOString(),
    });
    expect(decision).toMatchObject({ decision: "abort" });
    if (decision.decision === "abort") expect(decision.reason).toContain("yes");
  });
});

describe("ownership spans the post-handoff capture (review #3)", () => {
  it("is still held by the human while the resumed state is captured", async () => {
    // Restoring ownership first left a window in which queued automation was permitted and the
    // operator's final clicks were dropped by the ownership-filtered recorder — and it made the
    // documented order ("restored after a fresh observation") untrue.
    const ownerDuringCapture: string[] = [];
    const channel = new ScriptedInterventionChannel(() => ({ decision: "proceed" }));

    const controller: SessionController = new SessionController(channel, {
      observe: async () => {
        ownerDuringCapture.push(controller.owner);
        return observation;
      },
      screenshot: async () => {
        ownerDuringCapture.push(controller.owner);
        return "s.png";
      },
      record: async () => {},
    });

    await controller.handOver({ runId: "r", reason: "approval_required", message: "m" });

    // Four captures: observe + screenshot before handing over, observe + screenshot after.
    //
    // The first pair runs while automation still owns — it is automation recording the state
    // that caused the stop, before anyone else can touch the page.
    //
    // The second pair is the one this test exists for: it must run while the HUMAN still owns,
    // so a person finishing up is still recorded and automation is not yet eligible to act.
    expect(ownerDuringCapture).toHaveLength(4);
    expect(ownerDuringCapture.slice(0, 2)).toEqual(["automation", "automation"]);
    expect(ownerDuringCapture.slice(2)).toEqual(["human", "human"]);
    expect(controller.owner).toBe("automation");
  });

  it("still restores ownership when the post-capture itself throws", async () => {
    const controller = new SessionController(
      new ScriptedInterventionChannel(() => ({ decision: "proceed" })),
      {
        observe: async () => observation,
        screenshot: async (label) => {
          if (label.startsWith("resumed")) throw new Error("screenshot failed");
          return "s.png";
        },
        record: async () => {},
      },
    );

    await expect(
      controller.handOver({ runId: "r", reason: "approval_required", message: "m" }),
    ).rejects.toThrow("screenshot failed");
    expect(controller.owner).toBe("automation");
  });
});
