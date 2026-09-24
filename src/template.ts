/**
 * Template resolution and output coercion.
 *
 * Artifacts store references, never values: `{{inputs.accountId}}`, `{{secrets.password}}`,
 * `{{vars.balanceText}}`, `{{baseUrl}}`. Resolution happens immediately before each step, from
 * a scope assembled at invocation time.
 *
 * The property that matters: a secret exists only in the resolved string that is handed to the
 * browser. It is never written back into an artifact, and every sensitive secret value is
 * registered with the redactor before the run starts, so the resolved form cannot reach
 * evidence either.
 */

export interface TemplateScope {
  baseUrl: string;
  inputs: Record<string, unknown>;
  secrets: Record<string, string>;
  vars: Record<string, unknown>;
}

const REFERENCE = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

export class TemplateError extends Error {}

/**
 * Substitutes every `{{...}}` reference in a string.
 *
 * An unknown reference throws rather than resolving to empty. Silently substituting "" would
 * mean typing an empty string into a form field or navigating to a truncated URL — the kind of
 * failure that looks like an application problem and wastes a debugging session.
 */
export function resolveTemplate(input: string, scope: TemplateScope): string {
  return input.replace(REFERENCE, (_match, reference: string) => {
    const value = lookup(reference, scope);
    if (value === undefined) {
      throw new TemplateError(`unresolved reference {{${reference}}}`);
    }
    return String(value);
  });
}

function lookup(reference: string, scope: TemplateScope): unknown {
  if (reference === "baseUrl") return scope.baseUrl;

  const dot = reference.indexOf(".");
  if (dot < 0) return undefined;
  const namespace = reference.slice(0, dot);
  const key = reference.slice(dot + 1);

  switch (namespace) {
    case "inputs":
      return scope.inputs[key];
    case "secrets":
      return scope.secrets[key];
    case "vars":
      return scope.vars[key];
    default:
      return undefined;
  }
}

/** Every reference a string mentions. Used to validate an artifact before the browser opens. */
export function referencesIn(input: string): string[] {
  return [...input.matchAll(REFERENCE)].map((m) => m[1] as string);
}

/**
 * Whether a secret's *value* should be registered with the redactor.
 *
 * Not every credential is sensitive. Registering a username like "john" would scrub it from
 * every event and make the evidence unreadable while protecting nothing, so sensitivity is
 * decided by the key's name rather than by the fact that it arrived through `secrets`.
 */
export function isSensitiveSecretKey(key: string): boolean {
  return /pass|secret|token|key|credential|pin|ssn/i.test(key);
}

// ─── Output coercion ───────────────────────────────────────────────────────────

export type CoercionResult = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * Turns page text into a declared output type.
 *
 * Coercion is a closed set rather than anything pluggable. Every entry here has to round-trip
 * something a real screen actually renders — `currency` exists because ParaBank shows
 * `-$100.00`, and parsing that with parseFloat yields NaN.
 */
export function coerce(raw: string, kind: string | undefined, type: string): CoercionResult {
  const trimmed = raw.trim();

  switch (kind) {
    case "trim":
      break;
    case "currency": {
      // Accounting negatives appear as "-$100.00" and as "($100.00)"; both mean the same thing.
      const parenthesised = /^\(.*\)$/.test(trimmed);
      const negative = parenthesised || trimmed.includes("-");
      const digits = trimmed.replace(/[^0-9.]/g, "");
      if (!digits || Number.isNaN(Number.parseFloat(digits))) {
        return { ok: false, reason: `cannot read a currency amount from ${JSON.stringify(raw)}` };
      }
      const magnitude = Number.parseFloat(digits);
      return { ok: true, value: negative ? -magnitude : magnitude };
    }
    case "int": {
      const n = Number.parseInt(trimmed.replace(/[^0-9-]/g, ""), 10);
      if (Number.isNaN(n)) {
        return { ok: false, reason: `cannot read an integer from ${JSON.stringify(raw)}` };
      }
      return { ok: true, value: n };
    }
    case "number": {
      const n = Number.parseFloat(trimmed.replace(/[^0-9.eE+-]/g, ""));
      if (Number.isNaN(n)) {
        return { ok: false, reason: `cannot read a number from ${JSON.stringify(raw)}` };
      }
      return { ok: true, value: n };
    }
    case undefined:
      break;
    default:
      return { ok: false, reason: `unknown coercion ${kind}` };
  }

  // No coercion requested: the declared type still has to hold, or the contract is a lie.
  switch (type) {
    case "string":
      return { ok: true, value: trimmed };
    case "number": {
      const n = Number.parseFloat(trimmed);
      return Number.isNaN(n)
        ? { ok: false, reason: `output declared number but read ${JSON.stringify(raw)}` }
        : { ok: true, value: n };
    }
    case "boolean":
      return { ok: true, value: /^(true|yes|on|1)$/i.test(trimmed) };
    default:
      return { ok: false, reason: `unknown output type ${type}` };
  }
}

/** Validates and coerces an invocation input against its declaration. */
export function coerceInput(
  name: string,
  raw: unknown,
  definition: { type: string; pattern?: string | undefined },
): CoercionResult {
  if (definition.type === "number") {
    const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (Number.isNaN(n)) return { ok: false, reason: `input "${name}" must be a number` };
    return { ok: true, value: n };
  }
  if (definition.type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (/^(true|false)$/i.test(String(raw))) {
      return { ok: true, value: /^true$/i.test(String(raw)) };
    }
    return { ok: false, reason: `input "${name}" must be true or false` };
  }

  const value = String(raw);
  if (definition.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(definition.pattern);
    } catch {
      return { ok: false, reason: `input "${name}" has an invalid pattern in the artifact` };
    }
    if (!re.test(value)) {
      return { ok: false, reason: `input "${name}" does not match ${definition.pattern}` };
    }
  }
  return { ok: true, value };
}
