import { describe, expect, it } from "vitest";

import {
  TICKET_READ_FAILURES,
  TICKET_READ_FAILURE_CODE,
  classifyCallError,
  classifyGatewayError,
  isTicketReadFailure,
  ticketReadFailure,
  ticketReadFailureMessage,
} from "./field-ticket-read-failure";

describe("every failure is named, worded and coded", () => {
  it("gives each reason its own code, so a crew can read one out to the office", () => {
    const codes = TICKET_READ_FAILURES.map((r) => TICKET_READ_FAILURE_CODE[r]);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^FT-[A-Z]+$/);
  });

  it("prints the code after the message", () => {
    for (const reason of TICKET_READ_FAILURES) {
      expect(ticketReadFailureMessage(reason)).toMatch(
        new RegExp(`\\(Code ${TICKET_READ_FAILURE_CODE[reason]}\\)$`),
      );
    }
  });

  it("always ends on a way out — by hand, the office, or signing in", () => {
    for (const reason of TICKET_READ_FAILURES) {
      expect(ticketReadFailureMessage(reason)).toMatch(/by hand|sign in again/i);
    }
  });

  it("does not call a limiter that could not answer a spent budget", () => {
    // RateLimitOutcome.degraded: "they must not present it to the user as a limit".
    expect(ticketReadFailureMessage("limiter_unavailable")).not.toMatch(/too many/i);
    expect(ticketReadFailureMessage("rate_limited")).toMatch(/too many/i);
  });

  it("tells the budget's wait in whole minutes, never zero", () => {
    expect(ticketReadFailureMessage("rate_limited", { retryAfterSeconds: 610 })).toContain(
      "about 11 minutes",
    );
    expect(ticketReadFailureMessage("rate_limited", { retryAfterSeconds: 5 })).toContain(
      "about 1 minute,",
    );
  });

  it("builds a result the panel can show as it is", () => {
    expect(ticketReadFailure("not_configured")).toEqual({
      ok: false,
      reason: "not_configured",
      error: expect.stringContaining("Code FT-KEY"),
      retryable: false,
    });
    expect(ticketReadFailure("gateway").retryable).toBe(true);
  });

  it("recognizes its own reasons and nothing else", () => {
    expect(isTicketReadFailure("rate_limited")).toBe(true);
    expect(isTicketReadFailure("nope")).toBe(false);
    expect(isTicketReadFailure(undefined)).toBe(false);
  });
});

describe("classifyGatewayError", () => {
  it("names a missing key, which no retry will fix", () => {
    expect(classifyGatewayError("AI is not configured (missing LOVABLE_API_KEY).")).toBe(
      "not_configured",
    );
  });

  it("names spent credits", () => {
    expect(
      classifyGatewayError(
        "AI credits exhausted. Top up credits in workspace settings to keep using the assistant.",
      ),
    ).toBe("no_credits");
  });

  it("calls everything else the gateway", () => {
    expect(classifyGatewayError("AI request failed [500]: upstream")).toBe("gateway");
    expect(classifyGatewayError("AI rate limit reached. Try again in a moment.")).toBe("gateway");
  });
});

describe("classifyCallError", () => {
  it("reads the auth middleware's refusal as signed out", () => {
    expect(classifyCallError(new Error("Unauthorized: Invalid token"))).toBe("signed_out");
    expect(
      classifyCallError(new Error("Unauthorized: Account access is not approved or active")),
    ).toBe("signed_out");
  });

  it("reads a fetch that never connected as unreachable, in each browser's words", () => {
    expect(classifyCallError(new TypeError("Failed to fetch"))).toBe("unreachable");
    expect(classifyCallError(new TypeError("Load failed"))).toBe("unreachable");
    expect(
      classifyCallError(new TypeError("NetworkError when attempting to fetch resource.")),
    ).toBe("unreachable");
  });

  it("reads anything else as our own server", () => {
    expect(classifyCallError(new Error("Something exploded"))).toBe("server_error");
    expect(classifyCallError("a string")).toBe("server_error");
  });
});
