import { describe, expect, it } from "vitest";
import {
  coerce,
  coerceInput,
  isSensitiveSecretKey,
  referencesIn,
  resolveTemplate,
  TemplateError,
  type TemplateScope,
} from "../src/template.js";

const scope = (over: Partial<TemplateScope> = {}): TemplateScope => ({
  baseUrl: "http://app.test/bank",
  inputs: { accountId: "12678", amount: 25 },
  secrets: { password: "s3cret", username: "john" },
  vars: { balanceText: "-$100.00" },
  ...over,
});

describe("resolveTemplate", () => {
  it("resolves each namespace", () => {
    expect(resolveTemplate("{{baseUrl}}/activity.htm?id={{inputs.accountId}}", scope())).toBe(
      "http://app.test/bank/activity.htm?id=12678",
    );
    expect(resolveTemplate("{{secrets.password}}", scope())).toBe("s3cret");
    expect(resolveTemplate("{{vars.balanceText}}", scope())).toBe("-$100.00");
  });

  it("leaves literals untouched and tolerates whitespace in references", () => {
    expect(resolveTemplate("no references here", scope())).toBe("no references here");
    expect(resolveTemplate("{{ inputs.accountId }}", scope())).toBe("12678");
  });

  it("throws on an unresolved reference instead of substituting empty", () => {
    // Silently resolving to "" would type an empty string into a form or navigate to a
    // truncated URL — a failure that looks like an application problem and wastes a session.
    expect(() => resolveTemplate("{{inputs.nope}}", scope())).toThrow(TemplateError);
    expect(() => resolveTemplate("{{secrets.nope}}", scope())).toThrow(/unresolved/);
    expect(() => resolveTemplate("{{bogusNamespace.x}}", scope())).toThrow(TemplateError);
  });

  it("lists the references a string contains", () => {
    expect(referencesIn("{{baseUrl}}/x/{{inputs.accountId}}")).toEqual([
      "baseUrl",
      "inputs.accountId",
    ]);
  });
});

describe("isSensitiveSecretKey", () => {
  it("treats credential-shaped keys as sensitive", () => {
    for (const k of ["password", "parabankPassword", "apiKey", "authToken", "ssn", "userPin"]) {
      expect(isSensitiveSecretKey(k), k).toBe(true);
    }
  });

  it("does not redact a username", () => {
    // Registering "john" as a redaction literal would scrub it from every event and make the
    // evidence unreadable while protecting nothing.
    expect(isSensitiveSecretKey("username")).toBe(false);
    expect(isSensitiveSecretKey("parabankUsername")).toBe(false);
  });
});

describe("coerce", () => {
  it("reads the currency formats a real screen renders", () => {
    // parseFloat("-$100.00") is NaN, which is the whole reason this exists.
    expect(coerce("-$100.00", "currency", "number")).toEqual({ ok: true, value: -100 });
    expect(coerce("$1,234.56", "currency", "number")).toEqual({ ok: true, value: 1234.56 });
    expect(coerce("$0.00", "currency", "number")).toEqual({ ok: true, value: 0 });
    // Accounting negatives.
    expect(coerce("($250.00)", "currency", "number")).toEqual({ ok: true, value: -250 });
  });

  it("reports unreadable currency rather than returning NaN", () => {
    const r = coerce("balance unavailable", "currency", "number");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("currency");
  });

  it("handles the other coercions", () => {
    expect(coerce("  padded  ", "trim", "string")).toEqual({ ok: true, value: "padded" });
    expect(coerce("account 42", "int", "number")).toEqual({ ok: true, value: 42 });
    expect(coerce("3.5%", "number", "number")).toEqual({ ok: true, value: 3.5 });
  });

  it("still enforces the declared type when no coercion is requested", () => {
    // Otherwise a "typed output" is only a comment.
    expect(coerce("hello", undefined, "number").ok).toBe(false);
    expect(coerce("12.5", undefined, "number")).toEqual({ ok: true, value: 12.5 });
    expect(coerce("yes", undefined, "boolean")).toEqual({ ok: true, value: true });
    expect(coerce("no", undefined, "boolean")).toEqual({ ok: true, value: false });
  });

  it("rejects an unknown coercion", () => {
    expect(coerce("x", "hexadecimal", "string").ok).toBe(false);
  });
});

describe("coerceInput", () => {
  it("accepts a well-typed value", () => {
    expect(coerceInput("amount", "25", { type: "number" })).toEqual({ ok: true, value: 25 });
    expect(coerceInput("flag", "true", { type: "boolean" })).toEqual({ ok: true, value: true });
  });

  it("rejects a value of the wrong type", () => {
    expect(coerceInput("amount", "abc", { type: "number" }).ok).toBe(false);
    expect(coerceInput("flag", "maybe", { type: "boolean" }).ok).toBe(false);
  });

  it("enforces a declared pattern", () => {
    const definition = { type: "string", pattern: "^[0-9]{1,10}$" };
    expect(coerceInput("accountId", "12678", definition).ok).toBe(true);
    const bad = coerceInput("accountId", "12'; DROP--", definition);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("does not match");
  });

  it("reports an invalid pattern as an artifact problem, not a caller problem", () => {
    const r = coerceInput("x", "v", { type: "string", pattern: "([unclosed" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("artifact");
  });
});
