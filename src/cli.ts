/**
 * The production entry point: `replay` is the command an AI agent's tooling would invoke.
 *
 *   npm run cli -- validate <artifact>
 *   npm run cli -- replay <artifact> --input k=v [--headed] [--trace] [--json]
 */
import { readFile } from "node:fs/promises";
import { config, defaultPolicy } from "./config.js";
import { CapabilityArtifact, Policy, type RunResult } from "./schema.js";
import { replay } from "./replay.js";
import { loginToParabank } from "./parabank.js";
import { CliInterventionChannel } from "./handoff.js";
import { createInterface } from "node:readline";

interface ParsedArgs {
  command: string | undefined;
  artifactPath: string | undefined;
  inputs: Record<string, string>;
  headed: boolean;
  trace: boolean;
  json: boolean;
  interactive: boolean;
  goal: string | undefined;
  baseUrl: string | undefined;
  policyPath: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const inputs: Record<string, string> = {};
  let artifactPath: string | undefined;
  let baseUrl: string | undefined;
  let policyPath: string | undefined;
  let goal: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--input" || arg === "-i") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === "--base-url") {
      baseUrl = argv[++i];
    } else if (arg === "--policy") {
      policyPath = argv[++i];
    } else if (arg === "--goal") {
      goal = argv[++i];
    } else if (!arg.startsWith("-") && artifactPath === undefined) {
      artifactPath = arg;
    }
  }

  return {
    command: argv[0],
    artifactPath,
    inputs,
    headed: argv.includes("--headed"),
    trace: argv.includes("--trace"),
    json: argv.includes("--json"),
    interactive: argv.includes("--interactive"),
    goal,
    baseUrl,
    policyPath,
  };
}

const USAGE = `
Usage:
  npm run cli -- validate <artifact.json>
  npm run cli -- replay <artifact.json> --input name=value [options]

Options:
  --input k=v     Invocation input. Repeatable.
  --base-url URL  Override the artifact's recorded baseUrl (the per-tenant resolution point).
  --policy FILE   Policy JSON. Defaults to the ParaBank policy in src/config.ts.
  --headed        Show the browser. Required for a human to take over the session.
  --interactive   Route interventions to this terminal. A step needing a human then hands
                  you the live browser instead of returning an escalated result.
  --goal TEXT     What this invocation is for; shown to the operator on escalation.
  --trace         Write a raw Playwright trace. UNREDACTED — see README.
  --json          Print the RunResult as JSON and nothing else.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || !args.artifactPath) {
    process.stdout.write(USAGE);
    process.exit(args.command ? 1 : 0);
  }

  const raw: unknown = JSON.parse(await readFile(args.artifactPath, "utf8"));

  if (args.command === "validate") {
    const parsed = CapabilityArtifact.safeParse(raw);
    if (!parsed.success) {
      process.stderr.write(`INVALID  ${args.artifactPath}\n`);
      for (const issue of parsed.error.issues) {
        process.stderr.write(`  ${issue.path.join(".") || "(root)"}: ${issue.message}\n`);
      }
      process.exit(1);
    }
    const a = parsed.data;
    process.stdout.write(
      `VALID  ${a.capabilityId} v${a.version}  [${a.metadata.status}, risk=${a.metadata.risk}]\n` +
        `  inputs   : ${Object.keys(a.inputs).join(", ") || "(none)"}\n` +
        `  outputs  : ${Object.keys(a.outputs).join(", ") || "(none)"}\n` +
        `  steps    : ${a.steps.length}\n` +
        `  handlers : ${a.handlers.map((h) => `${h.id}->${h.disposition.kind}`).join(", ") || "(none)"}\n`,
    );
    return;
  }

  if (args.command !== "replay") {
    process.stderr.write(`unknown command "${args.command}"\n${USAGE}`);
    process.exit(1);
  }

  // A run always has a policy. The default is narrow — one origin, /parabank/** only — and a
  // tenant would supply its own here rather than the engine inventing permissive defaults.
  const policy = args.policyPath
    ? Policy.parse(JSON.parse(await readFile(args.policyPath, "utf8")))
    : defaultPolicy();

  if (!args.baseUrl) {
    // Nothing to reconcile: the artifact's own baseUrl is used and the policy governs it.
  } else {
    const decision = new (await import("./safety.js")).PolicyGuard(policy).checkUrl(args.baseUrl);
    if (!decision.allowed) {
      process.stderr.write(`--base-url refused by policy: ${decision.reason}\n`);
      process.exit(1);
    }
  }

  // With no channel, a step needing a human returns `escalated` — the honest result for an
  // unattended caller. --interactive routes it to this terminal instead.
  const lines = args.interactive ? createLineReader() : undefined;

  const channel = lines
    ? new CliInterventionChannel({
        write: (text) => process.stdout.write(text),
        readLine: () => lines.next(),
      })
    : undefined;

  if (args.interactive && !args.headed) {
    process.stdout.write(
      "\n  note: --interactive without --headed means you cannot see the session you are\n" +
        "        being asked to take over. Add --headed.\n",
    );
  }

  const result = await replay({
    artifact: raw,
    policy,
    ...(channel ? { interventionChannel: channel } : {}),
    ...(args.goal ? { goal: args.goal } : {}),
    inputs: args.inputs,
    secrets: {
      parabankUsername: config.parabank.username,
      parabankPassword: config.parabank.password,
    },
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    headed: args.headed,
    trace: args.trace ? "unredacted" : "off",
    // Login is a UI flow and differs per application, so the engine does not invent one.
    // The ParaBank routine is supplied here, at the edge that knows which app this is.
    reauthenticate: loginToParabank,
  });

  lines?.close();

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printResult(result);
  }

  // Exit codes distinguish the four statuses, so a caller can branch without parsing output.
  // A business outcome is NOT an error: "no such account" is a legitimate answer.
  process.exit(
    result.status === "success" || result.status === "business_outcome"
      ? 0
      : result.status === "escalated"
        ? 2
        : 1,
  );
}


/**
 * Buffers stdin from process start rather than reading on demand.
 *
 * An intervention is requested tens of seconds into a run, by which time piped input has long
 * since reached EOF — asking then gets "readline was closed" rather than the answer that was
 * provided. Buffering from the start makes a scripted operator behave the same as a person at a
 * terminal, which is what makes the handoff testable end to end.
 */
function createLineReader(): { next: () => Promise<string>; close: () => void } {
  const buffered: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let closed = false;

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    // Anything still waiting gets an empty answer, which the channel reads as "abort".
    while (waiting.length > 0) waiting.shift()?.("");
  });

  return {
    next: () =>
      new Promise<string>((resolve) => {
        const ready = buffered.shift();
        if (ready !== undefined) resolve(ready);
        else if (closed) resolve("");
        else waiting.push(resolve);
      }),
    close: () => rl.close(),
  };
}

function printResult(result: RunResult): void {
  const line = (s: string) => process.stdout.write(`${s}\n`);
  line("");
  switch (result.status) {
    case "success":
      line("SUCCESS");
      for (const [k, v] of Object.entries(result.outputs)) line(`  ${k} = ${JSON.stringify(v)}`);
      break;
    case "business_outcome":
      line(`BUSINESS OUTCOME  ${result.outcome}`);
      for (const [k, v] of Object.entries(result.detail)) line(`  ${k} = ${JSON.stringify(v)}`);
      line("  (this is an answer, not a failure)");
      break;
    case "escalated":
      line(`ESCALATED  ${result.intervention.reason}`);
      line(`  intervention : ${result.intervention.interventionId}`);
      line(`  resume token : ${result.intervention.resumeToken}`);
      break;
    case "failure":
      line(`FAILURE  ${result.error.code}`);
      line(`  ${result.error.message}`);
      if (result.error.step) line(`  at step ${result.error.step.index}: ${result.error.step.id}`);
      if (result.error.expected) line(`  expected : ${result.error.expected}`);
      if (result.error.observed) line(`  observed : ${result.error.observed}`);
      break;
  }
  line("");
  line(`  model calls : ${result.evidence.modelCalls}`);
  if (result.evidence.humanActions) line(`  human acts  : ${result.evidence.humanActions}`);
  if (result.evidence.directory) line(`  evidence    : ${result.evidence.directory}`);
  line("");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
