import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ChevronDown,
  Info,
  Plus,
  Search,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadError } from "@/components/ui-density";
import { useAppContext } from "@/components/app-context";
import { Pager, usePaged } from "@/components/billing-costs/pager";
import { SaveBar } from "@/components/billing-costs/save-bar";
import { toastDbError } from "@/lib/db-errors";
import { isPrivileged } from "@/lib/roles";
import { cn } from "@/lib/utils";
import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_LABEL,
  CATALOG_UNIT_LABEL,
  EMPTY_DRAFT,
  UNITS_BY_CATEGORY,
  applyEdit,
  draftSize,
  draftToChanges,
  duplicateFromError,
  loadCatalog,
  loadCatalogUsage,
  pruneEdit,
  saveCatalog,
  statusOf,
  validateDraft,
  type CatalogCategory,
  type CatalogDraft,
  type CatalogEdit,
  type CatalogItem,
  type CatalogStatus,
  type CatalogUnit,
  type FieldProblem,
  type NewCatalogItem,
} from "@/lib/catalog";
import { TAB_STRIP, TAB_TRIGGER } from "@/components/ui/tabs";

/** Shared with the T&M rate codes page: a catalog save changes that book too. */
const CATALOG_KEY = ["billing-costs", "catalog"] as const;
const TM_KEY = ["tm-rate-codes"] as const;

type StatusFilter = "all" | CatalogStatus | "review";
type SortBy = "sheet" | "name" | "code";

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All statuses",
  active: "Active",
  inactive: "Inactive",
  archived: "Archived",
  review: "Unit needs review",
};

/**
 * Billing & Costs › Catalogs. The items every price and cost will hang off:
 * Labor, General Consumables, PPE and Vehicle lines. Rules in src/lib/catalog.ts.
 *
 * Edits collect in a draft and are saved together with the Save button —
 * nothing saves when a box loses focus. A sticky bar counts what is pending,
 * takes an optional note for the change log, and blocks Save while a change
 * would be refused (with the reason on the row). Warnings — a unit carried
 * over from the old sheet, say — inform and never block.
 */
export function CatalogsTab({
  category,
  onCategory,
}: {
  category: CatalogCategory;
  onCategory: (c: CatalogCategory) => void;
}) {
  const qc = useQueryClient();
  const app = useAppContext();
  const canEdit = isPrivileged(app.realRoles ?? []);
  const q = useQuery({ queryKey: CATALOG_KEY, queryFn: () => loadCatalog() });

  const [draft, setDraft] = useState<CatalogDraft>(EMPTY_DRAFT);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("sheet");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<string[] | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /** A save the server refused for a duplicate name, shown on that row. */
  const [serverClash, setServerClash] = useState<{ code: string; clash: string } | null>(null);

  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const pending = draftSize(draft);
  const problems = useMemo(
    () => validateDraft(items, draft, q.data?.tmCodes),
    [items, draft, q.data?.tmCodes],
  );
  const problemCount = [...problems.values()].reduce((n, p) => n + p.length, 0);

  /* Clear the row highlight a moment after jumping to it. */
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(
      CATALOG_CATEGORIES.map((k) => [k, { live: 0, review: 0 }]),
    ) as Record<CatalogCategory, { live: number; review: number }>;
    for (const raw of items) {
      const i = applyEdit(raw, draft.edits[raw.code]);
      if (statusOf(i) !== "archived") c[i.category].live++;
      if (i.unit_review && statusOf(i) !== "archived") c[i.category].review++;
    }
    return c;
  }, [items, draft.edits]);

  /* The category's rows as they will be after Save, filtered and sorted. */
  const view = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = items
      .filter((i) => i.category === category)
      .map((raw) => ({ raw, item: applyEdit(raw, draft.edits[raw.code]) }))
      .filter(({ item }) => {
        if (needle && !`${item.code} ${item.name}`.toLowerCase().includes(needle)) return false;
        if (status === "review") return item.unit_review !== null;
        if (status !== "all") return statusOf(item) === status;
        return true;
      });
    rows.sort((a, b) =>
      sortBy === "name"
        ? a.item.name.localeCompare(b.item.name)
        : sortBy === "code"
          ? a.item.code.localeCompare(b.item.code, undefined, { numeric: true })
          : a.item.sort_order - b.item.sort_order || a.item.code.localeCompare(b.item.code),
    );
    return {
      current: rows.filter(({ item }) => statusOf(item) !== "archived"),
      archived: rows.filter(({ item }) => statusOf(item) === "archived"),
    };
  }, [items, category, draft.edits, search, status, sortBy]);

  const creates = draft.creates.filter((c) => c.category === category);
  const filterKey = `${category}|${search}|${status}|${sortBy}`;
  const currentPage = usePaged(view.current, filterKey);
  const archivedPage = usePaged(view.archived, filterKey);

  /* After showItem clears the filters: turn to the item's page, then scroll to it. */
  const [jump, setJump] = useState<string | null>(null);
  useEffect(() => {
    if (!jump) return;
    const at = view.current.findIndex(({ raw }) => raw.code === jump);
    if (at >= 0) currentPage.showIndex(at);
    else archivedPage.showIndex(view.archived.findIndex(({ raw }) => raw.code === jump));
    const code = jump;
    setJump(null);
    window.setTimeout(
      () =>
        document
          .getElementById(`catalog-row-${code}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      50,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per jump
  }, [jump, view]);

  /* ------------------------------------------------------------ draft edits */

  function edit(code: string, patch: CatalogEdit) {
    setServerClash(null);
    setDraft((d) => {
      const raw = items.find((i) => i.code === code);
      if (!raw) return d;
      const merged = pruneEdit(raw, { ...d.edits[code], ...patch });
      const edits = { ...d.edits };
      if (merged) edits[code] = merged;
      else delete edits[code];
      return { ...d, edits };
    });
  }

  function editMany(codes: readonly string[], patch: CatalogEdit) {
    for (const code of codes) edit(code, patch);
  }

  function addRow() {
    const tempId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const only = UNITS_BY_CATEGORY[category].length === 1 ? UNITS_BY_CATEGORY[category][0]! : null;
    setDraft((d) => ({
      ...d,
      creates: [...d.creates, { tempId, category, code: "", name: "", unit: only }],
    }));
    if (status === "archived") setStatus("all");
  }

  function editNew(tempId: string, patch: Partial<NewCatalogItem>) {
    setDraft((d) => ({
      ...d,
      creates: d.creates.map((c) => (c.tempId === tempId ? { ...c, ...patch } : c)),
    }));
  }

  function dropNew(tempId: string) {
    setDraft((d) => ({ ...d, creates: d.creates.filter((c) => c.tempId !== tempId) }));
  }

  function discard() {
    setDraft(EMPTY_DRAFT);
    setNote("");
    setServerClash(null);
  }

  /** Jump to another item: its category, no filters hiding it, highlighted. */
  function showItem(code: string) {
    const target = items.find((i) => i.code === code);
    if (!target) return;
    onCategory(target.category);
    setSearch("");
    setStatus("all");
    if (statusOf(applyEdit(target, draft.edits[code])) === "archived") setArchivedOpen(true);
    setFlash(code);
    setJump(code);
  }

  async function save() {
    if (problemCount > 0 || !pending) return;
    setSaving(true);
    try {
      const changes = draftToChanges(items, draft);
      const n = await saveCatalog(changes, note);
      toast.success(`Saved ${n} change${n === 1 ? "" : "s"} to the catalog`);
      setDraft(EMPTY_DRAFT);
      setNote("");
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: CATALOG_KEY });
      void qc.invalidateQueries({ queryKey: TM_KEY });
    } catch (err) {
      const clash = duplicateFromError(err);
      const firstNamed = Object.keys(draft.edits).find((c) => draft.edits[c]?.name !== undefined);
      if (clash && firstNamed) {
        setServerClash({ code: firstNamed, clash });
        toast.error("Not saved: another item already has that name. Nothing was changed.");
      } else {
        toastDbError(err, { action: "Saving the catalog" });
      }
    } finally {
      setSaving(false);
    }
  }

  /* --------------------------------------------------------------- render */

  if (q.isError) return <LoadError what="the catalog" error={q.error} />;
  if (q.isLoading || !q.data) {
    return <p className="p-3 text-sm text-muted-foreground">Loading the catalog…</p>;
  }
  if (!q.data.fromDatabase) {
    return (
      <Card>
        <CardContent className="space-y-1 p-4 text-sm">
          <p className="font-medium">The catalog is not available yet.</p>
          <p className="text-muted-foreground">
            The database update that creates it (migration 20261029120000) has not been applied
            here. Until it is, items are kept on{" "}
            <Link to="/admin/tm-rate-codes" className="font-medium text-link hover:underline">
              T&amp;M rate codes
            </Link>
            , which works exactly as before.
          </p>
        </CardContent>
      </Card>
    );
  }

  const selectedHere = [...selected].filter((code) =>
    items.some((i) => i.code === code && i.category === category),
  );
  const rowProblems = (code: string): FieldProblem[] => {
    const list = [...(problems.get(code) ?? [])];
    if (serverClash?.code === code) {
      list.push({
        field: "name",
        message: "Another item already has this name.",
        clashCode: serverClash.clash,
      });
    }
    return list;
  };

  return (
    <TooltipProvider delayDuration={250}>
      <div className={cn("space-y-3", pending > 0 && "pb-28 md:pb-20")}>
        {/* Category sub-tabs */}
        <div
          role="tablist"
          aria-label="Catalog categories"
          className={cn(TAB_STRIP, "w-max max-w-full")}
        >
          {CATALOG_CATEGORIES.map((c) => {
            const on = c === category;
            return (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  onCategory(c);
                  setSelected(new Set());
                }}
                data-state={on ? "active" : "inactive"}
                className={TAB_TRIGGER}
              >
                {CATALOG_CATEGORY_LABEL[c]}
                <span className={cn("tabular-nums", on ? "opacity-90" : "text-muted-foreground")}>
                  {counts[c].live}
                </span>
                {counts[c].review > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        aria-label={`${counts[c].review} units to review`}
                        className={cn("inline-flex", on ? "" : "text-warning")}
                      >
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {counts[c].review} unit{counts[c].review === 1 ? "" : "s"} to review
                    </TooltipContent>
                  </Tooltip>
                )}
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${CATALOG_CATEGORY_LABEL[category]} by code or name`}
              aria-label="Search the catalog"
              className="h-11 pl-8 md:h-8"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="h-11 w-full sm:w-44 md:h-8" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_FILTER_LABEL) as StatusFilter[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_FILTER_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
            <SelectTrigger className="h-11 w-full sm:w-40 md:h-8" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sheet">Sheet order</SelectItem>
              <SelectItem value="name">Name A–Z</SelectItem>
              <SelectItem value="code">Code</SelectItem>
            </SelectContent>
          </Select>
          {canEdit && (
            <Button variant="outline" className="h-11 md:h-8" onClick={addRow}>
              <Plus aria-hidden /> Add item
            </Button>
          )}
        </div>

        {/* Bulk actions */}
        {canEdit && selectedHere.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{selectedHere.length} selected</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => editMany(selectedHere, { active: true })}
            >
              Activate
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => editMany(selectedHere, { active: false })}
            >
              Deactivate
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              onClick={() => setConfirmArchive(selectedHere)}
            >
              <Archive aria-hidden /> Archive
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => editMany(selectedHere, { archived: false })}
            >
              <ArchiveRestore aria-hidden /> Restore
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        <Card className="max-md:border-0 max-md:bg-transparent max-md:shadow-none">
          <CardContent className="p-0">
            <HeaderRow
              canEdit={canEdit}
              allChecked={
                view.current.length > 0 && view.current.every(({ item }) => selected.has(item.code))
              }
              onCheckAll={(on) =>
                setSelected((s) => {
                  const next = new Set(s);
                  for (const { item } of view.current) {
                    if (on) next.add(item.code);
                    else next.delete(item.code);
                  }
                  return next;
                })
              }
            />
            <div className="space-y-2 md:space-y-0 md:divide-y">
              {creates.map((c) => (
                <NewRow
                  key={c.tempId}
                  row={c}
                  problems={problems.get(c.tempId) ?? []}
                  onChange={(p) => editNew(c.tempId, p)}
                  onRemove={() => dropNew(c.tempId)}
                  onShow={showItem}
                />
              ))}
              {currentPage.rows.map(({ raw, item }) => (
                <ItemRow
                  key={raw.code}
                  raw={raw}
                  item={item}
                  dirty={!!draft.edits[raw.code]}
                  canEdit={canEdit}
                  checked={selected.has(raw.code)}
                  highlight={flash === raw.code}
                  problems={rowProblems(raw.code)}
                  onCheck={(on) =>
                    setSelected((s) => {
                      const next = new Set(s);
                      if (on) next.add(raw.code);
                      else next.delete(raw.code);
                      return next;
                    })
                  }
                  onEdit={(p) => edit(raw.code, p)}
                  onArchive={() => setConfirmArchive([raw.code])}
                  onShow={showItem}
                />
              ))}
              {view.current.length === 0 && creates.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {search || status !== "all"
                    ? "Nothing matches these filters."
                    : `No ${CATALOG_CATEGORY_LABEL[category]} items yet.`}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Pager
          paged={currentPage}
          noun={`${CATALOG_CATEGORY_LABEL[category]} items`}
          pending={pending}
        />

        {view.archived.length > 0 && (
          <Collapsible open={archivedOpen || status === "archived"} onOpenChange={setArchivedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-1 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform",
                    (archivedOpen || status === "archived") && "rotate-180",
                  )}
                  aria-hidden
                />
                Archived
                <Badge variant="secondary">{view.archived.length}</Badge>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Card className="max-md:border-0 max-md:bg-transparent max-md:shadow-none">
                <CardContent className="space-y-2 p-0 md:space-y-0 md:divide-y">
                  {archivedPage.rows.map(({ raw, item }) => (
                    <ItemRow
                      key={raw.code}
                      raw={raw}
                      item={item}
                      dirty={!!draft.edits[raw.code]}
                      canEdit={canEdit}
                      checked={selected.has(raw.code)}
                      highlight={flash === raw.code}
                      problems={rowProblems(raw.code)}
                      onCheck={(on) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (on) next.add(raw.code);
                          else next.delete(raw.code);
                          return next;
                        })
                      }
                      onEdit={(p) => edit(raw.code, p)}
                      onArchive={() => edit(raw.code, { archived: false })}
                      onShow={showItem}
                    />
                  ))}
                </CardContent>
              </Card>
              <Pager paged={archivedPage} noun="archived items" pending={pending} />
            </CollapsibleContent>
          </Collapsible>
        )}

        <ArchiveDialog
          codes={confirmArchive}
          items={items}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={(codes) => {
            editMany(codes, { archived: true });
            setSelected((s) => new Set([...s].filter((c) => !codes.includes(c))));
            setConfirmArchive(null);
          }}
        />

        <SaveBar
          pending={pending}
          problems={problemCount}
          note={note}
          onNote={setNote}
          saving={saving}
          onSave={() => void save()}
          onDiscard={discard}
        />
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ rows */

const ROW_GRID =
  "md:grid md:grid-cols-[1.75rem_4.5rem_minmax(0,1fr)_10rem_9rem_2.5rem] md:items-start md:gap-3 md:px-3 md:py-2";

function HeaderRow({
  canEdit,
  allChecked,
  onCheckAll,
}: {
  canEdit: boolean;
  allChecked: boolean;
  onCheckAll: (on: boolean) => void;
}) {
  return (
    <div
      className={cn(
        "hidden md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 border-b bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground",
        ROW_GRID,
      )}
    >
      <span className="pt-0.5">
        {canEdit && (
          <Checkbox
            checked={allChecked}
            onCheckedChange={(v) => onCheckAll(v === true)}
            aria-label="Select all shown"
          />
        )}
      </span>
      <span className="flex items-center gap-1">
        Code
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-3.5 w-3.5" aria-label="About codes" />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs normal-case tracking-normal">
            The code a T&amp;M sheet stores. It never changes — add a new item instead.
          </TooltipContent>
        </Tooltip>
      </span>
      <span>Name</span>
      <span>Unit</span>
      <span>Status</span>
      <span className="sr-only">Archive</span>
    </div>
  );
}

function Problems({ list, onShow }: { list: FieldProblem[]; onShow: (code: string) => void }) {
  if (!list.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {list.map((p, i) => (
        <li key={i} className="flex flex-wrap items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {p.message}
          {p.clashCode && (
            <button
              type="button"
              className="font-medium text-link underline-offset-2 hover:underline"
              onClick={() => onShow(p.clashCode!)}
            >
              Show {p.clashCode}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function UnitSelect({
  category,
  value,
  invalid,
  label,
  onChange,
}: {
  category: CatalogCategory;
  value: CatalogUnit | null;
  invalid?: boolean;
  label: string;
  onChange: (u: CatalogUnit) => void;
}) {
  return (
    <Select value={value ?? ""} onValueChange={(v) => onChange(v as CatalogUnit)}>
      <SelectTrigger
        className={cn("h-11 md:h-8", invalid && "border-destructive")}
        aria-label={label}
        aria-invalid={invalid || undefined}
      >
        <SelectValue placeholder="Choose a unit" />
      </SelectTrigger>
      <SelectContent>
        {UNITS_BY_CATEGORY[category].map((u) => (
          <SelectItem key={u} value={u}>
            {CATALOG_UNIT_LABEL[u]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ItemRow({
  raw,
  item,
  dirty,
  canEdit,
  checked,
  highlight,
  problems,
  onCheck,
  onEdit,
  onArchive,
  onShow,
}: {
  raw: CatalogItem;
  item: CatalogItem;
  dirty: boolean;
  canEdit: boolean;
  checked: boolean;
  highlight: boolean;
  problems: FieldProblem[];
  onCheck: (on: boolean) => void;
  onEdit: (p: CatalogEdit) => void;
  onArchive: () => void;
  onShow: (code: string) => void;
}) {
  const archived = statusOf(item) === "archived";
  const nameProblems = problems.filter((p) => p.field === "name");
  const unitProblems = problems.filter((p) => p.field === "unit");
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <div
      id={`catalog-row-${raw.code}`}
      data-catalog-row={raw.code}
      className={cn(
        "space-y-2 rounded-lg border p-3 md:space-y-0 md:rounded-none md:border-0",
        ROW_GRID,
        dirty && "bg-muted/50 shadow-[inset_3px_0_0_var(--gold)]",
        highlight && "ring-2 ring-inset ring-link",
        archived && "text-muted-foreground",
      )}
    >
      {/* Line 1 on a phone: select, code, status chips */}
      <div className="flex items-center gap-2 md:contents">
        <span className="md:pt-2.5">
          {canEdit && (
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => onCheck(v === true)}
              aria-label={`Select ${raw.code}`}
            />
          )}
        </span>
        <span className="font-mono text-xs tabular-nums md:pt-2.5">{raw.code}</span>
        <span className="ml-auto flex items-center gap-1 md:hidden">
          <StatusBadge item={item} dirty={dirty} />
        </span>
      </div>

      <div className="min-w-0">
        {canEdit ? (
          <>
            <Input
              ref={nameRef}
              value={item.name}
              onChange={(e) => onEdit({ name: e.target.value })}
              aria-label={`Name of ${raw.code}`}
              aria-invalid={nameProblems.length > 0 || undefined}
              className={cn("h-11 md:h-8", nameProblems.length > 0 && "border-destructive")}
            />
            <Problems list={nameProblems} onShow={onShow} />
            <Input
              value={item.note ?? ""}
              onChange={(e) => onEdit({ note: e.target.value })}
              placeholder="How it bills (optional)"
              aria-label={`How ${raw.code} bills`}
              maxLength={500}
              className="mt-1 h-9 text-xs text-muted-foreground md:h-7"
            />
          </>
        ) : (
          <>
            <p className="text-sm font-medium md:pt-2" data-catalog-name={raw.code}>
              {item.name}
            </p>
            {item.note && <p className="mt-0.5 text-xs text-muted-foreground">{item.note}</p>}
          </>
        )}
        {item.unit_review && !unitProblems.length && (
          <p className="mt-1 flex items-start gap-1 text-xs text-warning">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {item.unit_review}
              {canEdit && item.unit && (
                <button
                  type="button"
                  className="ml-1 font-medium text-link underline-offset-2 hover:underline"
                  onClick={() => onEdit({ confirmUnit: true })}
                >
                  Confirm {CATALOG_UNIT_LABEL[item.unit]}
                </button>
              )}
            </span>
          </p>
        )}
      </div>

      <div>
        {canEdit ? (
          <>
            <UnitSelect
              category={raw.category}
              value={item.unit}
              invalid={unitProblems.length > 0}
              label={`Unit of ${raw.code}`}
              onChange={(u) => onEdit({ unit: u })}
            />
            <Problems list={unitProblems} onShow={onShow} />
          </>
        ) : (
          <span className="block text-sm text-muted-foreground md:pt-2">
            {item.unit ? CATALOG_UNIT_LABEL[item.unit] : "No unit"}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 md:justify-start md:pt-1.5">
        {canEdit ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={item.active}
              disabled={archived}
              onCheckedChange={(v) => onEdit({ active: v })}
              aria-label={`${raw.code} active`}
            />
            {item.active ? "Active" : "Inactive"}
          </label>
        ) : (
          <span className="text-xs text-muted-foreground">
            {item.active ? "Active" : "Inactive"}
          </span>
        )}
        <span className="hidden md:inline-flex">
          <StatusBadge item={item} dirty={dirty} compact />
        </span>
        {canEdit && (
          <span className="md:hidden">
            <ArchiveButton archived={archived} code={raw.code} onClick={onArchive} />
          </span>
        )}
      </div>

      <div className="hidden md:block md:pt-0.5">
        {canEdit && <ArchiveButton archived={archived} code={raw.code} onClick={onArchive} />}
      </div>
    </div>
  );
}

function StatusBadge({
  item,
  dirty,
  compact,
}: {
  item: CatalogItem;
  dirty: boolean;
  compact?: boolean;
}) {
  const s = statusOf(item);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {dirty && <Badge variant="warning">Edited</Badge>}
      {s === "archived" && <Badge variant="secondary">Archived</Badge>}
      {!compact && s === "inactive" && <Badge variant="outline">Inactive</Badge>}
    </span>
  );
}

function ArchiveButton({
  archived,
  code,
  onClick,
}: {
  archived: boolean;
  code: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-11 w-11 md:h-8 md:w-8",
            !archived && "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
          )}
          onClick={onClick}
          aria-label={archived ? `Restore ${code}` : `Archive ${code}`}
        >
          {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {archived ? "Restore to the catalog" : "Archive — kept for history, never deleted"}
      </TooltipContent>
    </Tooltip>
  );
}

function NewRow({
  row,
  problems,
  onChange,
  onRemove,
  onShow,
}: {
  row: NewCatalogItem;
  problems: FieldProblem[];
  onChange: (p: Partial<NewCatalogItem>) => void;
  onRemove: () => void;
  onShow: (code: string) => void;
}) {
  const by = (f: FieldProblem["field"]) => problems.filter((p) => p.field === f);
  return (
    <div
      data-catalog-new
      className={cn(
        "space-y-2 rounded-lg border border-dashed bg-[var(--label-blue)] p-3 md:space-y-0 md:rounded-none md:border-0",
        ROW_GRID,
      )}
    >
      <span className="hidden md:block md:pt-2">
        <Badge variant="default">New</Badge>
      </span>
      <div>
        <Input
          value={row.code}
          onChange={(e) => onChange({ code: e.target.value.toUpperCase() })}
          placeholder="Code"
          aria-label="New item code"
          aria-invalid={by("code").length > 0 || undefined}
          className={cn(
            "h-11 font-mono uppercase md:h-8",
            by("code").length > 0 && "border-destructive",
          )}
        />
        <Problems list={by("code")} onShow={onShow} />
      </div>
      <div className="min-w-0">
        <Input
          value={row.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Name"
          aria-label="New item name"
          aria-invalid={by("name").length > 0 || undefined}
          className={cn("h-11 md:h-8", by("name").length > 0 && "border-destructive")}
        />
        <Problems list={by("name")} onShow={onShow} />
      </div>
      <div>
        <UnitSelect
          category={row.category}
          value={row.unit}
          invalid={by("unit").length > 0}
          label="New item unit"
          onChange={(u) => onChange({ unit: u })}
        />
        <Problems list={by("unit")} onShow={onShow} />
      </div>
      {row.category === "equipment" ? (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground md:pt-2">
          <input
            type="checkbox"
            checked={!!row.inTm}
            onChange={(e) => onChange({ inTm: e.target.checked })}
            aria-label="Also on the T&M Daily Supply List"
          />
          On the T&amp;M sheet
        </label>
      ) : (
        <p className="text-xs text-muted-foreground md:pt-2.5">Active once saved</p>
      )}
      <div className="flex justify-end md:block">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 md:h-8 md:w-8"
              onClick={onRemove}
              aria-label="Remove this new item"
            >
              <X aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove — it has not been saved</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- archive */

function ArchiveDialog({
  codes,
  items,
  onCancel,
  onConfirm,
}: {
  codes: string[] | null;
  items: readonly CatalogItem[];
  onCancel: () => void;
  onConfirm: (codes: string[]) => void;
}) {
  const usage = useQuery({
    queryKey: ["billing-costs", "catalog-usage", codes],
    enabled: !!codes?.length,
    queryFn: () => loadCatalogUsage(codes ?? []),
  });
  const named = (codes ?? [])
    .map((c) => items.find((i) => i.code === c))
    .filter(Boolean) as CatalogItem[];
  const used = named.filter((i) => (usage.data?.get(i.code) ?? 0) > 0);
  const title =
    named.length === 1
      ? `Archive ${named[0]!.code} · ${named[0]!.name}?`
      : `Archive ${named.length} items?`;

  return (
    <AlertDialog open={!!codes} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Archived items leave the crew&rsquo;s T&amp;M pickers. Nothing is deleted: sheets
                and bills that already carry them keep them, and you can restore them any time.
              </p>
              {usage.isLoading ? (
                <p className="text-muted-foreground">
                  Checking which jobs use {named.length === 1 ? "it" : "them"}…
                </p>
              ) : usage.isError ? (
                <p className="text-warning">
                  Couldn&rsquo;t count the jobs that use {named.length === 1 ? "it" : "them"}.
                </p>
              ) : used.length === 0 ? (
                <p className="text-muted-foreground">Not on any job&rsquo;s T&amp;M sheets yet.</p>
              ) : (
                <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                  {used.map((i) => {
                    const n = usage.data!.get(i.code)!;
                    return (
                      <li key={i.code} className="text-foreground">
                        <span className="font-mono text-xs">{i.code}</span> {i.name} — used on{" "}
                        <strong>
                          {n} job{n === 1 ? "" : "s"}
                        </strong>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">Takes effect when you press Save.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={() => codes && onConfirm(codes)}
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
