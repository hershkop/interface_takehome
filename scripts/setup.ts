/**
 * Resets ParaBank to its seeded fixture state and verifies the accounts the demo capabilities
 * depend on actually exist.
 *
 * `POST /services/bank/initializeDB` is fixture setup — the automated task itself always goes
 * through the UI. Doing it over the API keeps the reviewer's starting state reproducible
 * instead of depending on whatever the container was left in.
 */
import { config } from "../src/config.js";

const { baseUrl } = config.parabank;

/** Tomcat needs ~20s after the container starts; poll rather than fail on a cold start. */
async function waitForParabank(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    const ok = await fetch(`${baseUrl}/index.htm`).then((r) => r.ok).catch(() => false);
    if (ok) {
      if (announced) process.stdout.write("\n");
      return true;
    }
    if (!announced) {
      process.stdout.write("waiting for ParaBank to finish starting");
      announced = true;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (announced) process.stdout.write("\n");
  return false;
}

async function main(): Promise<void> {
  process.stdout.write(`ParaBank at ${baseUrl}\n`);

  const reachable = await waitForParabank();
  if (!reachable) {
    console.error(
      `\nCannot reach ParaBank at ${baseUrl}\n\n` +
        `  1. Is it running?      docker compose up -d && docker compose ps\n` +
        `  2. Port already taken? Currently configured: ${config.parabank.port} (default 18080).\n` +
        `     If something else holds it, pick another and put BOTH in .env:\n` +
        `       PARABANK_PORT=19080\n` +
        `       PARABANK_BASE_URL=http://localhost:19080/parabank\n` +
        `     then: docker compose up -d --force-recreate\n`,
    );
    process.exit(1);
  }

  const init = await fetch(`${baseUrl}/services/bank/initializeDB`, { method: "POST" });
  if (!init.ok) {
    console.error(`initializeDB failed: HTTP ${init.status}`);
    process.exit(1);
  }
  process.stdout.write("seeded  POST /services/bank/initializeDB -> 204\n");

  const res = await fetch(`${baseUrl}/services/bank/customers/12212/accounts`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`could not read seeded accounts: HTTP ${res.status}`);
    process.exit(1);
  }
  const accounts = (await res.json()) as Array<{ id: number; type: string; balance: number }>;

  process.stdout.write(`\nSeeded accounts for ${config.parabank.username} (customer 12212):\n`);
  for (const a of accounts.slice(0, 6)) {
    process.stdout.write(`  ${a.id}  ${a.type.padEnd(8)} ${a.balance.toFixed(2).padStart(10)}\n`);
  }
  if (accounts.length > 6) process.stdout.write(`  ... and ${accounts.length - 6} more\n`);

  const savings = accounts.find((a) => a.type === "SAVINGS");
  process.stdout.write(
    `\nReady. Demo values:\n` +
      `  existing account : ${accounts[0]?.id ?? "?"}\n` +
      `  savings account  : ${savings?.id ?? "none"}\n` +
      `  absent account   : 99999   (-> business_outcome: account_not_found)\n`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
