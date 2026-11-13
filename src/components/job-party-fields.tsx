import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link2, Search } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { CompanyPersonPicker } from "@/components/company-person-picker";
import { Input } from "@/components/ui/input";
import { JobField, useSectionEdit, type JobRecordLike } from "@/components/job-inline-field";
import {
  canAddPeopleTo,
  fetchPickablePeople,
  partyFillPatch,
  PARTY_SLOTS,
  searchPeople,
  type CompanyPerson,
  type PartySlot,
  type PartySlotKey,
  type SharedPersonField,
} from "@/lib/company-people";
import { useJobFieldAccess } from "@/lib/job-field-access";
import { updateJobFieldsQueued } from "@/lib/job-update";

/**
 * One person-at-a-firm on the job's Insurance card — the carrier adjuster,
 * desk and field adjusters, public adjuster, reviewer or agent — as a picker
 * above the Name / Email / Phone the job has always shown (BC-CON-1).
 *
 * The picker lists the people at the firm the job already names (the carrier
 * for its adjusters, the PA firm for the PA, …). Picking one copies their
 * name, email and phone into the job's columns and records the link; "+ New"
 * inside it saves a new person under the firm first. With no firm on the job
 * yet the picker says to choose it first, and the three fields stay typeable
 * exactly as before.
 *
 * The picker appears only where somebody is editing: under the card's pencil,
 * or on a party that is still empty. A job whose adjuster was typed months ago
 * shows that adjuster just as it did, with no new control in the way.
 *
 * Once linked, editing Name, Email or Phone asks whether to update the firm's
 * record or change this job only. The job's copy is written either way.
 */
export function JobPartyFields({
  job,
  slot: slotKey,
  onSaved,
}: {
  job: JobRecordLike;
  slot: PartySlotKey;
  onSaved: () => void;
}) {
  const slot = PARTY_SLOTS[slotKey];
  const app = useAppContext();
  const access = useJobFieldAccess();
  const sectionEditing = useSectionEdit();

  const companyId = (job[slot.companyKey] as string | null) ?? null;
  const contactId = (job[slot.contactKey] as string | null) ?? null;
  const name = (job[slot.nameKey] as string | null) ?? null;
  const empty = !name?.trim() && !job[slot.emailKey] && !job[slot.phoneKey];
  const editable = !app.writesDisabled && access.canEdit(slot.nameKey);

  const companyQ = useQuery({
    queryKey: ["job-party-company", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data } = await supabase
        .from("accounts")
        .select("name")
        .eq("id", companyId!)
        .maybeSingle();
      return data?.name ?? null;
    },
    staleTime: 5 * 60_000,
  });
  const companyName = companyQ.data ?? null;

  /* The firm the linked person is filed under decides who may edit them —
     usually the firm on the job, but an adjuster can move carrier. */
  const linkQ = useQuery({
    queryKey: ["job-party-link", contactId, app.userId],
    enabled: !!contactId && editable,
    queryFn: async () => {
      const { data } = await supabase
        .from("contacts")
        .select("account_id, accounts(name)")
        .eq("id", contactId!)
        .maybeSingle();
      const row = data as unknown as {
        account_id: string | null;
        accounts: { name: string } | null;
      } | null;
      if (!row) return null;
      return {
        companyName: row.accounts?.name ?? null,
        canUpdate: row.account_id ? await canAddPeopleTo(row.account_id, app.userId) : false,
      };
    },
    staleTime: 5 * 60_000,
  });

  const linkedAs = (field: SharedPersonField) =>
    contactId && linkQ.data
      ? {
          contactId,
          personName: name?.trim() || slot.label,
          companyName: linkQ.data.companyName ?? companyName,
          field,
          canUpdateRecord: linkQ.data.canUpdate,
        }
      : null;

  const showPicker = editable && (sectionEditing || empty);

  const pick = async (p: Pick<CompanyPerson, "id" | "full_name" | "email" | "phone">) => {
    const patch = partyFillPatch(slot, p, job);
    const res = await updateJobFieldsQueued(job.id, patch, slot.label);
    if (!res.ok) return;
    if (res.queued)
      toast.warning(`${slot.label} held on this device — it saves when you have signal.`);
    else toast.success(`${slot.label}: ${p.full_name}`);
    onSaved();
  };

  return (
    <>
      {/*
       * 6 Nov (David): "can we just have it that you put in the name over
       * here, and this box is linked to the CRM — without having an
       * additional search." The Name box IS the search while the card is
       * being edited: typing lists the firm's people, then everyone in the
       * CRM; picking one fills name, email and phone and links the record;
       * a name nobody matches is saved as typed. "+ New" still files a new
       * person under the firm.
       */}
      {showPicker ? (
        <div className="pb-1" data-party-picker={slot.key}>
          <PartyNameSearch
            slot={slot}
            companyId={companyId}
            companyName={companyName}
            value={name}
            onPick={pick}
            onTyped={async (text) => {
              if ((text || null) === (name || null)) return;
              const res = await updateJobFieldsQueued(
                job.id,
                { [slot.nameKey]: text || null },
                slot.label,
              );
              if (res.ok) onSaved();
            }}
          />
          {companyId && (
            <CompanyPersonPicker
              accountId={companyId}
              accountName={companyName}
              companyNoun={slot.companyNoun}
              newTitle={slot.title}
              triggerLabel={`+ New ${slot.label.toLowerCase()} at ${companyName ?? `the ${slot.companyNoun}`}`}
              onPick={pick}
            />
          )}
        </div>
      ) : (
        <JobField
          job={job}
          label="Name"
          fieldKey={slot.nameKey}
          onSaved={onSaved}
          linked={linkedAs("full_name")}
        />
      )}
      <JobField
        job={job}
        label="Email"
        fieldKey={slot.emailKey}
        onSaved={onSaved}
        linked={linkedAs("email")}
      />
      <JobField
        job={job}
        label="Phone"
        fieldKey={slot.phoneKey}
        onSaved={onSaved}
        linked={linkedAs("phone")}
      />
      {contactId && !empty && (
        <p
          className="flex items-center gap-1 pt-0.5 text-[11px] text-muted-foreground"
          data-party-linked={slot.key}
        >
          <Link2 className="size-3 shrink-0" />
          From {linkQ.data?.companyName ?? companyName ?? "the CRM"}&rsquo;s records
        </p>
      )}
    </>
  );
}

/** One row of search_customers_minimal, narrowed to a person. */
type CrmPersonRow = {
  kind: string;
  id: string;
  name: string;
  account_name: string | null;
  phone: string | null;
  email: string | null;
  viewer_has_full_access: boolean;
};

type Suggestion = Pick<CompanyPerson, "id" | "full_name" | "email" | "phone"> & {
  where: string | null;
};

/**
 * The Name box that searches the CRM as it is typed (6 Nov). The firm's own
 * people come first, without typing; from two characters on, everyone in the
 * CRM joins the list. Enter or leaving the box with a name nobody matched
 * saves it as typed, exactly as the plain Name field did.
 */
function PartyNameSearch({
  slot,
  companyId,
  companyName,
  value,
  onPick,
  onTyped,
}: {
  slot: PartySlot;
  companyId: string | null;
  companyName: string | null;
  value: string | null;
  onPick: (p: Suggestion) => Promise<void>;
  onTyped: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  const [term, setTerm] = useState("");
  useEffect(() => setText(value ?? ""), [value]);
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 220);
    return () => clearTimeout(t);
  }, [text]);

  const firmQ = useQuery({
    queryKey: ["job-party-firm-people", companyId],
    enabled: !!companyId && focused,
    queryFn: () => fetchPickablePeople(companyId!, companyName),
    staleTime: 60_000,
  });
  const crmQ = useQuery({
    queryKey: ["job-party-crm-search", term],
    enabled: focused && term.length >= 2,
    queryFn: async (): Promise<CrmPersonRow[]> => {
      const { data, error } = await supabase.rpc("search_customers_minimal", { _query: term });
      if (error) throw error;
      return ((data ?? []) as unknown as CrmPersonRow[]).filter(
        (r) => r.kind === "contact" && r.viewer_has_full_access,
      );
    },
  });

  const suggestions = useMemo<Suggestion[]>(() => {
    const firm = searchPeople(firmQ.data ?? [], text)
      .slice(0, 6)
      .map((p) => ({
        id: p.id,
        full_name: p.full_name,
        email: p.email,
        phone: p.phone,
        where: p.account_name ?? companyName,
      }));
    const seen = new Set(firm.map((p) => p.id));
    const crm = (crmQ.data ?? [])
      .filter((r) => !seen.has(r.id))
      .slice(0, 6)
      .map((r) => ({
        id: r.id,
        full_name: r.name,
        email: r.email,
        phone: r.phone,
        where: r.account_name,
      }));
    return [...firm, ...crm];
  }, [firmQ.data, crmQ.data, text, companyName]);

  const open = focused && (suggestions.length > 0 || (term.length >= 2 && crmQ.isLoading));
  const commit = () => void onTyped(text.trim());

  return (
    <div className="relative" data-party-name-search={slot.key}>
      <label className="block space-y-1">
        <span className="block text-xs font-medium text-muted-foreground">Name</span>
        <span className="relative block">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={text}
            placeholder={
              companyId
                ? `Type a name — ${companyName ?? `the ${slot.companyNoun}`}'s people, then the CRM`
                : "Type a name to search the CRM"
            }
            aria-label={`${slot.label} name`}
            autoComplete="off"
            className="h-11 pl-8 sm:h-9"
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              // Let a tap on a suggestion land before the list goes.
              setTimeout(() => setFocused(false), 150);
              commit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (suggestions.length === 1) void onPick(suggestions[0]);
                else commit();
                setFocused(false);
              }
              if (e.key === "Escape") setFocused(false);
            }}
          />
        </span>
      </label>
      {open && (
        <ul
          role="listbox"
          aria-label={`${slot.label} matches`}
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        >
          {suggestions.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setFocused(false);
                  void onPick(p);
                }}
              >
                <span className="font-medium">{p.full_name}</span>
                <span className="text-xs text-muted-foreground">
                  {[p.where, p.email, p.phone].filter(Boolean).join(" · ") || "In the CRM"}
                </span>
              </button>
            </li>
          ))}
          {suggestions.length === 0 && crmQ.isLoading && (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">Searching the CRM…</li>
          )}
        </ul>
      )}
    </div>
  );
}
