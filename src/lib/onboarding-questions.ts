/**
 * The Active Client onboarding popup — the question catalogue.
 *
 * Mark, 9 Sep 2026: when a Conversation Established record is dropped on
 * Active Clients, a popup asks a few label-specific questions and the system
 * does the rest — onboarding tasks, compliance items on the deal, the referral
 * fee per person. None of the questions is mandatory.
 *
 * This module is the ONE definition of those questions. The UI renders from
 * it; the answers go, as one object keyed by question key, to the database
 * function `pipeline_apply_onboarding(account_id, answers)` (migration
 * 20260909140100), which turns them into tasks, compliance requirements and
 * account_referral_fees rows and keeps the answers verbatim on
 * accounts.onboarding_answers. The keys below are the contract with that
 * function — rename here, rename there.
 */

export const ONBOARDING_LABELS = [
  "management",
  "insurance_broker",
  "public_adjuster",
  "direct_owner",
  "outside_referral",
] as const;
export type OnboardingLabel = (typeof ONBOARDING_LABELS)[number];

export const ONBOARDING_LABEL_TITLE: Record<OnboardingLabel, string> = {
  management: "Management",
  insurance_broker: "Insurance Broker",
  public_adjuster: "Public Adjuster",
  direct_owner: "Direct Owner",
  outside_referral: "Outside Referral",
};

/**
 * The same five as account LABELS, so the category can be put on an account by
 * hand rather than only inferred from its type. Six until Mark said "remove the
 * other tag and the questions assosiated with it"; the count is spelled out
 * here because a stale number is how somebody concludes one is missing.
 *
 * Mark asked for these "as labels ... and the questions tied to them". The
 * titles above are the label names, exactly, which is what lets a label found
 * on an account resolve back to its question set. Seeded by migration
 * 20260910190000; renaming one in Admin breaks that link, which is why the
 * lookup below falls back rather than throwing.
 */
export function onboardingLabelFromNames(
  names: readonly string[] | null | undefined,
): OnboardingLabel | null {
  const wanted = new Map<string, OnboardingLabel>(
    ONBOARDING_LABELS.map((k) => [ONBOARDING_LABEL_TITLE[k].toLowerCase(), k]),
  );
  for (const n of names ?? []) {
    const hit = wanted.get(n.trim().toLowerCase());
    if (hit) return hit;
  }
  return null;
}

export type OnboardingQuestionType =
  | "boolean"
  | "text"
  | "select"
  | "multiselect"
  | "number"
  /** Rendered as the referral-fee widget: person, basis, rate or amount, note. */
  | "referral_fee";

export type OnboardingQuestion = {
  key: string;
  label: string;
  type: OnboardingQuestionType;
  /** Shown under the label; the "why" a rep needs to answer well. */
  hint?: string;
  options?: { value: string; label: string }[];
  /** Only render when another answer equals this value (e.g. limits after "COI needed"). */
  showWhen?: { key: string; equals: unknown };
  /** What the server does with the answer — surfaced so the popup can say so. */
  effect?: string;
};

/** The shape of a referral-fee answer. `referral_fees: [...]` for several people. */
export type ReferralFeeAnswer = {
  contact_id?: string | null;
  basis?: "percent" | "flat" | "per_job" | "commission_per_job" | "none" | "other";
  rate_percent?: number | string | null;
  amount?: number | string | null;
  notes?: string | null;
};

export type OnboardingAnswers = Record<string, unknown> & {
  referral_fee?: ReferralFeeAnswer;
  referral_fees?: ReferralFeeAnswer[];
};

export const REFERRAL_FEE_BASES: {
  value: NonNullable<ReferralFeeAnswer["basis"]>;
  label: string;
}[] = [
  { value: "percent", label: "% of the job" },
  { value: "commission_per_job", label: "Commission per job" },
  { value: "flat", label: "Flat amount" },
  { value: "per_job", label: "Fixed amount per job" },
  { value: "none", label: "No fee" },
  { value: "other", label: "Other (say in the note)" },
];

/* --------------------------------------------------------------- shared */

const COI: OnboardingQuestion = {
  key: "coi_needed",
  label: "Do they need a COI from us?",
  type: "boolean",
  effect: "Adds a Certificate of Insurance requirement to the deal's compliance.",
};
const COI_LIMITS: OnboardingQuestion = {
  key: "coi_limits",
  label: "Limits required",
  type: "text",
  hint: "e.g. $2M GL / $1M auto / $5M umbrella",
  showWhen: { key: "coi_needed", equals: true },
};
const COI_WORDING: OnboardingQuestion = {
  key: "coi_additional_insured",
  label: "Additional-insured wording",
  type: "text",
  hint: "Exactly as they want it to read on the certificate.",
  showWhen: { key: "coi_needed", equals: true },
};
const W9: OnboardingQuestion = {
  key: "w9_needed",
  label: "W-9?",
  type: "boolean",
  effect: "Adds a W-9 requirement to the deal's compliance.",
};
const REFERRAL_FEE: OnboardingQuestion = {
  key: "referral_fee",
  label: "Referral fee",
  type: "referral_fee",
  hint: "Who gets it, and how it is worked out.",
  effect: "Stored per person on the account.",
};

/* ------------------------------------------------------------ by label */

export const ONBOARDING_QUESTIONS: Record<OnboardingLabel, OnboardingQuestion[]> = {
  management: [
    COI,
    COI_LIMITS,
    COI_WORDING,
    {
      key: "credentialing_platform",
      label: "Do they use a vendor credentialing platform?",
      type: "boolean",
      effect: "Creates a task to complete the credentialing.",
    },
    {
      key: "credentialing_platform_name",
      label: "Which one?",
      type: "text",
      hint: "Compliance Depot, NetVendor, Vendor Shield, RMIS…",
      showWhen: { key: "credentialing_platform", equals: true },
    },
    {
      key: "vendor_packet_required",
      label: "Onboarding / vendor packet required?",
      type: "boolean",
      effect: "Creates a task to complete the packet.",
    },
    {
      key: "dispatch_method",
      label: "How is work dispatched?",
      type: "select",
      options: [
        { value: "single_contact", label: "One contact" },
        { value: "office_line", label: "Office line" },
        { value: "portal", label: "Portal" },
      ],
    },
    {
      key: "dispatch_detail",
      label: "Dispatch details",
      type: "text",
      hint: "The name, the number, or the portal and login owner.",
    },
    {
      key: "after_hours_protocol",
      label: "After-hours / emergency protocol",
      type: "text",
      hint: "Who calls, who authorizes.",
      effect: "Creates a task to confirm dispatch has it.",
    },
    { ...REFERRAL_FEE, label: "Referral fee → commission per job" },
  ],
  insurance_broker: [
    REFERRAL_FEE,
    {
      key: "keep_in_loop",
      label: "Kept in the loop on jobs they send?",
      type: "boolean",
    },
  ],
  public_adjuster: [
    REFERRAL_FEE,
    {
      key: "loss_types",
      label: "Loss types",
      type: "multiselect",
      options: [
        { value: "large_loss", label: "Large loss" },
        { value: "commercial", label: "Commercial" },
        { value: "residential", label: "Residential" },
      ],
    },
    { key: "states_licensed", label: "States licensed", type: "text", hint: "NY, NJ, CT…" },
  ],
  direct_owner: [
    COI,
    COI_LIMITS,
    COI_WORDING,
    {
      key: "onboarding_into_system",
      label: "Onboarding us into their system?",
      type: "boolean",
      effect: "Creates a task to get set up.",
    },
    {
      key: "vendor_agreement_needed",
      label: "Signed vendor agreement?",
      type: "boolean",
      effect: "Adds a Signed Vendor Agreement requirement to the deal's compliance.",
    },
    W9,
    REFERRAL_FEE,
  ],
  outside_referral: [REFERRAL_FEE, { ...COI, label: "COI from us?" }, COI_LIMITS, COI_WORDING, W9],
};

/* ---------------------------------------------------------------- helpers */

/**
 * Which set of questions an account gets. The board labels a card by the
 * account type (Settings → Dropdown options → Account type) and, failing
 * that, by what they do. Anything unmapped is "Other".
 */
export function onboardingLabelForAccount(account: {
  account_type?: string | null;
  what_they_do?: string[] | null;
}): OnboardingLabel | null {
  const type = (account.account_type ?? "").toLowerCase();
  const byType: Record<string, OnboardingLabel> = {
    property_management: "management",
    management: "management",
    insurance_broker: "insurance_broker",
    broker: "insurance_broker",
    public_adjusting_firm: "public_adjuster",
    public_adjuster: "public_adjuster",
    property_owner: "direct_owner",
    direct_owner: "direct_owner",
    commercial: "direct_owner",
    residential: "direct_owner",
    referral_partner: "outside_referral",
    outside_referral: "outside_referral",
  };
  if (byType[type]) return byType[type];
  for (const fn of account.what_they_do ?? []) {
    const k = fn.toLowerCase();
    if (byType[k]) return byType[k];
  }
  // No category. Nothing matched, and there is no catch-all any more -- Mark
  // removed "Other" along with its questions. Null is the honest answer, and
  // the popup then asks only for the green light date rather than putting a
  // guessed company type in front of somebody.
  return null;
}

export function questionsForLabel(label: OnboardingLabel | null): OnboardingQuestion[] {
  return label ? (ONBOARDING_QUESTIONS[label] ?? []) : [];
}

/** Whether a question should render given the answers so far. */
export function isQuestionVisible(q: OnboardingQuestion, answers: OnboardingAnswers): boolean {
  if (!q.showWhen) return true;
  return answers[q.showWhen.key] === q.showWhen.equals;
}

/**
 * Drop blanks and hidden answers before submitting, so a toggled-off COI
 * does not send its limits along, and an untouched form submits `{}`.
 */
export function cleanOnboardingAnswers(
  label: OnboardingLabel,
  answers: OnboardingAnswers,
): OnboardingAnswers {
  const out: OnboardingAnswers = {};
  const visibleKeys = new Set(
    questionsForLabel(label)
      .filter((q) => isQuestionVisible(q, answers))
      .map((q) => q.key),
  );
  for (const [key, value] of Object.entries(answers)) {
    if (!visibleKeys.has(key) && key !== "referral_fees") continue;
    if (value == null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === "referral_fee" && isEmptyFee(value as ReferralFeeAnswer)) continue;
    if (key === "referral_fees") {
      const fees = (value as ReferralFeeAnswer[]).filter((f) => !isEmptyFee(f));
      if (fees.length === 0) continue;
      out.referral_fees = fees;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isEmptyFee(fee: ReferralFeeAnswer | null | undefined): boolean {
  if (!fee || typeof fee !== "object") return true;
  const rate = fee.rate_percent;
  const amount = fee.amount;
  return (
    !fee.basis &&
    (rate == null || rate === "") &&
    (amount == null || amount === "") &&
    !(fee.notes ?? "").trim()
  );
}
