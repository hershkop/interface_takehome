import "dotenv/config";
import { Policy, type TokenUsage } from "./schema.js";

/** 18080, not 8080: the container only ever listens on 8080 internally, and 8080 on a
 *  developer machine is already spoken for more often than not. */
const PORT = process.env.PARABANK_PORT ?? "18080";

export const config = {
  parabank: {
    port: PORT,
    baseUrl: process.env.PARABANK_BASE_URL ?? `http://localhost:${PORT}/parabank`,
    username: process.env.PARABANK_USERNAME ?? "john",
    password: process.env.PARABANK_PASSWORD ?? "demo",
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
} as const;

export function origin(url: string): string {
  return new URL(url).origin;
}

/**
 * Default policy for the ParaBank demo. Deliberately narrow: one origin, no navigation outside
 * the /parabank context, and every action type except none. Tenants would supply their own.
 */
export function defaultPolicy(): Policy {
  return Policy.parse({
    allowedOrigins: [origin(config.parabank.baseUrl)],
    allowedPaths: ["/parabank/**"],
    redactPatterns: [],
    // Controls that move money. Replay reads risk off the artifact; discovery has no artifact
    // yet, so this is what stops an exploring model committing a transaction.
    riskyControls: ["^transfer$", "^pay$", "^submit", "confirm", "^delete", "withdraw"],
  });
}

/**
 * Published per-million-token rates, in USD.
 *
 * Cache reads bill at 0.1x the input rate and cache writes at 1.25x, so they are listed
 * separately rather than folded into `input` — a run that used caching would otherwise be
 * mispriced in whichever direction the fold went.
 *
 * Keyed by the exact model id recorded in `run.json`. A model absent from this table is
 * reported as unpriced rather than estimated: a made-up number in an audit is worse than an
 * admitted gap.
 */
export const MODEL_RATES_USD_PER_MTOK: Readonly<
  Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
} as const;

/**
 * Applies a rate card to recorded token counts.
 *
 * Deliberately a display-time function over stored tokens, not a field written into evidence:
 * prices change, and a run's cost recomputed under today's rates is a more honest answer than
 * a dollar figure frozen at a rate nobody can look up any more. Returns `undefined` when the
 * model is unknown or nothing was measured.
 */
export function priceRun(
  model: string | undefined,
  tokens: TokenUsage | undefined,
): number | undefined {
  if (model === undefined || tokens === undefined) return undefined;
  const rate = MODEL_RATES_USD_PER_MTOK[model];
  if (rate === undefined) return undefined;
  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheWrite * rate.cacheWrite) /
    1_000_000
  );
}
