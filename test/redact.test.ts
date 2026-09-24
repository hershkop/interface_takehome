import { describe, expect, it } from "vitest";
import { createRedactor, redactDeep } from "../src/redact.js";

describe("createRedactor", () => {
  it("scrubs literal secrets it was given", () => {
    const redact = createRedactor({ literals: ["hunter2-the-password"] });
    expect(redact("logging in with hunter2-the-password now")).toBe(
      "logging in with [REDACTED] now",
    );
  });

  it("masks the longest literal first so a shorter one cannot leave a remainder", () => {
    // "abc" is a substring of "abcdef". Scrubbing the short one first would turn
    // "abcdef" into "[REDACTED]def" and leak the tail.
    const redact = createRedactor({ literals: ["abc", "abcdef"] });
    expect(redact("value=abcdef")).toBe("value=[REDACTED]");
  });

  it("ignores literals too short to be meaningfully secret", () => {
    // Scrubbing a 1-2 char "secret" would redact most of the log and hide real problems.
    const redact = createRedactor({ literals: ["a"] });
    expect(redact("a banana")).toBe("a banana");
  });

  it("removes API keys and bearer tokens without configuration", () => {
    const redact = createRedactor();
    expect(redact("key=sk-ant-api03-AAAAbbbbCCCC1234")).toBe("key=[REDACTED]");
    expect(redact("Authorization: Bearer eyJhbGciOi.payload.sig")).toContain("[REDACTED]");
  });

  it("masks secret-looking query parameters but keeps the parameter name", () => {
    const redact = createRedactor();
    expect(redact("GET /login?username=john&password=demo1234&next=/home")).toBe(
      "GET /login?username=john&password=[REDACTED]&next=/home",
    );
  });

  it("masks JSON secret values but keeps the key", () => {
    const redact = createRedactor();
    expect(redact('{"password": "demo", "user": "john"}')).toBe(
      '{"password": [REDACTED], "user": "john"}',
    );
  });

  it("masks regulated financial identifiers", () => {
    const redact = createRedactor();
    expect(redact("card 4111111111111111 ssn 123-45-6789")).toBe(
      "card [REDACTED] ssn [REDACTED]",
    );
  });

  it("leaves short account numbers legible, since they are what runs are about", () => {
    // ParaBank account ids are 5 digits. Redacting them would make evidence useless, and they
    // are not the regulated identifiers the rule targets.
    const redact = createRedactor();
    expect(redact("account 12345 balance -100.00")).toBe("account 12345 balance -100.00");
  });

  it("applies extra policy patterns", () => {
    const redact = createRedactor({ patterns: ["CUST-\\d+"] });
    expect(redact("customer CUST-99 logged in")).toBe("customer [REDACTED] logged in");
  });

  it("reports an invalid policy pattern instead of throwing", () => {
    const seen: string[] = [];
    const redact = createRedactor({
      patterns: ["([unclosed"],
      onInvalidPattern: (p) => seen.push(p),
    });
    expect(seen).toEqual(["([unclosed"]);
    expect(redact("still works")).toBe("still works");
  });
});

describe("redactDeep", () => {
  it("redacts nested strings, arrays, and object values", () => {
    const redact = createRedactor({ literals: ["s3cret-value"] });
    const input = {
      user: "john",
      creds: { password: "s3cret-value" },
      history: ["ok", "used s3cret-value here"],
      attempts: 3,
      nothing: null,
    };
    expect(redactDeep(input, redact)).toEqual({
      user: "john",
      creds: { password: "[REDACTED]" },
      history: ["ok", "used [REDACTED] here"],
      attempts: 3,
      nothing: null,
    });
  });
});
