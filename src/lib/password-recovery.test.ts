import { describe, expect, it } from "vitest";
import { isRecoveryLink, validateRecoveryPassword } from "./password-recovery";

describe("password recovery", () => {
  it("does not treat a regular sign-in link as recovery", () => {
    expect(isRecoveryLink("https://hub.test/reset-password#type=recovery")).toBe(true);
    expect(isRecoveryLink("https://hub.test/reset-password#type=signup")).toBe(false);
    expect(isRecoveryLink("https://hub.test/reset-password")).toBe(false);
  });
  it("requires matching passwords", () => {
    expect(validateRecoveryPassword("new-password", "other-password")).toBe("Passwords do not match.");
    expect(validateRecoveryPassword("new-password", "new-password")).toBeNull();
  });
  it("rejects passwords shorter than the existing eight-character minimum", () => {
    expect(validateRecoveryPassword("1234567", "1234567")).toBe("Password must be at least 8 characters.");
    expect(validateRecoveryPassword("12345678", "12345678")).toBeNull();
  });
});