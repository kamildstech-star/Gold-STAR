/**
 * The pure parts of a show's intake link: what it is called, how long it
 * lives, where it points, and what a booth submission has to contain before
 * it is worth an account.
 */
import { describe, expect, it } from "vitest";

import {
  defaultShowLinkLabel,
  isLinkLive,
  showLinkExpiry,
  tradeshowIntakeUrl,
} from "@/lib/tradeshow-intake";
import { boothSubmissionProblem } from "@/lib/tradeshow-intake.server";
import { findTradeshowLeadSourceId } from "@/lib/tradeshow-lead-source";

const NOW = new Date("2026-09-03T12:00:00.000Z");
const DAY = 86_400_000;

describe("a show link", () => {
  it("is named after the show unless someone says otherwise", () => {
    expect(defaultShowLinkLabel({ name: "RIMS 2026" })).toBe("RIMS 2026");
    expect(defaultShowLinkLabel({ name: "   " })).toBe("Trade show form");
  });

  it("points at the public intake route", () => {
    expect(tradeshowIntakeUrl("abc123", "https://hub.example.com")).toBe(
      "https://hub.example.com/intake/abc123",
    );
  });

  it("lives for the office default when the show is soon", () => {
    const iso = showLinkExpiry({ starts_on: "2026-09-10", ends_on: "2026-09-11" }, 30, NOW);
    expect(new Date(iso).getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  it("never expires before two weeks after the show's last day", () => {
    const iso = showLinkExpiry({ starts_on: "2026-11-02", ends_on: "2026-11-04" }, 30, NOW);
    expect(iso).toBe(new Date(Date.parse("2026-11-04T23:59:59Z") + 14 * DAY).toISOString());
  });

  it("uses the start date when there is no end date, and copes with neither", () => {
    const one = showLinkExpiry({ starts_on: "2026-12-01", ends_on: null }, 30, NOW);
    expect(one).toBe(new Date(Date.parse("2026-12-01T23:59:59Z") + 14 * DAY).toISOString());
    const none = showLinkExpiry({ starts_on: null, ends_on: null }, 30, NOW);
    expect(new Date(none).getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  it("is live until it is withdrawn or runs out", () => {
    const later = new Date(NOW.getTime() + DAY).toISOString();
    const earlier = new Date(NOW.getTime() - DAY).toISOString();
    expect(isLinkLive({ revoked_at: null, expires_at: later }, NOW.getTime())).toBe(true);
    expect(isLinkLive({ revoked_at: earlier, expires_at: later }, NOW.getTime())).toBe(false);
    expect(isLinkLive({ revoked_at: null, expires_at: earlier }, NOW.getTime())).toBe(false);
  });
});

describe("a booth submission", () => {
  it("needs someone and a way to reach them, not an address", () => {
    expect(boothSubmissionProblem({})).toMatch(/name or your company/);
    expect(boothSubmissionProblem({ customer_name: "Dana" })).toMatch(/phone|email/);
    expect(
      boothSubmissionProblem({ company: "Harbor Point", customer_email: "d@hp.com" }),
    ).toBeNull();
    expect(boothSubmissionProblem({ customer_name: "Dana", customer_phone: "555" })).toBeNull();
    expect(boothSubmissionProblem({ site_address: "1 Main St", customer_phone: "555" })).toMatch(
      /name or your company/,
    );
  });

  it("is tagged with the same lead source the tablet uses", () => {
    const opts = [
      { id: "a", key: "broker", label: "Broker" },
      { id: "b", key: "trade_show", label: "Trade show" },
    ];
    expect(findTradeshowLeadSourceId(opts)).toBe("b");
  });
});
