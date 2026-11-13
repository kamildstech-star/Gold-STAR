/**
 * Customers — the merged Accounts + Contacts view.
 *
 * One search box spans companies and people (name, contact name, phone, email,
 * address). Tabs narrow to one type when a rep wants to work a single list.
 * Both underlying tables are untouched: a company row opens the account record,
 * a person row opens the contact — exactly as before.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Building2, Plus, Search, SlidersHorizontal, User, Users } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { DataTable, IdentityCell, type DataColumn } from "@/components/data-table";
import { MasterDetail } from "@/components/master-detail";
import { ContactDrawer, type ContactDrawerRow } from "@/components/contact-drawer";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import { LabelFilter, ALL_LABELS } from "@/components/label-filter";
import { LabelPills } from "@/components/label-pill";
import { OwnerFilter, EVERYONE } from "@/components/owner-filter";
import { LocationFilter } from "@/components/location-filter";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  accountMatchesOffices,
  fetchAccountLocationsMap,
  footprintLabel,
} from "@/lib/account-locations";
import { fetchLabelMap, type Label } from "@/lib/labels";
import { fetchGiftPolicies } from "@/lib/gift-policy";
import { AWAITING_APPROVAL_ROW, approvalLabel, isAwaitingApproval } from "@/lib/approval";
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABEL,
  cadenceHealth,
  HEALTH_LABEL,
  daysSinceTs,
  type AccountStatus,
} from "@/lib/accounts";
import {
  fetchComplianceIndicators,
  INDICATOR_DOT,
  INDICATOR_LABEL,
  INDICATOR_TONE,
  type ComplianceIndicator,
} from "@/lib/credentials";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
type Tab = "all" | "companies" | "people";

const DEFAULT_STATUS = "active_pipeline";

const GIFT_POLICY_LABEL: Record<string, string> = {
  unknown: "Policy unknown",
  open: "Gifts allowed",
  approval_required: "Pre-approval required",
  prohibited: "Gifts prohibited",
};

const ROLE_LABEL: Record<string, string> = {
  decision_maker: "Decision maker",
  regional_manager: "Regional manager",
  influencer: "Influencer",
  gatekeeper: "Gatekeeper",
};

type CompanyRow = {
  id: string;
  name: string;
  status: AccountStatus;
  account_type: string | null;
  location_id: string | null;
  /** Worked from more than one office. Absent until the migration lands. */
  is_multi_location?: boolean;
  assigned_rep: string | null;
  phone: string | null;
  email: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  last_in_person_at: string | null;
  approval_state: string | null;
  approval_due_on: string | null;
};

type AccountLite = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  status: string;
  account_type: string;
  location_id: string | null;
  assigned_rep: string | null;
};

type PersonRow = ContactDrawerRow & {
  gift_policy: string;
  created_at: string;
  location_id: string | null;
  account: AccountLite | null;
  last_touch: { at: string; type: string } | null;
};

type LocationLite = { id: string; code: string; name: string };

export const Route = createFileRoute("/_authenticated/customers/")({
  head: () => ({
    meta: [
      { title: "Customers · Recovery Hub" },
      {
        name: "description",
        content: "Every company and person you work with, in one searchable customer directory.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput) => ({
    tab: (["all", "companies", "people"] as const).includes(raw.tab as Tab)
      ? (raw.tab as Tab)
      : ("all" as Tab),
    q: typeof raw.q === "string" ? raw.q : "",
    status: typeof raw.status === "string" && raw.status ? raw.status : DEFAULT_STATUS,
    sel: typeof raw.sel === "string" && raw.sel ? raw.sel : undefined,
  }),
  component: CustomersPage,
});

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);
}

function hay(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function CustomersPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab = search.tab;
  const [qDraft, setQDraft] = useState(search.q);
  const [owner, setOwner] = useState(EVERYONE);
  const [labelId, setLabelId] = useState(ALL_LABELS);
  const [locIds, setLocIds] = useState<string[]>([]);
  const [footprint, setFootprint] = useState<"any" | "single" | "multi">("any");
  const [showArchived, setShowArchived] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [createKind, setCreateKind] = useState<"company" | "person" | null>(null);

  const term = search.q.trim().toLowerCase();
  const selectedId = search.sel ?? null;

  const update = (patch: Partial<{ tab: Tab; q: string; status: string; sel?: string }>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const selectPerson = (id: string | null) =>
    navigate({ search: (prev) => ({ ...prev, sel: id ?? undefined }), replace: true });

  const locationsQ = useQuery({
    queryKey: ["locations-lite"],
    queryFn: async () => {
      const { data } = await supabase.from("locations").select("id,code,name").order("code");
      return (data ?? []) as LocationLite[];
    },
  });

  const companiesQ = useQuery({
    queryKey: ["customers-companies", showArchived],
    queryFn: async (): Promise<CompanyRow[]> => {
      const run = (withFootprint: boolean) => {
        let q = supabase
          .from("accounts")
          .select(
            `id,name,status,account_type,location_id,assigned_rep,phone,email,address_line1,city,state,last_in_person_at,approval_state,approval_due_on${
              withFootprint ? ",is_multi_location" : ""
            }`,
          )
          .order("name")
          .limit(1000);
        q = showArchived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
        return q;
      };
      // is_multi_location ships in a migration that is written but not
      // applied; a database without it must still list every company.
      let res = await run(true);
      if (res.error && isMissingSchema(res.error)) res = await run(false);
      if (res.error) throw res.error;
      return (res.data ?? []) as unknown as CompanyRow[];
    },
  });

  /** Offices serving each company — the owner plus any extras. */
  const servedQ = useQuery({
    queryKey: ["customers-account-locations"],
    queryFn: () => fetchAccountLocationsMap(),
  });
  const servedBy = useMemo(() => servedQ.data ?? new Map<string, string[]>(), [servedQ.data]);

  const peopleQ = useQuery({
    queryKey: ["customers-people", showArchived],
    queryFn: async (): Promise<PersonRow[]> => {
      let query = supabase
        .from("contacts")
        .select(
          "id, full_name, title, email, phone, is_primary, decision_role, archived_at, created_at, location_id, account:account_id(id, name, city, state, status, account_type, location_id, assigned_rep)",
        )
        .order("full_name")
        .limit(1000);
      query = showArchived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
      const { data, error } = await query;
      if (error) throw error;
      const rowsRaw = data ?? [];
      const ids = rowsRaw.map((r) => r.id);
      const [policies, touches] = await Promise.all([
        fetchGiftPolicies(ids),
        ids.length
          ? supabase
              .from("touchpoints")
              .select("contact_id, type, occurred_at")
              .in("contact_id", ids)
              .order("occurred_at", { ascending: false })
              .limit(3000)
          : Promise.resolve({ data: [], error: null } as const),
      ]);
      const lastTouch = new Map<string, { at: string; type: string }>();
      for (const t of touches.data ?? []) {
        if (t.contact_id && !lastTouch.has(t.contact_id)) {
          lastTouch.set(t.contact_id, { at: t.occurred_at, type: t.type });
        }
      }
      return rowsRaw.map((r) => ({
        ...r,
        gift_policy: policies.get(r.id) ?? "unknown",
        last_touch: lastTouch.get(r.id) ?? null,
      })) as unknown as PersonRow[];
    },
  });

  const repsQ = useQuery({
    queryKey: ["customers-reps"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("user_id, full_name");
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name as string]));
    },
  });

  const companyIds = useMemo(() => (companiesQ.data ?? []).map((c) => c.id), [companiesQ.data]);
  const personIds = useMemo(() => (peopleQ.data ?? []).map((c) => c.id), [peopleQ.data]);

  const companyLabelsQ = useQuery({
    queryKey: ["customers-account-labels", companyIds.length, showArchived],
    enabled: companyIds.length > 0,
    queryFn: () => fetchLabelMap("account", companyIds),
  });
  const personLabelsQ = useQuery({
    queryKey: ["customers-contact-labels", personIds.length, showArchived],
    enabled: personIds.length > 0,
    queryFn: () => fetchLabelMap("contact", personIds),
  });
  const complianceQ = useQuery({
    queryKey: ["customers-compliance", companyIds.length, showArchived],
    enabled: companyIds.length > 0,
    queryFn: () => fetchComplianceIndicators(companyIds),
  });
  const indicators: Record<string, ComplianceIndicator> = complianceQ.data ?? {};
  const companyLabels: Record<string, Label[]> = companyLabelsQ.data ?? {};
  const personLabels: Record<string, Label[]> = personLabelsQ.data ?? {};

  /** Contacts indexed by company, so a company also matches on its people. */
  const peopleByAccount = useMemo(() => {
    const map = new Map<string, PersonRow[]>();
    for (const p of peopleQ.data ?? []) {
      if (!p.account?.id) continue;
      const list = map.get(p.account.id) ?? [];
      list.push(p);
      map.set(p.account.id, list);
    }
    return map;
  }, [peopleQ.data]);

  const companies = useMemo(() => {
    return (companiesQ.data ?? []).filter((c) => {
      if (search.status === "active_pipeline") {
        if (!["prospect", "onboarding", "active"].includes(c.status)) return false;
      } else if (search.status !== "all" && c.status !== search.status) return false;
      // A company shows under every office that owns OR serves it.
      if (!accountMatchesOffices(c.location_id, servedBy.get(c.id), locIds)) return false;
      if (footprint !== "any" && (c.is_multi_location === true) !== (footprint === "multi"))
        return false;
      if (owner !== EVERYONE) {
        if (owner === "unassigned" ? c.assigned_rep !== null : c.assigned_rep !== owner)
          return false;
      }
      if (labelId !== ALL_LABELS && !(companyLabels[c.id] ?? []).some((l) => l.id === labelId))
        return false;
      if (!term) return true;
      const contactNames = (peopleByAccount.get(c.id) ?? [])
        .map((p) => `${p.full_name} ${p.email ?? ""} ${p.phone ?? ""}`)
        .join(" ");
      return hay(c.name, c.phone, c.email, c.address_line1, c.city, c.state, contactNames).includes(
        term,
      );
    });
  }, [
    companiesQ.data,
    search.status,
    locIds,
    servedBy,
    footprint,
    owner,
    labelId,
    companyLabels,
    term,
    peopleByAccount,
  ]);

  const people = useMemo(() => {
    return (peopleQ.data ?? []).filter((p) => {
      const acctStatus = p.account?.status ?? null;
      if (search.status === "active_pipeline") {
        if (acctStatus && !["prospect", "onboarding", "active"].includes(acctStatus)) return false;
      } else if (search.status !== "all" && acctStatus !== search.status) return false;
      const loc = p.account?.location_id ?? p.location_id ?? null;
      if (locIds.length > 0 && (!loc || !locIds.includes(loc))) return false;
      if (owner !== EVERYONE) {
        const rep = p.account?.assigned_rep ?? null;
        if (owner === "unassigned" ? rep !== null : rep !== owner) return false;
      }
      if (labelId !== ALL_LABELS && !(personLabels[p.id] ?? []).some((l) => l.id === labelId))
        return false;
      if (!term) return true;
      return hay(
        p.full_name,
        p.title,
        p.email,
        p.phone,
        p.account?.name,
        p.account?.city,
        p.account?.state,
      ).includes(term);
    });
  }, [peopleQ.data, search.status, locIds, owner, labelId, personLabels, term]);

  const locById = new Map((locationsQ.data ?? []).map((l) => [l.id, l]));
  const allOfficeIds = (locationsQ.data ?? []).map((l) => l.id);
  const footprintOf = (r: CompanyRow) =>
    footprintLabel({
      isMultiLocation: r.is_multi_location === true,
      servingIds: servedBy.get(r.id) ?? [],
      allOfficeIds,
    });
  const loading = companiesQ.isLoading || peopleQ.isLoading;

  const companyColumns: DataColumn<CompanyRow>[] = [
    {
      key: "name",
      header: "Company",
      identity: true,
      width: "250px",
      value: (r) => r.name,
      cell: (r) => (
        <IdentityCell
          icon={<Building2 className="size-3.5" />}
          primary={r.name}
          secondary={
            isAwaitingApproval(r.approval_state)
              ? approvalLabel(r.approval_state, r.approval_due_on)
              : `${locById.get(r.location_id ?? "")?.code ?? "—"} · ${ACCOUNT_STATUS_LABEL[r.status]}`
          }
        />
      ),
    },
    {
      key: "compliance",
      header: "Compliance",
      width: "130px",
      filter: "select",
      value: (r) => INDICATOR_LABEL[indicators[r.id] ?? "none"],
      cell: (r) => {
        const ind = indicators[r.id] ?? "none";
        if (ind === "none") return <span className="text-muted-foreground">—</span>;
        // Straight into that account's compliance section — the next thing
        // anyone does after seeing a red chip is go and look at why.
        return (
          <Link
            to="/accounts/$id"
            params={{ id: r.id }}
            hash="compliance"
            onClick={(e) => e.stopPropagation()}
          >
            <Badge
              variant="outline"
              className={`h-4 gap-1 rounded-[4px] px-1.5 text-[10px] ${INDICATOR_TONE[ind]}`}
            >
              <span className={`size-1.5 rounded-full ${INDICATOR_DOT[ind]}`} />
              {INDICATOR_LABEL[ind]}
            </Badge>
          </Link>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: "110px",
      filter: "select",
      value: (r) => ACCOUNT_STATUS_LABEL[r.status],
    },
    {
      key: "office",
      header: "Office",
      width: "110px",
      filter: "select",
      value: (r) => locById.get(r.location_id ?? "")?.code ?? "—",
    },
    {
      key: "footprint",
      header: "Footprint",
      width: "150px",
      filter: "select",
      defaultHidden: true,
      value: (r) => footprintOf(r),
    },
    { key: "phone", header: "Phone", width: "130px", value: (r) => r.phone ?? "—" },
    { key: "email", header: "Email", width: "200px", value: (r) => r.email ?? "—" },
    {
      key: "address",
      header: "Address",
      width: "220px",
      value: (r) => [r.address_line1, r.city, r.state].filter(Boolean).join(", ") || "—",
    },
    {
      key: "people",
      header: "People",
      numeric: true,
      width: "90px",
      value: (r) => (peopleByAccount.get(r.id) ?? []).length,
    },
    {
      key: "cadence",
      header: "Cadence",
      width: "120px",
      filter: "select",
      defaultHidden: true,
      value: (r) => HEALTH_LABEL[cadenceHealth(null, r.last_in_person_at)],
    },
    {
      key: "labels",
      header: "Labels",
      width: "190px",
      value: (r) => (companyLabels[r.id] ?? []).map((l) => l.name).join(", "),
      cell: (r) => {
        const list = companyLabels[r.id] ?? [];
        return list.length ? (
          <LabelPills labels={list} max={4} />
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
  ];

  const personColumns: DataColumn<PersonRow>[] = [
    {
      key: "full_name",
      header: "Person",
      identity: true,
      width: "220px",
      value: (c) => c.full_name,
      cell: (c) => (
        <IdentityCell
          icon={<Avatar name={c.full_name} className="size-7" />}
          primary={
            <>
              {c.full_name}
              {c.is_primary ? (
                <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[10px]">
                  Primary
                </Badge>
              ) : null}
            </>
          }
          secondary={c.title ?? ROLE_LABEL[c.decision_role ?? ""] ?? "—"}
        />
      ),
    },
    {
      key: "account",
      header: "Company",
      width: "210px",
      filter: "select",
      value: (c) => c.account?.name ?? "—",
      cell: (c) =>
        c.account ? (
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{c.account.name}</div>
            <div className="truncate text-[12px] text-muted-foreground">
              {[c.account.city, c.account.state].filter(Boolean).join(", ") || "—"}
            </div>
          </div>
        ) : (
          "—"
        ),
    },
    {
      key: "decision_role",
      header: "Role",
      width: "140px",
      filter: "select",
      value: (c) => (c.decision_role ? (ROLE_LABEL[c.decision_role] ?? c.decision_role) : "—"),
    },
    { key: "phone", header: "Phone", width: "130px", value: (c) => c.phone ?? "—" },
    { key: "email", header: "Email", width: "200px", value: (c) => c.email ?? "—" },
    {
      key: "last_touch",
      header: "Last interaction",
      width: "150px",
      value: (c) => c.last_touch?.at ?? "",
      cell: (c) =>
        c.last_touch ? (
          <div className="min-w-0">
            <div className="truncate">{fmtDate(c.last_touch.at)}</div>
            <div className="truncate text-[12px] capitalize text-muted-foreground">
              {c.last_touch.type.replace(/_/g, " ")}
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">No activity</span>
        ),
    },
    {
      key: "assigned",
      header: "Assigned to",
      width: "160px",
      filter: "select",
      value: (c) =>
        (c.account?.assigned_rep ? repsQ.data?.get(c.account.assigned_rep) : null) ?? "Unassigned",
    },
    {
      key: "labels",
      header: "Labels",
      width: "170px",
      defaultHidden: true,
      value: (c) => (personLabels[c.id] ?? []).map((l) => l.name).join(", "),
      cell: (c) => <LabelPills labels={personLabels[c.id] ?? []} max={3} />,
    },
    {
      key: "gift_policy",
      header: "Gift policy",
      width: "150px",
      defaultHidden: true,
      filter: "select",
      value: (c) => GIFT_POLICY_LABEL[c.gift_policy] ?? c.gift_policy,
      cell: (c) => (
        <Badge
          variant={c.gift_policy === "prohibited" ? "destructive" : "outline"}
          className="rounded-md px-1.5 py-0 text-[11px]"
        >
          {GIFT_POLICY_LABEL[c.gift_policy] ?? c.gift_policy}
        </Badge>
      ),
    },
  ];

  const shownCount =
    tab === "companies"
      ? companies.length
      : tab === "people"
        ? people.length
        : companies.length + people.length;

  /** Deviations from the default view — what the Filters trigger badges. */
  const activeFilterCount =
    (search.status !== DEFAULT_STATUS ? 1 : 0) +
    (owner !== EVERYONE ? 1 : 0) +
    (labelId !== ALL_LABELS ? 1 : 0) +
    (locIds.length ? 1 : 0) +
    (footprint !== "any" ? 1 : 0) +
    (showArchived ? 1 : 0);

  const customerFilters = (
    <>
      <Select value={search.status} onValueChange={(v) => update({ status: v })}>
        <SelectTrigger className="h-11 w-full md:h-9 md:w-[240px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active_pipeline">Active pipeline</SelectItem>
          <SelectItem value="all">All statuses</SelectItem>
          {ACCOUNT_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {ACCOUNT_STATUS_LABEL[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <OwnerFilter value={owner} onChange={setOwner} />
      <LabelFilter
        scope={tab === "people" ? "contact" : "account"}
        value={labelId}
        onChange={setLabelId}
      />
      <LocationFilter value={locIds} onChange={setLocIds} />
      {tab !== "people" ? (
        <Select
          value={footprint}
          onValueChange={(v) => setFootprint(v as "any" | "single" | "multi")}
        >
          <SelectTrigger className="h-11 w-full md:h-9 md:w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any footprint</SelectItem>
            <SelectItem value="single">Single office</SelectItem>
            <SelectItem value="multi">Multi-location</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      <div className="flex overflow-hidden rounded-md border md:ml-auto">
        {(["active", "archived"] as const).map((v) => {
          const on = (v === "archived") === showArchived;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setShowArchived(v === "archived")}
              className={`min-h-11 flex-1 px-4 text-[12px] capitalize md:min-h-0 md:flex-none md:px-2.5 md:py-1 ${
                on ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {v}
            </button>
          );
        })}
      </div>
    </>
  );

  /**
   * A ten-column grid is unreadable at 390px, so the phone gets one card per
   * row carrying only what identifies the record and what you would call or
   * visit it about. Sorting, grouping and the column picker are desktop
   * affordances and stay with the table; the saved per-user column choice is
   * simply not consulted here, and desktop still honours it untouched.
   */
  const companyCards = (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y">
          {companies.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => navigate({ to: "/accounts/$id", params: { id: c.id } })}
                className={cn(
                  "flex min-h-[44px] w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-accent",
                  isAwaitingApproval(c.approval_state) && AWAITING_APPROVAL_ROW,
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <Building2 className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                    {c.name}
                  </span>
                  {(indicators[c.id] ?? "none") !== "none" && (
                    <Badge
                      variant="outline"
                      className={`h-5 shrink-0 gap-1 rounded-[4px] px-1.5 text-[10px] ${INDICATOR_TONE[indicators[c.id]!]}`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${INDICATOR_DOT[indicators[c.id]!]}`}
                      />
                      {INDICATOR_LABEL[indicators[c.id]!]}
                    </Badge>
                  )}
                </span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {isAwaitingApproval(c.approval_state)
                    ? approvalLabel(c.approval_state, c.approval_due_on)
                    : `${locById.get(c.location_id ?? "")?.code ?? "—"} · ${ACCOUNT_STATUS_LABEL[c.status]} · ${(peopleByAccount.get(c.id) ?? []).length} people${
                        c.is_multi_location ? ` · ${footprintOf(c)}` : ""
                      }`}
                </span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {[c.phone, [c.address_line1, c.city, c.state].filter(Boolean).join(", ")]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );

  const personCards = (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y">
          {people.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => selectPerson(p.id)}
                className="flex min-h-[44px] w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-accent"
              >
                <span className="flex items-center gap-2">
                  <Avatar name={p.full_name} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                    {p.full_name}
                  </span>
                  {p.is_primary && (
                    <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px]">
                      Primary
                    </Badge>
                  )}
                </span>
                <span className="block truncate text-[12px] font-medium text-muted-foreground">
                  {p.account?.name ?? "No company"}
                </span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {[p.title ?? ROLE_LABEL[p.decision_role ?? ""], p.phone, p.email]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </span>
                <span className="block truncate text-[11.5px] text-muted-foreground">
                  {p.last_touch
                    ? `Last: ${fmtDate(p.last_touch.at)} · ${p.last_touch.type.replace(/_/g, " ")}`
                    : "No activity"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );

  /** A failed query is not an empty directory — say which, and offer the retry. */
  const listError = (what: string, error: unknown, retry: () => void) => (
    <Card>
      <CardContent className="space-y-2 p-4 text-[13px]">
        <p className="font-medium text-destructive">{what} could not be loaded.</p>
        <p className="text-muted-foreground">
          {error instanceof Error ? error.message : "The request failed."} This screen is not an
          empty list — nothing should be concluded from it.
        </p>
        <Button variant="outline" className="h-11 md:h-9" onClick={retry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <div className="page-shell space-y-3 pb-20 md:pb-4">
      <PageHeader
        title="Customers"
        subtitle={`${shownCount.toLocaleString("en-US")} shown · companies and people together`}
      >
        <Button size="sm" className="h-11 md:h-9" onClick={() => setCreateKind("company")}>
          <Plus className="mr-1.5 size-4" /> New company
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-11 md:h-9"
          onClick={() => setCreateKind("person")}
        >
          <Plus className="mr-1.5 size-4" /> New person
        </Button>
      </PageHeader>

      <CreateCustomerDialog
        open={createKind !== null}
        onOpenChange={(v) => !v && setCreateKind(null)}
        kind={createKind ?? "company"}
        onCreated={() => {
          void companiesQ.refetch();
          void peopleQ.refetch();
        }}
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") update({ q: qDraft });
          }}
          onBlur={() => {
            if (qDraft !== search.q) update({ q: qDraft });
          }}
          placeholder="Search companies and people — name, contact, phone, email, address"
          className="h-11 pl-9"
        />
      </div>

      <div className="flex items-center gap-1 overflow-x-auto border-b">
        {(
          [
            { key: "all", label: `All (${companies.length + people.length})` },
            { key: "companies", label: `Companies (${companies.length})` },
            { key: "people", label: `People (${people.length})` },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => update({ tab: t.key as Tab })}
            className={cn(
              "-mb-px min-h-11 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors md:min-h-0",
              tab === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <MetricStrip
        metrics={[
          { label: "Companies", value: companies.length.toLocaleString("en-US"), icon: Building2 },
          { label: "People", value: people.length.toLocaleString("en-US"), icon: User },
          {
            label: "Customers in view",
            value: (companies.length + people.length).toLocaleString("en-US"),
            icon: Users,
          },
        ]}
      />

      {/* Phone: one Filters control with the active count on it. Desktop: the
          same controls inline. Defined once so the two cannot drift apart. */}
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline" className="h-11 w-full md:hidden">
            <SlidersHorizontal className="mr-1.5 size-4" />
            Filters
            {activeFilterCount > 0 && (
              <Badge className="ml-1.5 h-5 min-w-5 justify-center px-1">{activeFilterCount}</Badge>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="max-h-[85svh] gap-3 rounded-t-xl p-4">
          <SheetHeader className="text-left">
            <SheetTitle className="text-base">Filters</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 [&>*]:w-full">{customerFilters}</div>
        </SheetContent>
      </Sheet>

      <div className="hidden flex-wrap items-center gap-2 md:flex">{customerFilters}</div>

      {companiesQ.isError ? (
        listError("Companies", companiesQ.error, () => void companiesQ.refetch())
      ) : peopleQ.isError ? (
        listError("People", peopleQ.error, () => void peopleQ.refetch())
      ) : tab === "all" ? (
        <MergedList
          companies={companies}
          people={people}
          loading={loading}
          locById={locById}
          onOpenCompany={(id) => navigate({ to: "/accounts/$id", params: { id } })}
          onOpenPerson={(id) => update({ tab: "people", sel: id })}
        />
      ) : tab === "companies" ? (
        <>
          <div className="md:hidden">
            {companiesQ.isLoading ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">Loading…</CardContent>
              </Card>
            ) : companies.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  No companies match those filters.
                </CardContent>
              </Card>
            ) : (
              companyCards
            )}
          </div>
          <div className="hidden md:block">
            <DataTable
              tableKey="customers-companies"
              columns={companyColumns}
              rows={companies}
              rowId={(r) => r.id}
              loading={companiesQ.isLoading}
              defaultSortKey="name"
              exportName="companies"
              exportEntity="accounts"
              emptyMessage="No companies match those filters."
              onRowClick={(r) => navigate({ to: "/accounts/$id", params: { id: r.id } })}
              rowClassName={(r) =>
                isAwaitingApproval(r.approval_state) ? AWAITING_APPROVAL_ROW : undefined
              }
              detailRows={(r) => [
                { label: "Status", value: ACCOUNT_STATUS_LABEL[r.status] },
                { label: "Office", value: locById.get(r.location_id ?? "")?.name ?? "—" },
                { label: "Phone", value: r.phone ?? "—" },
                { label: "Email", value: r.email ?? "—" },
                {
                  label: "Address",
                  value: [r.address_line1, r.city, r.state].filter(Boolean).join(", ") || "—",
                },
                { label: "People", value: (peopleByAccount.get(r.id) ?? []).length },
              ]}
            />
          </div>
        </>
      ) : (
        /* One MasterDetail at every width — it already falls back to the
           full-screen contact drawer when there is no room for a split, and a
           second mounted ContactDrawer would portal a duplicate sheet. Only the
           list inside it swaps between cards and the table. */
        <MasterDetail
          storageKey="customers-people"
          selectedId={selectedId}
          onSelect={selectPerson}
          order={order}
          detail={
            <ContactDrawer
              contact={people.find((r) => r.id === selectedId) ?? null}
              onOpenChange={(v) => !v && selectPerson(null)}
              onChanged={() => void peopleQ.refetch()}
            />
          }
        >
          <div className="md:hidden">
            {peopleQ.isLoading ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">Loading…</CardContent>
              </Card>
            ) : people.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-sm text-muted-foreground">
                  No people match those filters.
                </CardContent>
              </Card>
            ) : (
              personCards
            )}
          </div>
          <div className="hidden md:block">
            <DataTable
              tableKey="customers-people"
              columns={personColumns}
              rows={people}
              rowId={(c) => c.id}
              selectedId={selectedId}
              onOrderChange={setOrder}
              loading={peopleQ.isLoading}
              defaultSortKey="full_name"
              exportName="contacts"
              exportEntity="contacts"
              emptyMessage="No people match those filters."
              onRowClick={(c) => selectPerson(c.id)}
              detailRows={(c) => [
                { label: "Company", value: c.account?.name ?? "—" },
                { label: "Email", value: c.email ?? "—" },
                { label: "Phone", value: c.phone ?? "—" },
                { label: "Decision role", value: c.decision_role ?? "—" },
                {
                  label: "Gift policy",
                  value: GIFT_POLICY_LABEL[c.gift_policy] ?? c.gift_policy,
                  sub:
                    c.gift_policy === "prohibited"
                      ? "Excluded from every gift send, automatically."
                      : undefined,
                },
              ]}
            />
          </div>
        </MasterDetail>
      )}
    </div>
  );
}

/** The blended All view: companies and people interleaved, each labelled. */
function MergedList({
  companies,
  people,
  loading,
  locById,
  onOpenCompany,
  onOpenPerson,
}: {
  companies: CompanyRow[];
  people: PersonRow[];
  loading: boolean;
  locById: Map<string, LocationLite>;
  onOpenCompany: (id: string) => void;
  onOpenPerson: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const merged: Array<
      | { kind: "company"; id: string; name: string; sub: string }
      | { kind: "person"; id: string; name: string; sub: string; company: string }
    > = [
      ...companies.map((c) => ({
        kind: "company" as const,
        id: c.id,
        name: c.name,
        sub:
          [
            locById.get(c.location_id ?? "")?.code,
            ACCOUNT_STATUS_LABEL[c.status],
            [c.address_line1, c.city, c.state].filter(Boolean).join(", ") || null,
            c.phone,
          ]
            .filter(Boolean)
            .join(" · ") || "—",
      })),
      ...people.map((p) => ({
        kind: "person" as const,
        id: p.id,
        name: p.full_name,
        sub: [p.title, p.email, p.phone].filter(Boolean).join(" · ") || "—",
        company: p.account?.name ?? "No company",
      })),
    ];
    merged.sort((a, b) => a.name.localeCompare(b.name));
    return merged.slice(0, 600);
  }, [companies, people, locById]);

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">Loading customers…</CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-sm">
          <div className="font-medium">No customers match that search</div>
          <p className="text-xs text-muted-foreground">
            Try a shorter term, or widen the status filter to “All statuses”.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={`${r.kind}-${r.id}`}>
              <button
                type="button"
                onClick={() => (r.kind === "company" ? onOpenCompany(r.id) : onOpenPerson(r.id))}
                className="flex min-h-[44px] w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
              >
                {r.kind === "company" ? (
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <Building2 className="size-4" />
                  </span>
                ) : (
                  <Avatar name={r.name} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold">{r.name}</span>
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 rounded-[4px] px-1.5 text-[10px] font-medium"
                    >
                      {r.kind === "company" ? "Company" : "Person"}
                    </Badge>
                  </span>
                  {r.kind === "person" && (
                    <span className="block truncate text-[12px] font-medium text-muted-foreground">
                      {r.company}
                    </span>
                  )}
                  <span className="block truncate text-[12px] text-muted-foreground">{r.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {rows.length >= 600 && (
          <div className="border-t px-3 py-2 text-[12px] text-muted-foreground">
            Showing the first 600 matches — narrow the search to see more.{" "}
            <Link to="/customers" search={{ tab: "companies" }} className="underline">
              Switch to a single list
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
