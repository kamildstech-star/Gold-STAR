import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Mail,
  Maximize2,
  Phone,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AccountMonogram } from "@/components/account-monogram";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  managerChain,
  wouldCycle,
  type AccountProperty,
  type HierarchyContact,
  type OrgNode,
  type PropertyAssignment,
} from "@/lib/company-hierarchy";
import {
  orgChartModel,
  orgTone,
  personInitials,
  type OrgTone,
  ORG_TONE_TAG,
} from "@/lib/company-org-chart";
import { cn } from "@/lib/utils";
import { ContactBuildingsChip, type ContactBuilding } from "@/components/contact-buildings-chip";
import { Link } from "@tanstack/react-router";

/**
 * The company's people as an org chart — the sketch the client drew, drawn
 * from the same rows the hierarchy list edits.
 *
 * Every card is a way in: tap it for the person's numbers, who to escalate to
 * when they do not pick up, who reports to them and the buildings they cover;
 * the phone and envelope on the card dial and write straight away. Billing sits
 * beside the company, not under it. Wide portfolios pan inside the chart's own
 * scroll box, and on a phone the chart becomes an indented list, because a
 * diagram is no use to someone standing in a flooded basement.
 */

type Label = (key: string | null | undefined) => string;

export interface OrgChartProps {
  accountName: string;
  people: HierarchyContact[];
  properties: AccountProperty[];
  assignments: PropertyAssignment[];
  label: Label;
  /**
   * 4 Nov: build the tree by hand — drag a person onto their manager, or onto
   * the company to put them at the top. Absent for people who may not edit.
   */
  onMove?: (contactId: string, managerId: string | null) => void;
}

const TONE: Record<OrgTone, { card: string; tag: string; avatar: string }> = {
  lead: {
    card: "border-primary",
    tag: "bg-accent text-accent-foreground",
    avatar: "bg-sidebar text-sidebar-accent-foreground",
  },
  region: {
    card: "border-primary/60",
    tag: ORG_TONE_TAG.region,
    avatar: "bg-primary text-primary-foreground",
  },
  asset: {
    card: "border-success",
    tag: "bg-success/10 text-success",
    avatar: "bg-success text-white",
  },
  site: {
    card: "border-info",
    tag: ORG_TONE_TAG.site,
    avatar: "bg-info text-white",
  },
  billing: {
    card: "border-dashed border-warning",
    tag: "bg-warning/10 text-warning",
    avatar: "bg-warning text-white",
  },
  plain: {
    card: "border-border",
    tag: "bg-muted text-muted-foreground",
    avatar: "bg-sidebar text-sidebar-foreground",
  },
};

/** Big portfolios start folded below the first two levels; small ones open. */
const OPEN_ALL_UP_TO = 40;

export function CompanyOrgChart(props: OrgChartProps) {
  const { accountName, people, properties, assignments, label, onMove } = props;
  const sensors = useSensors(
    // A click still opens the person; only a real drag moves them.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );
  /*
   * 4 Nov: "show the temporary attachment while dragging, and place it when
   * dropped." The card stays where it is, faded, and a copy follows the
   * pointer (the overlay below); on drop the move is shown at once — the
   * panel updates its rows before the write comes back.
   */
  const [dragId, setDragId] = useState<string | null>(null);
  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id).replace(/^p:/, ""));
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    if (!onMove || !e.over) return;
    const id = String(e.active.id).replace(/^p:/, "");
    const target = String(e.over.id);
    const manager = target === COMPANY_DROP ? null : target.replace(/^p:/, "");
    const person = people.find((p) => p.id === id);
    if (!person || manager === id) return;
    if ((person.reports_to_contact_id ?? null) === manager) return;
    if (wouldCycle(people, id, manager)) {
      const boss = people.find((p) => p.id === manager)?.full_name ?? "them";
      toast.error(`${boss} already reports to ${person.full_name} — that would make a loop.`);
      return;
    }
    onMove(id, manager);
  };
  const model = useMemo(() => orgChartModel(people), [people]);
  const [selected, setSelected] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string> | null>(null);

  const defaultFolded = useMemo(() => {
    if (people.length <= OPEN_ALL_UP_TO) return new Set<string>();
    const out = new Set<string>();
    const walk = (n: OrgNode, depth: number) => {
      if (depth >= 1 && n.children.length) out.add(n.contact.id);
      n.children.forEach((k) => walk(k, depth + 1));
    };
    model.placed.forEach((n) => walk(n, 0));
    return out;
  }, [model, people.length]);
  const fold = folded ?? defaultFolded;
  const toggle = (id: string) => {
    const next = new Set(fold);
    if (!next.delete(id)) next.add(id);
    setFolded(next);
  };

  const buildings = useMemo(() => {
    const byProp = new Map(properties.map((p) => [p.id, p]));
    const by = new Map<string, ContactBuilding[]>();
    for (const a of assignments) {
      const p = byProp.get(a.property_id);
      if (!p) continue;
      const b: ContactBuilding = {
        id: p.id,
        name: p.name,
        address: p.address,
        role: a.position_key ? label(a.position_key) : null,
      };
      by.set(a.contact_id, [...(by.get(a.contact_id) ?? []), b]);
    }
    return by;
  }, [properties, assignments, label]);

  const card = (c: HierarchyContact, extra?: { reports: number; open: boolean }) => (
    <DragDrop id={c.id} disabled={!onMove}>
      <PersonCard
        contact={c}
        label={label}
        buildings={buildings.get(c.id) ?? []}
        selected={selected === c.id}
        onSelect={() => setSelected(selected === c.id ? null : c.id)}
        fold={extra && extra.reports > 0 ? { open: extra.open, count: extra.reports } : undefined}
        onToggle={() => toggle(c.id)}
      />
    </DragDrop>
  );

  if (people.length === 0) {
    return (
      <p className="px-4 pb-4 text-[13px] text-muted-foreground sm:px-5">
        Nobody is on this company yet. Add people in the list view and give them a position and a
        manager; the chart draws itself from that.
      </p>
    );
  }

  const company = (
    <CompanyDrop disabled={!onMove}>
      <div className="flex w-full items-center gap-2.5 rounded-xl border border-sidebar bg-sidebar p-3 @min-[640px]:w-64 text-sidebar-foreground shadow-[var(--card-shadow)]">
        <AccountMonogram
          name={accountName}
          className="size-9 rounded-lg bg-sidebar-accent text-[12px]"
        />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-bold text-white" title={accountName}>
            {accountName}
          </p>
          <p className="text-[11.5px]">
            {people.length} {people.length === 1 ? "person" : "people"} · {properties.length}{" "}
            {properties.length === 1 ? "building" : "buildings"}
          </p>
        </div>
      </div>
    </CompanyDrop>
  );

  const detail = selected ? (
    <PersonDetail
      person={people.find((p) => p.id === selected) ?? null}
      people={people}
      buildings={buildings.get(selected) ?? []}
      label={label}
      onSelect={setSelected}
      onClose={() => setSelected(null)}
    />
  ) : null;

  return (
    /*
      The chart or the list is decided by the width THIS card gets, not the
      screen: on the full record the card sits in a ~320px side column of a
      desktop page, where a chart is a sideways scrollbar. Under 640px of card
      it is the indented list; with room, the chart. Both are in the markup
      and CSS shows one, so nothing has to measure.
    */
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
    >
      <div className="@container space-y-3">
        {onMove && (
          <p className="px-4 text-[12px] text-muted-foreground sm:px-5" data-org-drag-hint>
            Drag a person onto their manager to place them under that person — or onto the company
            to put them at the top.
          </p>
        )}
        <div data-org-list className="space-y-3 px-3 pb-3 @min-[640px]:hidden">
          {company}
          {model.billing.length > 0 && (
            <div className="space-y-1.5">
              {model.billing.map((b) => (
                <div key={b.id}>{card(b)}</div>
              ))}
            </div>
          )}
          <ul className="space-y-1.5">
            {model.placed.map((n) => (
              <ListNode key={n.contact.id} node={n} fold={fold} card={card} />
            ))}
          </ul>
          {detail}
        </div>
        <div className="hidden @min-[640px]:block">
          <div className="flex flex-col gap-3 @min-[960px]:flex-row @min-[960px]:items-start">
            <div className="min-w-0 flex-1 overflow-x-auto px-4 pb-3 sm:px-5" data-org-chart>
              <div className="org-tree mx-auto w-max min-w-full">
                <ul>
                  <li>
                    <div className="flex items-center">
                      {model.billing.length > 0 && (
                        <span aria-hidden className="w-[16.5rem] shrink-0" />
                      )}
                      {company}
                      {model.billing.length > 0 && (
                        <>
                          <span
                            aria-hidden
                            className="w-6 border-t-2 border-dashed border-warning/60"
                          />
                          <div className="w-60 space-y-1.5">
                            {model.billing.map((b) => (
                              <div key={b.id}>{card(b)}</div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    {model.placed.length > 0 && (
                      <ul>
                        {model.placed.map((n) => (
                          <ChartNode key={n.contact.id} node={n} fold={fold} card={card} />
                        ))}
                      </ul>
                    )}
                  </li>
                </ul>
              </div>
            </div>
            {detail && (
              <div className="px-4 pb-3 sm:px-5 @min-[960px]:w-80 @min-[960px]:shrink-0 @min-[960px]:pl-0">
                {detail}
              </div>
            )}
          </div>
        </div>

        {model.unplaced.length > 0 && (
          <div className="mx-4 mb-4 rounded-lg border border-dashed px-3 py-2.5 sm:mx-5">
            <p className="text-[12px] font-semibold text-foreground">
              Not placed yet · {model.unplaced.length}
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              No position or manager.{" "}
              {onMove
                ? "Drag one onto their manager or the company to place them."
                : "Set them in the list view to put them on the chart."}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {model.unplaced.map((p) => (
                <DragDrop key={p.id} id={p.id} disabled={!onMove} inline>
                  <button
                    type="button"
                    onClick={() => setSelected(p.id)}
                    className={cn(
                      "inline-flex min-h-8 items-center gap-1.5 rounded-full border bg-card px-2.5 text-[12px] hover:bg-hover",
                      selected === p.id && "border-primary",
                    )}
                  >
                    {onMove && (
                      <GripVertical className="size-3 text-muted-foreground" aria-hidden />
                    )}
                    {p.full_name}
                  </button>
                </DragDrop>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* The copy that follows the pointer; the card itself never moves. */}
      <DragOverlay dropAnimation={null}>
        {dragId
          ? (() => {
              const c = people.find((p) => p.id === dragId);
              if (!c) return null;
              return (
                <div className="w-56 rotate-1 cursor-grabbing shadow-2xl" data-org-drag-overlay>
                  <PersonCard
                    contact={c}
                    label={label}
                    buildings={buildings.get(c.id) ?? []}
                    selected={false}
                    onSelect={() => {}}
                    onToggle={() => {}}
                  />
                </div>
              );
            })()
          : null}
      </DragOverlay>
    </DndContext>
  );
}

const COMPANY_DROP = "company";

/** A card you can pick up and that others can be dropped on. */
function DragDrop({
  id,
  disabled,
  inline = false,
  children,
}: {
  id: string;
  disabled: boolean;
  inline?: boolean;
  children: ReactNode;
}) {
  const drag = useDraggable({ id: `p:${id}`, disabled });
  const drop = useDroppable({ id: `p:${id}`, disabled });
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...(disabled ? {} : drag.listeners)}
      {...(disabled ? {} : drag.attributes)}
      data-org-drag={id}
      className={cn(
        inline ? "inline-flex" : "relative",
        !disabled && "cursor-grab touch-none active:cursor-grabbing",
        // Left in its place, faded, while the copy is carried.
        drag.isDragging && "opacity-40",
        drop.isOver && !drag.isDragging && "rounded-xl ring-2 ring-primary ring-offset-2",
      )}
    >
      {children}
    </div>
  );
}

/** The company box: drop someone here to put them at the top of the chart. */
function CompanyDrop({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const drop = useDroppable({ id: COMPANY_DROP, disabled });
  return (
    <div
      ref={drop.setNodeRef}
      className={cn(drop.isOver && "rounded-xl ring-2 ring-primary ring-offset-2")}
    >
      {children}
    </div>
  );
}

type CardFn = (c: HierarchyContact, extra?: { reports: number; open: boolean }) => ReactNode;

function ChartNode({
  node,
  fold,
  card,
}: {
  node: OrgNode;
  fold: ReadonlySet<string>;
  card: CardFn;
}) {
  const open = !fold.has(node.contact.id);
  return (
    <li>
      {card(node.contact, { reports: node.children.length, open })}
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((k) => (
            <ChartNode key={k.contact.id} node={k} fold={fold} card={card} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ListNode({
  node,
  fold,
  card,
}: {
  node: OrgNode;
  fold: ReadonlySet<string>;
  card: CardFn;
}) {
  const open = !fold.has(node.contact.id);
  return (
    <li>
      {card(node.contact, { reports: node.children.length, open })}
      {open && node.children.length > 0 && (
        <ul className="ml-4 mt-1.5 space-y-1.5 border-l-2 pl-3">
          {node.children.map((k) => (
            <ListNode key={k.contact.id} node={k} fold={fold} card={card} />
          ))}
        </ul>
      )}
    </li>
  );
}

function PersonCard({
  contact,
  label,
  buildings,
  selected,
  onSelect,
  fold,
  onToggle,
}: {
  contact: HierarchyContact;
  label: Label;
  buildings: ContactBuilding[];
  selected: boolean;
  onSelect: () => void;
  fold?: { open: boolean; count: number };
  onToggle: () => void;
}) {
  const tone = TONE[orgTone(contact.position_key)];
  return (
    <div
      data-org-person={contact.id}
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-xl border-[1.5px] bg-card text-left shadow-[var(--card-shadow)] @min-[640px]:w-56",
        tone.card,
        selected && "ring-2 ring-primary/40",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-h-14 items-center gap-2.5 px-3 py-2 text-left hover:bg-hover"
      >
        <span
          aria-hidden
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
            tone.avatar,
          )}
        >
          {personInitials(contact.full_name)}
        </span>
        <span className="min-w-0 flex-1">
          {contact.position_key && (
            <span
              className={cn(
                "mb-0.5 inline-block rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
                tone.tag,
              )}
            >
              {label(contact.position_key)}
            </span>
          )}
          <span className="block truncate text-[13.5px] font-bold text-foreground">
            {contact.full_name}
          </span>
          {contact.title && (
            <span className="block truncate text-[11.5px] text-muted-foreground">
              {contact.title}
            </span>
          )}
        </span>
      </button>
      <div className="flex items-center gap-0.5 border-t px-1.5 py-1">
        {contact.phone ? (
          <a
            href={`tel:${contact.phone}`}
            aria-label={`Call ${contact.full_name}`}
            title={contact.phone}
            className="flex size-8 items-center justify-center rounded-md text-link hover:bg-hover"
          >
            <Phone className="size-3.5" />
          </a>
        ) : null}
        {contact.email ? (
          <a
            href={`mailto:${contact.email}`}
            aria-label={`Email ${contact.full_name}`}
            title={contact.email}
            className="flex size-8 items-center justify-center rounded-md text-link hover:bg-hover"
          >
            <Mail className="size-3.5" />
          </a>
        ) : null}
        {/* 5 Nov: the count opens the buildings; each goes to its page. */}
        <ContactBuildingsChip name={contact.full_name} buildings={buildings} />
        {fold && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={fold.open}
            aria-label={
              fold.open
                ? `Hide who reports to ${contact.full_name}`
                : `Show who reports to ${contact.full_name}`
            }
            className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            {fold.count}
            {fold.open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function PersonDetail({
  person,
  people,
  buildings,
  label,
  onSelect,
  onClose,
}: {
  person: HierarchyContact | null;
  people: HierarchyContact[];
  buildings: ContactBuilding[];
  label: Label;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  if (!person) return null;
  const chain = managerChain(people, person.id);
  const reports = people.filter((p) => p.reports_to_contact_id === person.id);
  const tone = TONE[orgTone(person.position_key)];
  return (
    <aside
      aria-label={`${person.full_name} details`}
      data-org-detail
      className="rounded-xl border bg-card shadow-[var(--card-shadow)]"
    >
      <div className="flex items-start gap-3 border-b p-4">
        <span
          aria-hidden
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold",
            tone.avatar,
          )}
        >
          {personInitials(person.full_name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {person.position_key ? label(person.position_key) : "No position yet"}
          </p>
          <p className="truncate text-[17px] font-bold">{person.full_name}</p>
          {person.title && (
            <p className="truncate text-[12.5px] text-muted-foreground">{person.title}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 border-b p-3">
        <Button
          asChild={!!person.phone}
          variant="outline"
          disabled={!person.phone}
          className="h-10"
        >
          {person.phone ? (
            <a href={`tel:${person.phone}`}>
              <Phone className="size-4" /> Call
            </a>
          ) : (
            <span>
              <Phone className="size-4" /> No phone
            </span>
          )}
        </Button>
        <Button
          asChild={!!person.email}
          variant="outline"
          disabled={!person.email}
          className="h-10"
        >
          {person.email ? (
            <a href={`mailto:${person.email}`}>
              <Mail className="size-4" /> Email
            </a>
          ) : (
            <span>
              <Mail className="size-4" /> No email
            </span>
          )}
        </Button>
      </div>

      <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b px-4 py-3 text-[13px]">
        <dt className="text-muted-foreground">Phone</dt>
        <dd className="truncate">{person.phone ?? "Not on file"}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd className="truncate">{person.email ?? "Not on file"}</dd>
      </dl>

      {chain.length > 0 && (
        <PeopleList
          title="If they don't pick up, escalate to"
          people={chain}
          numbered
          label={label}
          onSelect={onSelect}
        />
      )}
      {reports.length > 0 && (
        <PeopleList title="Reports to them" people={reports} label={label} onSelect={onSelect} />
      )}

      <div className="px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Buildings covered
        </p>
        {buildings.length ? (
          <ul className="mt-1.5 space-y-1">
            {buildings.map((b) => (
              <li key={b.id}>
                <Link
                  to="/buildings/$id"
                  params={{ id: b.id }}
                  className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[12.5px] hover:bg-hover"
                >
                  <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{b.name || b.address}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[12.5px] text-muted-foreground">No buildings assigned.</p>
        )}
      </div>
    </aside>
  );
}

function PeopleList({
  title,
  people,
  numbered,
  label,
  onSelect,
}: {
  title: string;
  people: HierarchyContact[];
  numbered?: boolean;
  label: Label;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="border-b px-2 py-2.5">
      <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <ol className="mt-1">
        {people.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-hover"
            >
              {numbered && (
                <span className="w-4 text-[12px] tabular-nums text-muted-foreground">{i + 1}</span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold">{p.full_name}</span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {p.position_key ? label(p.position_key) : (p.title ?? "Contact")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The chart at full width. The hierarchy card lives in a narrow column of the
 * full record, which is fine for the list and cramped for a chart; this opens
 * the same chart across the screen.
 */
export function OrgChartFullScreen(props: OrgChartProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-[12px]"
        onClick={() => setOpen(true)}
      >
        <Maximize2 className="size-3.5" />
        Full screen
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-[min(96vw,1440px)] max-w-none overflow-y-auto p-0 sm:max-w-none">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>Company hierarchy · {props.accountName}</DialogTitle>
          </DialogHeader>
          <div className="pt-4">{open && <CompanyOrgChart {...props} />}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
