import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, User } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { resolveContactLocationId } from "@/lib/contacts";
import { toastDbError } from "@/lib/db-errors";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface PickedContact {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
}

/** One row of search_customers_minimal, narrowed to the people. */
interface PersonRow {
  kind: string;
  id: string;
  name: string;
  title: string | null;
  account_id: string | null;
  account_name: string | null;
  phone: string | null;
  email: string | null;
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

/**
 * Company + the individual you deal with there — the shape the client uses for
 * public adjusters and referrals alike. Contacts can be created inline so the
 * office never has to leave the job form to add a person.
 */
export function CompanyContactPicker({
  accountLabel,
  contactLabel = "Individual",
  account,
  onAccountChange,
  contact,
  onContactChange,
  disabled,
  reason,
  suggestion,
  onAcceptSuggestion,
  onDismissSuggestion,
  typeKey,
  typeNoun,
  personFirst = false,
  hideCompany = false,
  createLocationId = null,
}: {
  accountLabel: string;
  contactLabel?: string;
  account: PickedAccount | null;
  onAccountChange: (a: PickedAccount | null) => void;
  contact: PickedContact | null;
  onContactChange: (c: PickedContact | null) => void;
  disabled?: boolean;
  reason?: string | null;
  suggestion?: { account: PickedAccount; reason: string } | null;
  onAcceptSuggestion?: () => void;
  onDismissSuggestion?: () => void;
  /** Scope the company search to one managed account type. */
  typeKey?: string;
  typeNoun?: string;
  /**
   * David, on the Main point of contact field: "The main point of contact will
   * make me do a company. Right. I don't want a company. Main point of contact
   * should be a person. Because the company is right in here."
   *
   * In this mode the person comes first and is never gated on a company: you
   * search people by name, phone or email across the CRM, the company's own
   * people are the list you see before you type anything, and the company
   * chooser sits underneath as a way to narrow — not as a toll gate. "New"
   * opens the full contact form rather than the three boxes below, so a person
   * added from a job gets the position, the phones and the duplicate check
   * that a person added from the CRM gets.
   */
  personFirst?: boolean;
  /**
   * The company is already settled — a job's own Company, chosen just above
   * the Main point of contact (4 Nov: "why we are giving this again when we
   * have already selected above?"). Its people are listed; no second chooser.
   */
  hideCompany?: boolean;
  /** Office to file a company-less contact under, when personFirst is on. */
  createLocationId?: string | null;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const contactsQ = useQuery({
    queryKey: ["account-contacts", account?.id],
    enabled: !!account?.id,
    queryFn: async (): Promise<PickedContact[]> => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone")
        .eq("account_id", account!.id)
        .order("is_primary", { ascending: false })
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as PickedContact[];
    },
  });

  /* Typing looks past the company. The whole point of the person-first mode is
     that a job whose account is blank — or whose person works somewhere else —
     still finds somebody, which the company-scoped list above cannot do. */
  const term = useDebounced(search.trim());
  const searchQ = useQuery({
    queryKey: ["contact-search", term],
    enabled: personFirst && term.length >= 2,
    queryFn: async (): Promise<PersonRow[]> => {
      const { data, error } = await supabase.rpc("search_customers_minimal", { _query: term });
      if (error) throw error;
      return (data ?? []) as unknown as PersonRow[];
    },
  });

  const results = useMemo(() => {
    if (term.length >= 2) {
      // Another office's records come back locked in this RPC; they are not
      // ours to attach to a job, so they are simply not offered here.
      return (searchQ.data ?? []).filter((r) => r.kind === "contact" && r.viewer_has_full_access);
    }
    return (contactsQ.data ?? []).map((c): PersonRow => ({
      kind: "contact",
      id: c.id,
      name: c.full_name,
      title: null,
      account_id: account?.id ?? null,
      account_name: account?.name ?? null,
      phone: c.phone,
      email: c.email,
      viewer_has_full_access: true,
    }));
  }, [term, searchQ.data, contactsQ.data, account]);

  const createContact = async () => {
    if (!account || !name.trim()) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("contacts")
      .insert({
        account_id: account.id,
        location_id: await resolveContactLocationId(account.id),
        full_name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
      })
      .select("id, full_name, email, phone")
      .single();
    setSaving(false);
    if (error || !data) {
      toastDbError(error ?? new Error("no row returned"), { action: "Creating contact" });
      return;
    }
    toast.success("Contact added");
    onContactChange(data as PickedContact);
    setAdding(false);
    setName("");
    setEmail("");
    setPhone("");
    qc.invalidateQueries({ queryKey: ["account-contacts", account.id] });
  };

  const companyBlock = (
    <AccountPicker
      value={account}
      label={accountLabel}
      reason={reason}
      suggestion={suggestion}
      onAcceptSuggestion={onAcceptSuggestion}
      onDismissSuggestion={onDismissSuggestion}
      onChange={(a) => {
        onAccountChange(a);
        onContactChange(null);
      }}
      disabled={disabled}
      typeKey={typeKey}
      typeNoun={typeNoun}
    />
  );

  if (personFirst) {
    return (
      <div className="grid gap-3 rounded-md border p-3">
        <div className="grid gap-1.5">
          <Label>{contactLabel}</Label>
          {/* One way to add somebody (David, 21 Oct): type their name, and
              the list offers "Add contact" for it — no separate New button. */}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, phone or email"
            className="h-9"
            disabled={disabled}
          />

          <div className="max-h-56 overflow-y-auto rounded-sm border">
            {(searchQ.isFetching || contactsQ.isLoading) && results.length === 0 && (
              <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
            )}
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onContactChange({
                    id: r.id,
                    full_name: r.name,
                    email: r.email,
                    phone: r.phone,
                  })
                }
                className={`flex w-full items-start gap-2 px-2 py-2 text-left transition-colors hover:bg-accent ${
                  contact?.id === r.id ? "bg-accent" : ""
                }`}
              >
                <User className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[r.title, r.account_name].filter(Boolean).join(" · ") || "No company on file"}
                  </div>
                  {(r.phone || r.email) && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {[r.phone, r.email].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              </button>
            ))}
            {results.length === 0 && !searchQ.isFetching && !contactsQ.isLoading && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {term.length >= 2
                  ? `Nobody called “${term}” yet.`
                  : account
                    ? "Nobody on file at this company yet."
                    : "Type a name, phone or email to find somebody."}
              </p>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => setCreateOpen(true)}
              data-add-contact
              className="flex w-full items-center gap-2 border-t px-2 py-2 text-left text-sm font-medium text-primary transition-colors hover:bg-accent disabled:opacity-50"
            >
              <Plus className="size-4 shrink-0" />
              <span className="truncate">
                {term.length >= 2 ? `Add contact “${term}”` : "Add contact"}
              </span>
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {term.length >= 2
              ? hideCompany
                ? "Searching every company, not just this one."
                : "Searching every company, not just the one below."
              : account
                ? `People at ${account.name}. Type to search everywhere else.`
                : "Type to search, or pick a company below to see its people."}
          </p>
        </div>

        {/* The company is the narrowing tool, not the way in. */}
        {hideCompany ? null : companyBlock}

        <CreateCustomerDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          kind="person"
          initialName={search.trim()}
          defaultAccount={account}
          lockAccount={hideCompany && !!account}
          defaultLocationId={createLocationId}
          onCreated={(created) => {
            setCreateOpen(false);
            if (!created.contactId) return;
            onContactChange({
              id: created.contactId,
              full_name: created.name,
              email: created.email,
              phone: created.phone,
            });
            if (account?.id) qc.invalidateQueries({ queryKey: ["account-contacts", account.id] });
          }}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-2 rounded-md border p-3">
      {companyBlock}
      {account && (
        <div className="grid gap-1.5">
          <Label>{contactLabel}</Label>
          <div className="flex gap-2">
            <Select
              value={contact?.id ?? ""}
              onValueChange={(id) =>
                onContactChange((contactsQ.data ?? []).find((c) => c.id === id) ?? null)
              }
              disabled={disabled}
            >
              <SelectTrigger className="h-9 flex-1">
                <SelectValue placeholder={contactsQ.isLoading ? "Loading…" : "Choose a person"} />
              </SelectTrigger>
              <SelectContent>
                {(contactsQ.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.full_name}
                    {c.email ? ` · ${c.email}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9"
              disabled={disabled}
              onClick={() => setAdding((v) => !v)}
            >
              <Plus className="mr-1 size-3.5" /> New
            </Button>
          </div>
          {adding && (
            <div className="grid gap-2 rounded-md border bg-muted/30 p-2 sm:grid-cols-3">
              <Input
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9"
              />
              <Input
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9"
              />
              <Input
                placeholder="Phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="h-9"
              />
              <div className="sm:col-span-3">
                <Button
                  type="button"
                  size="sm"
                  onClick={createContact}
                  disabled={saving || !name.trim()}
                >
                  {saving ? "Adding…" : "Add contact"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
