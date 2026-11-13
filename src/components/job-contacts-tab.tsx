import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Building2,
  Check,
  Link2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  User,
  Star,
  Settings2,
  UserCheck,
  X,
  CornerDownRight,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { isPrivileged } from "@/lib/roles";
import { useOptionList, optionLabel } from "@/lib/option-lists";
import {
  crmDrift,
  crmRefreshPatch,
  derivedJobContacts,
  fetchJobContactOrigin,
  fetchJobContacts,
  fetchJobFirms,
  fetchLinkedCrmContacts,
  type CrmContactLite,
  type DerivedJobContact,
  type JobContactRow,
} from "@/lib/job-relationships";
import {
  belongsToAccount,
  canAddPeopleTo,
  createCompanyPerson,
  entryFromPerson,
  fetchPickablePeople,
  findExistingPerson,
  updateCompanyPerson,
  type CompanyPerson,
  type DuplicateMatch,
  type SharedPersonField,
} from "@/lib/company-people";
import {
  CONTACT_POSITION_OPTIONS,
  buildOrgTree,
  fetchCompanyPeople,
  fetchContactCovers,
  fetchPropertiesByIds,
  flattenOrgTree,
} from "@/lib/company-hierarchy";
import { ContactBuildingsChip, type ContactBuilding } from "@/components/contact-buildings-chip";
import { useManagedOptions } from "@/lib/managed-options";
import { isMissingSchema } from "@/lib/schema-fallback";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import { CompanyPersonPicker, companyPeopleKey } from "@/components/company-person-picker";
import { LinkedEditChoice, type LinkedEditScope } from "@/components/linked-edit-choice";
import { SiteEscalationCard } from "@/components/site-escalation-card";
import { SectionEdit } from "@/components/job-inline-field";
import { ORG_TONE_TAG, orgTone } from "@/lib/company-org-chart";
import { cn } from "@/lib/utils";
import { RowField } from "@/components/row-inline-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** A company the Contacts picker lists people from: the client or an insurance firm. */
type PickSource = {
  id: string;
  label: string;
  name: string | null;
  noun: string;
  role: string | null;
};

/**
 * Related contacts on a job. The relationship lives here, per job — the same
 * property manager is Customer on one job and Caller on another, so it must
 * never be stored on the contact record itself.
 *
 * The default contact is who we email or send a document to when nothing more
 * specific applies.
 */
export function JobContactsTab({ jobId }: { jobId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const { options: roles } = useOptionList("job_contact_role");
  const canEditList = isPrivileged(app.roles);
  const [role, setRole] = useState("customer");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  /*
   * Set when the entry row was filled from the account's people. The add then
   * links the job row to that record instead of saving anybody new. Typing a
   * different name drops it — that is somebody else now.
   */
  const [picked, setPicked] = useState<{ contactId: string; accountId: string | null } | null>(
    null,
  );
  const [positionKey, setPositionKey] = useState("");
  const [saveToAccount, setSaveToAccount] = useState(true);
  const [dupe, setDupe] = useState<DuplicateMatch<CompanyPerson> | null>(null);
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  /* 4 Nov: one row at a time — "every row should have edit option instead of
     bulk". The open row's fields are editable; the rest stay read. */
  const [editingRow, setEditingRow] = useState<string | null>(null);

  const rowsQ = useQuery({
    queryKey: ["job-contacts", jobId],
    queryFn: () => fetchJobContacts(jobId),
  });
  const rows: JobContactRow[] = rowsQ.data ?? [];

  /*
   * The customer and the main point of contact live on the `jobs` row, not in
   * `job_contacts` — see the note in job-relationships.ts. Reading them here
   * is what puts Mark's missing contact back on every job already in the
   * database, without a backfill.
   */
  const originQ = useQuery({
    queryKey: ["job-contacts-origin", jobId],
    queryFn: () => fetchJobContactOrigin(jobId),
  });
  /*
   * 4 Nov: "at same point how can it be company and customer?" When the
   * customer is a company (the job has a Company on General) the company is
   * the customer — it is shown once, above the list, as that, and never as a
   * person row. The list is for people. An individual customer is a person
   * and stays a row.
   */
  const companyCustomer = originQ.data?.account_id
    ? (originQ.data.account_name ?? originQ.data.customer_name ?? null)
    : null;
  const companyKeys = new Set(
    [originQ.data?.account_name, originQ.data?.customer_name]
      .map((v) => (v ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const isCompanyRow = (r: Pick<JobContactRow, "contact_id" | "full_name">) =>
    !!companyCustomer && !r.contact_id && companyKeys.has((r.full_name ?? "").trim().toLowerCase());
  const listRows = rows.filter((r) => !isCompanyRow(r));
  const derived = originQ.data
    ? derivedJobContacts(rows, originQ.data).filter(
        (d) => !(companyCustomer && d.key === "customer_name"),
      )
    : [];
  /*
   * 4 Nov: the customer is chosen on the General tab, so their row here is
   * General's, not this list's — no bin ("one thing i am selecting in general
   * instead of keep them we are giving the delete option"). A new Company on
   * General replaces it; that is the way to change it.
   */
  const jobRecordPeople = originQ.data ? derivedJobContacts([], originQ.data) : [];
  const fromGeneral = (r: JobContactRow) => {
    const name = (r.full_name ?? "").trim().toLowerCase();
    return jobRecordPeople.some(
      (d) =>
        (!!r.contact_id && d.contact_id === r.contact_id) ||
        (!!name && d.full_name.trim().toLowerCase() === name),
    );
  };
  const accountId = originQ.data?.account_id ?? null;
  const accountName = originQ.data?.account_name ?? null;
  /* The job's Company as the New-contact form wants it (with its office). */
  const jobCompanyQ = useQuery({
    queryKey: ["job-contacts-company", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id, name, location_id")
        .eq("id", accountId!)
        .maybeSingle();
      if (error) throw error;
      return data
        ? {
            id: data.id as string,
            name: (data.name as string) ?? "",
            location_id: (data.location_id as string) ?? "",
            primary_contact: null,
          }
        : null;
    },
    staleTime: 5 * 60_000,
  });

  /*
   * 5 Nov: the people in the company's order — the reporting line the
   * company page shows (Owner / CEO, then who reports to them, indented),
   * not the order they were added to the job. People who are not in the
   * company's tree (a typed name, another firm's adjuster) follow, as before.
   */
  const peopleQ = useQuery({
    queryKey: ["company-hierarchy", accountId],
    enabled: !!accountId,
    queryFn: () => fetchCompanyPeople(accountId!),
    staleTime: 5 * 60_000,
  });
  const orgPlace = useMemo(() => {
    const flat = flattenOrgTree(buildOrgTree(peopleQ.data?.rows ?? []).roots);
    return new Map(flat.map((n, i) => [n.contact.id, { order: i, depth: n.depth }]));
  }, [peopleQ.data]);
  const orderedRows = listRows
    .map((r, i) => ({ r, i, place: r.contact_id ? orgPlace.get(r.contact_id) : undefined }))
    .sort(
      (a, b) =>
        (a.place?.order ?? Number.MAX_SAFE_INTEGER) - (b.place?.order ?? Number.MAX_SAFE_INTEGER) ||
        a.i - b.i,
    );
  /* Depth among the people actually on this job: someone whose manager is not
     on the job sits one step in from the nearest one who is, never deeper. */
  const jobDepth = new Map<string, number>();
  {
    const stack: number[] = [];
    for (const { r, place } of orderedRows) {
      if (!place) continue;
      while (stack.length && stack[stack.length - 1]! >= place.depth) stack.pop();
      jobDepth.set(r.id, Math.min(stack.length, 4));
      stack.push(place.depth);
    }
  }

  /*
   * Who the picker lists: the client by default, or one of the firms on the
   * Insurance card — the carrier's adjusters, the PA, the reviewer, the agent
   * — so they are added to the job without being typed again.
   */
  const firmsQ = useQuery({
    queryKey: ["job-contacts-firms", jobId],
    queryFn: () => fetchJobFirms(jobId),
  });
  const pickSources: PickSource[] = [
    ...(accountId
      ? [{ id: accountId, label: "Client", name: accountName, noun: "company", role: null }]
      : []),
    ...(firmsQ.data ?? [])
      .filter((f) => f.accountId !== accountId)
      .map((f) => ({
        id: f.accountId,
        label: f.label,
        name: f.accountName,
        noun: f.noun,
        role: f.role as string | null,
      })),
  ];
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source: PickSource | null =
    pickSources.find((p) => p.id === sourceId) ?? pickSources[0] ?? null;

  /* Whether a person typed here may be filed under the account — the contacts
     policy, asked up front so the "save for next time" box is only offered to
     people it would let through. */
  const canAddQ = useQuery({
    queryKey: ["can-add-people", accountId, app.userId],
    enabled: !!accountId && !app.writesDisabled,
    queryFn: () => canAddPeopleTo(accountId!, app.userId),
    staleTime: 5 * 60_000,
  });
  const canSaveBack =
    !!accountId && canAddQ.data === true && !picked && belongsToAccount(company, accountName);

  /*
   * The CRM records behind the linked rows, read once per render of the list
   * and never polled. This exists only to answer "does this differ?" and to
   * give the refresh action something to copy — nothing here writes.
   */
  const linkedIds = rows.map((r) => r.contact_id).filter((v): v is string => !!v);
  const crmQ = useQuery({
    queryKey: ["job-contacts-crm", jobId, linkedIds.join(",")],
    enabled: linkedIds.length > 0,
    queryFn: () => fetchLinkedCrmContacts(linkedIds),
  });
  const crmById = crmQ.data ?? new Map<string, CrmContactLite>();
  /* D2, 5 Nov review: which buildings each linked person runs, as a small
     building icon with a count beside their name. */
  const buildingsQ = useQuery({
    queryKey: ["job-contacts-buildings", linkedIds.join(",")],
    enabled: linkedIds.length > 0,
    queryFn: async () => {
      const covers = await fetchContactCovers(linkedIds);
      const props = await fetchPropertiesByIds([...new Set(covers.rows.map((c) => c.property_id))]);
      return { covers: covers.rows, props: new Map(props.map((p) => [p.id, p])) };
    },
    staleTime: 5 * 60_000,
  });
  const buildingsOf = (contactId: string | null): ContactBuilding[] => {
    if (!contactId || !buildingsQ.data) return [];
    return buildingsQ.data.covers
      .filter((c) => c.contact_id === contactId)
      .map((c) => {
        const p = buildingsQ.data!.props.get(c.property_id);
        if (!p || !p.active) return null;
        return {
          id: p.id,
          name: p.name,
          address: p.address,
          role: c.position_key ? positions.label(c.position_key) : null,
        };
      })
      .filter((b): b is ContactBuilding => b != null);
  };

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["job-contacts", jobId] });
    qc.invalidateQueries({ queryKey: ["job-contacts-origin", jobId] });
    qc.invalidateQueries({ queryKey: ["job-comms", jobId] });
  };

  const resetEntry = () => {
    setName("");
    setCompany("");
    setEmail("");
    setPhone("");
    setMakeDefault(false);
    setPicked(null);
    setPositionKey("");
    setDupe(null);
  };

  const insertRow = async (values: {
    contactId: string | null;
    accountId: string | null;
    fullName: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    positionKey: string | null;
    role?: string;
  }) => {
    if (makeDefault) {
      await supabase
        .from("job_contacts")
        .update({ is_default_contact: false })
        .eq("job_id", jobId)
        .eq("is_default_contact", true);
    }
    const row = {
      job_id: jobId,
      role: values.role ?? role,
      contact_id: values.contactId,
      account_id: values.accountId,
      full_name: values.fullName,
      email: values.email?.trim() || null,
      phone: values.phone?.trim() || null,
      notes: values.company?.trim() || null,
      is_default_contact: makeDefault,
      sort_order: rows.length * 10,
      created_by: app.userId,
    };
    let { error } = await supabase
      .from("job_contacts")
      .insert({ ...row, position_key: values.positionKey || null } as typeof row);
    // Before 20261105120000 the row has no position to keep; the person still lands.
    if (error && isMissingSchema(error))
      ({ error } = await supabase.from("job_contacts").insert(row));
    return error;
  };

  /*
   * 4 Nov: a person picked from the company's records goes straight onto the
   * list — the pick is the decision, there is nothing left to type. Their
   * firm's usual role (the carrier's adjuster) when it has one, else the
   * relationship chosen in the entry row. Somebody already on the job is not
   * added twice.
   */
  const [addingPerson, setAddingPerson] = useState<string | null>(null);
  const addPerson = async (p: CompanyPerson, from: PickSource | null = source) => {
    if (rows.some((r) => r.contact_id === p.id)) {
      toast.info(`${p.full_name} is already on this job`);
      return;
    }
    const e = entryFromPerson(p, from?.name ?? accountName);
    const pickedRole = from?.role && roles.some((r) => r.key === from.role) ? from.role : role;
    setAddingPerson(p.id);
    const error = await insertRow({
      contactId: e.contactId,
      accountId: e.accountId,
      fullName: e.name,
      email: e.email || null,
      phone: e.phone || null,
      company: e.company || null,
      positionKey: e.positionKey,
      role: pickedRole,
    });
    setAddingPerson(null);
    if (error) return void toastDbError(error, { action: "Adding related contact" });
    toast.success(`${p.full_name} added to this job`);
    invalidate();
  };

  /* Everyone at the chosen company, listed under the search so they can be
     added with one click. The picker reads the same cache. */
  const sourcePeopleQ = useQuery({
    queryKey: companyPeopleKey(source?.id ?? null),
    enabled: !!source,
    queryFn: () => fetchPickablePeople(source!.id, source!.name),
    staleTime: 60_000,
  });
  const onJob = new Set(rows.map((r) => r.contact_id).filter(Boolean));
  const sourcePeople = (sourcePeopleQ.data ?? []).filter((p) => !onJob.has(p.id));

  /**
   * Promote a derived entry to a real row. This is the ONLY write a derived
   * entry offers, and it is the one that makes every other write possible:
   * once the row exists the rename, the role select, the star and the bin all
   * work exactly as they do for any other contact, and the derivation drops
   * the entry because `job_contacts` now accounts for that person.
   */
  const [adding, setAdding] = useState<string | null>(null);
  const addDerived = async (d: DerivedJobContact, opts: { quiet?: boolean } = {}) => {
    setAdding(d.key);
    const { error } = await supabase.from("job_contacts").insert({
      job_id: jobId,
      role: d.role,
      contact_id: d.contact_id,
      account_id: d.account_id,
      full_name: d.full_name,
      email: d.email,
      phone: d.phone,
      notes: d.notes,
      sort_order: rows.length * 10,
      created_by: app.userId,
    });
    setAdding(null);
    if (error) {
      // Quietly: the entry shows, with its Add to list button, for a person to try.
      if (opts.quiet) return void setAutoFailed((prev) => new Set(prev).add(d.key));
      return toastDbError(error, { action: "Adding the job's contact to the list" });
    }
    if (!opts.quiet) toast.success(`${d.full_name} added to this job's contacts`);
    invalidate();
  };

  /*
   * 4 Nov: "after adding from general tab why they still ask to add in the
   * list — this should be added automatically." Somebody named on the job
   * record (the customer, the caller) joins the list as an ordinary row as
   * soon as both lists have loaded. Each entry is tried once per visit; if
   * the write is refused (a read-only viewer) it stays an entry with its
   * Add to list button, as before.
   */
  const autoTried = useRef(new Set<string>());
  const [autoFailed, setAutoFailed] = useState<Set<string>>(new Set());
  /* While the add runs there is nothing to click — the person appears as a
     row directly. The entry is only drawn when it could not be added. */
  const shownDerived = app.writesDisabled ? derived : derived.filter((d) => autoFailed.has(d.key));
  const derivedKeys = derived.map((d) => d.key).join("|");
  useEffect(() => {
    if (app.writesDisabled || !rowsQ.isSuccess || !originQ.isSuccess) return;
    for (const d of derived) {
      if (autoTried.current.has(d.key)) continue;
      autoTried.current.add(d.key);
      void addDerived(d, { quiet: true });
    }
    // `derived` is rebuilt every render; its keys are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedKeys, rowsQ.isSuccess, originQ.isSuccess, app.writesDisabled]);

  const setDefault = async (id: string) => {
    await supabase
      .from("job_contacts")
      .update({ is_default_contact: false })
      .eq("job_id", jobId)
      .eq("is_default_contact", true);
    const { error } = await supabase
      .from("job_contacts")
      .update({ is_default_contact: true })
      .eq("id", id);
    if (error) return toastDbError(error, { action: "Setting default contact" });
    toast.success("Default contact method set");
    invalidate();
  };

  const changeRole = async (id: string, next: string) => {
    const { error } = await supabase.from("job_contacts").update({ role: next }).eq("id", id);
    if (error) return toastDbError(error, { action: "Changing relationship" });
    invalidate();
  };

  /*
   * The name, email and phone here are the job's own copy — correcting them is
   * not meant to reach back into the CRM contact record, which may legitimately
   * hold a different number for the same person.
   */
  const patch = async (id: string, values: Partial<Omit<JobContactRow, "position_key">>) => {
    const { error } = await supabase.from("job_contacts").update(values).eq("id", id);
    if (error) return toastDbError(error, { action: "Updating related contact" });
    invalidate();
  };

  /*
   * Editing a person who came from the company's records asks whether the
   * change is to the person or to this job. Either way the job's copy is what
   * gets written; "update the company record" writes the contact as well.
   * A hand-typed row has no record behind it and saves straight away.
   */
  const [pendingEdit, setPendingEdit] = useState<{
    row: JobContactRow;
    field: SharedPersonField;
    value: string | null;
    canRecord: boolean;
  } | null>(null);
  const editShared = async (row: JobContactRow, field: SharedPersonField, value: string | null) => {
    if ((row[field] ?? null) === value) return;
    if (!row.contact_id) return void patch(row.id, { [field]: value });
    const owner = row.account_id ?? accountId;
    const canRecord = owner ? await canAddPeopleTo(owner, app.userId) : false;
    setPendingEdit({ row, field, value, canRecord });
  };
  const applyEdit = async (scope: LinkedEditScope) => {
    if (!pendingEdit) return;
    const { row, field, value } = pendingEdit;
    if (scope === "record" && row.contact_id) {
      try {
        await updateCompanyPerson(row.contact_id, { [field]: value });
        void qc.invalidateQueries({ queryKey: companyPeopleKey(row.account_id ?? accountId) });
        void qc.invalidateQueries({ queryKey: ["job-contacts-crm", jobId] });
      } catch (e) {
        // The record refused; the job's copy is not written either, so the
        // person can choose again rather than end up half-changed.
        toastDbError(e, { action: "Updating the company record" });
        return;
      }
    }
    await patch(row.id, { [field]: value });
    toast.success(
      scope === "record" ? "Job and company record updated" : "Changed on this job only",
    );
    setPendingEdit(null);
  };

  /**
   * Take the CRM's version, on request. Never automatic: the snapshot is
   * deliberate, so the only thing that moves a job contact is somebody
   * pressing this.
   */
  const refreshFromCrm = async (row: JobContactRow) => {
    const crm = row.contact_id ? crmById.get(row.contact_id) : null;
    if (!crm) return;
    const { error } = await supabase
      .from("job_contacts")
      .update(crmRefreshPatch(crm))
      .eq("id", row.id);
    if (error) return toastDbError(error, { action: "Refreshing from the CRM" });
    toast.success(`Copied ${crm.full_name} from the CRM`);
    invalidate();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("job_contacts").delete().eq("id", id);
    if (error) return toastDbError(error, { action: "Removing related contact" });
    invalidate();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Relationship decides who gets emailed and who a document is addressed to. The person who
          rang is often not the insured, and the owner is often not the occupant.
        </p>
      </div>

      {/*
       * Above the per-job list on purpose. The people below were typed onto
       * this job; these are the ones the customer's own hierarchy says are
       * responsible for this building, and at 2am that is the first thing
       * wanted.
       */}
      <SiteEscalationCard jobId={jobId} />

      {/*
       * 4 Nov: the search sits above the list, so finding somebody on file is
       * the first thing on the tab, and picking adds them at once. Below it,
       * everyone at the chosen company who is not on the job yet.
       */}
      <div className="space-y-2" data-job-contact-search>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {source ? (
            <>
              {pickSources.length > 1 && (
                <Select value={source.id} onValueChange={setSourceId}>
                  <SelectTrigger
                    className="h-11 sm:h-9 sm:w-56"
                    aria-label="Pick people from"
                    data-job-contact-source
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pickSources.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                        {p.name ? ` · ${p.name}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <CompanyPersonPicker
                key={source.id}
                accountId={source.id}
                accountName={source.name}
                companyNoun={source.noun}
                askPosition
                disabled={app.writesDisabled}
                triggerLabel={`Pick contact from ${source.name ?? `the ${source.noun}`}…`}
                onPick={(p) => addPerson(p, source)}
                excludeIds={[...onJob].filter((v): v is string => !!v)}
                className="sm:max-w-sm"
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              This job has no company or insurance firms yet, so there is nobody on file to pick
              from. Use Add contact for someone new.
            </p>
          )}
          {/* 4 Nov: the one way to add somebody new — the full form; the
              inline "Add a person" row is gone. */}
          <Button
            variant="outline"
            className="sm:ml-auto"
            disabled={app.writesDisabled}
            onClick={() => setCreateOpen(true)}
            data-job-contact-add
          >
            <Plus className="size-4" />
            Add contact
          </Button>
        </div>
        {source && sourcePeople.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-job-contact-company-people>
            <span className="text-xs text-muted-foreground">
              At {source.name ?? "this company"}:
            </span>
            {sourcePeople.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant="outline"
                className="h-8 rounded-full"
                disabled={app.writesDisabled || addingPerson === p.id}
                onClick={() => void addPerson(p, source)}
                title={[p.title, p.email, p.phone].filter(Boolean).join(" · ") || undefined}
              >
                <Plus className="size-3.5" />
                {p.full_name}
                {p.title ? (
                  <span className="font-normal text-muted-foreground">· {p.title}</span>
                ) : null}
              </Button>
            ))}
          </div>
        )}
      </div>

      {companyCustomer && (
        <div
          className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2"
          data-job-contact-company-customer
        >
          <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-medium">{companyCustomer}</span>
              <Badge variant="outline">Customer · company</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              The company this job is for. Its people are listed below.
            </p>
          </div>
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
            title="Set on the General tab — change the Company there."
          >
            <Lock className="size-3" aria-hidden />
            Set on General
          </span>
        </div>
      )}

      <>
        <div className="rounded-md border">
          {rowsQ.isError ? (
            <div className="p-3 text-sm text-destructive">
              Related contacts could not be loaded — this is not an empty list.
            </div>
          ) : rowsQ.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : (
            listRows.length === 0 &&
            shownDerived.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <User className="size-4 shrink-0" aria-hidden />
                No people on this job yet — pick someone above, or use Add contact.
              </div>
            )
          )}
          {/*
           * Above the real rows, and visibly not one of them. These two come
           * off the `jobs` row — the muted background and the field name in
           * place of a relationship select say so, and there is no bin, no
           * star and no editable field, because there is no row behind them
           * to write to. "Add to list" is the one thing that can be done, and
           * it turns the entry into an ordinary row.
           */}
          {shownDerived.map((d) => (
            <div
              key={d.key}
              data-testid="job-contact-derived"
              className="flex flex-col gap-2 border-b bg-muted/40 px-3 py-2 last:border-b-0 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium">{d.full_name}</span>
                    <Badge variant="outline">{d.label}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {d.email && <span>{d.email}</span>}
                    {d.phone && <span>{d.phone}</span>}
                    {d.notes && <span>{d.notes}</span>}
                    <span>From the job record — not yet on this list.</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={app.writesDisabled || adding === d.key}
                  onClick={() => void addDerived(d)}
                >
                  <Plus className="size-3.5" /> Add to list
                </Button>
              </div>
            </div>
          ))}
          {/*
           * One row on a desktop, two stacked blocks on a phone. Squeezed onto a
           * 360px screen the relationship select, the star and the bin left the
           * name about forty pixels, so the one thing the row is for — who this
           * person is — was the first thing to disappear.
           */}
          {orderedRows.map(({ r }) => (
            <SectionEdit key={r.id} editing={editingRow === r.id}>
              <div
                className={cn(
                  "flex flex-col gap-2 border-b px-3 py-2 last:border-b-0 sm:flex-row sm:items-center",
                  editingRow === r.id && "bg-muted/40",
                )}
                data-org-depth={jobDepth.get(r.id) ?? undefined}
              >
                <div
                  className="flex min-w-0 flex-1 items-start gap-2"
                  style={
                    jobDepth.get(r.id)
                      ? { paddingLeft: `${(jobDepth.get(r.id) ?? 0) * 1.25}rem` }
                      : undefined
                  }
                >
                  {jobDepth.get(r.id) ? (
                    <CornerDownRight
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-label="Reports to the person above"
                    />
                  ) : (
                    <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <RowField
                        value={r.full_name}
                        readOnly={app.writesDisabled}
                        className="text-[13px] font-medium"
                        empty="Unnamed"
                        onSave={(v) => {
                          if (v == null) return void toast.error("A related contact needs a name");
                          void editShared(r, "full_name", String(v));
                        }}
                      />
                      {r.is_default_contact && (
                        <Badge variant="outline" className="gap-1">
                          <Star className="size-3" /> Default
                        </Badge>
                      )}
                      {/* 5 Nov (T3): the title the CRM shows ("Building
                          super / manager"), the job's own position first,
                          then the CRM's, and its free-text title — once each. */}
                      {(() => {
                        const crm = crmById.get(r.contact_id ?? "");
                        const posKey = r.position_key ?? crm?.position_key ?? null;
                        const pos = posKey ? positions.label(posKey) : null;
                        const title = crm?.title?.trim() || null;
                        const showTitle =
                          title && title.toLowerCase() !== (pos ?? "").toLowerCase();
                        return pos || showTitle ? (
                          <span
                            className="flex min-w-0 items-center gap-1.5"
                            data-testid="job-contact-title"
                          >
                            {pos && (
                              /* 6 Nov (David): the pill takes the colour its
                                 level has on the company hierarchy. */
                              <span
                                className={cn(
                                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                  ORG_TONE_TAG[orgTone(posKey)],
                                )}
                              >
                                {pos}
                              </span>
                            )}
                            {showTitle && (
                              <span
                                className="min-w-0 truncate text-[11px] text-muted-foreground"
                                title={title}
                              >
                                {title}
                              </span>
                            )}
                          </span>
                        ) : null;
                      })()}
                      <ContactBuildingsChip
                        name={r.full_name ?? "They"}
                        buildings={buildingsOf(r.contact_id)}
                      />
                      {/* Quiet on purpose. Differing from the CRM is normal —
                        the 2am number is often not the one on file — so this
                        states the fact and offers the action, and never
                        implies the job's copy is wrong. */}
                      {crmDrift(r, crmById.get(r.contact_id ?? "")).length > 0 && (
                        <span
                          className="text-[11px] text-muted-foreground"
                          title="This job keeps its own copy. Refresh from CRM to take the CRM's version."
                          data-testid="job-contact-crm-drift"
                        >
                          differs from CRM
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <RowField
                        kind="email"
                        value={r.email}
                        placeholder="Email"
                        empty="+ email"
                        readOnly={app.writesDisabled}
                        onSave={(v) => editShared(r, "email", v == null ? null : String(v))}
                      />
                      <RowField
                        kind="phone"
                        value={r.phone}
                        placeholder="Phone"
                        empty="+ phone"
                        readOnly={app.writesDisabled}
                        onSave={(v) => editShared(r, "phone", v == null ? null : String(v))}
                      />
                      {/* `notes` is where the add form puts the company. */}
                      <RowField
                        value={r.notes}
                        placeholder="Company"
                        empty="+ company"
                        readOnly={app.writesDisabled}
                        onSave={(v) => patch(r.id, { notes: v == null ? null : String(v) })}
                      />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:shrink-0">
                  {app.writesDisabled ? (
                    <span className="flex-1 text-xs text-muted-foreground sm:w-[180px] sm:flex-none">
                      {optionLabel(roles, r.role)}
                    </span>
                  ) : (
                    <Select
                      value={r.role}
                      onValueChange={(v) => {
                        if (v === "__edit") return;
                        void changeRole(r.id, v);
                      }}
                    >
                      <SelectTrigger className="h-8 w-full sm:w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((o) => (
                          <SelectItem key={o.key} value={o.key}>
                            {o.label}
                          </SelectItem>
                        ))}
                        {canEditList && (
                          <>
                            <SelectSeparator />
                            <div className="px-2 py-1.5">
                              <Link
                                to="/admin/option-lists"
                                search={{ list: "job_contact_role" } as never}
                                className="flex items-center gap-1.5 text-xs text-primary underline"
                              >
                                <Settings2 className="size-3.5" /> Edit…
                              </Link>
                            </div>
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  )}
                  {!r.is_default_contact && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Set as default contact method"
                      aria-label={`Make ${r.full_name || "this contact"} the default contact`}
                      disabled={app.writesDisabled}
                      onClick={() => void setDefault(r.id)}
                    >
                      <Star className="size-3.5" />
                    </Button>
                  )}
                  {/* Only on a row that is actually linked to a CRM record. A
                    hand-typed snapshot has nothing to refresh FROM, and a
                    button that did nothing would read as a broken one. */}
                  {r.contact_id && crmById.get(r.contact_id) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Refresh name, email and phone from the CRM record"
                      aria-label="Refresh from CRM"
                      data-testid="job-contact-refresh-crm"
                      disabled={app.writesDisabled}
                      onClick={() => void refreshFromCrm(r)}
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant={editingRow === r.id ? "secondary" : "ghost"}
                    className="size-7"
                    title={editingRow === r.id ? "Done" : "Edit this contact"}
                    aria-label={
                      editingRow === r.id
                        ? `Done editing ${r.full_name || "this contact"}`
                        : `Edit ${r.full_name || "this contact"}`
                    }
                    aria-pressed={editingRow === r.id}
                    disabled={app.writesDisabled}
                    onClick={() => setEditingRow((cur) => (cur === r.id ? null : r.id))}
                  >
                    {editingRow === r.id ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Pencil className="size-3.5" />
                    )}
                  </Button>
                  {fromGeneral(r) ? (
                    <span
                      className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground"
                      title="This is the job's customer, set on the General tab — change the Company there."
                      data-job-contact-from-general
                    >
                      <Lock className="size-3" aria-hidden />
                      Set on General
                    </span>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Remove from this job"
                      aria-label={`Remove ${r.full_name || "this contact"} from this job`}
                      disabled={app.writesDisabled}
                      onClick={() => void remove(r.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </SectionEdit>
          ))}
        </div>
      </>

      <CreateCustomerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        kind="person"
        initialName={name}
        /* 4 Nov: a new Customer-role person belongs to the job's Company —
           picked for them and locked. An adjuster, a PA or a tenant is from
           somewhere else, so their company stays open; and with no Company
           on the job the customer is an individual, so there is none. */
        defaultAccount={role === "customer" ? (jobCompanyQ.data ?? null) : null}
        lockAccount={role === "customer" && !!jobCompanyQ.data}
        onCreated={(created) => {
          setCreateOpen(false);
          void insertRow({
            contactId: created.contactId,
            accountId: created.accountId,
            fullName: created.name,
            email: created.email,
            phone: created.phone,
            company: company || null,
            positionKey: positionKey || null,
          }).then((error) => {
            if (error) return void toastDbError(error, { action: "Adding related contact" });
            toast.success("Contact added to job");
            resetEntry();
            invalidate();
          });
        }}
      />

      <LinkedEditChoice
        open={!!pendingEdit}
        personName={pendingEdit?.row.full_name || "this contact"}
        companyName={pendingEdit?.row.notes ?? accountName}
        fieldLabel={pendingEdit?.field === "full_name" ? "name" : (pendingEdit?.field ?? "details")}
        canUpdateRecord={pendingEdit?.canRecord ?? false}
        onChoose={applyEdit}
        onCancel={() => setPendingEdit(null)}
      />
    </div>
  );
}
