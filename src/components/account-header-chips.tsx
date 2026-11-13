/**
 * The chips on an account's header line — status, office footprint, what the
 * account is — shared by the full record and the prospect layout so the two
 * headers say the same things in the same way. Mark, with a screenshot of the
 * full record's header: "these should show on the prospects page as well."
 *
 * The last-visit badge (`routes/last-visit-badge.tsx`), the compliance badge
 * and the labels chip (`LabelPicker`) are already components of their own and
 * sit beside these.
 */
import { Briefcase, Building2, Landmark } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { footprintLabel, useAccountLocations } from "@/lib/account-locations";
import { isHouseAccount } from "@/lib/account-clocks";
import {
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_TYPE_LABEL,
  type AccountStatus,
  type AccountType,
} from "@/lib/accounts";
import { cn } from "@/lib/utils";

/**
 * The lifecycle in the shared tones (`styles.css`, Tones), so the chip agrees
 * with the rail beside it: a prospect is still on the road (sky, Ready's
 * colour), a customer is a win (emerald, Active Client's), lost is rose, and
 * dormant is the grey of No Service Needed. It used to be green for every
 * status, which made "Prospect" look like a won client. Literal classes,
 * because Tailwind only builds what it can read.
 */
const STATUS_TONE: Record<AccountStatus, string> = {
  prospect: "bg-tone-sky-soft text-tone-sky-text",
  onboarding: "bg-tone-teal-soft text-tone-teal-text",
  active: "bg-tone-emerald-soft text-tone-emerald-text",
  dormant: "bg-tone-slate-soft text-tone-slate-text",
  lost: "bg-tone-rose-soft text-tone-rose-text",
};

/** Prospect, Onboarding, Active customer… — the account's standing with us. */
export function AccountStatusPill({
  status,
  className,
}: {
  status: AccountStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-lg px-3 py-1.5 text-[13px] font-semibold",
        STATUS_TONE[status] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {ACCOUNT_STATUS_LABEL[status]}
    </span>
  );
}

const TEXT_CHIP = "inline-flex items-center gap-1.5 text-[13px] text-muted-foreground";

/**
 * Commercial, Property management… — what the account is.
 *
 * `ACCOUNT_TYPE_LABEL` only covers the four values of the legacy enum, while
 * the type itself has been a managed list for a while (Insurance carrier,
 * Property owner, and now Homeowner). An unmapped key used to render an empty
 * chip; it now falls back to the key, spelled out, which is wrong-ish but
 * readable rather than invisible.
 */
export function AccountTypeChip({
  type,
  className,
}: {
  type: AccountType | string | null | undefined;
  className?: string;
}) {
  if (!type) return null;
  const label =
    ACCOUNT_TYPE_LABEL[type as AccountType] ??
    type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return (
    <span className={cn(TEXT_CHIP, className)}>
      <Briefcase className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * "House account" — Mark: "House accounts belong to the company rather than a
 * rep. Owner level relationships, TPA work that already does not count toward
 * any rep, and accounts sitting between reps."
 *
 * It is a label somebody puts on deliberately (never inferred from an empty
 * `assigned_rep`, which usually just means nobody has picked the record up
 * yet), so it earns a chip of its own rather than being one coloured pill
 * among eight in the Tags row.
 */
export function AccountHouseChip({
  labels,
  className,
}: {
  labels: readonly string[] | null | undefined;
  className?: string;
}) {
  if (!isHouseAccount({ labels })) return null;
  return (
    <span className={cn(TEXT_CHIP, className)} title="Belongs to the company, not to a rep's book">
      <Landmark className="size-4 shrink-0" />
      <span className="truncate">House account</span>
    </span>
  );
}

/**
 * "Multi-location · 2 offices" / "National" — only on an account worked from
 * more than one Gold Star office; a single-office account shows nothing here.
 */
export function AccountFootprintChip({
  accountId,
  isMultiLocation,
  className,
}: {
  accountId: string;
  isMultiLocation: boolean | null | undefined;
  className?: string;
}) {
  const { allLocations } = useAppContext();
  const served = useAccountLocations(isMultiLocation ? accountId : null);
  if (!isMultiLocation) return null;
  return (
    <span className={cn(TEXT_CHIP, className)} title="Worked from more than one Gold Star office">
      <Building2 className="size-4 shrink-0" />
      <span className="truncate">
        {footprintLabel({
          isMultiLocation: true,
          servingIds: served.data ?? [],
          allOfficeIds: allLocations.map((l) => l.id),
        })}
      </span>
    </span>
  );
}
