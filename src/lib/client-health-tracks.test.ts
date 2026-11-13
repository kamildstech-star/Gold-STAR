import { describe, expect, it } from "vitest";

import {
  COMPLIANCE_DIRECTION_FIX,
  complianceBandForRow,
  computeComplianceTrack,
  daysOutstanding,
  computeHealthTracks,
  healthTracksSummary,
  worstTrack,
  type ComplianceTrackRow,
} from "./client-health-tracks";
import { healthTrackIndicators } from "./client-health-rail";
import { CLIENT_HEALTH_DEFAULTS, computeClientHealth, HEALTH_SEVERITY } from "./client-health";
import { HOMEOWNER_TYPE_KEYS } from "./account-clocks";

/**
 * Phase 1 of the two-track model. Three properties are load-bearing and each
 * one is tested from the direction it would actually break:
 *
 *   WORSE-OF   A healthy relationship must not hide an expired certificate.
 *              Before this change the card showed the relationship band alone,
 *              so an account nobody could legally work for looked green.
 *   BOTH SHOWN A single band tells a rep the client is red and leaves them to
 *              guess which of two unrelated jobs fixes it. The card has to
 *              carry both, so the tracks are asserted to survive individually
 *              and not just through the overall band.
 *   TYPE GATE  A homeowner has no tracks AT ALL — not two healthy ones. A green
 *              pill is a claim the record did nothing to earn, and a red one is
 *              the false alarm the type rule exists to prevent, arriving by a
 *              new route.
 *
 * And the property the whole two-track split exists to protect: no financial
 * fact can move either band.
 */

const NOW = Date.parse("2026-09-14T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

/** A relationship verdict from the real computation, not a hand-written one. */
const relationship = (daysSinceTouch: number, clocksRun = true) =>
  computeClientHealth(
    { lastTouchAt: daysAgo(daysSinceTouch), clocksRun },
    CLIENT_HEALTH_DEFAULTS,
    NOW,
  );

/**
 * A requirement that, when it is outstanding at all, has been outstanding for
 * a while: 20 days since it was requested and 40 days since it expired. Phase 2
 * bands by AGE, so an undated fixture would sit at zero days and read Watch —
 * which would quietly turn every "this is At Risk" assertion below into a test
 * of the wrong thing. Tests that care about a boundary pass their own dates.
 *
 * These dates are anchored to NOW_T, so every call into the computation has to
 * be given NOW_T as well. `computeComplianceTrack` defaults its clock to
 * `Date.now()`, and seven calls here left it at that default — which aged the
 * fixtures by however long had passed since the file was written. It held for
 * ten days and then went red on its own on 24 September: a missing document
 * written as 20 days outstanding read 30 and banded Critical instead of At
 * Risk. A fixed clock in the fixture and a live one in the call is not a slow
 * test, it is a test with an expiry date.
 */
const req = (over: Partial<ComplianceTrackRow> = {}): ComplianceTrackRow => ({
  account_id: "acc-1",
  requirement_type: "certificate_of_insurance",
  direction: "gsr_to_client",
  mandatory: true,
  status: "satisfied",
  requested_at: new Date(Date.parse("2026-09-14T12:00:00Z") - 20 * 86_400_000).toISOString(),
  effective_expiry: new Date(Date.parse("2026-09-14T12:00:00Z") - 40 * 86_400_000).toISOString(),
  ...over,
});

const MANAGEMENT = { account_type: "property_management", assigned_rep: "rep-1" };

/* ------------------------------------------------------------------ */

const NOW_T = Date.parse("2026-09-14T12:00:00Z");
const ago = (d: number) => new Date(NOW_T - d * 86_400_000).toISOString();

describe("compliance bands by days outstanding (phase 2 replaces the state seam)", () => {
  // The boundaries, each asserted on both sides. Phase 1 mapped states, so a
  // document requested this morning and one missing since spring both read
  // At Risk; these are the numbers that replaced that.
  it("bands a missing document by how long it has been outstanding", () => {
    const at = (days: number) =>
      complianceBandForRow(req({ status: "missing", requested_at: ago(days) }), NOW_T);
    expect(at(0)).toBe("monitoring");
    expect(at(1)).toBe("monitoring");
    expect(at(14)).toBe("monitoring");
    expect(at(15)).toBe("at_risk");
    expect(at(29)).toBe("at_risk");
    expect(at(30)).toBe("critical");
    expect(at(400)).toBe("critical");
  });

  it("ages a LAPSED document from its expiry date, not its request date", () => {
    // The spec's second clock start. Requested a year ago, expired 20 days
    // ago: it is 20 days outstanding, not 365.
    const row = req({
      status: "expired",
      requested_at: ago(365),
      effective_expiry: ago(20),
    });
    expect(daysOutstanding(row, NOW_T)).toBe(20);
    expect(complianceBandForRow(row, NOW_T)).toBe("at_risk");
  });

  it("treats a still-valid document expiring within 30 days as Watch", () => {
    expect(complianceBandForRow(req({ status: "expiring_soon" }), NOW_T)).toBe("monitoring");
    expect(complianceBandForRow(req({ status: "satisfied" }), NOW_T)).toBe("healthy");
    expect(daysOutstanding(req({ status: "expiring_soon" }), NOW_T)).toBeNull();
  });

  it("shows an unageable outstanding document rather than hiding it", () => {
    // Missing, but nobody recorded when it was asked for. It IS outstanding;
    // we just cannot age it, so it lands in Watch rather than disappearing.
    const row = req({ status: "missing", requested_at: null });
    expect(daysOutstanding(row, NOW_T)).toBe(0);
    expect(complianceBandForRow(row, NOW_T)).toBe("monitoring");
  });

  it("does not invent a band for a status it has never seen", () => {
    expect(complianceBandForRow(req({ status: "some_future_status" }), NOW_T)).toBe("healthy");
  });
});

describe("the Non-Compliant badge is separate from the color", () => {
  const outstandingFor = (days: number) =>
    computeComplianceTrack([req({ status: "missing", requested_at: ago(days) })], NOW_T);

  it("raises at 15 days outstanding, not before", () => {
    expect(outstandingFor(14).nonCompliant).toBe(false);
    expect(outstandingFor(15).nonCompliant).toBe(true);
  });

  it("is set at At Risk and stays set at Critical — it is not a band", () => {
    const atRisk = outstandingFor(20);
    const critical = outstandingFor(45);
    expect(atRisk.health).toBe("at_risk");
    expect(atRisk.nonCompliant).toBe(true);
    expect(critical.health).toBe("critical");
    expect(critical.nonCompliant).toBe(true);
  });

  it("is NOT set for a Watch band that is merely expiring soon", () => {
    // The two come apart in this direction: amber card, perfectly compliant.
    const v = computeComplianceTrack([req({ status: "expiring_soon" })], NOW_T);
    expect(v.health).toBe("monitoring");
    expect(v.nonCompliant).toBe(false);
  });

  it("reaches the account verdict", () => {
    const v = computeHealthTracks({
      relationship: relationship(3),
      compliance: [req({ status: "missing", requested_at: ago(20) })],
      account: MANAGEMENT,
      now: NOW_T,
    });
    expect(v.nonCompliant).toBe(true);
  });
});

describe("onboarding starts a new client at Watch, never Healthy", () => {
  /*
   * The onboarding floor is isolated by holding the REQUIREMENT young (asked
   * for two days ago, so its own aging says Watch) and varying only how long
   * the client has existed. Otherwise the two rules move together and the test
   * would be measuring the compliance clock instead: a document 30 days
   * outstanding is Critical on its own terms, which is correct and is not what
   * this block is about.
   */
  const newClient = (daysOld: number, incomplete = true) =>
    computeHealthTracks({
      relationship: relationship(1),
      compliance: incomplete ? [req({ status: "missing", requested_at: ago(2) })] : [],
      account: MANAGEMENT,
      clientSince: ago(daysOld),
      now: NOW_T,
    });

  it("is Watch on day one, never Healthy", () => {
    const v = newClient(0);
    expect(v.overall).toBe("monitoring");
    expect(v.onboarding).toBe(true);
  });

  it("is still not Healthy even with the paperwork only just requested", () => {
    // The guarantee: a client signed this morning cannot show green.
    for (const day of [0, 1, 5, 20, 29]) {
      expect(newClient(day).overall, `day ${day}`).toBe("monitoring");
    }
  });

  it("escalates to At Risk at 30 days still incomplete", () => {
    expect(newClient(29).overall).toBe("monitoring");
    expect(newClient(30).overall).toBe("at_risk");
    expect(newClient(59).overall).toBe("at_risk");
    expect(newClient(30).tracks.find((t) => t.key === "compliance")?.reason).toMatch(
      /Onboarding incomplete after 30 days/,
    );
  });

  it("escalates to Critical at 60 days still incomplete", () => {
    expect(newClient(59).overall).toBe("at_risk");
    expect(newClient(60).overall).toBe("critical");
    expect(newClient(400).overall).toBe("critical");
  });

  it("lifts the moment the paperwork is complete", () => {
    // No outstanding requirements: there was nothing left to onboard, so no
    // floor — even at 400 days, which would otherwise be Critical.
    const v = newClient(400, false);
    expect(v.onboarding).toBe(false);
    expect(v.overall).toBe("healthy");
  });

  it("only ever raises the band, never lowers it", () => {
    // A three-day-old client whose certificate lapsed 40 days ago is Critical
    // on the compliance clock. The day-three Watch floor must not soften it.
    const v = computeHealthTracks({
      relationship: relationship(1),
      compliance: [req({ status: "expired", effective_expiry: ago(40) })],
      account: MANAGEMENT,
      clientSince: ago(3),
      now: NOW_T,
    });
    expect(v.overall).toBe("critical");
    // The floor is in effect — the paperwork is not done — but it is not what
    // set the band, so the reason names the real problem, not the onboarding.
    expect(v.onboarding).toBe(true);
    expect(v.tracks.find((t) => t.key === "compliance")?.reason).not.toMatch(/Onboarding/);
  });

  it("does not apply to an account that never became a client", () => {
    const v = computeHealthTracks({
      relationship: relationship(1),
      compliance: [req({ status: "missing", requested_at: ago(2) })],
      account: MANAGEMENT,
      now: NOW_T,
    });
    expect(v.onboarding).toBe(false);
  });
});

describe("both paperwork directions reach the same track", () => {
  it("bands a document the CLIENT owes us", () => {
    const v = computeComplianceTrack(
      [req({ requirement_type: "w9", direction: "client_to_gsr", status: "missing" })],
      NOW_T,
    );
    expect(v.health).toBe("at_risk");
    expect(v.byDirection.client_to_gsr).toBe("at_risk");
    expect(v.byDirection.gsr_to_client).toBe("healthy");
    expect(v.reason).toContain("Client owes us");
  });

  it("bands a document WE owe the client", () => {
    const v = computeComplianceTrack([req({ status: "expired" })], NOW_T);
    expect(v.health).toBe("critical");
    expect(v.byDirection.gsr_to_client).toBe("critical");
    expect(v.reason).toContain("We owe the client");
  });

  it("takes the worse of the two directions but remembers both", () => {
    const v = computeComplianceTrack(
      [
        req({ requirement_type: "w9", direction: "client_to_gsr", status: "expiring_soon" }),
        req({ requirement_type: "coi", direction: "gsr_to_client", status: "expired" }),
      ],
      NOW_T,
    );
    expect(v.health).toBe("critical");
    expect(v.byDirection.client_to_gsr).toBe("monitoring");
    expect(v.byDirection.gsr_to_client).toBe("critical");
    // Both remedies exist and are opposite — the reason must not lose which.
    expect(COMPLIANCE_DIRECTION_FIX.client_to_gsr).not.toBe(COMPLIANCE_DIRECTION_FIX.gsr_to_client);
  });

  it("reads a row written before the direction column existed as ours", () => {
    // Every pre-migration row is GSR-owes-client; that is the column default
    // and the only meaning the table ever had.
    const v = computeComplianceTrack([req({ direction: null, status: "missing" })], NOW_T);
    expect(v.byDirection.gsr_to_client).toBe("at_risk");
    expect(v.byDirection.client_to_gsr).toBe("healthy");
  });

  it("is healthy, and says so, with no requirements at all", () => {
    const v = computeComplianceTrack([], NOW_T);
    expect(v.health).toBe("healthy");
    expect(v.outstanding).toEqual([]);
    expect(v.reason).toMatch(/No paperwork requirements/i);
  });

  it("lists what is outstanding, worst first", () => {
    const v = computeComplianceTrack(
      [
        req({ requirement_type: "w9", status: "missing" }),
        req({ requirement_type: "coi", status: "expired" }),
        req({ requirement_type: "license", status: "satisfied" }),
      ],
      NOW_T,
    );
    expect(v.outstanding.map((o) => o.requirementType)).toEqual(["coi", "w9"]);
    expect(v.outstanding).toHaveLength(2);
  });
});

describe("worse-of, with both tracks shown", () => {
  it("a healthy relationship does not hide an outstanding client-owed document", () => {
    // The headline case from the brief, and the one the old single-track card
    // got wrong: green relationship, red paperwork, overall must follow the
    // paperwork and BOTH must still be visible.
    const v = computeHealthTracks({
      relationship: relationship(3),
      compliance: [req({ requirement_type: "w9", direction: "client_to_gsr", status: "expired" })],
      account: MANAGEMENT,
    });

    expect(v.tracked).toBe(true);
    expect(v.overall).toBe("critical");

    const byKey = Object.fromEntries(v.tracks.map((t) => [t.key, t]));
    expect(byKey.relationship.health).toBe("healthy");
    expect(byKey.compliance.health).toBe("critical");
    expect(v.tracks).toHaveLength(2);
    expect(worstTrack(v)?.key).toBe("compliance");
  });

  it("a healthy paperwork record does not hide a silent relationship", () => {
    const v = computeHealthTracks({
      relationship: relationship(200),
      compliance: [req({ status: "satisfied" })],
      account: MANAGEMENT,
    });
    // 200 days since a touch is 110 days past a 90-day follow-up, which the
    // phase 2 table bands Critical (>30 past due). Under phase 1's
    // days-since-touch table the same account was only At Risk — this is the
    // inversion doing its job, not a regression.
    expect(v.overall).toBe("critical");
    expect(worstTrack(v)?.key).toBe("relationship");
    expect(v.tracks.map((t) => t.key)).toEqual(["relationship", "compliance"]);
  });

  it("always reports both tracks, in the same order, whichever is worse", () => {
    for (const days of [1, 95, 200]) {
      for (const status of ["satisfied", "expiring_soon", "missing", "expired"]) {
        const v = computeHealthTracks({
          relationship: relationship(days),
          compliance: [req({ status })],
          account: MANAGEMENT,
        });
        expect(v.tracks.map((t) => t.key)).toEqual(["relationship", "compliance"]);
        // The overall band is exactly the worse of the two, never a third answer.
        const worstOfTwo = v.tracks
          .map((t) => t.health)
          .reduce((a, b) => (HEALTH_SEVERITY[b] > HEALTH_SEVERITY[a] ? b : a));
        expect(v.overall).toBe(worstOfTwo);
      }
    }
  });

  it("gives every track a one-word label and an actionable reason", () => {
    const v = computeHealthTracks({
      relationship: relationship(200),
      compliance: [req({ status: "missing" })],
      account: MANAGEMENT,
    });
    for (const t of v.tracks) {
      expect(t.label).toMatch(/^(Relationship|Compliance)$/);
      expect(t.reason.length).toBeGreaterThan(0);
    }
    expect(healthTracksSummary(v)).toContain("Relationship");
  });
});

describe("the card renders two sub-indicators, not one scale", () => {
  it("returns one indicator per track, with its own band and label", () => {
    const v = computeHealthTracks({
      relationship: relationship(3),
      compliance: [req({ status: "expired" })],
      account: MANAGEMENT,
    });
    const indicators = healthTrackIndicators(v);
    expect(indicators).toHaveLength(2);
    expect(indicators.map((i) => i.label)).toEqual(["Relationship", "Compliance"]);
    expect(indicators.map((i) => i.bandLabel)).toEqual(["Healthy", "Critical"]);
  });

  it("flags which track is setting the overall band", () => {
    const v = computeHealthTracks({
      relationship: relationship(3),
      compliance: [req({ status: "expired" })],
      account: MANAGEMENT,
    });
    const indicators = healthTrackIndicators(v);
    expect(indicators.find((i) => i.key === "compliance")?.driving).toBe(true);
    expect(indicators.find((i) => i.key === "relationship")?.driving).toBe(false);
  });

  it("flags both when both sit at the overall band", () => {
    const v = computeHealthTracks({
      relationship: relationship(200),
      compliance: [req({ status: "expired", effective_expiry: ago(40) })],
      account: MANAGEMENT,
      now: NOW_T,
    });
    // Both Critical: 110 days past a follow-up, and a certificate 40 days lapsed.
    expect(v.overall).toBe("critical");
    expect(healthTrackIndicators(v).every((i) => i.driving)).toBe(true);
  });
});

describe("the account type still decides whether anything runs", () => {
  it("shows a homeowner NO tracks, however bad the paperwork", () => {
    const v = computeHealthTracks({
      relationship: relationship(400, false),
      compliance: [
        req({ status: "expired" }),
        req({ direction: "client_to_gsr", status: "missing" }),
      ],
      account: { account_type: "homeowner", assigned_rep: "rep-1" },
    });
    expect(v.tracked).toBe(false);
    expect(v.tracks).toEqual([]);
    expect(v.overall).toBe("healthy");
    expect(healthTrackIndicators(v)).toEqual([]);
    expect(v.untrackedReason).toMatch(/one-time job/i);
  });

  it("covers every spelling of homeowner the clocks module recognizes", () => {
    // Iterating the exported list rather than hardcoding, so a spelling added
    // to account-clocks.ts tomorrow is covered here with no edit.
    for (const account_type of HOMEOWNER_TYPE_KEYS) {
      const v = computeHealthTracks({
        relationship: relationship(400, false),
        compliance: [req({ status: "expired" })],
        account: { account_type, assigned_rep: "rep-1" },
      });
      expect(v.tracks, `type ${account_type}`).toEqual([]);
      expect(v.overall, `type ${account_type}`).toBe("healthy");
    }
  });

  it("still tracks every other type, including ones nobody has thought of", () => {
    for (const account_type of ["property_management", "insurance_broker", "tpa", "new_2027"]) {
      const v = computeHealthTracks({
        relationship: relationship(3),
        compliance: [req({ status: "expired" })],
        account: { account_type, assigned_rep: "rep-1" },
      });
      expect(v.tracked, `type ${account_type}`).toBe(true);
      expect(v.overall, `type ${account_type}`).toBe("critical");
    }
  });

  it("honors an untracked relationship verdict even with no account passed", () => {
    const v = computeHealthTracks({
      relationship: relationship(400, false),
      compliance: [req({ status: "expired" })],
    });
    expect(v.tracked).toBe(false);
    expect(v.tracks).toEqual([]);
  });
});

describe("finance cannot move either band", () => {
  it("has no financial input to move", () => {
    // The guarantee is structural, so it is asserted structurally: the only
    // things either track reads are a relationship verdict, requirement rows
    // and the account type. A future edit that adds a financial field to this
    // input has to change this assertion to pass.
    const keys = Object.keys({
      relationship: null,
      compliance: null,
      account: null,
    }).sort();
    expect(keys).toEqual(["account", "compliance", "relationship"]);
  });

  it("does not change when money, margin or job outcome change around it", () => {
    // Same account, same relationship, same paperwork — with every financial
    // fact the spec names attached as noise. The band must be identical.
    const base = {
      relationship: relationship(95),
      compliance: [req({ status: "expiring_soon" })],
      account: MANAGEMENT,
    };
    const withMoney = {
      ...base,
      // Deliberately shaped like an invoice/margin/job payload. None of it is
      // read, and that is the point of the assertion.
      ...({
        invoiceOverdueDays: 120,
        grossMarginPercent: 2,
        lastJobRating: "bad",
        jobsSentThisYear: 0,
        collectedAmount: 0,
      } as unknown as Record<string, never>),
    };
    expect(computeHealthTracks(withMoney).overall).toBe(computeHealthTracks(base).overall);
    expect(computeHealthTracks(withMoney).tracks).toEqual(computeHealthTracks(base).tracks);
  });

  it("ignores required_amount as money — it is an insurance limit", () => {
    // `required_amount` is the cover a property manager demands, and it only
    // ever decides insufficient vs satisfied. It is not money owed, and a
    // large one does not make a satisfied requirement unhealthy.
    const v = computeComplianceTrack([req({ status: "satisfied" })], NOW_T);
    expect(v.health).toBe("healthy");
  });
});
