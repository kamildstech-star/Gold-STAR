import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Building2, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";

import { OtherOfficeNotice, otherOfficeNames } from "@/components/other-office-notice";
import { supabase } from "@/integrations/supabase/client";
import { setGiftPolicyTag } from "@/lib/gift-policy";
import { useAppContext } from "@/components/app-context";
import { isSeller } from "@/lib/roles";
import { toastDbError } from "@/lib/db-errors";
import { loadContactMethods, resolveContactLocationId } from "@/lib/contacts";
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABEL,
  CONTACT_DECISION_ROLES,
  CONTACT_ROLE_LABEL,
  GIFT_POLICIES,
  GIFT_POLICY_LABEL,
  type AccountStatus,
  type ContactDecisionRole,
  type GiftPolicy,
} from "@/lib/accounts";
import { isReferenceTypeKey, useAccountTypes } from "@/lib/account-types";
import { fetchLabels, setLabelsFor, type Label as CrmLabel } from "@/lib/labels";
import { LabelPill } from "@/components/label-pill";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { LocationPicker, useDefaultLocationId } from "@/components/location-picker";
import { ContactMethodEditor, type DraftMethod } from "@/components/job-contact-methods";
import { contactMethodsError } from "@/lib/job-contact-methods";
import type { CustomerKind, PickedCustomer } from "@/components/customer-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DetailSelect } from "@/components/detail-select";
import { LeadSourcePicker } from "@/components/lead-source-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useManagedOptions, optionsFrom } from "@/lib/managed-options";
import { CONTACT_POSITION_OPTIONS, positionFromTitle } from "@/lib/company-hierarchy";
import { composeFullName, personNameWrite, splitFullName } from "@/lib/person-name";
import { isMissingSchema } from "@/lib/schema-fallback";

const CONTACT_ROLE_OPTS = optionsFrom(CONTACT_DECISION_ROLES, CONTACT_ROLE_LABEL);

/**
 * The one place a customer gets created from anywhere in the app.
 *
 * Reached from the "+ Create new…" row at the bottom of a type-ahead, so the
 * rep never leaves the form they were filling in. Only the name is required —
 * a rep standing in a flooded basement saves a name and a number and fills the
 * rest later — but the relationship fields are all *offered* here, because
 * creation is the one moment anyone reliably fills them in, and they are what
 * lets an account survive a rep change.
 *
 * The duplicate check runs as the fields are filled, not on save: catching a
 * match here costs one click, catching it later costs a merge.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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

interface MinimalAccountRow {
  account_id: string;
  account_name: string;
  owning_location_code: string;
  owning_location_name: string;
  owning_location_id: string;
  status: string;
  primary_contact_name: string | null;
  viewer_has_full_access: boolean;
}

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function firstOf(methods: DraftMethod[], kind: "phone" | "email") {
  const preferred = methods.find((m) => m.kind === kind && m.is_preferred && m.value.trim());
  return (
    (preferred ?? methods.find((m) => m.kind === kind && m.value.trim()))?.value.trim() ?? null
  );
}

/** "State Farm Insurance", "State Farm", "StateFarm" all squash to "statefarm". */
function squashName(s: string) {
  return s
    .toLowerCase()
    .replace(
      /\b(insurance|insurers?|ins|assurance|company|co|corp|incorporated|inc|llc|lp|group|the|of|and|adjusters?|adjusting|public)\b/g,
      "",
    )
    .replace(/[^a-z0-9]/g, "");
}

function looksLikeSameName(a: string, b: string) {
  const x = squashName(a);
  const y = squashName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}

export interface CreateCustomerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: CustomerKind;
  /** Carried through from whatever the rep typed into the type-ahead. */
  initialName?: string;
  /** Prefilled when the form already knows the account. */
  defaultAccount?: PickedAccount | null;
  defaultLocationId?: string | null;
  /**
   * Preset account type when the dialog was opened from a type-scoped picker —
   * "+ Create 'dougs' as a public adjusting firm".
   */
  defaultAccountTypeKey?: string;
  /** Fired on create *and* on "link to the existing one instead". */
  onCreated: (customer: PickedCustomer) => void;
  /**
   * The company is settled by whoever opened this — a job's own Company
   * (4 Nov: "we are adding the customer for already selecting company").
   * Shown, not editable.
   */
  lockAccount?: boolean;
}

export function CreateCustomerDialog(props: CreateCustomerDialogProps) {
  // Remount on open so every launch starts from the typed text, not stale state.
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(46rem,calc(100vw-1.5rem))] overflow-y-auto">
        {props.open && <DialogBody key={`${props.kind}-${props.initialName ?? ""}`} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({
  kind,
  initialName = "",
  defaultAccount = null,
  defaultLocationId = null,
  defaultAccountTypeKey,
  onOpenChange,
  onCreated,
  lockAccount = false,
}: CreateCustomerDialogProps) {
  const app = useAppContext();
  const [saving, setSaving] = useState(false);

  /* ---------------- shared ---------------- */
  /*
   * `name` stays the single source of truth: the duplicate check, the company
   * branch and the created-record callback all read it. For a person it is now
   * COMPOSED from the two boxes below rather than typed directly, so nothing
   * downstream has to know the field was split.
   */
  const [name, setName] = useState(initialName);
  const initialSplit = useMemo(() => splitFullName(initialName), [initialName]);
  const [firstName, setFirstName] = useState(initialSplit.firstName);
  const [lastName, setLastName] = useState(initialSplit.lastName);

  /** Typing in either box recomposes the name every other rule reads. */
  const setNamePart = (part: "first" | "last", value: string) => {
    const first = part === "first" ? value : firstName;
    const last = part === "last" ? value : lastName;
    if (part === "first") setFirstName(value);
    else setLastName(value);
    setName(composeFullName(first, last));
  };
  const [locationId, setLocationId] = useState<string>(defaultLocationId ?? "");
  const [methods, setMethods] = useState<DraftMethod[]>([
    { kind: "phone", label: "Mobile", value: "", is_preferred: true },
  ]);

  /* ---------------- person ---------------- */
  const [account, setAccount] = useState<PickedAccount | null>(defaultAccount);
  const [title, setTitle] = useState("");
  /* Position in their own company. Suggested from the title until somebody
     picks one by hand, after which the suggestion stops interfering. */
  const [position, setPosition] = useState("none");
  const [positionTouched, setPositionTouched] = useState(false);
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const suggested = positionFromTitle(title);
  const positionValue = positionTouched ? position : (suggested ?? "none");
  const [decisionRole, setDecisionRole] = useState<ContactDecisionRole | "none">("none");
  const decisionRoles = useManagedOptions("contact_decision_role", CONTACT_ROLE_OPTS);
  const [decisionRoleDetail, setDecisionRoleDetail] = useState("");
  const [giftPolicy, setGiftPolicy] = useState<GiftPolicy>("unknown");
  const [birthdayMonth, setBirthdayMonth] = useState<string>("none");
  const [birthdayDay, setBirthdayDay] = useState("");
  const [spouse, setSpouse] = useState("");
  const [children, setChildren] = useState("");
  const [hobbies, setHobbies] = useState("");
  const [likes, setLikes] = useState("");
  const [dietary, setDietary] = useState("");
  const [bestTime, setBestTime] = useState("");
  const [relationshipNotes, setRelationshipNotes] = useState("");

  /* ---------------- company ---------------- */
  const accountTypes = useAccountTypes();
  const [accountTypeId, setAccountTypeId] = useState<string>("");
  useEffect(() => {
    if (accountTypeId || accountTypes.options.length === 0) return;
    const preset =
      (defaultAccountTypeKey ? accountTypes.byKey.get(defaultAccountTypeKey) : null) ??
      accountTypes.options.find((o) => o.is_default) ??
      accountTypes.options[0];
    if (preset) setAccountTypeId(preset.id);
  }, [accountTypeId, accountTypes, defaultAccountTypeKey]);
  const [status, setStatus] = useState<AccountStatus>("prospect");
  const [website, setWebsite] = useState("");
  const [address1, setAddress1] = useState("");
  const [city, setCity] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [postal, setPostal] = useState("");
  const [assignedRep, setAssignedRep] = useState<string>(app.userId ?? "none");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [leadSourceId, setLeadSourceId] = useState<string>("");
  const [leadSourceDetail, setLeadSourceDetail] = useState("");

  const phone = firstOf(methods, "phone");
  const email = firstOf(methods, "email");

  /* Read from allLocations, not the writable list: the picked account may well
     be owned by an office this user isn't a member of, and naming it is the
     whole point of showing it. */
  const accountOfficeLabel = useMemo(() => {
    if (!account) return null;
    const l = app.allLocations.find((x) => x.id === account.location_id);
    return l ? `${l.code} · ${l.name}` : "Another office";
  }, [account, app.allLocations]);

  /* ---------------- duplicate check, live ---------------- */
  const probe = useDebounced({
    name: name.trim(),
    phone: phone ?? "",
    email: email ?? "",
    accountId: account?.id ?? null,
  });

  const personDupeEnabled =
    kind === "person" &&
    (probe.phone.replace(/\D/g, "").length >= 7 ||
      probe.email.includes("@") ||
      (!!probe.accountId && probe.name.length >= 3));

  const personDupeQ = useQuery({
    queryKey: ["create-customer-dupes", probe],
    enabled: personDupeEnabled,
    queryFn: async (): Promise<DupeRow[]> => {
      const { data, error } = await supabase.rpc("find_customer_duplicates", {
        _name: probe.name || undefined,
        _phone: probe.phone || undefined,
        _email: probe.email || undefined,
        _account_id: probe.accountId ?? undefined,
      });
      if (error) throw error;
      return (data ?? []) as unknown as DupeRow[];
    },
  });

  const companyDupeQ = useQuery({
    queryKey: ["create-customer-account-dupes", probe.name],
    enabled: kind === "company" && probe.name.length >= 3,
    queryFn: async (): Promise<MinimalAccountRow[]> => {
      const { data, error } = await supabase.rpc("search_accounts_minimal", { _query: probe.name });
      if (error) throw error;
      return (data ?? []) as unknown as MinimalAccountRow[];
    },
  });

  /* Reference records (carriers, PA firms) are shared across all eleven
     offices, so "State Farm" / "State Farm Insurance" / "StateFarm" would
     multiply fast. Match on the squashed name, not the typed one. */
  const referenceDupeQ = useQuery({
    queryKey: ["create-customer-reference-dupes", probe.name],
    enabled: kind === "company" && probe.name.length >= 3,
    queryFn: async (): Promise<Array<{ id: string; name: string; location_id: string }>> => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id, name, location_id")
        .eq("is_reference", true)
        .order("name")
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; name: string; location_id: string }>;
    },
  });

  const labelsQ = useQuery({
    queryKey: ["labels", "account"],
    enabled: kind === "company",
    queryFn: () => fetchLabels("account"),
  });

  const peopleQ = useQuery({
    queryKey: ["create-customer-reps"],
    enabled: kind === "company",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name")
        .limit(300);
      if (error) throw error;
      return (data ?? []) as Array<{ user_id: string; full_name: string | null }>;
    },
  });

  /* Duplicates are offered only where this person may link to them: a record
     another office owns is not mentioned (no "X owns it" row). */
  const personDupes = useMemo(
    () => (personDupeQ.data ?? []).filter((d) => d.viewer_has_full_access),
    [personDupeQ.data],
  );
  const selectedTypeKey = accountTypes.byId.get(accountTypeId)?.key;
  /**
   * Reference mode: a carrier or a PA firm is reference data, not a
   * relationship anyone farms. Name, claims phone/email, website, notes —
   * a rep mid-intake adds "Doug's Mutual" in five seconds and carries on.
   */
  const referenceMode = kind === "company" && isReferenceTypeKey(selectedTypeKey);
  const fallbackLocationId = useDefaultLocationId();
  const companyDupes = useMemo(
    () =>
      referenceMode
        ? []
        : (companyDupeQ.data ?? []).filter((m) => m.viewer_has_full_access).slice(0, 4),
    [companyDupeQ.data, referenceMode],
  );
  /* 13 Nov (owner): a match another office holds is said in one line — which
     office, nothing of the record — so no second customer is made. */
  const personElsewhere = useMemo(() => {
    const rows = (personDupeQ.data ?? []).filter((d) => !d.viewer_has_full_access);
    return rows.length ? otherOfficeNames(rows.map((d) => d.owning_location_name)) : null;
  }, [personDupeQ.data]);
  const companyElsewhere = useMemo(() => {
    if (referenceMode) return null;
    const rows = (companyDupeQ.data ?? []).filter((m) => !m.viewer_has_full_access);
    return rows.length ? otherOfficeNames(rows.map((m) => m.owning_location_name)) : null;
  }, [companyDupeQ.data, referenceMode]);
  const referenceDupes = useMemo(() => {
    if (!referenceMode || probe.name.trim().length < 3) return [];
    return (referenceDupeQ.data ?? [])
      .filter((a) => looksLikeSameName(a.name, probe.name))
      .slice(0, 4);
  }, [referenceDupeQ.data, referenceMode, probe.name]);

  /* ---------------- link instead ---------------- */
  const linkPerson = async (d: DupeRow) => {
    const existing = await loadContactMethods(d.contact_id);
    onCreated({
      kind: "person",
      contactId: d.contact_id,
      name: d.full_name,
      title: d.title,
      accountId: d.account_id,
      accountName: d.account_name,
      accountLocationId: null,
      phone: d.phone,
      email: d.email,
      methods: existing,
    });
    toast.success(`Linked to ${d.full_name} — nothing new was created.`);
    onOpenChange(false);
  };

  const linkCompany = (m: MinimalAccountRow) => {
    onCreated({
      kind: "company",
      contactId: null,
      name: m.account_name,
      title: null,
      accountId: m.account_id,
      accountName: m.account_name,
      accountLocationId: m.owning_location_id,
      phone: null,
      email: null,
      methods: [],
    });
    toast.success(`Linked to ${m.account_name} — nothing new was created.`);
    onOpenChange(false);
  };

  /* ---------------- save ---------------- */
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("A name is all this needs — add one to save.");
      return;
    }
    const badMethod = contactMethodsError(methods);
    if (badMethod) {
      toast.error(badMethod);
      return;
    }
    setSaving(true);
    try {
      if (kind === "person") {
        const loc = await resolveContactLocationId(account?.id ?? null, locationId);
        const day = Number(birthdayDay);
        const nameFields = personNameWrite(firstName, lastName, trimmed);
        const contactRow = {
          account_id: account?.id ?? null,
          location_id: loc,
          title: title.trim() || null,
          decision_role: decisionRole === "none" ? null : decisionRole,
          decision_role_detail: decisionRoleDetail.trim() || null,
          position_key: positionValue === "none" ? null : positionValue,
          phone,
          email,
          birthday_month: birthdayMonth === "none" ? null : Number(birthdayMonth),
          birthday_day: Number.isFinite(day) && day >= 1 && day <= 31 ? day : null,
          spouse_name: spouse.trim() || null,
          children: children.trim() || null,
          hobbies: hobbies.trim() || null,
          likes: likes.trim() || null,
          dietary_notes: dietary.trim() || null,
          best_time_to_reach: bestTime.trim() || null,
          relationship_notes: relationshipNotes.trim() || null,
          created_by: app.userId,
        };

        /*
         * The pair first, the composed name alone as the fallback.
         * `first_name` arrives with 20260913120000; until it is applied
         * PostgREST rejects the whole insert for naming a column it does not
         * know, so this retries without the pair and creates exactly the row
         * it would have created before. The name is identical either way —
         * `personNameWrite` composes `full_name` from the same two boxes.
         */
        const insert = (row: Record<string, unknown>) =>
          supabase
            .from("contacts")
            .insert(row as never)
            .select("id, full_name, title, phone, email")
            .single();

        let { data, error } = await insert({ ...contactRow, ...nameFields });
        if (error && isMissingSchema(error)) {
          ({ data, error } = await insert({ ...contactRow, full_name: nameFields.full_name }));
        }
        if (error || !data) throw error ?? new Error("No contact row returned");
        await setGiftPolicyTag(data.id, giftPolicy);

        const rows = methods
          .filter((m) => m.value.trim())
          .map((m) => ({
            contact_id: data.id,
            kind: m.kind,
            label: m.label || (m.kind === "phone" ? "Main" : "Work"),
            value: m.value.trim(),
            extension: m.extension?.trim() || null,
            is_preferred: m.is_preferred,
            created_by: app.userId,
          }));
        if (rows.length) {
          const { error: mErr } = await supabase.from("contact_methods").insert(rows);
          if (mErr) toastDbError(mErr, { action: "Saving phones and emails" });
        }

        toast.success(`${data.full_name} added to the CRM`);
        onCreated({
          kind: "person",
          contactId: data.id,
          name: data.full_name,
          title: data.title,
          accountId: account?.id ?? null,
          accountName: account?.name ?? null,
          accountLocationId: account?.location_id ?? null,
          phone: data.phone,
          email: data.email,
          methods: methods.filter((m) => m.value.trim()),
        });
      } else {
        const ownerLocationId = referenceMode
          ? locationId || defaultLocationId || fallbackLocationId || ""
          : locationId;
        if (!ownerLocationId) {
          toast.error("Pick the office that will own this account.");
          setSaving(false);
          return;
        }
        const { data, error } = await supabase
          .from("accounts")
          .insert({
            name: trimmed,
            account_type_id: accountTypeId || null,
            is_reference: referenceMode,
            // Reference data a real person added during testing — never demo.
            is_demo: false,
            status: referenceMode ? "active" : status,
            location_id: ownerLocationId,
            assigned_rep: referenceMode ? null : assignedRep === "none" ? null : assignedRep,
            phone,
            email,
            website: website.trim() || null,
            address_line1: referenceMode ? null : address1.trim() || null,
            city: referenceMode ? null : city.trim() || null,
            state: referenceMode ? null : stateCode.trim() || null,
            postal_code: referenceMode ? null : postal.trim() || null,
            notes: relationshipNotes.trim() || null,
            lead_source_id: referenceMode ? null : leadSourceId || null,
            lead_source_detail: referenceMode ? null : leadSourceDetail.trim() || null,
            created_by: app.userId,
          })
          .select("id, name, location_id")
          .single();
        if (error || !data) throw error ?? new Error("No account row returned");

        if (!referenceMode && labelIds.length) {
          try {
            await setLabelsFor("account", data.id, labelIds, []);
          } catch (e) {
            toastDbError(e, { action: "Saving labels" });
          }
        }

        toast.success(`${data.name} added to the CRM`);

        onCreated({
          kind: "company",
          contactId: null,
          name: data.name,
          title: null,
          accountId: data.id,
          accountName: data.name,
          accountLocationId: data.location_id,
          phone,
          email,
          methods: methods.filter((m) => m.value.trim()),
        });
      }
      onOpenChange(false);
    } catch (e) {
      toastDbError(e, { action: kind === "person" ? "Creating contact" : "Creating account" });
    } finally {
      setSaving(false);
    }
  };

  const referenceNoun = selectedTypeKey
    ? accountTypes.label(selectedTypeKey).toLowerCase()
    : "reference record";

  const linkReference = (a: { id: string; name: string; location_id: string }) => {
    onCreated({
      kind: "company",
      contactId: null,
      name: a.name,
      title: null,
      accountId: a.id,
      accountName: a.name,
      accountLocationId: a.location_id,
      phone: null,
      email: null,
      methods: [],
    });
    onOpenChange(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {kind === "person"
            ? lockAccount && account
              ? `New contact at ${account.name}`
              : "New customer"
            : referenceMode
              ? `New ${referenceNoun}`
              : "New company"}
        </DialogTitle>
        <DialogDescription>
          {referenceMode
            ? "Reference data shared by every office. Name is all you need — the rest helps the next rep reach them."
            : "Only the name is required. Everything else can wait until you are off site — but the relationship details are what keep this account when the rep changes."}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-1">
        {kind === "person" ? (
          /* Two boxes, composed into the one `full_name` the rest of the app
             reads. Both are optional individually — a mononym is a real name
             and so is a record filed under a surname — but the pair cannot be
             empty, which is what the * and the save guard enforce. */
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ccd-first-name">First name *</Label>
              <Input
                id="ccd-first-name"
                autoFocus
                value={firstName}
                onChange={(e) => setNamePart("first", e.target.value)}
                placeholder="David"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ccd-last-name">Last name</Label>
              <Input
                id="ccd-last-name"
                value={lastName}
                onChange={(e) => setNamePart("last", e.target.value)}
                placeholder="Stern"
              />
            </div>
          </div>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="ccd-name">Company name *</Label>
            <Input
              id="ccd-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kestrel Property Group"
            />
          </div>
        )}

        {/* Live duplicate check — inline, one click to abandon the create. */}
        {kind === "person" && <OtherOfficeNotice offices={personElsewhere} what="customer" />}
        {kind === "company" && <OtherOfficeNotice offices={companyElsewhere} what="company" />}
        {kind === "person" && personDupes.length > 0 && (
          <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5" /> Already on file
            </div>
            <ul className="mt-1 space-y-1">
              {personDupes.map((d) => (
                <li key={d.contact_id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{d.full_name}</span>
                    {d.account_name ? ` at ${d.account_name}` : ""} already has this{" "}
                    {d.match_reason === "phone"
                      ? "phone"
                      : d.match_reason === "email"
                        ? "email"
                        : "name"}
                    .
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => void linkPerson(d)}
                  >
                    Link to them instead
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {kind === "company" && companyDupes.length > 0 && (
          <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5" /> Similar accounts already exist
            </div>
            <ul className="mt-1 space-y-1">
              {companyDupes.map((m) => (
                <li key={m.account_id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{m.account_name}</span> · {m.owning_location_name}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => linkCompany(m)}
                  >
                    Use this one
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {referenceMode && referenceDupes.length > 0 && (
          <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5" /> This may already be on file
            </div>
            <ul className="mt-1 space-y-1">
              {referenceDupes.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{a.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => linkReference(a)}
                  >
                    Use this one
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ContactMethodEditor value={methods} onChange={setMethods} />

        {referenceMode ? (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="ccd-web">Website</Label>
              <Input
                id="ccd-web"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="statefarm.com"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ccd-refnotes">Notes</Label>
              <Textarea
                id="ccd-refnotes"
                rows={2}
                value={relationshipNotes}
                onChange={(e) => setRelationshipNotes(e.target.value)}
                placeholder="Claims portal, submission quirks, anything the next rep needs."
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Shared record — every office will see and use this one.
            </p>
          </>
        ) : kind === "person" ? (
          <>
            {/*
             * Three fields used to sit in one row — Title, Position and
             * Decision role — and nobody could say which was which. They are
             * three different questions:
             *
             *   Position      where they sit in THEIR company. A fixed list,
             *                 so the org chart can be drawn from it.
             *   Title         what is printed on their card. Free text, and
             *                 only worth typing when it differs.
             *   Decision role what they are to US in a sale. A sales concept,
             *                 so it moved into the relationship section that
             *                 already collapses for non-sellers.
             *
             * Position leads because it is the one the app can act on.
             */}
            <div className="grid gap-1.5">
              <Label htmlFor="ccd-position">Position</Label>
              <Select
                value={positionValue}
                onValueChange={(v) => {
                  setPositionTouched(true);
                  setPosition(v);
                }}
              >
                <SelectTrigger id="ccd-position">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No position</SelectItem>
                  {positions.options.map((o) => (
                    <SelectItem key={o.key} value={o.key}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Where they sit in their company — this is what draws the org chart.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ccd-title">Custom title (optional)</Label>
              <Input
                id="ccd-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Facilities director"
              />
              <p className="text-xs text-muted-foreground">
                Only if their own wording differs from the position above. Typing one suggests a
                position.
              </p>
            </div>

            {lockAccount && account ? (
              <div className="grid gap-1.5">
                <Label>Company</Label>
                <div className="flex h-9 items-center gap-2 rounded-[6px] border bg-muted/40 px-3 text-sm">
                  <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-medium">{account.name}</span>
                  <Lock className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </div>
                <p className="text-xs text-muted-foreground">
                  Added at {account.name}, the job&rsquo;s company.
                </p>
              </div>
            ) : (
              <AccountPicker
                value={account}
                onChange={setAccount}
                label="Company (optional)"
                allowCreate={false}
              />
            )}

            {/* `items-start`: a column with a note under it no longer pushes
                its neighbour's box down out of line. */}
            <div className="grid items-start gap-2 sm:grid-cols-2">
              {/* Office is not decoration: it is the office whose people can
                  open this contact. And when a CRM account is picked the
                  contact follows the account's office — the picker used to sit
                  here editable and then be discarded on save, so a rep in NY
                  filing a contact under a GA account watched "NY" turn into GA
                  with no explanation. Say which it is instead of pretending
                  there is a choice. */}
              {account ? (
                <div className="grid gap-1.5">
                  <Label>Office</Label>
                  <div className="flex h-9 items-center rounded-[6px] border bg-muted/40 px-3 text-sm">
                    {accountOfficeLabel}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Follows {account.name}. Only that office can see this contact.
                  </p>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <LocationPicker value={locationId} onChange={setLocationId} label="Office" />
                  <p className="text-xs text-muted-foreground">
                    Only this office can see the contact.
                  </p>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label>Gift policy</Label>
                <Select value={giftPolicy} onValueChange={(v) => setGiftPolicy(v as GiftPolicy)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GIFT_POLICIES.map((g) => (
                      <SelectItem key={g} value={g}>
                        {GIFT_POLICY_LABEL[g]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Mark: "keep this collapsed unless you're a salesman." Birthdays,
                gift policy and personal preferences are a seller's working
                notes; for everyone else they are a wall of fields between the
                name they came to type and the Create button. Collapsed is only
                a starting position -- the section is one click away for
                anybody, and nothing in it is hidden. */}
            <Accordion
              type="single"
              collapsible
              defaultValue={isSeller(app.roles) ? "rel" : undefined}
            >
              <AccordionItem value="rel" className="border-b-0">
                <AccordionTrigger className="text-sm">
                  Relationship details — what survives a rep change
                </AccordionTrigger>
                <AccordionContent className="space-y-2">
                  {/* Decision role lives here, not beside Position: it is what
                      this person is to US in a sale, which is a seller's
                      question and belongs with the seller's other notes. */}
                  <div className="grid gap-1.5">
                    <DetailSelect
                      label="Decision role"
                      placeholder="Not known yet"
                      options={[
                        { value: "none", label: "Not known yet" },
                        ...decisionRoles.options.map((r) => ({ value: r.key, label: r.label })),
                      ]}
                      value={decisionRole}
                      onValueChange={(v) => setDecisionRole(v as ContactDecisionRole | "none")}
                      detail={decisionRoleDetail}
                      onDetailChange={setDecisionRoleDetail}
                      className="contents"
                    />
                    <p className="text-xs text-muted-foreground">
                      What they are to us in a sale — not their job.
                    </p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="grid gap-1.5 sm:col-span-2">
                      <Label>Birthday month</Label>
                      <Select value={birthdayMonth} onValueChange={setBirthdayMonth}>
                        <SelectTrigger>
                          <SelectValue placeholder="Not known" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not known</SelectItem>
                          {MONTHS.map((m, i) => (
                            <SelectItem key={m} value={String(i + 1)}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ccd-bday">Day</Label>
                      <Input
                        id="ccd-bday"
                        inputMode="numeric"
                        value={birthdayDay}
                        onChange={(e) =>
                          setBirthdayDay(e.target.value.replace(/\D/g, "").slice(0, 2))
                        }
                        placeholder="14"
                      />
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="ccd-spouse">Spouse / partner</Label>
                      <Input
                        id="ccd-spouse"
                        value={spouse}
                        onChange={(e) => setSpouse(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ccd-children">Children</Label>
                      <Input
                        id="ccd-children"
                        value={children}
                        onChange={(e) => setChildren(e.target.value)}
                        placeholder="Two boys, 8 and 11"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ccd-hobbies">Interests</Label>
                      <Input
                        id="ccd-hobbies"
                        value={hobbies}
                        onChange={(e) => setHobbies(e.target.value)}
                        placeholder="Golf, Mets"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ccd-likes">Preferences</Label>
                      <Input
                        id="ccd-likes"
                        value={likes}
                        onChange={(e) => setLikes(e.target.value)}
                        placeholder="Coffee, not lunch"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ccd-diet">Dietary notes</Label>
                      <Input
                        id="ccd-diet"
                        value={dietary}
                        onChange={(e) => setDietary(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="ccd-time">Best time to reach</Label>
                      <Input
                        id="ccd-time"
                        value={bestTime}
                        onChange={(e) => setBestTime(e.target.value)}
                        placeholder="Before 9am"
                      />
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ccd-notes">Relationship notes</Label>
                    <Textarea
                      id="ccd-notes"
                      rows={3}
                      value={relationshipNotes}
                      onChange={(e) => setRelationshipNotes(e.target.value)}
                      placeholder="How you met, who introduced you, what they care about."
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Type</Label>
                <Select value={accountTypeId} onValueChange={setAccountTypeId}>
                  <SelectTrigger>
                    <SelectValue placeholder={accountTypes.isLoading ? "Loading…" : "Choose"} />
                  </SelectTrigger>
                  <SelectContent>
                    {accountTypes.options.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isReferenceTypeKey(accountTypes.byId.get(accountTypeId)?.key) && (
                  <p className="text-[11px] text-muted-foreground">
                    Shared reference record — every office will see and use this one.
                  </p>
                )}
              </div>

              <div className="grid gap-1.5">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as AccountStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {ACCOUNT_STATUS_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <LocationPicker value={locationId} onChange={setLocationId} label="Office" />
              <div className="grid gap-1.5">
                <Label>Assigned rep</Label>
                <Select value={assignedRep} onValueChange={setAssignedRep}>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {(peopleQ.data ?? []).map((p) => (
                      <SelectItem key={p.user_id} value={p.user_id}>
                        {p.full_name ?? "Unnamed user"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ccd-web">Website</Label>
                <Input
                  id="ccd-web"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="kestrelpg.com"
                />
              </div>
              <LeadSourcePicker
                valueId={leadSourceId}
                onValueChange={setLeadSourceId}
                detail={leadSourceDetail}
                onDetailChange={setLeadSourceDetail}
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="ccd-addr">Address</Label>
                <Input
                  id="ccd-addr"
                  value={address1}
                  onChange={(e) => setAddress1(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ccd-city">City</Label>
                <Input id="ccd-city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="ccd-state">State</Label>
                  <Input
                    id="ccd-state"
                    value={stateCode}
                    onChange={(e) => setStateCode(e.target.value.toUpperCase().slice(0, 2))}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ccd-zip">ZIP</Label>
                  <Input id="ccd-zip" value={postal} onChange={(e) => setPostal(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Labels</Label>
              <div className="flex flex-wrap gap-1.5">
                {(labelsQ.data ?? []).map((l: CrmLabel) => {
                  const on = labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() =>
                        setLabelIds((prev) =>
                          on ? prev.filter((id) => id !== l.id) : [...prev, l.id],
                        )
                      }
                      className={on ? "opacity-100" : "opacity-45 hover:opacity-80"}
                    >
                      <LabelPill label={l} />
                    </button>
                  );
                })}
                {(labelsQ.data ?? []).length === 0 && (
                  <p className="text-[11px] text-muted-foreground">No account labels set up yet.</p>
                )}
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ccd-cnotes">Relationship notes</Label>
              <Textarea
                id="ccd-cnotes"
                rows={3}
                value={relationshipNotes}
                onChange={(e) => setRelationshipNotes(e.target.value)}
                placeholder="How the relationship started, who the champion is, what they care about."
              />
            </div>
          </>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void save()} disabled={saving || !name.trim()}>
          {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
          {kind === "person"
            ? lockAccount && account
              ? "Add contact"
              : "Create customer"
            : referenceMode
              ? `Add ${referenceNoun}`
              : "Create company"}
        </Button>
      </DialogFooter>
    </>
  );
}
