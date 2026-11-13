import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Check, Plus, Search, X } from "lucide-react";

import { OtherOfficeNotice, otherOfficeNames } from "@/components/other-office-notice";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import { useAccountTypes } from "@/lib/account-types";

/**
 * Account picker. Lists only the companies this person may open (normal RLS),
 * with the full row, so the form can prefill loss type and contact details.
 *
 * Companies owned by an office this person has no access to are not listed at
 * all (owner, 13 Nov: what a role is not granted, it does not see). Before,
 * they showed as locked "owned by another office" rows to head off duplicates.
 */

export interface PickedAccount {
  id: string;
  name: string;
  location_id: string;
  primary_contact: {
    full_name: string;
    phone: string | null;
    email: string | null;
  } | null;
}

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AccountPicker({
  value,
  onChange,
  label = "Company (optional)",
  disabled,
  reason,
  suggestion,
  onAcceptSuggestion,
  onDismissSuggestion,
  allowCreate = true,
  typeKey,
  typeNoun,
}: {
  value: PickedAccount | null;
  onChange: (a: PickedAccount | null) => void;
  label?: string;
  disabled?: boolean;
  /** Why the field filled itself — shown muted underneath, never hidden. */
  reason?: string | null;
  /** Weak evidence (a fuzzy name match) offered for confirmation. */
  suggestion?: { account: PickedAccount; reason: string } | null;
  onAcceptSuggestion?: () => void;
  onDismissSuggestion?: () => void;
  /** Off inside the create dialog itself, so it cannot nest into itself. */
  allowCreate?: boolean;
  /**
   * Restrict the search to one managed account type — carriers on the
   * insurance field, public adjusting firms on the PA field. Anything created
   * from the dead-end row is preset to the same type.
   */
  typeKey?: string;
  /** How to name that type in copy: “Create ‘dougs’ as a public adjusting firm”. */
  typeNoun?: string;
}) {
  const app = useAppContext();
  const accountTypes = useAccountTypes();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const term = useDebounced(q.trim());
  const typeId = typeKey ? accountTypes.idForKey(typeKey) : null;
  const noun = typeNoun ?? (typeKey ? accountTypes.label(typeKey).toLowerCase() : "company");
  const enabled = term.length >= 2 && (!typeKey || !!typeId);

  // Full detail for everything the viewer can actually read.
  const inScopeQ = useQuery({
    queryKey: ["account-picker-scoped", term, typeId],
    enabled,
    queryFn: async (): Promise<PickedAccount[]> => {
      let sel = supabase
        .from("accounts")
        .select("id, name, location_id, contacts(full_name, phone, email, is_primary)")
        .ilike("name", `%${term}%`);
      if (typeId) sel = sel.eq("account_type_id", typeId);
      const { data, error } = await sel.order("name").limit(15);
      if (error) throw error;
      return (data ?? []).map((a) => {
        const contacts = (a.contacts ?? []) as Array<{
          full_name: string;
          phone: string | null;
          email: string | null;
          is_primary: boolean;
        }>;
        const primary = contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;
        return {
          id: a.id,
          name: a.name,
          location_id: a.location_id,
          primary_contact: primary
            ? {
                full_name: primary.full_name,
                phone: primary.phone,
                email: primary.email,
              }
            : null,
        };
      });
    },
  });

  /* Only companies this person may open are listed. One another office owns
     is not shown at all — no locked row, no "not selectable" heading. */
  const inScope = inScopeQ.data ?? [];

  /*
   * 13 Nov (owner): "bring back the cross-office duplicate warning". The
   * other offices' matches are not listed, but one line says a match exists
   * and which office has it — nothing else of the record — so a rep calls
   * that office instead of creating a second company. Skipped on type-scoped
   * pickers: carriers and adjusting firms are shared reference records.
   */
  const elsewhereQ = useQuery({
    queryKey: ["account-picker-elsewhere", term],
    enabled: enabled && !typeKey,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase.rpc("search_accounts_minimal", { _query: term });
      if (error) return [];
      const rows = (data ?? []) as unknown as {
        account_id: string;
        owning_location_name: string | null;
        viewer_has_full_access: boolean;
      }[];
      return otherOfficeNames(
        rows.filter((r) => !r.viewer_has_full_access).map((r) => r.owning_location_name),
      );
    },
  });
  const elsewhereOffices = elsewhereQ.data?.length ? elsewhereQ.data : null;

  const loading = inScopeQ.isFetching;
  /*
   * A failed search and a search with no hits both leave the lists empty, and
   * "no account matches anywhere in the company" is the sentence that makes
   * someone create a duplicate of an account that already exists.
   */
  const failed = inScopeQ.isError;
  const nothing = enabled && !loading && !failed && inScope.length === 0;

  const pick = (a: PickedAccount) => {
    onChange(a);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {value ? (
        <>
          <div className="flex items-center justify-between rounded-sm border bg-muted/30 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Building2 className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{value.name}</div>
                {value.primary_contact && (
                  <div className="truncate text-xs text-muted-foreground">
                    {value.primary_contact.full_name}
                    {value.primary_contact.phone ? ` · ${value.primary_contact.phone}` : ""}
                  </div>
                )}
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(null)}
              aria-label="Clear company"
            >
              <X className="size-4" />
            </Button>
          </div>
          {reason && <p className="text-[11px] text-muted-foreground">{reason}</p>}
        </>
      ) : null}

      {suggestion && !value && (
        <div className="flex items-start justify-between gap-2 rounded-sm border border-primary/40 bg-primary/5 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{suggestion.account.name}</div>
            <p className="text-[11px] text-muted-foreground">{suggestion.reason}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={disabled}
              onClick={onAcceptSuggestion}
            >
              Link
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px]"
              onClick={onDismissSuggestion}
            >
              No
            </Button>
          </div>
        </div>
      )}

      {/* Search stays available even when the field is prefilled — the rep
          may need to override, and the cross-office copy is the duplicate
          prevention doing its work. */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {value ? (
            <Button
              type="button"
              variant="link"
              disabled={disabled}
              className="h-auto p-0 text-[11px] font-normal text-muted-foreground"
            >
              <Search className="mr-1 size-3" />
              Search for a different company
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className="h-11 w-full justify-start font-normal text-muted-foreground"
            >
              <Search className="mr-2 size-4" />
              Link a company…
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-0">
          <div className="border-b p-2">
            <Input
              autoFocus
              placeholder="Search companies…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {!enabled && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {typeKey
                  ? `Type at least two characters to search ${noun}s already in the CRM.`
                  : "Type at least two characters. Check here before creating a new company."}
              </p>
            )}
            {enabled && loading && (
              <p className="px-2 py-3 text-xs text-muted-foreground">Searching…</p>
            )}
            {enabled && !loading && failed && (
              <p className="px-2 py-3 text-xs text-destructive">
                The company search failed. This is not an empty result — don&rsquo;t create a new
                company on the strength of it. Try again.
              </p>
            )}
            {!loading && (
              <OtherOfficeNotice
                offices={elsewhereOffices}
                what="company"
                className="my-1 px-3 py-2"
              />
            )}
            {nothing && !elsewhereOffices && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {typeKey
                  ? `No ${noun} called “${term}” yet — create it below and it is there for every office next time.`
                  : `No company matches “${term}”.`}
              </p>
            )}

            {inScope.map((a) => {
              const loc = app.allLocations.find((l) => l.id === a.location_id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => pick(a)}
                  className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent"
                >
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{a.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {loc ? `${loc.code} · ${loc.name}` : "—"}
                      {a.primary_contact ? ` · ${a.primary_contact.full_name}` : ""}
                    </div>
                  </div>
                </button>
              );
            })}

            {allowCreate && term.length >= 2 && (
              <div className="mt-1 border-t pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm font-medium text-primary hover:bg-accent"
                >
                  <Plus className="size-4 shrink-0" />
                  {typeKey
                    ? `Add “${term}” as ${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`
                    : `Create new company — “${term}”`}
                </button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <CreateCustomerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        kind="company"
        initialName={term}
        defaultAccountTypeKey={typeKey}
        onCreated={(c) => {
          if (!c.accountId) return;
          pick({
            id: c.accountId,
            name: c.name,
            location_id: c.accountLocationId ?? "",
            primary_contact: null,
          });
        }}
      />

      <p className="text-[11px] text-muted-foreground">
        Search covers every office, so check here before creating a new account.
      </p>
    </div>
  );
}
