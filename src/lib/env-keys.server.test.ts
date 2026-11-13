import { describe, expect, it } from "vitest";
import { issueToken, LOCKOUT_RULE, passwordMatches, secretStatus, tokenValid } from "./env-keys.server";

describe("env-keys gate", () => {
  it("locks out after 5 failures for 15 minutes", () => {
    expect(LOCKOUT_RULE).toMatchObject({ limit: 5, blockSeconds: 900 });
  });
  it("token lasts 15 minutes", () => {
    const now = 1_000_000;
    const { token } = issueToken("pw", now);
    expect(tokenValid(token, "pw", now + 14 * 60_000)).toBe(true);
    expect(tokenValid(token, "pw", now + 16 * 60_000)).toBe(false);
  });
  it("token dies when the password changes", () => {
    expect(tokenValid(issueToken("pw").token, "other")).toBe(false);
  });
  it("checks the password", () => {
    expect(passwordMatches("pw", "pw")).toBe(true);
    expect(passwordMatches("px", "pw")).toBe(false);
  });
  it("never returns a secret value", () => {
    process.env["CRON_SECRET"] = "super-secret-value";
    const out = JSON.stringify(secretStatus());
    expect(out).not.toContain("super-secret-value");
    expect(secretStatus().find((s) => s.name === "CRON_SECRET")?.isSet).toBe(true);
  });
});
