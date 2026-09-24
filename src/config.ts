import "dotenv/config";
import { Policy } from "./schema.js";

const PORT = process.env.PARABANK_PORT ?? "8080";

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
  });
}
