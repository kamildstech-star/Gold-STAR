import { createContext, useContext, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Mail,
  Network,
  Pencil,
  Phone,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AccountMonogram } from "@/components/account-monogram";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { useWritesDisabled } from "@/components/app-context";
import { RecordLoadError } from "@/components/record-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CONTACT_POSITION_OPTIONS } from "@/lib/company-hierarchy";
import type { HierarchyContact, OrgNode } from "@/lib/company-hierarchy";
import {
  fetchCompanyFamily,
  pathTo,
  setParentCompany,
  wouldLoop,
  type FamilyCompanyNode,
  type FamilyTree,
} from "@/lib/company-family-tree";
import { toastDbError } from "@/lib/db-errors";
import { useManagedOptions } from "@/lib/managed-options";
import { cn } from "@/lib/utils";
import { assertWritesEnabled } from "@/lib/write-guard";

/**
 * The family tree view of a company: parent company, child companies, and the
 * key people in each — the org chart David asked after on 24 Sep ("sometimes
 * it could give clarity").
 *
 * It sits beside the list on the hierarchy card rather than replacing it. The
 * list is where positions and reporting lines are edited, and it is the one
 * that works in a flooded basement; this is the one you read to understand a
 * portfolio. On a phone the chart has no width to branch into, so it becomes
 * the same tree as an indented list that opens and closes.
 */

type Labeler = (key: string) => string;

export const familyTreeQueryKey = (accountId: string) => ["company-family", accountId] as const;

/**
 * Phone and email by contact id, for this account's own people only.
 *
 * The family read never carries them (see `PEOPLE_FIELDS` in the lib), so a
 * sister company's people stay name and position. The hierarchy panel already
 * holds this account's contacts with their numbers; it hands them in, and only
 * those people get call and email links on the chart.
 */
type Reach = ReadonlyMap<string, Pick<HierarchyContact, "phone" | "email">>;
const ReachContext = createContext<Reach>(new Map());

export function CompanyFamilyTree({
  accountId,
  reach: reachRows,
}: {
  accountId: string;
  /** This account's contacts as the hierarchy panel read them. */
  reach?: readonly HierarchyContact[];
}) {
  const reach = useMemo<Reach>(
    () => new Map((reachRows ?? []).map((c) => [c.id, { phone: c.phone, email: c.email }])),
    [reachRows],
  );
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const q = useQuery({
    queryKey: familyTreeQueryKey(accountId),
    queryFn: () => fetchCompanyFamily(accountId),
  });

  /* Open by default: the path from the top down to this company, and this
     company itself, so the first thing on screen is where you are. Everything
     else starts folded — a portfolio of forty buildings drawn fully open is a
     wall, not a chart. */
  const [open, setOpen] = useState<Set<string> | null>(null);
  const defaults = useMemo(() => {
    if (!q.data) return new Set<string>();
    const path = pathTo(q.data.root, accountId) ?? [q.data.root.company.id];
    return new Set(path.map((id) => `c:${id}`));
  }, [q.data, accountId]);
  const expanded = open ?? defaults;
  const toggle = (key: string) =>
    setOpen(() => {
      const next = new Set(expanded);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  if (q.isError) {
    return (
      <RecordLoadError
        error={q.error}
        record="company family"
        table="accounts"
        id={accountId}
        onRetry={() => void q.refetch()}
      />
    );
  }
  if (q.isLoading || !q.data) {
    return (
      <p className="px-4 pb-4 text-[13px] text-muted-foreground sm:px-5">Loading the family…</p>
    );
  }

  const tree = q.data;
  const label: Labeler = (k) => positions.label(k);
  const single = tree.root.children.length === 0;

  return (
    <ReachContext.Provider value={reach}>
      <div className="@container space-y-3 border-t px-4 py-3 sm:px-5">
        <ParentCompanyLine tree={tree} accountId={accountId} />

        {/* A parent this person cannot see is simply not drawn: the chart starts
            at the highest company they can open, with no note about the rest. */}
        {tree.cycleIds.length > 0 && (
          <p className="rounded-md bg-destructive/15 px-3 py-2 text-[12px] text-destructive">
            {tree.cycleIds.length} parent {tree.cycleIds.length === 1 ? "link loops" : "links loop"}{" "}
            back on itself and {tree.cycleIds.length === 1 ? "is" : "are"} shown under the top
            company. Re-pick the parent company to fix it.
          </p>
        )}
        {tree.truncated && (
          <p className="rounded-md bg-warning/15 px-3 py-2 text-[12px]">
            This family is larger than the chart draws at once; some branches are left out.
          </p>
        )}
        {single && (
          <p className="text-[12px] text-muted-foreground">
            No parent or child companies are linked yet. Set a parent company above and this company
            appears as its branch.
          </p>
        )}

        {/*
          A family of one is this company alone — its people are on the chart
          above, so a single box here would only repeat the card's own title.
          With a family: the indented list in a narrow card, the chart where
          there is room (the card's width, not the screen's — see the people
          chart for why).
        */}
        {single ? null : (
          <>
            <ul className="-mx-1 @min-[640px]:hidden">
              <ListCompany
                node={tree.root}
                currentId={accountId}
                expanded={expanded}
                toggle={toggle}
                label={label}
              />
            </ul>
            {/* The scroll box is the chart's own, so a wide portfolio pans inside
              the card instead of widening the account page. */}
            <div className="-mx-4 hidden overflow-x-auto px-4 pb-2 sm:-mx-5 sm:px-5 @min-[640px]:block">
              <ul className="mx-auto flex w-max min-w-full justify-center">
                <ChartCompany
                  node={tree.root}
                  currentId={accountId}
                  expanded={expanded}
                  toggle={toggle}
                  label={label}
                  isFirst
                  isLast
                />
              </ul>
            </div>
          </>
        )}
      </div>
    </ReachContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Org chart (desktop)                                                 */
/* ------------------------------------------------------------------ */

function ChartCompany({
  node,
  currentId,
  expanded,
  toggle,
  label,
  isFirst,
  isLast,
}: {
  node: FamilyCompanyNode;
  currentId: string;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  label: Labeler;
  isFirst: boolean;
  isLast: boolean;
}) {
  const c = node.company;
  const key = `c:${c.id}`;
  const isOpen = expanded.has(key);
  const peopleKey = `people:${c.id}`;
  const peopleOpen = expanded.has(peopleKey);
  const hasKids = node.children.length > 0;
  const isRoot = node.depth === 0;

  return (
    <li className="relative flex flex-col items-center px-2 pt-5">
      {/* The connector into this box: a vertical drop from the sibling bar,
          and the half of that bar on each side that has a sibling. */}
      {!isRoot && (
        <>
          {!(isFirst && isLast) && (
            <span
              aria-hidden
              className={cn(
                "absolute top-0 h-px bg-border",
                isFirst ? "left-1/2 right-0" : isLast ? "left-0 right-1/2" : "inset-x-0",
              )}
            />
          )}
          <span aria-hidden className="absolute left-1/2 top-0 h-5 w-px bg-border" />
        </>
      )}

      <div
        className={cn(
          "w-64 rounded-xl border bg-card p-3 shadow-[var(--card-shadow)]",
          c.id === currentId && "border-primary ring-2 ring-primary/30",
        )}
      >
        <div className="flex items-center gap-2.5">
          <AccountMonogram name={c.name} className="size-9 rounded-lg text-[12px]" />
          <div className="min-w-0 flex-1">
            <CompanyLink node={node} currentId={currentId} />
            {c.status && (
              <p className="truncate text-[11px] capitalize text-muted-foreground">
                {c.status.replace(/_/g, " ")}
              </p>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {node.peopleCount > 0 && (
            <button
              type="button"
              onClick={() => toggle(peopleKey)}
              aria-expanded={peopleOpen}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <Users className="size-3" />
              {node.peopleCount} {node.peopleCount === 1 ? "person" : "people"}
              {peopleOpen ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
            </button>
          )}
          {hasKids && (
            <button
              type="button"
              onClick={() => toggle(key)}
              aria-expanded={isOpen}
              aria-label={
                isOpen ? `Hide the companies under ${c.name}` : `Show the companies under ${c.name}`
              }
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <Network className="size-3" />
              {node.children.length} {node.children.length === 1 ? "company" : "companies"}
              {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          )}
        </div>
        {peopleOpen && (
          <ul className="mt-2 space-y-1 border-t pt-2">
            {node.people.map((p) => (
              <ChartPerson
                key={p.contact.id}
                node={p}
                expanded={expanded}
                toggle={toggle}
                label={label}
              />
            ))}
          </ul>
        )}
      </div>

      {hasKids && isOpen && (
        <>
          <span aria-hidden className="h-5 w-px bg-border" />
          <ul className="flex">
            {node.children.map((k, i) => (
              <ChartCompany
                key={k.company.id}
                node={k}
                currentId={currentId}
                expanded={expanded}
                toggle={toggle}
                label={label}
                isFirst={i === 0}
                isLast={i === node.children.length - 1}
              />
            ))}
          </ul>
        </>
      )}
    </li>
  );
}

/* People stack inside the company box rather than branching sideways: a
   company with twelve people drawn as twelve boxes across would push its own
   child companies off the screen. */
function ChartPerson({
  node,
  expanded,
  toggle,
  label,
}: {
  node: OrgNode;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  label: Labeler;
}) {
  const p = node.contact;
  const key = `p:${p.id}`;
  const isOpen = expanded.has(key);
  return (
    <li>
      <PersonLine node={node} isOpen={isOpen} onToggle={() => toggle(key)} label={label} />
      {isOpen && node.children.length > 0 && (
        <ul className="ml-2 mt-1 space-y-1 border-l pl-2">
          {node.children.map((k) => (
            <ChartPerson
              key={k.contact.id}
              node={k}
              expanded={expanded}
              toggle={toggle}
              label={label}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Indented list (phone)                                               */
/* ------------------------------------------------------------------ */

function ListCompany({
  node,
  currentId,
  expanded,
  toggle,
  label,
}: {
  node: FamilyCompanyNode;
  currentId: string;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  label: Labeler;
}) {
  const c = node.company;
  const key = `c:${c.id}`;
  const isOpen = expanded.has(key);
  const hasBranch = node.children.length > 0 || node.peopleCount > 0;
  return (
    <li>
      <div
        className={cn(
          "flex min-h-11 items-center gap-1 rounded-md px-1",
          c.id === currentId && "bg-primary/10",
        )}
      >
        {hasBranch ? (
          <button
            type="button"
            onClick={() => toggle(key)}
            aria-expanded={isOpen}
            aria-label={isOpen ? `Fold ${c.name}` : `Open ${c.name}`}
            className="flex size-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-hover"
          >
            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <span className="size-9 shrink-0" />
        )}
        <Building2 className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <CompanyLink node={node} currentId={currentId} />
        </div>
        {(node.children.length > 0 || node.peopleCount > 0) && (
          <span className="shrink-0 pr-1 text-[11px] tabular-nums text-muted-foreground">
            {[
              node.children.length > 0 ? `${node.children.length} co.` : null,
              node.peopleCount > 0 ? `${node.peopleCount} ppl` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>
      {isOpen && (
        <ul className="ml-[1.1rem] border-l pl-2">
          {node.people.map((p) => (
            <ListPerson
              key={p.contact.id}
              node={p}
              expanded={expanded}
              toggle={toggle}
              label={label}
            />
          ))}
          {node.children.map((k) => (
            <ListCompany
              key={k.company.id}
              node={k}
              currentId={currentId}
              expanded={expanded}
              toggle={toggle}
              label={label}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ListPerson({
  node,
  expanded,
  toggle,
  label,
}: {
  node: OrgNode;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  label: Labeler;
}) {
  const key = `p:${node.contact.id}`;
  const isOpen = expanded.has(key);
  return (
    <li className="py-1">
      <PersonLine node={node} isOpen={isOpen} onToggle={() => toggle(key)} label={label} roomy />
      {isOpen && node.children.length > 0 && (
        <ul className="ml-3 border-l pl-2">
          {node.children.map((k) => (
            <ListPerson
              key={k.contact.id}
              node={k}
              expanded={expanded}
              toggle={toggle}
              label={label}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

function CompanyLink({ node, currentId }: { node: FamilyCompanyNode; currentId: string }) {
  const c = node.company;
  if (c.id === currentId) {
    return (
      <span className="block truncate text-[13px] font-semibold text-foreground" title={c.name}>
        {c.name} <span className="font-normal text-muted-foreground">(this company)</span>
      </span>
    );
  }
  return (
    <Link
      to="/accounts/$id"
      params={{ id: c.id }}
      className="block truncate text-[13px] font-semibold text-foreground hover:underline"
      title={c.name}
    >
      {c.name}
    </Link>
  );
}

function PersonLine({
  node,
  isOpen,
  onToggle,
  label,
  roomy,
}: {
  node: OrgNode;
  isOpen: boolean;
  onToggle: () => void;
  label: Labeler;
  roomy?: boolean;
}) {
  const p = node.contact;
  const reports = node.children.length;
  return (
    <div className={cn("group/person flex items-center gap-1.5", roomy && "min-h-9")}>
      {reports > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-label={
            isOpen ? `Hide who reports to ${p.full_name}` : `Show who reports to ${p.full_name}`
          }
          className={cn(
            "flex shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-hover",
            roomy ? "size-8" : "size-5",
          )}
        >
          {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : (
        <span className={cn("shrink-0", roomy ? "w-8" : "w-5")} />
      )}
      <span className="min-w-0 truncate text-[12px] font-medium" title={p.title ?? undefined}>
        {p.full_name}
      </span>
      {p.position_key && (
        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
          {label(p.position_key)}
        </Badge>
      )}
      {reports > 0 && !isOpen && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">+{reports}</span>
      )}
      <ContactLinks contact={p} roomy={roomy} />
    </div>
  );
}

/**
 * One tap to reach the person: their phone and email as links, pushed to the
 * end of the line. Nothing is drawn for a channel that is not on the record,
 * so the icons themselves say what is missing.
 */
function ContactLinks({ contact, roomy }: { contact: OrgNode["contact"]; roomy?: boolean }) {
  const known = useContext(ReachContext).get(contact.id);
  const phone = contact.phone ?? known?.phone ?? null;
  const email = contact.email ?? known?.email ?? null;
  if (!phone && !email) return null;
  const cell = cn(
    "flex shrink-0 items-center justify-center rounded text-link hover:bg-hover",
    roomy ? "size-9" : "size-6",
  );
  return (
    <span className="ml-auto flex shrink-0 items-center">
      {phone && (
        <a
          href={`tel:${phone}`}
          aria-label={`Call ${contact.full_name}`}
          title={phone}
          className={cell}
        >
          <Phone className="size-3.5" />
        </a>
      )}
      {email && (
        <a
          href={`mailto:${email}`}
          aria-label={`Email ${contact.full_name}`}
          title={email}
          className={cell}
        >
          <Mail className="size-3.5" />
        </a>
      )}
    </span>
  );
}

/**
 * Where this company sits: its parent, and the one control that changes it.
 *
 * The column has been on every account since the first migration, but nothing
 * on screen ever set it, so every family was a family of one. A chart with no
 * way to draw a line on it would be a chart of nothing.
 */
function ParentCompanyLine({ tree, accountId }: { tree: FamilyTree; accountId: string }) {
  const writes = useWritesDisabled();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<PickedAccount | null>(null);

  const self = useMemo(() => {
    const walk = (n: FamilyCompanyNode): FamilyCompanyNode | null =>
      n.company.id === accountId ? n : (n.children.map(walk).find(Boolean) ?? null);
    return walk(tree.root);
  }, [tree, accountId]);
  const parentId = self?.company.parent_account_id ?? null;
  const parentName = useMemo(() => {
    if (!parentId) return null;
    const walk = (n: FamilyCompanyNode): string | null =>
      n.company.id === parentId ? n.company.name : (n.children.map(walk).find(Boolean) ?? null);
    return walk(tree.root);
  }, [tree, parentId]);

  const save = useMutation({
    mutationFn: async (next: string | null) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      await setParentCompany(accountId, next);
    },
    onSuccess: () => {
      setEditing(false);
      setPicked(null);
      // Every family this company was, or now is, part of has to redraw.
      void qc.invalidateQueries({ queryKey: ["company-family"] });
      toast.success("Parent company saved");
    },
    onError: (e) => toastDbError(e, { action: "save the parent company" }),
  });

  const loops = picked ? wouldLoop(tree, accountId, picked.id) : false;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-muted-foreground">Parent company:</span>
      {parentId ? (
        parentName ? (
          <Link
            to="/accounts/$id"
            params={{ id: parentId }}
            className="font-medium hover:underline"
          >
            {parentName}
          </Link>
        ) : null /* a parent outside this person's access is not named or hinted at */
      ) : (
        <span className="text-muted-foreground">none — this is a top-level company</span>
      )}
      {!writes.disabled && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[12px]"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3" />
          {parentId ? "Change" : "Set"}
        </Button>
      )}
      {!writes.disabled && parentId && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-[12px] text-muted-foreground"
          disabled={save.isPending}
          onClick={() => save.mutate(null)}
        >
          <X className="size-3" />
          Remove
        </Button>
      )}

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Parent company</DialogTitle>
            <DialogDescription>
              The company this one belongs to. It appears as a branch under it in the family tree.
            </DialogDescription>
          </DialogHeader>
          <AccountPicker
            value={picked}
            onChange={setPicked}
            label="Belongs to"
            allowCreate={false}
          />
          {loops && (
            <p className="text-[12px] text-destructive">
              That company is this one or sits underneath it, so it can't also be its parent.
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              disabled={!picked || loops || save.isPending}
              onClick={() => picked && save.mutate(picked.id)}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
