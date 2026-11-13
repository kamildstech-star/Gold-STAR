import { useMemo } from "react";
import { useOptionList, type OptionValue } from "./option-lists";

/**
 * Loss type = the service category (Water Mitigation, Reconstruction…).
 * Job type  = how the work is paid for (Insurance, Cash…).
 *
 * Both are managed option lists — admins add, rename, reorder and deactivate
 * them without a developer — so nothing here may hardcode the set. The only
 * fixed thing is the colour palette, keyed by the `color` token each option
 * carries in its metadata.
 */

export const LOSS_COLOR_TOKENS = [
  "water",
  "fire",
  "smoke",
  "sewer",
  "mold",
  "biohazard",
  "storm",
  "cleaning",
  "emergency",
  "contents",
  "boardup",
  "reconstruction",
  "asbestos",
] as const;
export type LossColorToken = (typeof LOSS_COLOR_TOKENS)[number];

const SOFT: Record<LossColorToken, string> = {
  water: "bg-loss-water/10 text-loss-water",
  fire: "bg-loss-fire/10 text-loss-fire",
  smoke: "bg-loss-smoke/10 text-loss-smoke",
  sewer: "bg-loss-sewer/10 text-loss-sewer",
  mold: "bg-loss-mold/10 text-loss-mold",
  biohazard: "bg-loss-biohazard/10 text-loss-biohazard",
  storm: "bg-loss-storm/10 text-loss-storm",
  cleaning: "bg-loss-cleaning/10 text-loss-cleaning",
  emergency: "bg-loss-emergency/10 text-loss-emergency",
  contents: "bg-loss-contents/10 text-loss-contents",
  boardup: "bg-loss-boardup/10 text-loss-boardup",
  reconstruction: "bg-loss-reconstruction/10 text-loss-reconstruction",
  asbestos: "bg-loss-asbestos/10 text-loss-asbestos",
};

const STRIPE: Record<LossColorToken, string> = {
  water: "border-l-loss-water",
  fire: "border-l-loss-fire",
  smoke: "border-l-loss-smoke",
  sewer: "border-l-loss-sewer",
  mold: "border-l-loss-mold",
  biohazard: "border-l-loss-biohazard",
  storm: "border-l-loss-storm",
  cleaning: "border-l-loss-cleaning",
  emergency: "border-l-loss-emergency",
  contents: "border-l-loss-contents",
  boardup: "border-l-loss-boardup",
  reconstruction: "border-l-loss-reconstruction",
  asbestos: "border-l-loss-asbestos",
};

function token(v?: OptionValue | null): LossColorToken | null {
  const c = (v?.metadata as { color?: string } | null)?.color;
  return c && (LOSS_COLOR_TOKENS as readonly string[]).includes(c) ? (c as LossColorToken) : null;
}

export interface LossTypeIndex {
  options: OptionValue[];
  isLoading: boolean;
  byId: Map<string, OptionValue>;
  byKey: Map<string, OptionValue>;
  label: (id: string | null | undefined) => string;
  badge: (id: string | null | undefined) => string;
  stripe: (id: string | null | undefined) => string;
  /** Colour by option *key* — for account loss_types arrays, which store keys. */
  badgeForKey: (key: string | null | undefined) => string;
  /** Label by option *key*, falling back to a de-underscored title case. */
  labelForKey: (key: string | null | undefined) => string;
  defaultId: string;
}

export function useLossTypes(locationId?: string | null): LossTypeIndex {
  const { options, isLoading } = useOptionList("loss_type", { locationId });
  return useMemo(() => {
    const byId = new Map(options.map((o) => [o.id, o]));
    const byKey = new Map(options.map((o) => [o.key, o]));
    const cls = (v: OptionValue | null | undefined, map: Record<LossColorToken, string>) => {
      const t = token(v);
      return t ? map[t] : "bg-muted text-muted-foreground";
    };
    return {
      options,
      isLoading,
      byId,
      byKey,
      label: (id) => (id ? (byId.get(id)?.label ?? "—") : "—"),
      badge: (id) => cls(id ? byId.get(id) : null, SOFT),
      stripe: (id) => {
        const t = token(id ? byId.get(id) : null);
        return t ? STRIPE[t] : "border-l-border";
      },
      badgeForKey: (key) => cls(key ? byKey.get(key) : null, SOFT),
      labelForKey: (key) =>
        !key
          ? "—"
          : (byKey.get(key)?.label ??
            key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())),
      defaultId: options.find((o) => o.is_default)?.id ?? options[0]?.id ?? "",
    };
  }, [options, isLoading]);
}

/* ---------------------------------------------------------------- payment */

export interface PaymentTypeIndex {
  options: OptionValue[];
  isLoading: boolean;
  label: (key: string | null | undefined) => string;
  tone: (key: string | null | undefined) => string;
  defaultKey: string;
}

const PAYMENT_TONE: Record<string, string> = {
  insurance: "bg-info/10 text-info",
  cash: "bg-success/15 text-success",
  reconstruction: "bg-accent/15 text-accent-foreground",
  undetermined: "bg-warning/15 text-warning",
};

export function usePaymentTypes(): PaymentTypeIndex {
  const { options, isLoading } = useOptionList("job_type");
  return useMemo(
    () => ({
      options,
      isLoading,
      label: (key) => options.find((o) => o.key === key)?.label ?? key ?? "—",
      tone: (key) => (key && PAYMENT_TONE[key]) || "bg-muted text-muted-foreground",
      defaultKey: options.find((o) => o.is_default)?.key ?? options[0]?.key ?? "",
    }),
    [options, isLoading],
  );
}

/**
 * Intake often cannot tell yet whether a carrier is paying. The job is created
 * and worked as `undetermined`; it must be resolved before it is invoiced.
 */
export function isUndeterminedJobType(jobType: string | null | undefined): boolean {
  return !jobType || jobType === "undetermined";
}

/**
 * Insurance-only concepts — carrier, policy, claim, adjusters, deductible,
 * approved-vs-billed shortfall — must not appear on cash work. Undetermined
 * jobs keep the insurance fields available, since a claim may still surface.
 *
 * Reconstruction is a routing class, not a payer: a rebuild is usually the
 * back half of an insurance claim and sometimes paid direct, and the client
 * asked for no reconstruction-specific rules. It keeps the insurance fields
 * available like undetermined does, without the "resolve before invoicing"
 * nag — it IS resolved.
 */
export function isInsuranceJob(jobType: string | null | undefined): boolean {
  const key = jobType ?? "insurance";
  return key === "insurance" || key === "undetermined" || key === "reconstruction";
}

/* --------------------------------------------------------- insurance kind */

export interface InsuranceKindIndex {
  options: OptionValue[];
  isLoading: boolean;
  label: (key: string | null | undefined) => string;
  defaultKey: string;
}

export function useInsuranceKinds(): InsuranceKindIndex {
  const { options, isLoading } = useOptionList("insurance_kind");
  return useMemo(
    () => ({
      options,
      isLoading,
      label: (key) => options.find((o) => o.key === key)?.label ?? key ?? "—",
      defaultKey: options.find((o) => o.is_default)?.key ?? "",
    }),
    [options, isLoading],
  );
}

/**
 * A renter's policy changes who pays and what is covered — it must be visible
 * wherever the carrier is, not buried in a dropdown.
 */
export function isRentersPolicy(kind: string | null | undefined): boolean {
  return kind === "renters";
}
