import { describe, expect, it } from "vitest";

import { collectAnswers, todayLocal, visibleQuestions } from "@/components/activate-client-dialog";
import {
  ONBOARDING_LABEL_TITLE,
  ONBOARDING_QUESTIONS,
  onboardingLabelFromNames,
} from "@/lib/onboarding-questions";
import type { OnboardingQuestion } from "@/lib/onboarding-questions";

/**
 * Mark, on dropping a deal into Active Clients: "a small screen appears with
 * everything already filled in ... None of the fields are mandatory."
 *
 * Not mandatory has a consequence that is easy to get wrong: a field somebody
 * left alone must not be sent as an answer, or the server creates a task for
 * work nobody agreed to. These are the two pure decisions behind that.
 */
const q = (key: string, extra: Partial<OnboardingQuestion> = {}): OnboardingQuestion => ({
  key,
  label: key,
  type: "text",
  ...extra,
});

describe("what the popup actually sends", () => {
  it("sends nothing for a question left alone", () => {
    const qs = [q("a"), q("b"), q("c")];
    expect(collectAnswers(qs, { a: undefined, b: "", c: null }, {})).toEqual({});
  });

  it("drops an empty multiselect, which is not an answer either", () => {
    expect(
      collectAnswers([q("loss_types", { type: "multiselect" })], { loss_types: [] }, {}),
    ).toEqual({});
  });

  it("sends what was actually answered, including false", () => {
    // A deliberate "no" is an answer. Only absence is absence.
    const out = collectAnswers(
      [q("coi_needed", { type: "boolean" }), q("note")],
      {
        coi_needed: false,
        note: "call the office first",
      },
      {},
    );
    expect(out).toEqual({ coi_needed: false, note: "call the office first" });
  });

  it("only attaches a referral fee when something was entered", () => {
    expect(collectAnswers([], {}, {})).toEqual({});
    expect(collectAnswers([], {}, { basis: "percent", rate_percent: "10" })).toEqual({
      referral_fee: { basis: "percent", rate_percent: "10" },
    });
    // A note on its own still counts — somebody typed it for a reason.
    expect(collectAnswers([], {}, { notes: "pays on collection" })).toHaveProperty("referral_fee");
  });
});

describe("which questions are asked", () => {
  it("hides a follow-up until its trigger is answered", () => {
    const qs = [
      q("credentialing_platform", { type: "boolean" }),
      q("credentialing_platform_name", {
        showWhen: { key: "credentialing_platform", equals: true },
      }),
    ];
    expect(visibleQuestions(qs, {}).map((x) => x.key)).toEqual(["credentialing_platform"]);
    expect(visibleQuestions(qs, { credentialing_platform: true }).map((x) => x.key)).toEqual([
      "credentialing_platform",
      "credentialing_platform_name",
    ]);
    // Answered "no" hides it again.
    expect(visibleQuestions(qs, { credentialing_platform: false }).map((x) => x.key)).toEqual([
      "credentialing_platform",
    ]);
  });

  it("never sends the answer to a question it stopped asking", () => {
    // Tick the platform, name it, then untick. The name must not be sent.
    const qs = [
      q("credentialing_platform", { type: "boolean" }),
      q("credentialing_platform_name", {
        showWhen: { key: "credentialing_platform", equals: true },
      }),
    ];
    const answers = { credentialing_platform: false, credentialing_platform_name: "NetVendor" };
    expect(collectAnswers(visibleQuestions(qs, answers), answers, {})).toEqual({
      credentialing_platform: false,
    });
  });
});

describe("the question catalog the popup renders", () => {
  it("asks every label the referral fee question", () => {
    // Mark listed it under all six.
    for (const [label, qs] of Object.entries(ONBOARDING_QUESTIONS)) {
      expect(
        qs.some((x) => x.type === "referral_fee"),
        `${label} has no referral fee question`,
      ).toBe(true);
    }
  });

  it("asks the two labels that need a W-9 for one", () => {
    for (const label of ["direct_owner", "outside_referral"] as const) {
      expect(
        ONBOARDING_QUESTIONS[label].some((x) => x.key === "w9_needed"),
        `${label} does not ask for a W-9`,
      ).toBe(true);
    }
  });
});

describe("the green light date", () => {
  it("defaults to today in the viewer's own timezone", () => {
    // UTC is already tomorrow by teatime in New York, which would put the
    // client clock a day out for exactly the people using this.
    const local = todayLocal();
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(local).toBe(expected);
  });
});

/**
 * Mark: "each of these need to be labels as well and the questions tied to
 * them", listing the six categories.
 *
 * They existed as a question catalogue, but which one applied was only ever
 * INFERRED from account_type and what_they_do. That works until it does not:
 * an account typed commercial that is really a broker got the wrong questions
 * and there was no way to say so. A label put on by hand now decides, and the
 * inference stays as the fallback for accounts nobody has labelled.
 */
describe("which category's questions get asked", () => {
  it("uses a category label when the account carries one", () => {
    for (const [key, title] of Object.entries(ONBOARDING_LABEL_TITLE)) {
      expect(onboardingLabelFromNames([title]), title).toBe(key);
    }
  });

  it("ignores case and stray spacing, because people type labels", () => {
    expect(onboardingLabelFromNames(["  public adjuster "])).toBe("public_adjuster");
    expect(onboardingLabelFromNames(["INSURANCE BROKER"])).toBe("insurance_broker");
  });

  it("ignores labels that are not categories", () => {
    expect(onboardingLabelFromNames(["GIFTS OK", "LEGAL REVIEW"])).toBeNull();
    expect(onboardingLabelFromNames([])).toBeNull();
    expect(onboardingLabelFromNames(null)).toBeNull();
  });

  it("reads a category label wherever it sits in the list", () => {
    // Mark: "remove the other tag and the questions associated with it." There
    // is no catch-all left to demote, so an account carrying a stray "Other"
    // label from before the removal is simply read past.
    expect(onboardingLabelFromNames(["Other", "Management"])).toBe("management");
    expect(onboardingLabelFromNames(["Management", "Other"])).toBe("management");
    expect(onboardingLabelFromNames(["Other"])).toBeNull();
  });

  it("hands back to type inference when no category is labeled", () => {
    // Null, not a guess — the caller falls back to onboardingLabelForAccount.
    expect(onboardingLabelFromNames(["NO GIFTS"])).toBeNull();
  });
});
