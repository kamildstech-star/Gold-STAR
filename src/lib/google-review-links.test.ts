import { describe, expect, it } from "vitest";

import {
  googleReviewTrackingUrl,
  normalizeGoogleReviewDestination,
} from "@/lib/google-review-links";

describe("Google review links", () => {
  it("accepts common Google Business review destinations", () => {
    expect(normalizeGoogleReviewDestination("https://g.page/r/example/review")).toBe(
      "https://g.page/r/example/review",
    );
    expect(
      normalizeGoogleReviewDestination(
        "https://search.google.com/local/writereview?placeid=abc#ignored",
      ),
    ).toBe("https://search.google.com/local/writereview?placeid=abc");
    expect(normalizeGoogleReviewDestination("https://maps.app.goo.gl/example")).toBe(
      "https://maps.app.goo.gl/example",
    );
  });

  it("rejects insecure links and lookalike/open-redirect destinations", () => {
    expect(normalizeGoogleReviewDestination("http://g.page/r/example/review")).toBeNull();
    expect(normalizeGoogleReviewDestination("https://google.com.evil.example/review")).toBeNull();
    expect(normalizeGoogleReviewDestination("https://example.com/review")).toBeNull();
    expect(normalizeGoogleReviewDestination("not a url")).toBeNull();
  });

  it("builds a same-origin opaque tracking route", () => {
    expect(googleReviewTrackingUrl("abc-123", "https://app.example.com/")).toBe(
      "https://app.example.com/api/review/abc-123",
    );
  });
});
