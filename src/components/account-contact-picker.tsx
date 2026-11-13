import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, User, X } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { companyPeopleKey } from "@/components/company-person-picker";
import {
  canAddPeopleTo,
  createCompanyPerson,
  findExistingPerson,
  type CompanyPerson,
  type DuplicateMatch,
} from "@/lib/company-people";
import { useAccountTypes } from "@/lib/account-types";
import { toastDbError } from "@/lib/db-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * A person at a firm you already picked — desk adjuster at the carrier, public
 * adjuster at their firm.
 *
 * Adjusters are repeat players: the same handful appear job after job at the
 * same carriers. Capturing them as contacts under the firm means the second
 * job prefills entirely, and the directory survives the rep who built it.
 * With no firm selected the caller falls back to free text.
 */

export interface PickedPerson {
  id: string;
  full_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  /** Set when the person was found without a firm picked first. */
  account_id?: string | null;
  account_name?: string | null;
}

export function AccountContactPicker({
  accountId,
  accountName,
  label,
  value,
  onChange,
  disabled,
  defaultTitle,
  searchTypeKey,
}: {
  accountId: string | null;
  accountName?: string | null;
  label: string;
  value: PickedPerson | null;
  onChange: (p: PickedPerson | null) => void;
  disabled?: boolean;
  /** Seeded into the create form — "Desk adjuster", "Public adjuster". */
  defaultTitle?: string;
  /**
   * Lets the person be found before the firm is. With no firm picked, the
   * search runs across every account of this managed type — so a rep who knows
   * the adjuster's name but not which carrier they sit at can start there, and
   * the caller reads the firm back off the person.
   */
  searchTypeKey?: string;
}) {
  const qc = useQueryClient();
  const app = useAppContext();
  const accountTypes = useAccountTypes();
  const [dupe, setDupe] = useState<DuplicateMatch<CompanyPerson> | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);

  const searchTypeId = searchTypeKey ? accountTypes.idForKey(searchTypeKey) : null;
  const crossFirm = !accountId && !!searchTypeId;

  const peopleQ = useQuery({
    queryKey: ["account-contacts", accountId],
    enabled: !!accountId,
    queryFn: async (): Promise<PickedPerson[]> => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, full_name, title, email, phone")
        .eq("account_id", accountId!)
        .order("full_name")
        .limit(200);
      if (error) throw error;
      return (data ?? []) as PickedPerson[];
    },
  });

  /*
   * Cross-firm search. Typed rather than listed: there are far too many people
   * across every carrier to show a default list, so this stays quiet until
   * there are two characters to go on.
   */
  const anyFirmQ = useQuery({
    queryKey: ["contacts-by-account-type", searchTypeId, q.trim().toLowerCase()],
    enabled: crossFirm && q.trim().length >= 2,
    queryFn: async (): Promise<PickedPerson[]> => {
      const term = q.trim();
      const { data, error } = await supabase
        .from("contacts")
        .select(
          "id, full_name, title, email, phone, account_id, accounts!inner(id, name, account_type_id)",
        )
        .eq("accounts.account_type_id", searchTypeId!)
        .or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)
        .order("full_name")
        .limit(25);
      if (error) throw error;
      return (data ?? []).map((r) => {
        const acct = r.accounts as unknown as { id: string; name: string } | null;
        return {
          id: r.id,
          full_name: r.full_name,
          title: r.title,
          email: r.email,
          phone: r.phone,
          account_id: acct?.id ?? r.account_id,
          account_name: acct?.name ?? null,
        };
      });
    },
  });

  const term = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (crossFirm) return anyFirmQ.data ?? [];
    const all = peopleQ.data ?? [];
    if (!term) return all.slice(0, 25);
    return all
      .filter(
        (p) =>
          p.full_name.toLowerCase().includes(term) ||
          (p.email ?? "").toLowerCase().includes(term) ||
          (p.phone ?? "").includes(term),
      )
      .slice(0, 25);
  }, [peopleQ.data, term, crossFirm, anyFirmQ.data]);

  /*
   * BC-CON-1: "+ Add" only for people the contacts policy lets write to this
   * firm. Everyone else picks from who is there.
   */
  const canAddQ = useQuery({
    queryKey: ["can-add-people", accountId, app.userId],
    enabled: open && !!accountId && !app.writesDisabled,
    queryFn: () => canAddPeopleTo(accountId!, app.userId),
    staleTime: 5 * 60_000,
  });
  const canAdd = !app.writesDisabled && canAddQ.data === true;

  const startCreate = () => {
    setDupe(null);
    setName(q.trim());
    setEmail("");
    setPhone("");
    setCreating(true);
  };

  const use = (p: PickedPerson) => {
    onChange(p);
    setCreating(false);
    setDupe(null);
    setOpen(false);
    setQ("");
  };

  /**
   * Look before creating (BC-CON-1): the same email anywhere, or the same name
   * at this firm, is somebody we already have. A match is shown with "Use
   * existing"; `force` is the "Different person" answer.
   */
  const create = async (force = false) => {
    if (!accountId || !name.trim()) return;
    setSaving(true);
    try {
      if (!force) {
        const found = await findExistingPerson({
          accountId,
          accountName: accountName ?? null,
          full_name: name,
          email,
        });
        if (found) {
          setDupe(found);
          return;
        }
      }
      const created = await createCompanyPerson({
        accountId,
        accountName: accountName ?? null,
        full_name: name,
        email,
        phone,
        title: defaultTitle ?? null,
      });
      toast.success(`${created.full_name} added to ${accountName ?? "the firm"}`);
      qc.invalidateQueries({ queryKey: ["account-contacts", accountId] });
      qc.invalidateQueries({ queryKey: companyPeopleKey(accountId) });
      use(created);
    } catch (e) {
      toastDbError(e, { action: "Adding the person" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {value ? (
        <div className="flex items-center justify-between rounded-sm border bg-muted/30 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <User className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{value.full_name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {[value.email, value.phone].filter(Boolean).join(" · ") || "No contact details yet"}
              </div>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(null)}
            aria-label={`Clear ${label}`}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : (
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setCreating(false);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || (!accountId && !crossFirm)}
              className="h-10 w-full justify-start font-normal text-muted-foreground"
            >
              <Search className="mr-2 size-4" />
              {accountId
                ? `Find a person at ${accountName ?? "this firm"}…`
                : crossFirm
                  ? "Search by name — the firm fills itself in…"
                  : "Pick the firm first"}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] p-0">
            <div className="border-b p-2">
              <Input
                autoFocus
                placeholder="Search by name, email or phone…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {(crossFirm ? anyFirmQ.isLoading : peopleQ.isLoading) && (
                <p className="px-2 py-3 text-xs text-muted-foreground">Loading…</p>
              )}
              {crossFirm && q.trim().length < 2 && (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  Type a name to search across every firm, or pick the firm first to browse its
                  people.
                </p>
              )}
              {!(crossFirm ? anyFirmQ.isLoading : peopleQ.isLoading) &&
                matches.length === 0 &&
                !(crossFirm && q.trim().length < 2) && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    Nobody here yet — add them below and the next job prefills.
                  </p>
                )}
              {matches.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                    setQ("");
                  }}
                  className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent"
                >
                  <User className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.full_name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[p.title, p.email, p.phone].filter(Boolean).join(" · ") || "—"}
                    </div>
                    {/* Which firm, when the search spanned all of them. */}
                    {p.account_name && (
                      <div className="truncate text-xs font-medium text-primary">
                        {p.account_name}
                      </div>
                    )}
                  </div>
                </button>
              ))}

              {!canAdd ? null : !creating ? (
                <div className="mt-1 border-t pt-1">
                  <button
                    type="button"
                    onClick={startCreate}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm font-medium text-primary hover:bg-accent"
                  >
                    <Plus className="size-4 shrink-0" />
                    {q.trim()
                      ? `Add “${q.trim()}” as a contact at ${accountName ?? "this firm"}`
                      : `Add someone at ${accountName ?? "this firm"}`}
                  </button>
                </div>
              ) : (
                <div className="mt-1 grid gap-2 border-t p-2">
                  <Input
                    autoFocus
                    className="h-9"
                    placeholder="Full name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDupe(null);
                    }}
                  />
                  <Input
                    className="h-9"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setDupe(null);
                    }}
                  />
                  <Input
                    className="h-9"
                    placeholder="Phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                  {dupe && (
                    <div
                      className="grid gap-2 rounded-md border border-primary/40 bg-primary/5 p-2 text-xs"
                      data-picker-duplicate
                    >
                      <span className="text-foreground">
                        <span className="font-medium">{dupe.match.full_name}</span> is already on
                        file{dupe.match.account_name ? ` at ${dupe.match.account_name}` : ""}
                        {dupe.by === "email" ? " with that email" : ""}.
                      </span>
                      <span className="text-muted-foreground">
                        {[dupe.match.email, dupe.match.phone].filter(Boolean).join(" · ") ||
                          "No email or phone on file"}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" onClick={() => use(dupe.match)}>
                          Use existing
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={saving}
                          onClick={() => void create(true)}
                        >
                          Different person
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving || !name.trim() || !!dupe}
                      onClick={() => void create()}
                    >
                      {saving ? "Adding…" : "Add and use"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setCreating(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
