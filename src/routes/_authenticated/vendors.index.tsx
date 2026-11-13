import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, FileWarning, Plus, ShieldCheck } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import { Button } from "@/components/ui/button";
import { MetricStrip } from "@/components/metric-strip";
import { RecordLoadError } from "@/components/record-load-error";
import { ROW_NAV_CLASS, useRowNav } from "@/components/clickable-row";
import { PageHeader } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ACCOUNT_TYPE_LIST_KEY } from "@/lib/account-types";
import { useOptionList } from "@/lib/option-lists";
import {
  VENDOR_DOC_KIND_LABEL,
  VENDOR_RENEWAL_LEAD_DAYS,
  VENDOR_STATE_LABEL,
  VENDOR_STATE_TONE,
  expiryPhrase,
  fetchVendorAccounts,
  fetchVendorDocuments,
  formatDate,
  resolveVendorTypes,
  rollupVendorDocs,
  vendorStateRank,
  type VendorDocState,
} from "@/lib/vendors";

/**
 * The approved-vendor list.
 *
 * It exists to answer one question from across the room: whose paperwork is
 * about to stop covering us. So the sort is worst-first and never
 * alphabetical, and the expiry is on the row — a COI lapsing in three weeks
 * has to be visible without opening the record.
 */

type Search = { q: string; state: VendorDocState | "all" | "attention" };

export const Route = createFileRoute("/_authenticated/vendors/")({
  head: () => ({
    meta: [
      { title: "Vendors · Recovery Hub" },
      {
        name: "description",
        content:
          "Approved subcontractors and vendors, sorted by whose insurance and license paperwork lapses first.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): Search => ({
    q: typeof raw.q === "string" ? raw.q : "",
    state: typeof raw.state === "string" ? (raw.state as Search["state"]) : "attention",
  }),
  component: VendorsPage,
});

const STATE_FILTERS: Search["state"][] = [
  "attention",
  "all",
  "expired",
  "missing",
  "expiring_soon",
  "pending",
  "satisfied",
];

function VendorsPage() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  // Vendor is a managed account type, not a constant — resolve it live.
  const types = useOptionList(ACCOUNT_TYPE_LIST_KEY);
  const vendorTypes = useMemo(() => resolveVendorTypes(types.options), [types.options]);
  const typeIds = useMemo(() => vendorTypes.map((t) => t.id), [vendorTypes]);

  const accountsQ = useQuery({
    queryKey: ["vendor-accounts", typeIds, app.currentLocationId],
    enabled: typeIds.length > 0,
    queryFn: () => fetchVendorAccounts({ typeIds, locationId: app.currentLocationId }),
  });

  const accountIds = useMemo(() => (accountsQ.data ?? []).map((a) => a.id), [accountsQ.data]);

  const docsQ = useQuery({
    queryKey: ["vendor-documents", accountIds],
    enabled: accountIds.length > 0,
    queryFn: () => fetchVendorDocuments(accountIds),
  });

  const rows = useMemo(() => {
    // Until the paperwork is in hand every vendor would roll up as "Missing",
    // which is the one wrong answer this screen must never flash.
    if (accountIds.length > 0 && !docsQ.data) return [];
    const byAccount = new Map<string, ReturnType<typeof rollupVendorDocs>>();
    const docs = docsQ.data ?? [];
    for (const a of accountsQ.data ?? []) {
      byAccount.set(a.id, rollupVendorDocs(docs.filter((d) => d.account_id === a.id)));
    }
    return (accountsQ.data ?? [])
      .map((a) => ({ account: a, roll: byAccount.get(a.id)! }))
      .sort((x, y) => {
        const r = vendorStateRank(x.roll.state) - vendorStateRank(y.roll.state);
        if (r !== 0) return r;
        // Inside a state, whatever lapses first is what gets chased first.
        const xs = x.roll.soonestExpiry ?? "9999-12-31";
        const ys = y.roll.soonestExpiry ?? "9999-12-31";
        if (xs !== ys) return xs.localeCompare(ys);
        return x.account.name.localeCompare(y.account.name);
      });
  }, [accountsQ.data, accountIds.length, docsQ.data]);

  const filtered = useMemo(() => {
    const needle = search.q.trim().toLowerCase();
    return rows.filter((r) => {
      if (search.state === "attention" && r.roll.state === "satisfied") return false;
      if (search.state !== "all" && search.state !== "attention" && r.roll.state !== search.state)
        return false;
      if (needle && !r.account.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, search.q, search.state]);

  const counts = useMemo(() => {
    const c = { expired: 0, missing: 0, expiring_soon: 0, satisfied: 0 };
    for (const r of rows) if (r.roll.state in c) c[r.roll.state as keyof typeof c] += 1;
    return c;
  }, [rows]);

  // A failed read is not an empty book. This screen's whole job is telling you
  // paperwork is missing, so "nothing on file" and "could not read the file"
  // must never look the same.
  if (types.error) {
    return (
      <RecordLoadError error={types.error} record="account type list" table="option_list_values" />
    );
  }
  if (accountsQ.error) {
    return (
      <RecordLoadError
        error={accountsQ.error}
        record="vendor list"
        table="accounts"
        onRetry={() => void accountsQ.refetch()}
      />
    );
  }
  if (docsQ.error) {
    return (
      <RecordLoadError
        error={docsQ.error}
        record="vendor paperwork"
        table="vendor_documents"
        onRetry={() => void docsQ.refetch()}
      />
    );
  }

  return (
    <div className="space-y-3 px-3 py-4 sm:px-4">
      <PageHeader
        title="Vendors"
        subtitle="Approved subcontractors, sorted by whose paperwork stops covering us first."
      >
        {/*
         * The screen listed vendors and gave no way to add one: a vendor is an
         * account of a managed type, so the only route in was Customers ->
         * create -> remember to change the type. Same dialog, opened here with
         * the type already chosen — the account-picker's own
         * "+ Create 'dougs' as a public adjusting firm" uses the same prop.
         *
         * Disabled until the type list has resolved, because a vendor created
         * with no type is not a vendor and would not come back in this list.
         */}
        <Button
          disabled={app.writesDisabled || vendorTypes.length === 0}
          title={
            vendorTypes.length === 0
              ? "No vendor account type is configured yet"
              : "Add a vendor or subcontractor"
          }
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="mr-1.5 size-4" /> New vendor
        </Button>
      </PageHeader>

      <CreateCustomerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        kind="company"
        defaultAccountTypeKey={vendorTypes[0]?.key}
        defaultLocationId={app.currentLocationId}
        onCreated={() => {
          setCreateOpen(false);
          // The new vendor is in neither query's cache, so both are refetched
          // rather than leaving somebody to reload the page to see what they
          // just created. The documents query keys off the account ids, so it
          // has to follow the accounts one.
          void qc.invalidateQueries({ queryKey: ["vendor-accounts"] });
          void qc.invalidateQueries({ queryKey: ["vendor-documents"] });
        }}
      />

      {!types.isLoading && vendorTypes.length === 0 ? (
        <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
          <p className="font-medium">No vendor account type is configured.</p>
          <p className="mt-1">
            Vendors are accounts, and the account type list is admin-managed — nothing here can
            guess which of your types means “subcontractor”. Add one (Trade partner, Vendor or
            Subcontractor) under Admin → Option lists → Account type, then tag the vendors with it.
          </p>
        </div>
      ) : (
        <>
          <MetricStrip
            metrics={[
              { label: "Expired", value: counts.expired, tone: "danger", icon: AlertTriangle },
              { label: "Missing paperwork", value: counts.missing, icon: FileWarning },
              {
                label: `Expiring within ${VENDOR_RENEWAL_LEAD_DAYS} days`,
                value: counts.expiring_soon,
                tone: "warning",
                icon: CalendarClock,
              },
              { label: "Current", value: counts.satisfied, tone: "success", icon: ShieldCheck },
            ]}
          />

          <div className="flex flex-wrap items-center gap-2">
            {/* 16px below sm: iOS zooms into any smaller field on focus. */}
            <Input
              className="h-11 w-full text-base sm:h-8 sm:w-56 sm:text-[12px]"
              placeholder="Search vendor"
              value={search.q}
              onChange={(e) =>
                navigate({ search: (p: Search) => ({ ...p, q: e.target.value }), replace: true })
              }
            />
            <Select
              value={search.state}
              onValueChange={(v) =>
                navigate({
                  search: (p: Search) => ({ ...p, state: v as Search["state"] }),
                  replace: true,
                })
              }
            >
              <SelectTrigger className="h-11 w-full text-base sm:h-8 sm:w-48 sm:text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATE_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all"
                      ? "All vendors"
                      : s === "attention"
                        ? "Needs action"
                        : VENDOR_STATE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[11px] text-muted-foreground">
              {filtered.length} of {rows.length}
            </span>
          </div>

          {/* Phone: a card per vendor. The five columns exist to be scanned
              side by side on a desk, which a 390px viewport cannot do. */}
          <ul className="space-y-2 md:hidden">
            {filtered.map(({ account, roll }) => (
              <VendorCard key={account.id} account={account} roll={roll} />
            ))}
            {filtered.length === 0 && (
              <li className="rounded-[6px] border px-3 py-6 text-center text-[12px] text-muted-foreground">
                {accountsQ.isLoading || docsQ.isLoading
                  ? "Loading…"
                  : rows.length === 0
                    ? "No accounts carry a vendor type in this office yet."
                    : "Nothing matches that filter."}
              </li>
            )}
          </ul>

          <div className="hidden overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-[6px] border md:block">
            <table className="w-full text-[12px]">
              <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Vendor</th>
                  <th className="px-2 py-1.5 text-left font-medium">Paperwork</th>
                  <th className="px-2 py-1.5 text-left font-medium">Not on file</th>
                  <th className="px-2 py-1.5 text-left font-medium">Next expiry</th>
                  <th className="px-2 py-1.5 text-left font-medium">Where</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ account, roll }) => (
                  <VendorRow key={account.id} account={account} roll={roll} />
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                      {accountsQ.isLoading || docsQ.isLoading
                        ? "Loading…"
                        : rows.length === 0
                          ? "No accounts carry a vendor type in this office yet."
                          : "Nothing matches that filter."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function VendorRow({
  account,
  roll,
}: {
  account: { id: string; name: string; city: string | null; state: string | null };
  roll: ReturnType<typeof rollupVendorDocs>;
}) {
  const nav = useRowNav(`/vendors/${account.id}`);
  return (
    <tr className={`border-t ${ROW_NAV_CLASS}`} {...nav}>
      <td className="px-2 py-1.5">
        <Link to="/vendors/$id" params={{ id: account.id }} className="font-medium hover:underline">
          {account.name}
        </Link>
      </td>
      <td className="px-2 py-1.5">
        <Badge
          variant="outline"
          className={`h-4 rounded-[4px] px-1.5 text-[10px] ${VENDOR_STATE_TONE[roll.state]}`}
        >
          {VENDOR_STATE_LABEL[roll.state]}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">
        {roll.missingKinds.length === 0
          ? "—"
          : roll.missingKinds.map((k) => VENDOR_DOC_KIND_LABEL[k]).join(", ")}
      </td>
      <td className="px-2 py-1.5">
        {roll.soonestExpiry ? (
          <span
            className={
              roll.soonestDays != null && roll.soonestDays < 0
                ? "text-red-700 dark:text-red-400"
                : roll.soonestDays != null && roll.soonestDays <= VENDOR_RENEWAL_LEAD_DAYS
                  ? "text-amber-700 dark:text-amber-400"
                  : ""
            }
          >
            {formatDate(roll.soonestExpiry)}
            <span className="ml-1.5 text-[11px] text-muted-foreground">
              {expiryPhrase(roll.soonestDays)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">No expiry on file</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">
        {[account.city, account.state].filter(Boolean).join(", ") || "—"}
      </td>
    </tr>
  );
}

/** Phone form of a vendor row: state first, then what is missing and when. */
function VendorCard({
  account,
  roll,
}: {
  account: { id: string; name: string; city: string | null; state: string | null };
  roll: ReturnType<typeof rollupVendorDocs>;
}) {
  return (
    <li>
      <Link
        to="/vendors/$id"
        params={{ id: account.id }}
        className="flex min-h-11 flex-col gap-1 rounded-[6px] border px-3 py-2.5 active:bg-hover"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 text-[14px] font-medium">{account.name}</span>
          <Badge
            variant="outline"
            className={`shrink-0 rounded-[4px] px-1.5 text-[10px] ${VENDOR_STATE_TONE[roll.state]}`}
          >
            {VENDOR_STATE_LABEL[roll.state]}
          </Badge>
        </div>
        {roll.missingKinds.length > 0 && (
          <div className="text-[12px] text-muted-foreground">
            Not on file: {roll.missingKinds.map((k) => VENDOR_DOC_KIND_LABEL[k]).join(", ")}
          </div>
        )}
        <div
          className={`text-[12px] ${
            roll.soonestDays != null && roll.soonestDays < 0
              ? "text-red-700 dark:text-red-400"
              : roll.soonestDays != null && roll.soonestDays <= VENDOR_RENEWAL_LEAD_DAYS
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
          }`}
        >
          {roll.soonestExpiry
            ? `Next expiry ${formatDate(roll.soonestExpiry)} · ${expiryPhrase(roll.soonestDays)}`
            : "No expiry on file"}
        </div>
        {[account.city, account.state].filter(Boolean).length > 0 && (
          <div className="text-[12px] text-muted-foreground">
            {[account.city, account.state].filter(Boolean).join(", ")}
          </div>
        )}
      </Link>
    </li>
  );
}
