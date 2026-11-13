import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Eye,
  List,
  Mail,
  Network,
  Pencil,
  Phone,
  Plus,
  Trash2,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { isMissingSchema } from "@/lib/schema-fallback";
import { resolveContactLocationId } from "@/lib/contacts";
import { addressKey } from "@/lib/standing-notes";
import { useManagedOptions, type ManagedOptions } from "@/lib/managed-options";
import { RecordLoadError } from "@/components/record-load-error";
import { CompanyFamilyTree } from "@/components/company-family-tree";
import { CompanyOrgChart, OrgChartFullScreen } from "@/components/company-org-chart";
import {
  buildOrgTree,
  CONTACT_POSITION_OPTIONS,
  descendantCount,
  eligibleManagers,
  fetchAccountProperties,
  fetchCompanyPeople,
  type HierarchyRead,
  fetchPropertyAssignments,
  positionRank,
  propertyScope,
  resolveBilling,
  visibleOrgNodes,
  type HierarchyContact,
  type PropertyScope,
} from "@/lib/company-hierarchy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWritesDisabled } from "@/components/app-context";
import { assertWritesEnabled } from "@/lib/write-guard";
import { cn } from "@/lib/utils";

/**
 * The company hierarchy on an account page: who does what, who they answer to,
 * and which buildings they cover.
 *
 * An indented list, not a canvas org chart. This gets opened on a phone at a
 * flooded building, where a pannable diagram is unusable and a list is not.
 */

const NONE = "__none__";

const HIERARCHY_VIEWS = [
  { value: "list", label: "List", icon: List },
  { value: "tree", label: "Tree", icon: Network },
] as const;
type HierarchyView = (typeof HIERARCHY_VIEWS)[number]["value"];

function HierarchyViewSwitch({
  view,
  onChange,
}: {
  view: HierarchyView;
  onChange: (v: HierarchyView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Hierarchy view"
      className="grid grid-cols-2 gap-0.5 rounded-[6px] border bg-muted/40 p-0.5"
    >
      {HIERARCHY_VIEWS.map((v) => (
        <button
          key={v.value}
          type="button"
          aria-pressed={view === v.value}
          onClick={() => onChange(v.value)}
          className={cn(
            "flex items-center justify-center gap-1 rounded-[4px] px-2 py-1 text-[11px] font-medium",
            view === v.value
              ? "bg-background text-foreground shadow-[0_0_0_1px_var(--border)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <v.icon className="size-3.5" />
          {v.label}
        </button>
      ))}
    </div>
  );
}

/* Indent geometry, shared by the padding and the guide rules so they cannot
   drift apart. Depth past MAX_GUIDES stops indenting: a phone has no width
   left, and the guides already carry the depth. */
const BASE_PAD = 16;
const STEP = 16;
const MAX_GUIDES = 6;

export function CompanyHierarchyPanel({
  accountId,
  accountName,
  initialView = "list",
  expandable = true,
}: {
  accountId: string;
  /** Heads the people chart; the card reads fine without it. */
  accountName?: string;
  /** Which view opens first — the list unless a caller came for the chart. */
  initialView?: HierarchyView;
  /** Off when the card is already shown full screen, in a dialog. */
  expandable?: boolean;
}) {
  const writes = useWritesDisabled();
  const qc = useQueryClient();
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const [view, setView] = useState<HierarchyView>(initialView);

  const peopleQ = useQuery({
    queryKey: ["company-hierarchy", accountId],
    queryFn: () => fetchCompanyPeople(accountId),
  });
  const propsQ = useQuery({
    queryKey: ["account-properties", accountId],
    queryFn: () => fetchAccountProperties(accountId),
  });
  const propertyIds = useMemo(() => (propsQ.data?.rows ?? []).map((p) => p.id), [propsQ.data]);
  const assignQ = useQuery({
    queryKey: ["account-property-contacts", accountId, propertyIds.join(",")],
    queryFn: () => fetchPropertyAssignments(propertyIds),
    enabled: propsQ.isSuccess,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["company-hierarchy", accountId] });
    void qc.invalidateQueries({ queryKey: ["account-properties", accountId] });
    void qc.invalidateQueries({ queryKey: ["account-property-contacts", accountId] });
    void qc.invalidateQueries({ queryKey: ["contacts", accountId] });
  };

  const people = useMemo(() => peopleQ.data?.rows ?? [], [peopleQ.data]);
  const properties = useMemo(() => propsQ.data?.rows ?? [], [propsQ.data]);
  const assignments = useMemo(() => assignQ.data?.rows ?? [], [assignQ.data]);
  const tree = useMemo(() => buildOrgTree(people), [people]);

  /*
   * Mark: "the layout wont wokr if there is a bunch of poeple on it, needs to
   * be a better tree."
   *
   * Three things were wrong at size. Every person was a row in one flat list,
   * so a company with two hundred people was two hundred near-identical rows
   * with nothing to collapse. The indent capped at four levels, so anything
   * deeper looked the same depth. And every row carried two open pickers,
   * which is four hundred of them, all mounted, none in use.
   *
   * So: branches fold, the indent draws a guide rather than relying on
   * padding alone, and the pickers belong to the one row being edited.
   */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const [editing, setEditing] = useState<string | null>(null);
  const flat = useMemo(() => visibleOrgNodes(tree.roots, folded), [tree, folded]);

  /* Only ever for the row being edited. Computing it for every row cost a
     cycle check against every other person, on every render. */
  const managerOptions = useMemo(
    () => (editing ? eligibleManagers(people, editing) : []),
    [people, editing],
  );

  /* Only the company's own accounts-payable contact belongs here. Somebody who
     bills for one building is that building's, and is named under it. */
  const billing = useMemo(
    () => resolveBilling({ people, covers: assignments, propertyId: null }),
    [people, assignments],
  );

  /*
    Which buildings each person may be told about — their own, plus every
    building run by anyone beneath them. The client was explicit about why this
    matters: on one fire job four people from the same company were involved,
    and the paperwork has to reach the right one. "We don't want to cause any
    harm with relationships."
  */
  const propertyLabel = useMemo(
    () => new Map(properties.map((p) => [p.id, p.name ?? p.address])),
    [properties],
  );
  const scopes = useMemo(() => {
    const allPropertyIds = properties.map((p) => p.id);
    return new Map(
      people.map((p) => [
        p.id,
        propertyScope({ people, covers: assignments, allPropertyIds, contactId: p.id }),
      ]),
    );
  }, [people, assignments, properties]);

  const setField = useMutation({
    mutationFn: async (input: {
      id: string;
      patch: { position_key?: string | null; reports_to_contact_id?: string | null };
    }) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      const { error } = await supabase.from("contacts").update(input.patch).eq("id", input.id);
      if (error) throw error;
    },
    /*
     * Shown at once (4 Nov: it used to snap back and then jump): the rows are
     * changed in the cache before the write, and put back if it is refused.
     */
    onMutate: async (input) => {
      const key = ["company-hierarchy", accountId];
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<HierarchyRead>(key);
      if (before)
        qc.setQueryData<HierarchyRead>(key, {
          ...before,
          rows: before.rows.map((r) => (r.id === input.id ? { ...r, ...input.patch } : r)),
        });
      return { before };
    },
    onSuccess: invalidate,
    // The database refuses a loop; the message it raises is the one to show.
    onError: (e, _input, ctx) => {
      if (ctx?.before) qc.setQueryData(["company-hierarchy", accountId], ctx.before);
      toastDbError(e, { action: "save the reporting line" });
    },
  });

  // A failed read must never look like a company with nobody in it.
  if (peopleQ.isError) {
    return (
      <section className="rounded-xl border bg-card">
        <RecordLoadError
          error={peopleQ.error}
          record="company hierarchy"
          table="contacts"
          id={accountId}
          onRetry={() => void peopleQ.refetch()}
        />
      </section>
    );
  }

  const notMigrated = peopleQ.data && !peopleQ.data.available;
  const chartProps = {
    accountName: accountName ?? "This company",
    people,
    properties,
    assignments,
    label: positions.label,
    // Drag-and-drop on the chart writes the same reporting line as the list's picker.
    onMove:
      writes.disabled || notMigrated
        ? undefined
        : (id: string, managerId: string | null) =>
            setField.mutate({ id, patch: { reports_to_contact_id: managerId } }),
  };

  const header = (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-4 sm:px-5",
        // In a dialog the close button sits in this corner.
        !expandable && "pr-12 sm:pr-14",
      )}
    >
      <div>
        <h2 className="text-[15px] font-semibold text-foreground">Company hierarchy</h2>
        <p className="text-[12px] text-muted-foreground">
          Who does what, and who to escalate to when they don't answer.
        </p>
      </div>
      {/*
          The panel used to be able to arrange people but not add them, so a
          company with nobody in it was a dead end that sent you off to the
          contact list and back. Adding somebody here records their position and
          their manager in the same breath, which is how the structure is
          actually known — at the moment you are told it.
        */}
      <div className="flex flex-wrap items-center gap-2">
        <HierarchyViewSwitch view={view} onChange={setView} />
        {view === "tree" && expandable && people.length > 0 && (
          <OrgChartFullScreen {...chartProps} />
        )}
        {view === "list" && flat.length > 0 && !writes.disabled && (
          <AddPersonDialog
            accountId={accountId}
            people={people}
            positions={positions}
            structureAvailable={!notMigrated}
            onAdded={invalidate}
          />
        )}
      </div>
    </div>
  );

  /*
    David, 24 Sep: "it's not going to show like a tree, like an organizational
    chart, right?... sometimes it could give clarity." The tree is a second way
    to read the same rows, so it is a switch on this card rather than a card of
    its own that could disagree with it.
  */
  if (view === "tree") {
    return (
      <section className="@container rounded-xl border bg-card">
        {header}
        {/* The people, as the client sketched them: Company, Owner/CEO,
            Regionals, Assets, Supers, with Billing to one side. */}
        <CompanyOrgChart {...chartProps} />
        {/* Then the companies around this one — parent, sisters, children. */}
        <h3 className="border-t px-4 pt-3 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-5">
          Company family
        </h3>
        <CompanyFamilyTree accountId={accountId} reach={peopleQ.data?.rows} />
      </section>
    );
  }

  return (
    <section className="@container rounded-xl border bg-card">
      {header}

      {notMigrated && (
        <p className="mx-4 mb-3 rounded-md bg-warning/15 px-3 py-2 text-[12px] sm:mx-5">
          Positions and reporting lines aren't switched on in the database yet. The people below are
          real; the structure isn't stored.
        </p>
      )}

      {tree.cycleIds.length > 0 && (
        <p className="mx-4 mb-3 rounded-md bg-destructive/15 px-3 py-2 text-[12px] text-destructive sm:mx-5">
          {tree.cycleIds.length} reporting{" "}
          {tree.cycleIds.length === 1 ? "line loops" : "lines loop"} back on{" "}
          {tree.cycleIds.length === 1 ? "itself" : "themselves"} and{" "}
          {tree.cycleIds.length === 1 ? "is" : "are"} shown at the top level. Re-pick their manager
          to fix it.
        </p>
      )}

      {peopleQ.isLoading ? (
        <p className="px-4 pb-4 text-[13px] text-muted-foreground sm:px-5">Loading people…</p>
      ) : flat.length === 0 ? (
        /*
          A brand-new company lands here, so this is an invitation rather than a
          statement that there is nothing. It names the shape the client
          described — top, region, building — because that is the order the
          structure is usually recited in.
        */
        <div className="px-4 pb-4 sm:px-5">
          <p className="text-[13px] text-muted-foreground">
            Nobody recorded here yet. Start with whoever you deal with — the owner or CEO, the
            corporate contact — then the regional over a group of buildings, then the super who runs
            each one.
            {notMigrated
              ? " Positions and reporting lines can't be stored yet, so the people you add will list flat for now."
              : " Each person you add can point at the one they answer to, so the escalation path is there the first time a job comes in."}
          </p>
          {!writes.disabled && (
            <AddPersonDialog
              accountId={accountId}
              people={people}
              positions={positions}
              structureAvailable={!notMigrated}
              onAdded={invalidate}
              className="mt-3"
              label="Add the first person"
            />
          )}
        </div>
      ) : (
        <ul className="divide-y border-t">
          {flat.map((node) => {
            const c = node.contact;
            const kids = descendantCount(node);
            const isFolded = folded.has(c.id);
            const isEditing = editing === c.id;
            const pad = `${BASE_PAD + Math.min(node.depth, MAX_GUIDES) * STEP}px`;
            return (
              <li key={c.id} className="relative py-2.5 pr-4 sm:pr-5" style={{ paddingLeft: pad }}>
                {/* One rule per level the row sits under, so depth is legible
                    past the point where indenting alone stops being. */}
                {Array.from({ length: Math.min(node.depth, MAX_GUIDES) }, (_, i) => (
                  <span
                    key={i}
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-border"
                    style={{ left: `${BASE_PAD + i * STEP + 7}px` }}
                  />
                ))}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {kids > 0 ? (
                    <button
                      type="button"
                      onClick={() => toggleFold(c.id)}
                      aria-expanded={!isFolded}
                      aria-label={
                        isFolded
                          ? `Show the ${kids} under ${c.full_name}`
                          : `Hide the ${kids} under ${c.full_name}`
                      }
                      className="-ml-1 flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground hover:bg-hover hover:text-foreground"
                    >
                      {isFolded ? (
                        <ChevronRight className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                      <span className="text-[10px] font-semibold tabular-nums">{kids}</span>
                    </button>
                  ) : (
                    node.depth > 0 && (
                      <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                    )
                  )}
                  <span className="text-[14px] font-semibold text-foreground">{c.full_name}</span>
                  {c.position_key ? (
                    <Badge variant="secondary" className="text-[11px]">
                      {positions.label(c.position_key)}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[11px] text-muted-foreground">
                      Position not set
                    </Badge>
                  )}
                  {node.detached && (
                    <Badge variant="outline" className="text-[11px]">
                      Manager not visible here
                    </Badge>
                  )}
                  {node.inCycle && (
                    <Badge variant="destructive" className="text-[11px]">
                      Looping reporting line
                    </Badge>
                  )}
                </div>
                {c.title && (
                  <p className="mt-0.5 break-words text-[12px] text-muted-foreground">{c.title}</p>
                )}
                <ContactLinks contact={c} />
                {properties.length > 0 && (
                  <VisibilityLine scope={scopes.get(c.id)} label={propertyLabel} />
                )}

                {!notMigrated && !writes.disabled && !isEditing && (
                  <button
                    type="button"
                    onClick={() => setEditing(c.id)}
                    className="mt-1.5 inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3" />
                    Position and reporting line
                  </button>
                )}

                {!notMigrated && !writes.disabled && isEditing && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Select
                      value={c.position_key ?? NONE}
                      onValueChange={(v) =>
                        setField.mutate({
                          id: c.id,
                          patch: { position_key: v === NONE ? null : v },
                        })
                      }
                    >
                      <SelectTrigger className="h-8 w-full text-[12px] @sm:w-[200px]">
                        <SelectValue placeholder="Position" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>No position</SelectItem>
                        {positions.options.map((o) => (
                          <SelectItem key={o.key} value={o.key}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Select
                      value={c.reports_to_contact_id ?? NONE}
                      onValueChange={(v) =>
                        setField.mutate({
                          id: c.id,
                          patch: { reports_to_contact_id: v === NONE ? null : v },
                        })
                      }
                    >
                      <SelectTrigger className="h-8 w-full text-[12px] @sm:w-[220px]">
                        <SelectValue placeholder="Reports to" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Reports to nobody (top)</SelectItem>
                        {managerOptions.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.full_name}
                            {m.position_key ? ` · ${positions.label(m.position_key)}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-[12px]"
                      onClick={() => setEditing(null)}
                    >
                      Done
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {billing.contacts.length > 0 && (
        <div className="border-t px-4 py-3 sm:px-5">
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            Company accounts payable
          </p>
          {/*
            Named here because Billing sits off the reporting tree in the shape
            the client drew. It is who you RING about a payment — the company an
            invoice is addressed to is still jobs.bill_to_account_id.
          */}
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Covers every building that doesn't bill its own. Doesn't change who the invoice is
            addressed to.
          </p>
          {billing.contacts.map((b) => (
            <div key={b.id} className="mt-2">
              <span className="text-[13px] font-medium">{b.full_name}</span>
              <ContactLinks contact={b} />
            </div>
          ))}
        </div>
      )}

      <PropertiesBlock
        accountId={accountId}
        people={people}
        positions={positions.options}
        positionsLabel={positions.label}
        properties={properties}
        propertiesAvailable={propsQ.data?.available ?? true}
        propertiesError={propsQ.isError ? propsQ.error : null}
        onRetryProperties={() => void propsQ.refetch()}
        assignments={assignments}
        assignmentsError={assignQ.isError ? assignQ.error : null}
        disabled={!!notMigrated || writes.disabled}
        onChanged={invalidate}
      />
    </section>
  );
}

function ContactLinks({ contact }: { contact: HierarchyContact }) {
  if (!contact.phone && !contact.email) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
      {contact.phone && (
        <a
          href={`tel:${contact.phone}`}
          className="flex items-center gap-1.5 text-link underline underline-offset-2"
        >
          <Phone className="size-3" />
          {contact.phone}
        </a>
      )}
      {contact.email && (
        <a
          href={`mailto:${contact.email}`}
          className="flex min-w-0 items-center gap-1.5 text-link underline underline-offset-2"
        >
          <Mail className="size-3 shrink-0" />
          <span className="truncate">{contact.email}</span>
        </a>
      )}
    </div>
  );
}

/**
 * Add somebody to the company and place them in it at the same time.
 *
 * Deliberately shorter than the full contact form on the account page: name,
 * where they sit, and who they answer to, plus a phone and an email because
 * that is what gets written on a pad at a trade show. Everything else — the
 * birthday, the gift policy, the decision role — is filled in later on the
 * contact itself, and asking for it here would stop the structure being
 * captured at all.
 */
function AddPersonDialog({
  accountId,
  people,
  positions,
  structureAvailable,
  onAdded,
  className,
  label = "Add person",
}: {
  accountId: string;
  people: HierarchyContact[];
  positions: ManagedOptions;
  /** False before the hierarchy migration lands: name them, don't promise structure. */
  structureAvailable: boolean;
  onAdded: () => void;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState("");
  const [position, setPosition] = useState(NONE);
  const [reportsTo, setReportsTo] = useState(NONE);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const reset = () => {
    setFullName("");
    setTitle("");
    setPosition(NONE);
    setReportsTo(NONE);
    setEmail("");
    setPhone("");
  };

  /* A person who does not yet exist cannot be their own manager, so every
     colleague is eligible — ordered most senior first, the same order the
     manager picker on an existing row uses. */
  const managers = useMemo(() => eligibleManagers(people, ""), [people]);

  const create = useMutation({
    mutationFn: async () => {
      const name = fullName.trim();
      if (name.length < 2) throw new Error("A name is required.");
      const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
      const base = {
        account_id: accountId,
        location_id: await resolveContactLocationId(accountId),
        full_name: name,
        title: title.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        created_by: userId,
      };
      // Position and reporting line ship ahead of their migration. Losing the
      // structure is survivable; losing the person because of a column that
      // isn't there yet is not, so retry without them.
      let res = await supabase.from("contacts").insert({
        ...base,
        position_key: position === NONE ? null : position,
        reports_to_contact_id: reportsTo === NONE ? null : reportsTo,
      });
      if (res.error && isMissingSchema(res.error)) {
        res = await supabase.from("contacts").insert(base);
      }
      if (res.error) throw res.error;
    },
    onSuccess: () => {
      toast.success(`${fullName.trim()} added`);
      reset();
      setOpen(false);
      onAdded();
    },
    onError: (e) => toastDbError(e, { action: "add that person" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className={className}>
          <UserPlus className="mr-1.5 size-3.5" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add someone at this company</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="hierarchy-person-name">Full name</Label>
            <Input
              id="hierarchy-person-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Dana Whitfield"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hierarchy-person-title">Title (optional)</Label>
            <Input
              id="hierarchy-person-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What their card says"
              className="h-11"
            />
          </div>

          {structureAvailable ? (
            <>
              {/* Position, not title: the box they occupy in their own company,
                  which is what a job's escalation path is ordered by. */}
              <div className="space-y-1.5">
                <Label>Position in their company</Label>
                <Select value={position} onValueChange={setPosition}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Position" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not sure yet</SelectItem>
                    {positions.options.map((o) => (
                      <SelectItem key={o.key} value={o.key}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Reports to</Label>
                <Select value={reportsTo} onValueChange={setReportsTo}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Reports to" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Nobody here / top of the company</SelectItem>
                    {managers.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.full_name}
                        {m.position_key ? ` · ${positions.label(m.position_key)}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {managers.length === 0
                    ? "First person in, so there is nobody above them yet. Add their manager next and come back to point this at them."
                    : "Who you'd ring when this person doesn't answer."}
                </p>
              </div>
            </>
          ) : (
            <p className="rounded-md bg-warning/15 px-3 py-2 text-[12px]">
              Positions and reporting lines aren't switched on in the database yet, so only the
              person is saved. Come back and place them once they are.
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hierarchy-person-phone">Phone</Label>
              <Input
                id="hierarchy-person-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hierarchy-person-email">Email</Label>
              <Input
                id="hierarchy-person-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || fullName.trim().length < 2}
          >
            {create.isPending ? "Saving…" : "Add person"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What this person is entitled to know about — the line the office reads
 * before deciding who to send a report or an invoice to.
 *
 * Said in buildings, not in permissions language, because the person reading
 * it is checking a name against a building, not administering a system.
 */
function VisibilityLine({
  scope,
  label,
}: {
  scope: PropertyScope | undefined;
  label: Map<string, string>;
}) {
  if (!scope) return null;

  if (scope.companyWide) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        <Eye className="mr-1 inline size-3" />
        Every building — accounts payable for the company.
      </p>
    );
  }
  if (scope.propertyIds.length === 0) {
    return (
      <p className="mt-1 text-[11px] text-muted-foreground">
        <Eye className="mr-1 inline size-3" />
        No building yet. Assign one below before sending them site paperwork.
      </p>
    );
  }

  const own = new Set(scope.ownIds);
  const names = scope.propertyIds.map((id) => label.get(id) ?? "a building");
  return (
    <p className="mt-1 break-words text-[11px] text-muted-foreground">
      <Eye className="mr-1 inline size-3" />
      {scope.reason === "assigned" && scope.propertyIds.length > own.size
        ? "Runs and oversees: "
        : scope.reason === "assigned"
          ? "Runs: "
          : scope.reason === "through_manager"
            ? /* Borrowed, not assigned: say so, so nobody reads it as a
                 record somebody made. Assign them a building of their own and
                 this stops being inherited. */
              "Covers, through the manager above them: "
            : "Oversees, through the people under them: "}
      {names.join(", ")}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Buildings                                                           */
/* ------------------------------------------------------------------ */

function PropertiesBlock({
  accountId,
  people,
  positions,
  positionsLabel,
  properties,
  propertiesAvailable,
  propertiesError,
  onRetryProperties,
  assignments,
  assignmentsError,
  disabled,
  onChanged,
}: {
  accountId: string;
  people: HierarchyContact[];
  positions: { key: string; label: string }[];
  positionsLabel: (key: string | null | undefined) => string;
  properties: { id: string; name: string | null; address: string }[];
  propertiesAvailable: boolean;
  propertiesError: unknown;
  onRetryProperties: () => void;
  assignments: {
    id: string;
    property_id: string;
    contact_id: string;
    position_key: string | null;
  }[];
  assignmentsError: unknown;
  disabled: boolean;
  onChanged: () => void;
}) {
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const removeAssignment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("account_property_contacts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e) => toastDbError(e, { action: "remove that person from the building" }),
  });

  /* What they do AT THIS BUILDING, which need not be what they do company-wide:
     a Regional can be the acting super at one site, and this is also how a
     building gets its own accounts-payable contact instead of the company's. */
  const setCoverPosition = useMutation({
    mutationFn: async (input: { id: string; positionKey: string | null }) => {
      const { error } = await supabase
        .from("account_property_contacts")
        .update({ position_key: input.positionKey })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e) => toastDbError(e, { action: "set their role at this building" }),
  });

  if (propertiesError) {
    return (
      <div className="border-t">
        <RecordLoadError
          error={propertiesError}
          record="property list"
          table="account_properties"
          id={accountId}
          onRetry={onRetryProperties}
          compact
        />
      </div>
    );
  }

  return (
    <div className="border-t px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            Buildings they manage
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            A job at one of these addresses shows its super and the manager above them. Give
            somebody the Billing role here and this building bills its own, rather than through the
            company's accounts payable.
          </p>
        </div>
        {!disabled && propertiesAvailable && (
          <NewPropertyDialog accountId={accountId} onCreated={onChanged} />
        )}
      </div>

      {!propertiesAvailable ? (
        <p className="mt-2 rounded-md bg-warning/15 px-3 py-2 text-[12px]">
          Buildings aren't switched on in the database yet.
        </p>
      ) : properties.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">No buildings recorded yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {properties.map((p) => {
            const covering = assignments
              .filter((a) => a.property_id === p.id)
              .flatMap((a) => {
                const c = byId.get(a.contact_id);
                return c ? [{ ...a, contact: c }] : [];
              })
              .sort(
                (a, b) =>
                  positionRank(a.position_key ?? a.contact.position_key) -
                  positionRank(b.position_key ?? b.contact.position_key),
              );
            return (
              <li key={p.id} className="rounded-lg border p-2.5">
                <div className="flex items-start gap-2">
                  <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    {p.name && <p className="text-[13px] font-semibold">{p.name}</p>}
                    <p className="break-words text-[12px] text-muted-foreground">{p.address}</p>
                  </div>
                </div>
                {assignmentsError ? (
                  <p className="mt-1.5 text-[12px] text-destructive">
                    Couldn't read who covers this building — don't treat it as unassigned.
                  </p>
                ) : covering.length === 0 ? (
                  <p className="mt-1.5 text-[12px] text-muted-foreground">Nobody assigned yet.</p>
                ) : (
                  <ul className="mt-1.5 space-y-1">
                    {covering.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                        <span className="text-[12px] font-medium">{a.contact.full_name}</span>
                        {disabled ? (
                          <Badge variant="outline" className="text-[11px]">
                            {positionsLabel(a.position_key ?? a.contact.position_key)}
                          </Badge>
                        ) : (
                          <Select
                            value={a.position_key ?? NONE}
                            onValueChange={(v) =>
                              setCoverPosition.mutate({
                                id: a.id,
                                positionKey: v === NONE ? null : v,
                              })
                            }
                          >
                            <SelectTrigger
                              className="h-7 w-full text-[11px] @sm:w-[190px]"
                              aria-label={`Role of ${a.contact.full_name} at ${p.address}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>
                                {a.contact.position_key
                                  ? `${positionsLabel(a.contact.position_key)} (company role)`
                                  : "Same as their company role"}
                              </SelectItem>
                              {positions.map((o) => (
                                <SelectItem key={o.key} value={o.key}>
                                  {o.label} here
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        {!disabled && (
                          <button
                            type="button"
                            aria-label={`Remove ${a.contact.full_name} from ${p.address}`}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => removeAssignment.mutate(a.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!disabled && (
                  <AssignContact
                    propertyId={p.id}
                    people={people}
                    taken={covering.map((a) => a.contact_id)}
                    onAssigned={onChanged}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AssignContact({
  propertyId,
  people,
  taken,
  onAssigned,
}: {
  propertyId: string;
  people: HierarchyContact[];
  taken: string[];
  onAssigned: () => void;
}) {
  const available = people.filter((p) => !taken.includes(p.id));
  const assign = useMutation({
    mutationFn: async (contactId: string) => {
      const { error } = await supabase
        .from("account_property_contacts")
        .insert({ property_id: propertyId, contact_id: contactId });
      if (error) throw error;
    },
    onSuccess: onAssigned,
    onError: (e) => toastDbError(e, { action: "assign that person to the building" }),
  });

  if (available.length === 0) return null;
  return (
    <Select value="" onValueChange={(v) => assign.mutate(v)}>
      <SelectTrigger className="mt-2 h-8 w-full text-[12px] @sm:w-[240px]">
        <SelectValue placeholder="Assign someone to this building" />
      </SelectTrigger>
      <SelectContent>
        {available.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.full_name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewPropertyDialog({ accountId, onCreated }: { accountId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      const key = addressKey(address);
      if (!key) throw new Error("A street address is required.");
      const { error } = await supabase.from("account_properties").insert({
        account_id: accountId,
        name: name.trim() || null,
        address: address.trim(),
        // The same fold property_notes is keyed by, so a note already left on
        // this address and this building are the same building.
        address_key: key,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Building added");
      setName("");
      setAddress("");
      setOpen(false);
      onCreated();
    },
    onError: (e) => toastDbError(e, { action: "add the building" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" className="h-8 text-[12px]">
          <Plus className="mr-1 size-3.5" /> Add building
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a building</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name (optional)</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Maple Court"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Street address</Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="12 Maple Avenue, Brooklyn NY"
            />
            <p className="text-[11px] text-muted-foreground">
              Matched against a job's address, so write it as it appears on a job.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || address.trim().length < 4}
          >
            {create.isPending ? "Saving…" : "Add building"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
