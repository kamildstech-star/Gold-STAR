/**
 * The prospect record's header line — back, company · person, the shared
 * account chips, and the record controls.
 *
 * ONE RULE, Mark's, and everything here follows from it: the company name is
 * the most important thing on the page and must never be the thing that
 * truncates. So:
 *
 *   - The name is `shrink-0`: it is not in the row's shrink pool at all, and
 *     no other item can take a character off it. `max-w-full` is its only
 *     limit, so a name genuinely wider than the header still ellipsises
 *     rather than pushing the controls off screen — but only once every chip
 *     has already moved out of its way.
 *   - The row always wraps (`flex-wrap`, never `flex-nowrap`). Wrapping is
 *     how everything else yields: the chips take a row of their own, and the
 *     person follows them down when the name has taken the width.
 *   - The chips only share the name's line where they measurably fit. That is
 *     a question about how wide THIS header is, not how wide the monitor is —
 *     the sidebar is 200-340px and collapsible, so the same viewport gives
 *     this header anywhere from ~700px to the full width. Hence `@container`
 *     and `@min-[…]` rather than `xl:`; the old viewport breakpoint switched
 *     the one-line layout on at 1024px of actual header width, where the name
 *     was crushed to its 6rem floor and read "Brookly…".
 *
 * The measured number: with every chip present and the last-visit sentence in
 * full, the one-line layout needs about 1900px of header width. Below that
 * the chips get their own row.
 */
import { Link } from "@tanstack/react-router";
import { MapPin, User } from "lucide-react";
import type { ReactNode } from "react";
import { AccountMonogram } from "@/components/account-monogram";

import {
  AccountFootprintChip,
  AccountStatusPill,
  AccountTypeChip,
} from "@/components/account-header-chips";
import { ComplianceBadge } from "@/components/compliance-badge";
import { LabelPicker } from "@/components/label-picker";
import { LastVisitBadge } from "@/components/routes/last-visit-badge";
import type { AccountStatus, AccountType } from "@/lib/accounts";

export function ProspectRecordHeader({
  accountId,
  name,
  status,
  accountType,
  isMultiLocation,
  place,
  ownerName,
  contactName,
  contactCount,
  onOpenCompany,
  onOpenContact,
  onEdit,
  editDisabled,
  editReason,
  headerExtra,
  chipsExtra,
  children,
}: {
  accountId: string;
  name: string;
  status: AccountStatus;
  accountType: AccountType;
  isMultiLocation?: boolean | null;
  /** "Brooklyn, NY" — the account's town, or its office when it has none. */
  place: string;
  ownerName: string | null;
  contactName: string | null;
  contactCount: number;
  onOpenCompany: () => void;
  onOpenContact: () => void;
  onEdit: () => void;
  editDisabled: boolean;
  editReason: string | null;
  /** The layout toggle, owned by the route. */
  headerExtra?: ReactNode;
  /** More chips at the end of the row — the full record's House account. */
  chipsExtra?: ReactNode;
  /** The stage line, which sits inside the same header block. */
  children?: ReactNode;
}) {
  return (
    <header className="@container border-b bg-card">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3.5 sm:px-6 sm:py-5">
        {/* No back arrow here (4 Nov): the top bar's Back already returns to
            whichever page the user came from. */}

        <AccountMonogram name={name} className="hidden sm:flex sm:size-12 sm:text-[17px]" />

        {/* The company name. `shrink-0` is the whole fix — see the file note. */}
        <button
          type="button"
          data-testid="prospect-header-name"
          onClick={onOpenCompany}
          title="Company details"
          className="display-heavy max-w-full shrink-0 truncate text-left text-[24px] leading-tight tracking-tight transition hover:text-primary sm:text-[28px]"
        >
          {name}
        </button>

        {/*
          The person, with its separator, as one wrappable chunk: it either
          gets the room to read as a name or it drops to the next row. It is
          never worth showing as "P…".
        */}
        <span className="inline-flex min-w-0 shrink items-center gap-3">
          <span aria-hidden className="text-muted-foreground/50">
            ·
          </span>
          {contactName ? (
            <button
              type="button"
              data-testid="prospect-header-contact"
              onClick={onOpenContact}
              title="Contact details"
              className="inline-flex min-w-[7rem] items-center gap-1.5 text-[15px] font-semibold text-primary hover:underline"
            >
              <User className="size-4 shrink-0" />
              <span className="truncate">{contactName}</span>
              {contactCount > 1 && (
                <span className="shrink-0 text-[12px] font-medium text-muted-foreground">
                  +{contactCount - 1}
                </span>
              )}
            </button>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-[13.5px] text-muted-foreground">
              <User className="size-4 shrink-0" />
              No contact yet
            </span>
          )}
        </span>

        {/*
          The chips — the full record's own components, in its order. Their own
          row beneath the name; alongside it only where the header is wide
          enough to hold the lot without anybody losing a character.
        */}
        <div
          data-testid="prospect-header-chips"
          className="order-last flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1.5 @min-[1900px]:order-none @min-[1900px]:basis-auto"
        >
          <AccountStatusPill status={status} className="shrink-0" />
          <ComplianceBadge accountId={accountId} hideWhenClear />
          <LastVisitBadge accountId={accountId} responsive />
          <span
            className="inline-flex min-w-0 max-w-[10rem] items-center gap-1.5 text-[13px] text-muted-foreground"
            title={place}
          >
            <MapPin className="size-4 shrink-0" />
            <span className="truncate">{place}</span>
          </span>
          <AccountFootprintChip
            accountId={accountId}
            isMultiLocation={isMultiLocation}
            className="min-w-0 max-w-[10rem]"
          />
          <AccountTypeChip type={accountType} className="min-w-0 max-w-[10rem]" />
          <span
            className="hidden max-w-[9rem] truncate text-[13px] text-muted-foreground @min-[60rem]:inline"
            title={ownerName ? `Owner: ${ownerName}` : "No owner"}
          >
            {ownerName ?? "Unassigned"}
          </span>
          {chipsExtra}
          <span className="shrink-0">
            <LabelPicker scope="account" recordId={accountId} />
          </span>
        </div>

        <div
          data-testid="prospect-header-controls"
          className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2"
        >
          {headerExtra}
          {/* 4 Nov: no Edit here — the account card that opens from the name
              has "Edit account", and two Edit buttons were one too many. */}
        </div>
      </div>
      {/* The stage rail, in a band of its own under the identity line. */}
      {children ? (
        <div className="border-t bg-background pt-2">
          <div className="mx-auto max-w-[1600px]">{children}</div>
        </div>
      ) : null}
    </header>
  );
}
