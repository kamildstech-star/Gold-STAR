import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Plus, Search, User, UserCheck } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { CONTACT_POSITION_OPTIONS } from "@/lib/company-hierarchy";
import {
  canAddPeopleTo,
  createCompanyPerson,
  fetchPickablePeople,
  findExistingPerson,
  searchPeople,
  type CompanyPerson,
  type DuplicateMatch,
} from "@/lib/company-people";
import { toastDbError } from "@/lib/db-errors";
import { isValidEmail } from "@/lib/email";
import { useManagedOptions } from "@/lib/managed-options";
import { cn } from "@/lib/utils";

/** Query key for a company's pickable people, shared so a save refreshes every picker. */
export const companyPeopleKey = (accountId: string | null) => ["company-people", accountId];

/**
 * "Who at this company?" — one picker for every place a job names a person who
 * belongs to a firm: the client's property manager on the Contacts tab, the
 * carrier's adjusters, the public adjuster, the reviewer, the agent.
 *
 * Type to search by name, email or phone; arrow keys and Enter pick. Each
 * result shows the email and phone under the name, because two Chaims at one
 * management company are told apart by their number, not their name.
 *
 * On a phone it opens as a bottom sheet instead of a popover: a popover
 * anchored to a field half way down a 360px screen leaves about three rows
 * visible above the keyboard, and the sheet gives the list the whole width.
 *
 * "+ New" adds the person to the company — after checking they are not already
 * there (see findDuplicatePerson for the rule). A match is shown with "Use
 * existing" rather than quietly linked or quietly duplicated, because only the
 * person typing knows whether the Liz Pedrogo on file is the Liz on the phone.
 * The New row is offered only to people the contacts policy lets write to this
 * company; everyone else can pick but not add.
 */
export function CompanyPersonPicker({
  accountId,
  accountName,
  companyNoun = "company",
  triggerLabel,
  onPick,
  disabled,
  newTitle,
  askPosition = false,
  excludeIds,
  className,
}: {
  accountId: string | null;
  accountName: string | null;
  /** "carrier", "public adjusting firm" — for "Choose the carrier first". */
  companyNoun?: string;
  /** What the closed button says. Defaults to "Pick from <company>…". */
  triggerLabel?: string;
  /** `created` is true when the person was just added to the company. */
  onPick: (person: CompanyPerson, info: { created: boolean }) => void | Promise<void>;
  disabled?: boolean;
  /** Seeded as the new person's job title — "Desk adjuster". */
  newTitle?: string;
  /** Ask for the person's position at the company in the New form. */
  askPosition?: boolean;
  /** People to leave out of the list — already on the job, say. The New
      form still sees them, so it can still catch a duplicate. */
  excludeIds?: readonly string[];
  className?: string;
}) {
  const app = useAppContext();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const peopleQ = useQuery({
    queryKey: companyPeopleKey(accountId),
    enabled: open && !!accountId,
    queryFn: () => fetchPickablePeople(accountId!, accountName),
    staleTime: 60_000,
  });

  const canAddQ = useQuery({
    queryKey: ["can-add-people", accountId, app.userId],
    enabled: open && !!accountId && !app.writesDisabled,
    queryFn: () => canAddPeopleTo(accountId!, app.userId),
    staleTime: 5 * 60_000,
  });
  const canAdd = !app.writesDisabled && canAddQ.data === true;

  const excludeKey = (excludeIds ?? []).join(",");
  const matches = useMemo(() => {
    const skip = new Set(excludeIds ?? []);
    return searchPeople(
      (peopleQ.data ?? []).filter((p) => !skip.has(p.id)),
      q,
    ).slice(0, 50);
    // excludeKey stands for excludeIds, which callers rebuild every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peopleQ.data, q, excludeKey]);

  const close = () => {
    setOpen(false);
    setCreating(false);
    setQ("");
  };

  const pick = async (p: CompanyPerson, created: boolean) => {
    close();
    await onPick(p, { created });
  };

  const body = !accountId ? (
    <p className="px-3 py-4 text-sm text-muted-foreground" data-picker-needs-company>
      Choose the {companyNoun} first to see its people. You can still type the details in by hand.
    </p>
  ) : creating ? (
    <NewPersonForm
      accountId={accountId}
      accountName={accountName}
      initialName={q.trim()}
      title={newTitle}
      askPosition={askPosition}
      people={peopleQ.data ?? []}
      onCancel={() => setCreating(false)}
      onDone={(p, created) => void pick(p, created)}
    />
  ) : (
    <Command shouldFilter={false} className="rounded-none">
      <CommandInput
        autoFocus
        value={q}
        onValueChange={setQ}
        placeholder="Search by name, email or phone…"
        aria-label={`Search people at ${accountName ?? `the ${companyNoun}`}`}
      />
      <CommandList className={cn(isMobile ? "max-h-[55vh]" : "max-h-72")}>
        {peopleQ.isLoading && <p className="px-3 py-3 text-xs text-muted-foreground">Loading…</p>}
        {peopleQ.isError && (
          <p className="px-3 py-3 text-xs text-destructive">
            The people at {accountName ?? `this ${companyNoun}`} could not be loaded. This is not an
            empty list — don&rsquo;t add someone new until it loads.
          </p>
        )}
        {!peopleQ.isLoading && !peopleQ.isError && (
          <CommandEmpty className="px-3 py-3 text-left text-xs text-muted-foreground">
            {q.trim()
              ? `Nobody at ${accountName ?? `this ${companyNoun}`} matches “${q.trim()}”.`
              : `Nobody on file at ${accountName ?? `this ${companyNoun}`} yet.`}
          </CommandEmpty>
        )}
        {matches.length > 0 && (
          <CommandGroup heading={accountName ?? undefined}>
            {matches.map((p) => (
              <CommandItem
                key={p.id}
                value={p.id}
                onSelect={() => void pick(p, false)}
                className="items-start gap-2 py-2"
                data-picker-person={p.id}
              >
                <User className="mt-0.5 size-4 shrink-0 text-primary" />
                <PersonLines person={p} accountName={accountName} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      {canAdd && !peopleQ.isError && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex w-full items-center gap-2 border-t px-3 py-2.5 text-left text-sm font-medium text-primary transition-colors hover:bg-accent"
          data-picker-new
        >
          <Plus className="size-4 shrink-0" />
          <span className="truncate">
            {q.trim()
              ? `New: add “${q.trim()}” to ${accountName ?? `the ${companyNoun}`}`
              : `New person at ${accountName ?? `the ${companyNoun}`}`}
          </span>
        </button>
      )}
    </Command>
  );

  const trigger = (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={isMobile ? () => setOpen(true) : undefined}
      className={cn("h-9 w-full justify-start gap-2 font-normal text-muted-foreground", className)}
      data-company-person-picker
    >
      <Search className="size-4 shrink-0" />
      <span className="truncate">
        {triggerLabel ??
          (accountId ? `Pick from ${accountName ?? `the ${companyNoun}`}…` : `Pick a person…`)}
      </span>
    </Button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
          <SheetContent side="bottom" className="max-h-[85vh] gap-0 overflow-y-auto p-0">
            <SheetHeader className="border-b px-4 py-3 text-left">
              <SheetTitle className="flex items-center gap-2 text-base">
                <Building2 className="size-4 text-primary" />
                {accountName ?? `Choose a ${companyNoun}`}
              </SheetTitle>
            </SheetHeader>
            {body}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] p-0">
        {body}
      </PopoverContent>
    </Popover>
  );
}

/** Name, then position · company, then email · phone — the lines that tell people apart. */
function PersonLines({
  person: p,
  accountName,
}: {
  person: CompanyPerson;
  accountName: string | null;
}) {
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const position = p.position_key ? positions.label(p.position_key) : p.title;
  const elsewhere = p.account_name && p.account_name !== accountName ? p.account_name : null;
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-foreground">{p.full_name}</div>
      {(position || elsewhere || p.source === "property") && (
        <div className="truncate text-xs text-muted-foreground">
          {[position, elsewhere, p.source === "property" ? "Building staff" : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      <div className="truncate text-xs text-muted-foreground">
        {[p.email, p.phone].filter(Boolean).join(" · ") || "No email or phone on file"}
      </div>
    </div>
  );
}

/**
 * Add a person to the company, from inside the picker.
 *
 * Save first looks for the person (findExistingPerson). A match stops the save
 * and shows the record with "Use existing"; "Different person" goes ahead and
 * creates. So the duplicate never happens by accident, and a genuine namesake
 * is still one click away.
 */
function NewPersonForm({
  accountId,
  accountName,
  initialName,
  title,
  askPosition,
  people,
  onCancel,
  onDone,
}: {
  accountId: string;
  accountName: string | null;
  initialName: string;
  title?: string;
  askPosition: boolean;
  people: readonly CompanyPerson[];
  onCancel: () => void;
  onDone: (p: CompanyPerson, created: boolean) => void;
}) {
  const qc = useQueryClient();
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [position, setPosition] = useState<string>("");
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dupe, setDupe] = useState<DuplicateMatch<CompanyPerson> | null>(null);

  const nameError = tried && !name.trim() ? "Enter the person’s name." : null;
  const emailError =
    tried && email.trim() && !isValidEmail(email) ? "That email doesn’t look complete." : null;

  const create = async () => {
    setSaving(true);
    try {
      const created = await createCompanyPerson({
        accountId,
        accountName,
        full_name: name,
        email,
        phone,
        title: title ?? null,
        position_key: position || null,
      });
      toast.success(`${created.full_name} added to ${accountName ?? "the company"}`);
      void qc.invalidateQueries({ queryKey: companyPeopleKey(accountId) });
      void qc.invalidateQueries({ queryKey: ["account-contacts", accountId] });
      onDone(created, true);
    } catch (e) {
      toastDbError(e, { action: `Adding the person to ${accountName ?? "the company"}` });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setTried(true);
    if (!name.trim() || (email.trim() && !isValidEmail(email))) return;
    setSaving(true);
    try {
      const found = await findExistingPerson({
        accountId,
        accountName,
        full_name: name,
        email,
        people,
      });
      if (found) {
        setDupe(found);
        return;
      }
    } catch (e) {
      // A failed duplicate check is reported, never treated as "no duplicate".
      toastDbError(e, { action: "Checking for an existing record" });
      return;
    } finally {
      setSaving(false);
    }
    await create();
  };

  if (dupe) {
    return (
      <div className="grid gap-3 p-3" data-picker-duplicate>
        <p className="text-sm text-foreground">
          {dupe.by === "email"
            ? "Someone with that email is already on file:"
            : `Someone with that name is already at ${accountName ?? "this company"}:`}
        </p>
        <div className="flex items-start gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
          <UserCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <PersonLines person={dupe.match} accountName={accountName} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => onDone(dupe.match, false)}>
            <Check className="size-3.5" /> Use existing
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void create()}
          >
            Different person — add new
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="grid gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-picker-new-form
    >
      <div className="text-xs font-medium text-muted-foreground">
        New person at {accountName ?? "this company"}
      </div>
      <div className="grid gap-1">
        <Input
          autoFocus
          className="h-9"
          placeholder="Full name"
          aria-label="Full name"
          aria-invalid={!!nameError}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      </div>
      <div className="grid gap-1">
        <Input
          className="h-9"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="Email"
          aria-label="Email"
          aria-invalid={!!emailError}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {emailError && <p className="text-xs text-destructive">{emailError}</p>}
      </div>
      <Input
        className="h-9"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        placeholder="Phone"
        aria-label="Phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      {askPosition && (
        <Select value={position} onValueChange={setPosition}>
          <SelectTrigger className="h-9" aria-label="Position">
            <SelectValue placeholder="Position at the company (optional)" />
          </SelectTrigger>
          <SelectContent>
            {positions.options.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save and use"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </form>
  );
}
