/**
 * Redaction, applied to everything that leaves the process as evidence.
 *
 * This lives in its own module rather than inside the safety layer because evidence writing
 * needs it from the moment there is anything to write. PR4's policy layer extends a redactor
 * with `redactPatterns` from configuration; it does not replace the core rules here.
 *
 * The design bias is that redaction is applied at the *sink*, not at each call site. Every
 * event, error string, and observation goes through one function, so forgetting to redact
 * requires bypassing the recorder rather than merely forgetting a call.
 */

export type Redactor = (value: string) => string;

const MASK = "[REDACTED]";

/**
 * Patterns that are sensitive regardless of configuration. Ordered longest-match-first
 * concerns aside, each is independent.
 */
const BUILT_IN: Array<{ label: string; pattern: RegExp }> = [
  // Anthropic keys, and anything else shaped like a long bearer token.
  { label: "api-key", pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  { label: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi },
  // Values in URL query strings that name themselves.
  { label: "url-secret", pattern: /([?&](?:password|passwd|pwd|token|secret|api_?key)=)[^&#\s]+/gi },
  // JSON-ish `"password": "..."` regardless of surrounding structure.
  {
    label: "json-secret",
    pattern: /("(?:password|passwd|pwd|token|secret|api_?key)"\s*:\s*)"[^"]*"/gi,
  },
  // Long digit runs: card numbers and full account numbers in regulated data.
  { label: "long-digits", pattern: /\b\d{12,19}\b/g },
  // US SSN. ParaBank's registration form collects one.
  { label: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
];

/**
 * Builds a redactor over the built-in rules plus any literal secret values and extra patterns
 * supplied by the caller.
 *
 * Literal values matter more than patterns: the surest way to keep a password out of the logs
 * is to know the exact string and remove it, rather than hope a regex describes it.
 */
export function createRedactor(options: {
  /** Exact strings to scrub — e.g. the configured ParaBank password. Empty values ignored. */
  literals?: readonly string[];
  /** Extra regex sources from policy configuration. Invalid patterns are reported, not thrown. */
  patterns?: readonly string[];
  onInvalidPattern?: (pattern: string, error: string) => void;
} = {}): Redactor {
  const literals = (options.literals ?? [])
    .filter((v): v is string => typeof v === "string" && v.length >= 3)
    // Longest first, so a short secret that is a substring of a longer one cannot partially
    // mask it and leave a recognisable remainder.
    .sort((a, b) => b.length - a.length);

  const extra: RegExp[] = [];
  for (const source of options.patterns ?? []) {
    try {
      extra.push(new RegExp(source, "g"));
    } catch (err) {
      options.onInvalidPattern?.(source, err instanceof Error ? err.message : String(err));
    }
  }

  return (value: string): string => {
    if (!value) return value;
    let out = value;

    for (const literal of literals) {
      out = out.split(literal).join(MASK);
    }
    for (const { pattern } of BUILT_IN) {
      pattern.lastIndex = 0;
      // Where a rule captures the key name (`password=`), keep it and mask only the value.
      // The type check is load-bearing: for a pattern with no capture group, String.replace
      // passes the match OFFSET as the second argument, so testing for `undefined` would
      // splice the offset into the output.
      out = out.replace(pattern, (_match, ...rest: unknown[]) => {
        const captured = rest[0];
        return typeof captured === "string" ? `${captured}${MASK}` : MASK;
      });
    }
    for (const pattern of extra) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, MASK);
    }
    return out;
  };
}

/** Deep-redacts a JSON-serialisable value, including object keys' values and array members. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, redact);
    }
    return out as T;
  }
  return value;
}
