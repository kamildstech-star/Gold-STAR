import { describe, expect, it } from "vitest";

import {
  ONBOARDING_LABELS,
  ONBOARDING_QUESTIONS,
  cleanOnboardingAnswers,
  isQuestionVisible,
  onboardingLabelForAccount,
  questionsForLabel,
} from "./onboarding-questions";

/**
 * Keys the database function pipeline_apply_onboarding acts on
 * (20260909140100). Everything else is kept verbatim on
 * accounts.onboarding_answers. Renaming one side without the other is the
 * bug this test exists to catch.
 */
const SERVER_KEYS = new Set([
  "coi_needed",
  "coi_limits",
  "coi_additional_insured",
  "w9_needed",
  "vendor_agreement_needed",
  "credentialing_platform",
  "credentialing_platform_name",
  "vendor_packet_required",
  "onboarding_into_system",
  "paperwork",
  "after_hours_protocol",
  "followup_cadence_days",
  "referral_fee",
]);

/**
 * Two of those keys are no longer asked anywhere: they were only on the Other
 * category, and Mark had it removed. The database function still handles them,
 * which is right — accounts onboarded before the removal have answers stored
 * under them and those answers must keep working. They are listed here so the
 * next person to read this does not take a key with no question as a typo.
 */
const RETIRED_KEYS = new Set(["paperwork", "followup_cadence_days"]);

describe("onboarding question catalog", () => {
  it("covers the five labels Mark kept, each with a referral-fee question", () => {
    // Mark: "remove the other tag and the questions associated with it."
    expect([...ONBOARDING_LABELS]).toEqual([
      "management",
      "insurance_broker",
      "public_adjuster",
      "direct_owner",
      "outside_referral",
    ]);
    for (const label of ONBOARDING_LABELS) {
      expect(questionsForLabel(label).some((q) => q.type === "referral_fee")).toBe(true);
    }
  });

  it("uses each key once per label and every acted-on key exists in the catalog", () => {
    const seen = new Set<string>();
    for (const label of ONBOARDING_LABELS) {
      const keys = ONBOARDING_QUESTIONS[label].map((q) => q.key);
      expect(new Set(keys).size).toBe(keys.length);
      keys.forEach((k) => seen.add(k));
    }
    // The point is the spelling: a key the server acts on and the screen asks
    // for has to match on both sides, or the answer lands nowhere.
    for (const k of SERVER_KEYS) {
      if (RETIRED_KEYS.has(k)) continue;
      expect(seen.has(k), `${k} is acted on by the server but nothing asks for it`).toBe(true);
    }
  });

  it("does not quietly ask for a retired key again", () => {
    // If one of these comes back it needs a deliberate decision about which
    // category asks it, not a copy-paste.
    const asked = new Set(
      ONBOARDING_LABELS.flatMap((l) => ONBOARDING_QUESTIONS[l].map((q) => q.key)),
    );
    for (const k of RETIRED_KEYS) expect(asked.has(k)).toBe(false);
  });

  it("asks Management the dispatch and after-hours questions, and Public Adjusters about loss types and states", () => {
    const mgmt = ONBOARDING_QUESTIONS.management.map((q) => q.key);
    expect(mgmt).toEqual(
      expect.arrayContaining([
        "coi_needed",
        "credentialing_platform",
        "vendor_packet_required",
        "dispatch_method",
        "after_hours_protocol",
        "referral_fee",
      ]),
    );
    expect(ONBOARDING_QUESTIONS.public_adjuster.map((q) => q.key)).toEqual([
      "referral_fee",
      "loss_types",
      "states_licensed",
    ]);
  });
});

describe("label for an account", () => {
  it("maps the account type first, then what they do, then nothing", () => {
    expect(onboardingLabelForAccount({ account_type: "property_management" })).toBe("management");
    expect(onboardingLabelForAccount({ account_type: "insurance_broker" })).toBe(
      "insurance_broker",
    );
    expect(onboardingLabelForAccount({ account_type: "public_adjusting_firm" })).toBe(
      "public_adjuster",
    );
    expect(onboardingLabelForAccount({ account_type: "property_owner" })).toBe("direct_owner");
    expect(onboardingLabelForAccount({ account_type: "referral_partner" })).toBe(
      "outside_referral",
    );
    expect(
      onboardingLabelForAccount({ account_type: "healthcare", what_they_do: ["broker"] }),
    ).toBe("insurance_broker");
    // Mark: "remove the other tag and the questions associated with it." An
    // account nothing matches is asked nothing, rather than being asked a set
    // of generic questions under a label he does not want to exist.
    expect(onboardingLabelForAccount({ account_type: "healthcare", what_they_do: [] })).toBeNull();
    expect(onboardingLabelForAccount({})).toBeNull();
  });
});

describe("answers", () => {
  it("hides the COI limits until COI is needed", () => {
    const limits = ONBOARDING_QUESTIONS.management.find((q) => q.key === "coi_limits")!;
    expect(isQuestionVisible(limits, {})).toBe(false);
    expect(isQuestionVisible(limits, { coi_needed: false })).toBe(false);
    expect(isQuestionVisible(limits, { coi_needed: true })).toBe(true);
  });

  it("drops blanks, hidden answers and empty fee widgets; an untouched form submits {}", () => {
    expect(cleanOnboardingAnswers("management", {})).toEqual({});
    expect(
      cleanOnboardingAnswers("management", {
        coi_needed: false,
        coi_limits: "$2M", // hidden because COI is off
        dispatch_method: "",
        after_hours_protocol: "  ",
        referral_fee: { basis: undefined, rate_percent: "", notes: "" },
        loss_types: [], // not a Management question at all
      }),
    ).toEqual({ coi_needed: false });
    expect(
      cleanOnboardingAnswers("direct_owner", {
        coi_needed: true,
        coi_limits: "$2M GL",
        w9_needed: true,
        referral_fees: [{ basis: "percent", rate_percent: 10 }, { notes: "" }],
      }),
    ).toEqual({
      coi_needed: true,
      coi_limits: "$2M GL",
      w9_needed: true,
      referral_fees: [{ basis: "percent", rate_percent: 10 }],
    });
  });
});
