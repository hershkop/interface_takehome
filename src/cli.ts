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
import { discover } from "./discovery.js";
import { invoke, loadCatalog, toToolDefinition } from "./catalog.js";
import { auditRuns, formatCost } from "./audit.js";
import { DesktopSurface } from "./desktop/surface.js";
import { StdioDesktopTransport } from "./desktop/transport.js";
import { writeFile } from "node:fs/promises";
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
  capability: string | undefined;
  out: string | undefined;
  maxSteps: number | undefined;
  allowDraft: boolean;
  desktopHelper: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const inputs: Record<string, string> = {};
  let artifactPath: string | undefined;
  let baseUrl: string | undefined;
  let policyPath: string | undefined;
  let goal: string | undefined;
  let capability: string | undefined;
  let out: string | undefined;
  let maxSteps: number | undefined;
  let desktopHelper: string | undefined;

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
    } else if (arg === "--capability") {
      capability = argv[++i];
    } else if (arg === "--out") {
      out = argv[++i];
    } else if (arg === "--desktop-helper") {
      desktopHelper = argv[++i];
    } else if (arg === "--max-steps") {
      maxSteps = Number.parseInt(argv[++i] ?? "", 10) || undefined;
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
    capability,
    out,
    maxSteps,
    allowDraft: argv.includes("--allow-draft"),
    desktopHelper,
  };
}

const USAGE = `
Usage:
  npm run cli -- discover --goal "..." --capability <id> --out <file> [--input k=v]
  npm run cli -- replay <artifact.json> --input name=value [options]
  npm run cli -- validate <artifact.json>
  npm run cli -- capabilities [--json]
  npm run cli -- audit [--json]
  npm run cli -- invoke <capabilityId> --input name=value [options]

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
  --allow-draft   invoke only: run a capability still marked draft.
  --desktop-helper CMD
                  Run against a desktop surface, driven by this helper process. The helper
                  answers the seven requests in src/desktop/protocol.ts over stdio. No
                  platform helper ships here; to see the path work, use the reference one:
                    --desktop-helper "node scripts/desktop-helper-stub.mjs" 

audit:
  Every run under evidence/, how it ended, and what it cost. Cost is computed from the
  rates in src/config.ts against the tokens each run recorded — runs store tokens, not
  dollars, so a repricing never rewrites history. Replay rows cost nothing by construction.

discover options:
  --goal TEXT       What to accomplish. Required.
  --capability ID   lower_snake_case id for the recorded capability. Required.
  --out FILE        Where to write the artifact. Required.
  --max-steps N     Cap on model turns (default 25).
  Requires ANTHROPIC_API_KEY (put it in .env).
`;

/**
 * Secrets available to a run, resolved from the environment at invocation time.
 *
 * Never from the artifact: an artifact stores secret *references*, and the value exists only
 * here, for the length of the call. A secret that is not set is omitted rather than passed as
 * an empty string — an empty string satisfies the artifact's "required" check and is then
 * typed into the application as a blank password, which fails somewhere far less obvious.
 */
function cliSecrets(): Record<string, string> {
  return {
    parabankUsername: config.parabank.username,
    parabankPassword: config.parabank.password,
    ...(process.env.DESKTOP_APP_PASSWORD
      ? { appPassword: process.env.DESKTOP_APP_PASSWORD }
      : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (args.command === "capabilities") {
    await printCatalog(args.json);
    return;
  }

  if (args.command === "audit") {
    await printAudit(args.json);
    return;
  }

  if (args.command === "discover") {
    await runDiscovery(args);
    return;
  }

  if (args.command === "invoke") {
    await runInvoke(args);
    return;
  }

  if (!args.artifactPath) {
    process.stdout.write(USAGE);
    process.exit(1);
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
      `VALID  ${a.capabilityId} v${a.version}  [${a.metadata.status}, ${a.target.surface}, risk=${a.metadata.risk}]\n` +
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

  // A desktop run swaps the surface and says so. Everything else about this call is identical,
  // which is the whole claim the port makes.
  const desktop = args.desktopHelper?.trim();
  const [helperCommand, ...helperArgs] = desktop ? desktop.split(/\s+/) : [];

  const result = await replay({
    artifact: raw,
    policy,
    ...(helperCommand
      ? {
          surfaceKind: "desktop" as const,
          createSurface: async () =>
            new DesktopSurface({
              transport: new StdioDesktopTransport({ command: helperCommand, args: helperArgs }),
            }),
        }
      : {}),
    ...(channel ? { interventionChannel: channel } : {}),
    ...(args.goal ? { goal: args.goal } : {}),
    inputs: args.inputs,
    secrets: {
      ...cliSecrets(),
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
  process.exit(exitCodeFor(result));
}


/**
 * Buffers stdin from process start rather than reading on demand.
 *
 * An intervention is requested tens of seconds into a run, by which time piped input has long
 * since reached EOF — asking then gets "readline was closed" rather than the answer that was
 * provided. Buffering from the start makes a scripted operator behave the same as a person at a
 * terminal, which is what makes the handoff testable end to end.
 */

const CAPABILITIES_DIR = "capabilities";

/**
 * The audit table.
 *
 * Ordered oldest-first and printed in full rather than paged or filtered: the value of an audit
 * is that it is the whole ledger, and a tool that decides for you which runs are interesting is
 * a tool you have to audit in turn.
 */
async function printAudit(asJson: boolean): Promise<void> {
  const report = await auditRuns();

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (report.rows.length === 0) {
    process.stdout.write("\nNo runs under evidence/.\n");
    return;
  }

  // Truncation reserves the column separator: a value that fills its column exactly would
  // otherwise run into the next one and the table stops being readable at a glance.
  const pad = (text: string, width: number): string =>
    (text.length > width - 1 ? `${text.slice(0, width - 2)}…` : text).padEnd(width);
  const num = (value: number | undefined, width: number): string =>
    (value === undefined ? "—" : value.toLocaleString("en-US")).padStart(width);

  process.stdout.write(
    `\n${pad("RUN", 34)}${pad("WHAT", 26)}${pad("OUTCOME", 26)}${"CALLS".padStart(6)}${"IN".padStart(10)}${"OUT".padStart(8)}${"COST".padStart(11)}\n`,
  );
  for (const row of report.rows) {
    // A copy is shown — it is the run a reader is pointed at — but marked, because its numbers
    // are already in the totals under the original's row.
    // The marker is appended after truncation, not before: an outcome long enough to be cut —
    // `business_outcome:account_not_found` — would otherwise lose the "(copy)" along with its
    // tail, and a copy would read as a second execution.
    const marker = row.duplicateOf === undefined ? "" : " (copy)";
    const cost = formatCost(row.costUsd);
    process.stdout.write(
      pad(row.dir, 34) +
        pad(row.capabilityId ?? row.phase, 26) +
        pad(row.outcome, 26 - marker.length) +
        marker +
        num(row.modelCalls, 6) +
        num(row.tokens?.input, 10) +
        num(row.tokens?.output, 8) +
        (row.tokensPartial ? `${cost}+`.padStart(11) : cost.padStart(11)) +
        "\n",
    );
  }

  const { totals } = report;
  process.stdout.write(
    `\n  ${totals.runs} run(s), ${totals.modelCalls} model call(s)\n` +
      `  tokens : ${totals.tokens.input.toLocaleString("en-US")} in, ${totals.tokens.output.toLocaleString("en-US")} out` +
      (totals.tokens.cacheRead + totals.tokens.cacheWrite > 0
        ? `, ${totals.tokens.cacheRead.toLocaleString("en-US")} cache read, ${totals.tokens.cacheWrite.toLocaleString("en-US")} cache write`
        : "") +
      `\n  cost   : ${formatCost(totals.costUsd)}\n`,
  );

  // Two ways the total can understate the truth. Both are stated rather than left to be
  // inferred from a number that looks authoritative.
  if (totals.partial > 0) {
    process.stdout.write(
      `  note   : ${totals.partial} run(s) had a request throw before reporting usage (marked +).\n` +
        `           Their tokens and cost are a floor, not the whole bill.\n`,
    );
  }
  if (totals.duplicates > 0) {
    process.stdout.write(
      `  note   : ${totals.duplicates} row(s) are committed copies under examples/ of runs already\n` +
        `           counted above, and are excluded from these figures.\n`,
    );
  }
  if (totals.unaccounted > 0) {
    process.stdout.write(
      `  note   : ${totals.unaccounted} run(s) left no usage record — recorded before token accounting existed.\n` +
        `           Their model calls and cost are unknown, and are not in the figures above.\n`,
    );
  }
  if (totals.unpriced > 0) {
    process.stdout.write(
      `  note   : ${totals.unpriced} run(s) used a model with no rate in src/config.ts and are unpriced\n`,
    );
  }
  for (const bad of report.skipped) {
    process.stderr.write(`  UNREADABLE  ${bad.dir}: ${bad.reason}\n`);
  }
}

async function printCatalog(asJson: boolean): Promise<void> {
  const { entries, invalid } = await loadCatalog(CAPABILITIES_DIR);

  if (asJson) {
    // Exactly what an agent would be handed: approved capabilities only. A draft it can see is
    // a draft it will call.
    const { entries: callable } = await loadCatalog(CAPABILITIES_DIR, { agentFacing: true });
    process.stdout.write(`${JSON.stringify(callable.map(toToolDefinition), null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${entries.length} capability(ies) in ${CAPABILITIES_DIR}/\n\n`);
  for (const entry of entries) {
    const flags = [entry.status, entry.surface, `risk=${entry.risk}`].join(", ");
    process.stdout.write(`  ${entry.capabilityId}  v${entry.version}  [${flags}]\n`);
    process.stdout.write(`    ${entry.description}\n`);
    const inputs = Object.entries(entry.artifact.inputs)
      .map(([n, d]) => `${n}: ${d.type}${d.required ? "" : "?"}`)
      .join(", ");
    const outputs = Object.entries(entry.artifact.outputs)
      .map(([n, d]) => `${n}: ${d.type}`)
      .join(", ");
    process.stdout.write(`    in  (${inputs || "none"})\n`);
    process.stdout.write(`    out (${outputs || "none"})\n\n`);
  }
  for (const bad of invalid) {
    process.stderr.write(`  INVALID  ${bad.path}: ${bad.reason}\n`);
  }
}

async function runInvoke(args: ParsedArgs): Promise<void> {
  const capabilityId = args.artifactPath;
  if (!capabilityId) {
    process.stderr.write("invoke needs a capability id. Try: npm run cli -- capabilities\n");
    process.exit(1);
  }

  const policy = args.policyPath
    ? Policy.parse(JSON.parse(await readFile(args.policyPath, "utf8")))
    : defaultPolicy();

  const lines = args.interactive ? createLineReader() : undefined;
  const channel = lines
    ? new CliInterventionChannel({
        write: (text) => process.stdout.write(text),
        readLine: () => lines.next(),
      })
    : undefined;

  const result = await invoke(CAPABILITIES_DIR, capabilityId, args.inputs, {
    policy,
    allowDraft: args.allowDraft,
    ...(channel ? { interventionChannel: channel } : {}),
    secrets: {
      ...cliSecrets(),
    },
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    headed: args.headed,
    trace: args.trace ? "unredacted" : "off",
    reauthenticate: loginToParabank,
  });

  lines?.close();

  if ("notFound" in result) {
    process.stderr.write(
      `no capability "${capabilityId}". Available: ${result.notFound.join(", ") || "(none)"}\n`,
    );
    process.exit(1);
  }
  if ("refused" in result) {
    process.stderr.write(`${result.refused}\n`);
    process.exit(1);
  }

  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printResult(result);
  // The same four-state contract `replay` exposes. Collapsing escalated into failure would stop
  // an agent distinguishing "a human is now involved" from "this did not work".
  process.exit(exitCodeFor(result));
}

/** 0 = success or business outcome, 2 = escalated, 1 = failure. */
function exitCodeFor(result: RunResult): number {
  if (result.status === "success" || result.status === "business_outcome") return 0;
  return result.status === "escalated" ? 2 : 1;
}

async function runDiscovery(args: ParsedArgs): Promise<void> {
  if (!args.goal || !args.capability || !args.out) {
    process.stderr.write("discover needs --goal, --capability and --out.\n");
    process.exit(1);
  }
  if (!config.anthropicApiKey) {
    process.stderr.write(
      "\nANTHROPIC_API_KEY is not set.\n" +
        "Discovery is the one path that needs a model. Add it to .env:\n" +
        "  ANTHROPIC_API_KEY=sk-ant-...\n\n",
    );
    process.exit(1);
  }

  const policy = args.policyPath
    ? Policy.parse(JSON.parse(await readFile(args.policyPath, "utf8")))
    : defaultPolicy();

  process.stdout.write(`\ndiscovering: ${args.goal}\n\n`);

  const result = await discover({
    goal: args.goal,
    capabilityId: args.capability,
    baseUrl: args.baseUrl ?? config.parabank.baseUrl,
    policy,
    inputs: args.inputs,
    secrets: {
      ...cliSecrets(),
    },
    ...(args.maxSteps === undefined ? {} : { maxSteps: args.maxSteps }),
    headed: args.headed,
    apiKey: config.anthropicApiKey,
  });

  if (result.status !== "recorded") {
    process.stderr.write(`\n${result.status.toUpperCase()}: ${result.reason}\n`);
    process.stderr.write(`  model calls : ${result.modelCalls}\n`);
    process.stderr.write(`  evidence    : ${result.evidenceDir}\n\n`);
    process.exit(1);
  }

  await writeFile(args.out, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`\nRECORDED  ${result.artifact.capabilityId} v${result.artifact.version}\n`);
  process.stdout.write(`  status      : ${result.artifact.metadata.status}\n`);
  process.stdout.write(`  steps       : ${result.artifact.steps.length}\n`);
  process.stdout.write(`  model calls : ${result.modelCalls}\n`);
  process.stdout.write(`  artifact    : ${args.out}\n`);
  process.stdout.write(`  evidence    : ${result.evidenceDir}\n\n`);
}

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
