import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Building2, Check, History, Plus, User, X } from "lucide-react";

import { OtherOfficeNotice, otherOfficeNames } from "@/components/other-office-notice";
import { supabase } from "@/integrations/supabase/client";
import { loadContactMethods } from "@/lib/contacts";
import type { PickedAccount } from "@/components/account-picker";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import type { DraftMethod } from "@/components/job-contact-methods";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * One customer look-up for every intake form — new job, new project, new lead,
 * new opportunity, incident intake.
 *
 * Three jobs, in order of how much data entry they save:
 *  1. Type-ahead over people AND companies, matching name, phone and email, so
 *     a rep with only a number off a work order still finds the record.
 *  2. Selecting prefills what we already know (phones, emails, labels,
 *     preferred flags) and links the CRM account, all still editable.
 *  3. Warns on near-duplicates before saving and shows other offices' records
 *     as minimal, non-selectable entries — the cross-location rule used as
 *     duplicate prevention rather than a cause of duplicates.
 *
 * Free text always works: nothing here blocks a save.
 */

export type CustomerKind = "person" | "company";

export interface PickedCustomer {
  kind: CustomerKind;
  /** Set when the rep picked an existing person. */
  contactId: string | null;
  name: string;
  title: string | null;
  accountId: string | null;
  accountName: string | null;
  accountLocationId: string | null;
  phone: string | null;
  email: string | null;
  /** Phones and emails prefilled from the CRM, with labels and preferred flags. */
  methods: DraftMethod[];
}

export function emptyCustomer(kind: CustomerKind, name = ""): PickedCustomer {
  return {
    kind,
    contactId: null,
    name,
    title: null,
    accountId: null,
    accountName: null,
    accountLocationId: null,
    phone: null,
    email: null,
    methods: [],
  };
}

interface SearchRow {
  kind: string;
  id: string;
  name: string;
  title: string | null;
  account_id: string | null;
  account_name: string | null;
  account_type: string | null;
  status: string | null;
  owning_location_id: string | null;
  owning_location_code: string | null;
  owning_location_name: string | null;
  owner_contact_name: string | null;
  phone: string | null;
  email: string | null;
  viewer_has_full_access: boolean;
}

interface DupeRow {
  contact_id: string;
  full_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  account_id: string | null;
  account_name: string | null;
  owning_location_code: string | null;
  owning_location_name: string | null;
  match_reason: string;
  viewer_has_full_access: boolean;
}

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function withFallbackMethods(base: DraftMethod[], phone: string | null, email: string | null) {
  const out = [...base];
  if (phone && !out.some((m) => m.kind === "phone")) {
    out.push({ kind: "phone", label: "Main", value: phone, is_preferred: true });
  }
  if (email && !out.some((m) => m.kind === "email")) {
    out.push({ kind: "email", label: "Work", value: email, is_preferred: true });
  }
  return out;
}

export function CustomerPicker({
  kind,
  value,
  onChange,
  label = "Customer name",
  placeholder,
  disabled,
  allowCreate = true,
  autoFocus,
  defaultAccount,
  defaultLocationId,
}: {
  kind: CustomerKind;
  value: PickedCustomer | null;
  onChange: (c: PickedCustomer) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  allowCreate?: boolean;
  autoFocus?: boolean;
  /** Seeds the create dialog when the form already knows these. */
  defaultAccount?: PickedAccount | null;
  defaultLocationId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const text = value?.name ?? "";
  const linked = !!(value?.contactId || (value?.kind === "company" && value?.accountId));
  const term = useDebounced(text.trim());
  const enabled = !linked && term.length >= 2;

  const searchQ = useQuery({
    queryKey: ["customer-search", term],
    enabled,
    queryFn: async (): Promise<SearchRow[]> => {
      const { data, error } = await supabase.rpc("search_customers_minimal", { _query: term });
      if (error) throw error;
      return (data ?? []) as unknown as SearchRow[];
    },
  });

  const rows = useMemo(() => {
    const all = searchQ.data ?? [];
    const wanted = kind === "person" ? "contact" : "account";
    // Show the matching entity type first, but never hide the other one —
    // a phone number typed in often belongs to a person at a company.
    return [...all].sort((a, b) => Number(b.kind === wanted) - Number(a.kind === wanted));
  }, [searchQ.data, kind]);

  /* Only records this person may open are listed. One another office owns
     is not shown at all — no locked row, no "not selectable" heading. */
  const inScope = rows.filter((r) => r.viewer_has_full_access);
  /* 13 Nov: …but a match another office holds is still said, in one line —
     which office, nothing of the record — so no second record is made. */
  const elsewhere = rows.filter((r) => !r.viewer_has_full_access);
  const elsewhereOffices = elsewhere.length
    ? otherOfficeNames(elsewhere.map((r) => r.owning_location_name))
    : null;

  // Duplicate check on whatever the rep has typed, once they are not linked.
  const dupeInput = useDebounced(
    {
      name: value?.name ?? "",
      phone: value?.methods.find((m) => m.kind === "phone" && m.value)?.value ?? value?.phone ?? "",
      email: value?.methods.find((m) => m.kind === "email" && m.value)?.value ?? value?.email ?? "",
      accountId: value?.accountId ?? null,
    },
    500,
  );

  const dupeEnabled =
    !linked &&
    (dupeInput.phone.replace(/\D/g, "").length >= 7 ||
      dupeInput.email.includes("@") ||
      (!!dupeInput.accountId && dupeInput.name.trim().length >= 3));

  const dupeQ = useQuery({
    queryKey: ["customer-dupes", dupeInput],
    enabled: dupeEnabled,
    queryFn: async (): Promise<DupeRow[]> => {
      const { data, error } = await supabase.rpc("find_customer_duplicates", {
        _name: dupeInput.name || undefined,
        _phone: dupeInput.phone || undefined,
        _email: dupeInput.email || undefined,
        _account_id: dupeInput.accountId ?? undefined,
      });
      if (error) throw error;
      return (data ?? []) as unknown as DupeRow[];
    },
  });
  // Same rule for the duplicate check: only records this person may link to.
  const dupes = (dupeQ.data ?? []).filter((d) => d.viewer_has_full_access);
  const dupesElsewhere = (dupeQ.data ?? []).filter((d) => !d.viewer_has_full_access);
  const dupeOffices = dupesElsewhere.length
    ? otherOfficeNames(dupesElsewhere.map((d) => d.owning_location_name))
    : null;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pickRow = async (r: SearchRow) => {
    const methods = r.kind === "contact" ? await loadContactMethods(r.id) : [];
    onChange({
      kind: r.kind === "contact" ? "person" : "company",
      contactId: r.kind === "contact" ? r.id : null,
      name: r.name,
      title: r.title,
      accountId: r.account_id,
      accountName: r.account_name,
      accountLocationId: r.owning_location_id,
      phone: r.phone,
      email: r.email,
      methods: withFallbackMethods(methods, r.phone, r.email),
    });
    setOpen(false);
  };

  const linkDupe = async (d: DupeRow) => {
    const methods = await loadContactMethods(d.contact_id);
    onChange({
      kind: "person",
      contactId: d.contact_id,
      name: d.full_name,
      title: d.title,
      accountId: d.account_id,
      accountName: d.account_name,
      accountLocationId: null,
      phone: d.phone,
      email: d.email,
      methods: withFallbackMethods(methods, d.phone, d.email),
    });
    setOpen(false);
  };

  const nothing = enabled && !searchQ.isFetching && inScope.length === 0;

  return (
    <div className="grid gap-1.5" ref={boxRef}>
      <Label>{label}</Label>
      <div className="relative">
        <Input
          value={text}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={
            placeholder ??
            (kind === "person" ? "Name, phone or email" : "Company name, phone or email")
          }
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            // Typing over a linked record unlinks it — free text always wins.
            onChange({ ...emptyCustomer(kind, e.target.value) });
            setOpen(true);
          }}
        />
        {open && enabled && (
          <div className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-sm border bg-popover p-1 shadow-md">
            {searchQ.isFetching && (
              <p className="px-2 py-2 text-xs text-muted-foreground">Searching…</p>
            )}
            {nothing && !elsewhereOffices && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No match for “{term}” — add them below.
              </p>
            )}
            {!searchQ.isFetching && (
              <OtherOfficeNotice
                offices={elsewhereOffices}
                what="customer"
                className="my-1 px-3 py-2"
              />
            )}

            {inScope.map((r) => (
              <button
                key={`${r.kind}-${r.id}`}
                type="button"
                onClick={() => void pickRow(r)}
                className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent"
              >
                {r.kind === "contact" ? (
                  <User className="mt-0.5 size-4 shrink-0 text-primary" />
                ) : (
                  <Building2 className="mt-0.5 size-4 shrink-0 text-primary" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.kind === "contact"
                      ? [r.title, r.account_name].filter(Boolean).join(" · ") ||
                        "No company on file"
                      : [r.account_type, r.owning_location_code, r.status]
                          .filter(Boolean)
                          .join(" · ")}
                  </div>
                  {(r.phone || r.email) && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {[r.phone, r.email].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}

            {/* Last row, always: the thing they are looking for may not exist
                yet, and sending them to another screen loses their place. */}
            {allowCreate && text.trim().length >= 2 && (
              <div className="mt-1 border-t pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setCreateOpen(true);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm font-medium text-primary hover:bg-accent"
                >
                  <Plus className="size-4 shrink-0" />
                  Create new {kind === "person" ? "customer" : "company"} — “{text.trim()}”
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {linked && value && (
        <div className="flex items-start justify-between gap-2 rounded-sm border bg-muted/30 px-2 py-1.5">
          <div className="min-w-0 text-xs">
            <span className="font-medium">Linked to the CRM</span>
            <span className="text-muted-foreground">
              {" · "}
              {[value.title, value.accountName].filter(Boolean).join(" · ") ||
                (value.kind === "company" ? "company record" : "person record")}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1"
            disabled={disabled}
            onClick={() => onChange(emptyCustomer(kind, value.name))}
            aria-label="Unlink customer"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {!linked && <OtherOfficeNotice offices={dupeOffices} what="customer" />}
      {!linked && dupes.length > 0 && (
        <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5" /> This may already be on file
          </div>
          <ul className="mt-1 space-y-1">
            {dupes.map((d) => (
              <li key={d.contact_id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {d.match_reason === "phone"
                    ? "Same phone"
                    : d.match_reason === "email"
                      ? "Same email"
                      : "Same name at this company"}
                  {": "}
                  <span className="font-medium">{d.full_name}</span>
                  {d.account_name ? ` at ${d.account_name}` : ""}
                  {d.owning_location_code ? ` · ${d.owning_location_code}` : ""}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 shrink-0 px-2 text-[11px]"
                  onClick={() => void linkDupe(d)}
                >
                  Link instead
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <CreateCustomerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        kind={kind}
        initialName={text.trim()}
        defaultAccount={defaultAccount ?? null}
        defaultLocationId={defaultLocationId ?? null}
        onCreated={(c) => onChange(c)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Prior jobs at the same property                                     */
/* ------------------------------------------------------------------ */

export interface PriorJob {
  job_id: string;
  job_number: string;
  address: string;
  loss_type: string;
  job_date: string | null;
  customer_kind: string | null;
  customer_name: string | null;
  account_id: string | null;
  account_name: string | null;
  primary_contact_id: string | null;
  primary_contact_name: string | null;
  owning_location_id: string | null;
  owning_location_code: string | null;
  owning_location_name: string | null;
  matched_by: string;
  viewer_has_full_access: boolean;
}

export function usePriorJobsAtAddress(
  address: string,
  lat?: string | number,
  lon?: string | number,
) {
  const term = useDebounced(address.trim(), 400);
  const la = lat === "" || lat == null ? null : Number(lat);
  const lo = lon === "" || lon == null ? null : Number(lon);
  return useQuery({
    queryKey: ["prior-jobs-at-address", term, la, lo],
    enabled: term.length >= 5,
    queryFn: async (): Promise<PriorJob[]> => {
      const { data, error } = await supabase.rpc("prior_jobs_at_address", {
        _address: term,
        _lat: la != null && Number.isFinite(la) ? la : undefined,
        _lon: lo != null && Number.isFinite(lo) ? lo : undefined,
      });
      if (error) throw error;
      return (data ?? []) as unknown as PriorJob[];
    },
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(d: string | null) {
  if (!d) return "";
  const dt = new Date(d);
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/**
 * Repeat losses at the same building are normal in restoration, and the same
 * property manager turns up across many buildings. One click adopts the
 * customer we already recorded there.
 */
export function PriorJobsBanner({
  address,
  lat,
  lon,
  onAdopt,
}: {
  address: string;
  lat?: string | number;
  lon?: string | number;
  onAdopt?: (job: PriorJob) => void;
}) {
  const q = usePriorJobsAtAddress(address, lat, lon);
  // Only jobs this person may open: another office's job is not mentioned.
  const jobs = (q.data ?? []).filter((j) => j.viewer_has_full_access);
  if (jobs.length === 0) return null;
  const latest = jobs[0]!;

  return (
    <div className="rounded-sm border border-primary/40 bg-primary/5 p-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <History className="size-3.5" />
        {jobs.length} previous job{jobs.length === 1 ? "" : "s"} at this address
        {latest.matched_by === "proximity" ? " (same building)" : ""}
      </div>
      <div className="mt-1 space-y-1.5">
        {jobs.slice(0, 3).map((j) => (
          <PriorJobRow key={j.job_id} job={j} onAdopt={onAdopt} />
        ))}
      </div>
    </div>
  );
}

/**
 * One earlier job at the address, with enough of its customer to decide
 * (26 Oct: "show more details of customer"). The name is the job's own
 * Customer name — typed on that job. When it was never linked to a saved
 * customer (no account, no contact) it is NOT in Customers, and the row says
 * so, rather than leaving the office searching Customers for it.
 */
function PriorJobRow({ job: j, onAdopt }: { job: PriorJob; onAdopt?: (job: PriorJob) => void }) {
  const contactQ = useQuery({
    queryKey: ["prior-job-contact-methods", j.primary_contact_id],
    enabled: j.viewer_has_full_access && !!j.primary_contact_id,
    queryFn: () => loadContactMethods(j.primary_contact_id!),
    staleTime: 60_000,
  });
  const methods = (contactQ.data ?? []).slice(0, 2);
  const saved = !!(j.account_id || j.primary_contact_id);
  const kind =
    j.customer_kind === "company" ? "Company" : j.customer_kind === "person" ? "Individual" : null;
  const when = [j.loss_type, j.job_date ? shortDate(j.job_date) : null].filter(Boolean).join(", ");
  return (
    <div className="flex items-start justify-between gap-2" data-prior-job>
      <div className="min-w-0 space-y-0.5">
        {j.viewer_has_full_access ? (
          <>
            {/* Whose job it was leads the row (David, 21 Oct): it is what
                tells two jobs at one address apart. */}
            <span className="block truncate font-semibold" data-prior-customer>
              {j.customer_name ||
                j.account_name ||
                j.primary_contact_name ||
                "No customer recorded"}
            </span>
            <span className="block text-muted-foreground" data-prior-customer-detail>
              {[kind, saved ? "Saved customer" : "Typed on the job — not a saved customer"]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {j.account_name && j.account_name !== j.customer_name ? (
              <span className="block truncate text-muted-foreground">
                Account: {j.account_name}
              </span>
            ) : null}
            {j.primary_contact_name || methods.length ? (
              <span className="block truncate text-muted-foreground">
                Contact:{" "}
                {[j.primary_contact_name, ...methods.map((m) => m.value)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </>
        ) : null}
        <span className="block truncate text-muted-foreground">
          {j.viewer_has_full_access ? (
            <a
              href={`/jobs/${j.job_id}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-foreground underline-offset-2 hover:underline"
              title="Open that job in a new tab"
            >
              {j.job_number}
            </a>
          ) : (
            <span className="font-mono">{j.job_number}</span>
          )}
          {when ? ` · ${when}` : ""}
          {j.owning_location_name ? ` · ${j.owning_location_name}` : ""}
        </span>
      </div>
      {onAdopt && j.viewer_has_full_access && (j.customer_name || j.account_id) && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-[11px]"
          onClick={() => onAdopt(j)}
        >
          Use this customer
        </Button>
      )}
    </div>
  );
}

/** Turn a prior job into a customer selection, pulling its contact methods. */
export async function customerFromPriorJob(j: PriorJob): Promise<PickedCustomer> {
  const methods = j.primary_contact_id ? await loadContactMethods(j.primary_contact_id) : [];
  return {
    kind: (j.customer_kind as CustomerKind) === "company" ? "company" : "person",
    contactId: j.primary_contact_id,
    name: j.customer_name ?? j.primary_contact_name ?? j.account_name ?? "",
    title: null,
    accountId: j.account_id,
    accountName: j.account_name,
    accountLocationId: j.owning_location_id,
    phone: null,
    email: null,
    methods,
  };
}
