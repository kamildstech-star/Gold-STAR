import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  Group,
  GripVertical,
  Search,
  Settings2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ROW_NAV_CLASS, useRowNav } from "@/components/clickable-row";
import { useExportGate } from "@/lib/export-guard";
import { ExportExcelButton } from "@/components/export-excel-button";
import {
  downloadCsv,
  fetchTablePrefs,
  mergeColumnOrder,
  saveTablePrefs,
  toCsv,
  type TablePrefs,
} from "@/lib/table-prefs";

export type DataColumn<T> = {
  key: string;
  header: string;
  /** Rendered cell. Falls back to the raw value. */
  cell?: (row: T) => ReactNode;
  /** Sort / filter / group / export value. */
  value?: (row: T) => string | number | null;
  /** Leading identity column: sticky, wider, two-line. Exactly one per table. */
  identity?: boolean;
  /** Right-aligned tabular figures. */
  numeric?: boolean;
  filter?: "text" | "select" | "none";
  /** Off for columns with no meaningful order — chip clusters, action columns. */
  sortable?: boolean;
  /** Hidden until the user turns it on in the column picker. */
  defaultHidden?: boolean;
  /** Never offered — used for role-gated columns such as money. */
  hidden?: boolean;
  width?: string;
  className?: string;
};

/** Two-line identity cell: icon/thumbnail, name, muted sub-line. */
export function IdentityCell({
  icon,
  thumbnail,
  primary,
  secondary,
  accent,
}: {
  icon?: ReactNode;
  thumbnail?: string | null;
  primary: ReactNode;
  secondary?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          loading="lazy"
          className="size-7 shrink-0 rounded-md object-cover"
        />
      ) : icon ? (
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/60 text-muted-foreground"
          style={accent ? { borderColor: accent, color: accent } : undefined}
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-[16px] text-link hover:underline">
          {primary}
        </div>
        {secondary != null && (
          <div className="truncate text-[11.5px] leading-[15px] text-muted-foreground">
            {secondary}
          </div>
        )}
      </div>
    </div>
  );
}

export type DataTableProps<T> = {
  tableKey: string;
  columns: DataColumn<T>[];
  rows: T[];
  rowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Destination for whole-row navigation; keeps the row keyboard-activatable. */
  rowHref?: (row: T) => string | null | undefined;
  /** Tint the whole row — used for farming health, overdue states etc. */
  rowClassName?: (row: T) => string | undefined;
  /** Inline actions rendered in a trailing cell (log a touch, call, etc). */
  rowActions?: (row: T) => ReactNode;

  /** Extra metrics for the "More" breakdown popover, beyond the columns. */
  detailRows?: (row: T) => { label: string; value: ReactNode; sub?: ReactNode }[];
  toolbarLeft?: ReactNode;
  toolbarRight?: ReactNode;
  loading?: boolean;
  emptyMessage?: ReactNode;
  exportName?: string;
  exportEntity?: string;
  defaultSortKey?: string;
  defaultSortDir?: "asc" | "desc";
  /** Compact height for embedding; default fills the page. */
  maxHeightClass?: string;
  /** Highlighted row when a record is open in the master-detail panel. */
  selectedId?: string | null;
  /** Visible row order after sorting/filtering — drives arrow-key navigation. */
  onOrderChange?: (ids: string[]) => void;
};

export function DataTable<T>({
  tableKey,
  columns,
  rows,
  rowId,
  onRowClick,
  rowHref,
  rowClassName,
  rowActions,
  detailRows,
  toolbarLeft,
  toolbarRight,
  loading,
  emptyMessage,
  exportName,
  exportEntity,
  defaultSortKey,
  defaultSortDir = "asc",
  maxHeightClass = "max-h-[calc(100vh-230px)]",
  selectedId,
  onOrderChange,
}: DataTableProps<T>) {
  const available = useMemo(() => columns.filter((c) => !c.hidden), [columns]);
  const exportGate = useExportGate();

  const [visible, setVisible] = useState<string[]>(() =>
    available.filter((c) => !c.defaultHidden).map((c) => c.key),
  );
  const [order, setOrder] = useState<string[]>(() => available.map((c) => c.key));
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [group, setGroup] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSortDir);
  const [loadedPrefs, setLoadedPrefs] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Restore this person's saved view for this table.
  useEffect(() => {
    let cancelled = false;
    fetchTablePrefs(tableKey).then(({ ok, prefs: p }) => {
      if (cancelled) return;
      // A read that failed leaves the table on its defaults, but must never be
      // saved back over the layout it could not read.
      if (!ok || !p) {
        setLoadedPrefs(ok);
        return;
      }
      if (p.visible?.length) {
        const keys = new Set(available.map((c) => c.key));
        const saved = p.visible.filter((k) => keys.has(k));
        // Columns added since the view was saved stay visible — a saved view
        // must never hide a new column the table now ships by default.
        const savedSet = new Set(p.visible);
        const added = available
          .filter((c) => !c.defaultHidden && !savedSet.has(c.key))
          .map((c) => c.key);
        setVisible([...saved, ...added]);
      }
      setOrder(
        mergeColumnOrder(
          available.map((c) => c.key),
          p.order,
        ),
      );

      if (p.filters) setFilters(p.filters);
      if (p.group !== undefined) setGroup(p.group);
      if (p.sortKey !== undefined) setSortKey(p.sortKey);
      if (p.sortDir) setSortDir(p.sortDir);
      setLoadedPrefs(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);

  // Persist quietly after the initial restore.
  useEffect(() => {
    if (!loadedPrefs) return;
    const t = setTimeout(() => {
      const prefs: TablePrefs = { visible, order, filters, group, sortKey, sortDir };
      void saveTablePrefs(tableKey, prefs);
    }, 600);
    return () => clearTimeout(t);
  }, [loadedPrefs, visible, order, filters, group, sortKey, sortDir, tableKey]);

  /**
   * Reconciled on every render, not only on restore: the column list itself
   * can change while the screen is open — money columns appear with a
   * permission — and a stale order must not drop them.
   */
  const ordered = useMemo(() => {
    const byKey = new Map(available.map((c) => [c.key, c]));
    return mergeColumnOrder(
      available.map((c) => c.key),
      order,
    ).map((k) => byKey.get(k)!);
  }, [available, order]);

  const shown = useMemo(
    () => ordered.filter((c) => visible.includes(c.key) || c.identity),
    [ordered, visible],
  );

  const valueOf = (col: DataColumn<T>, row: T): string | number | null => {
    if (col.value) return col.value(row);
    const raw = (row as Record<string, unknown>)[col.key];
    return typeof raw === "number" || typeof raw === "string"
      ? raw
      : raw == null
        ? null
        : String(raw);
  };

  const optionsFor = (col: DataColumn<T>) => {
    const set = new Set<string>();
    for (const r of rows) {
      const v = valueOf(col, r);
      if (v != null && v !== "") set.add(String(v));
    }
    return [...set].sort().slice(0, 60);
  };

  const filtered = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v && v.trim() !== "");
    if (active.length === 0) return rows;
    return rows.filter((row) =>
      active.every(([key, term]) => {
        const col = available.find((c) => c.key === key);
        if (!col) return true;
        const v = valueOf(col, row);
        return String(v ?? "")
          .toLowerCase()
          .includes(term.toLowerCase());
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, available]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = available.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = valueOf(col, a);
      const bv = valueOf(col, b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir, available]);

  const groups = useMemo(() => {
    if (!group) return [{ key: "__all", label: "", rows: sorted }];
    const col = available.find((c) => c.key === group);
    if (!col) return [{ key: "__all", label: "", rows: sorted }];
    const map = new Map<string, T[]>();
    for (const r of sorted) {
      const label = String(valueOf(col, r) ?? "—");
      (map.get(label) ?? map.set(label, []).get(label)!).push(r);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, list]) => ({ key: label, label, rows: list }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, group, available]);

  const activeFilters = Object.entries(filters).filter(([, v]) => v && v.trim() !== "");

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const runExport = () => {
    const cols = shown;
    void exportGate.runExport({
      surface: tableKey,
      entity: exportEntity ?? tableKey,
      recordCount: sorted.length,
      filters,
      download: () => {
        const csv = toCsv(
          cols.map((c) => c.header),
          sorted.map((r) => cols.map((c) => valueOf(c, r))),
        );
        downloadCsv(`${exportName ?? tableKey}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      },
    });
  };

  const orderKey = sorted.map((r) => rowId(r)).join(",");
  useEffect(() => {
    onOrderChange?.(orderKey ? orderKey.split(",") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5">
        {toolbarLeft}
        <span className="text-[12px] text-muted-foreground">
          {sorted.length.toLocaleString("en-US")} {sorted.length === 1 ? "record" : "records"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {toolbarRight}

          {/* Group by */}
          <Select
            value={group ?? "__none"}
            onValueChange={(v) => setGroup(v === "__none" ? null : v)}
          >
            <SelectTrigger className="filter-chip w-[150px] border-border">
              <Group className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue placeholder="No grouping" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">No grouping</SelectItem>
              {available
                .filter((c) => !c.identity && c.filter !== "none")
                .map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.header}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          {exportGate.allowed && (
            <>
              <Button variant="outline" size="sm" className="filter-chip" onClick={runExport}>
                <Download className="mr-1.5 size-3.5" />
                CSV
              </Button>
              <ExportExcelButton
                className="filter-chip"
                report={exportName ?? tableKey}
                surface={tableKey}
                entity={exportEntity ?? tableKey}
                filters={filters}
                sheets={[
                  {
                    name: exportName ?? tableKey,
                    rows: sorted,
                    columns: shown.map((c) => ({
                      key: c.key,
                      label: c.header,
                      get: (r: T) => valueOf(c, r),
                    })),
                  },
                ]}
              />
            </>
          )}
        </div>
      </div>

      {/* Active filter chips */}
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Filter className="size-3.5 text-muted-foreground" />
          {activeFilters.map(([key, val]) => {
            const col = available.find((c) => c.key === key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilters({ ...filters, [key]: "" })}
                className="filter-chip h-6 text-[11px]"
              >
                <span className="text-muted-foreground">{col?.header ?? key}:</span>
                <span className="font-medium">{val}</span>
                <X className="size-3" />
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setFilters({})}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Grid */}
      <div className={cn("min-h-0 overflow-auto rounded-md border bg-card", maxHeightClass)}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-20">
            <tr className="bg-card">
              {shown.map((c, i) => {
                const sortedOn = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    style={c.width ? { width: c.width, minWidth: c.width } : undefined}
                    className={cn(
                      "border-b px-2 py-1.5 text-left align-middle text-[11.5px] font-normal text-muted-foreground",
                      c.numeric && "text-right",
                      i === 0 && "sticky left-0 z-30 bg-card",
                    )}
                  >
                    <span className={cn("flex items-center gap-1", c.numeric && "justify-end")}>
                      {/* No dead control: a column with no meaningful order
                          renders its label as plain text. */}
                      {c.sortable === false ? (
                        <span className="truncate">{c.header}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleSort(c.key)}
                          aria-label={`Sort by ${c.header}`}
                          className={cn(
                            "truncate hover:text-foreground",
                            sortedOn && "font-medium text-foreground",
                          )}
                        >
                          {c.header}
                        </button>
                      )}
                      {sortedOn &&
                        (sortDir === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        ))}
                      {c.filter !== "none" && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "opacity-40 hover:opacity-100",
                                filters[c.key] && "opacity-100 text-primary",
                              )}
                              aria-label={`Filter ${c.header}`}
                            >
                              <Filter className="size-3" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent align="start" className="w-56 p-2">
                            {c.filter === "select" ? (
                              <div className="max-h-64 overflow-y-auto">
                                <button
                                  type="button"
                                  onClick={() => setFilters({ ...filters, [c.key]: "" })}
                                  className="block w-full px-2 py-1 text-left text-[12px] hover:bg-accent"
                                >
                                  Any
                                </button>
                                {optionsFor(c).map((o) => (
                                  <button
                                    key={o}
                                    type="button"
                                    onClick={() => setFilters({ ...filters, [c.key]: o })}
                                    className={cn(
                                      "block w-full truncate px-2 py-1 text-left text-[12px] hover:bg-accent",
                                      filters[c.key] === o &&
                                        "bg-primary/10 font-medium text-primary",
                                    )}
                                  >
                                    {o}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="relative">
                                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                  autoFocus
                                  value={filters[c.key] ?? ""}
                                  onChange={(e) =>
                                    setFilters({ ...filters, [c.key]: e.target.value })
                                  }
                                  placeholder={`Filter ${c.header.toLowerCase()}`}
                                  className="h-7 pl-7 text-[12px]"
                                />
                              </div>
                            )}
                          </PopoverContent>
                        </Popover>
                      )}
                    </span>
                  </th>
                );
              })}
              <th className="w-9 border-b bg-card px-1 py-1.5 text-right">
                <ColumnPicker
                  ordered={ordered}
                  visible={visible}
                  setVisible={setVisible}
                  setOrder={setOrder}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={shown.length + 1}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  Loading…
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={shown.length + 1}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  {emptyMessage ?? "Nothing here."}
                </td>
              </tr>
            ) : (
              groups.map((g) => (
                <GroupBlock
                  key={g.key}
                  label={g.label}
                  count={g.rows.length}
                  colSpan={shown.length + 1}
                  collapsed={!!collapsed[g.key]}
                  onToggle={() => setCollapsed({ ...collapsed, [g.key]: !collapsed[g.key] })}
                >
                  {g.rows.map((row) => (
                    <ClickableTr
                      key={rowId(row)}
                      href={rowHref?.(row)}
                      onActivate={onRowClick ? () => onRowClick(row) : undefined}
                      className={cn(
                        "border-b hover:bg-hover",
                        rowClassName?.(row),
                        selectedId === rowId(row) &&
                          "bg-primary/10 shadow-[inset_2px_0_0_0_var(--primary)] hover:bg-primary/10",
                      )}
                    >
                      {shown.map((c, i) => (
                        <td
                          key={c.key}
                          className={cn(
                            "px-2 py-1 align-middle",
                            // A number is never cut to "…": a numeric column
                            // stays on one line and the table scrolls sideways
                            // instead. Text columns keep their ellipsis.
                            c.numeric ? "whitespace-nowrap text-right tabular-nums" : "truncate",
                            i === 0 && "sticky left-0 z-10 bg-[inherit] bg-card",
                            c.className,
                          )}
                          style={c.width ? { maxWidth: c.width } : undefined}
                        >
                          {c.cell ? c.cell(row) : (valueOf(c, row) ?? "—")}
                        </td>
                      ))}
                      <td
                        className="whitespace-nowrap px-2 py-1 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="inline-flex items-center gap-1">
                          {rowActions?.(row)}
                          {detailRows && <DetailPopover rows={detailRows(row)} />}
                        </span>
                      </td>
                    </ClickableTr>
                  ))}
                </GroupBlock>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {activeFilters.length > 0 ? `${activeFilters.length} filter(s) active` : ""}
        {!exportGate.allowed && exportGate.reason ? ` · ${exportGate.reason}` : ""}
      </p>
    </div>
  );
}

function GroupBlock({
  label,
  count,
  colSpan,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  colSpan: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (!label) return <>{children}</>;
  return (
    <>
      <tr className="bg-surface">
        <td colSpan={colSpan} className="border-b px-2 py-1">
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 text-[11.5px] font-medium"
          >
            {collapsed ? (
              <ChevronRight className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            {label}
            <span className="text-muted-foreground">({count})</span>
          </button>
        </td>
      </tr>
      {!collapsed && children}
    </>
  );
}

/** The "More" breakdown: every metric for one row without leaving the list. */
function DetailPopover({ rows }: { rows: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-primary">
          More
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Breakdown
        </div>
        <div className="max-h-[360px] overflow-y-auto">
          {rows.map((r) => {
            const open = openKey === r.label;
            return (
              <div key={r.label} className="border-b last:border-b-0">
                <button
                  type="button"
                  disabled={!r.sub}
                  onClick={() => setOpenKey(open ? null : r.label)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/50 disabled:cursor-default"
                >
                  <span className="w-4 shrink-0">
                    {r.sub &&
                      (open ? (
                        <ChevronDown className="size-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      ))}
                  </span>
                  <span className="flex-1 truncate text-[12px] text-muted-foreground">
                    {r.label}
                  </span>
                  <span className="text-[12.5px] font-medium tabular-nums">{r.value}</span>
                </button>
                {open && r.sub && (
                  <div className="bg-muted/40 px-9 py-1.5 text-[11.5px] text-muted-foreground">
                    {r.sub}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A table row that is entirely clickable, focusable and Enter-activatable.
 * Nested controls opt out via <StopClick> or a `data-no-row-nav` attribute.
 */
function ClickableTr({
  href,
  onActivate,
  className,
  children,
}: {
  href?: string | null;
  onActivate?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const nav = useRowNav(href);
  const interactive = !!nav || !!onActivate;

  return (
    <tr
      {...(nav ?? {})}
      {...(onActivate && !nav
        ? {
            role: "button" as const,
            tabIndex: 0,
            onKeyDown: (e: KeyboardEvent) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate();
              }
            },
          }
        : {})}
      onClick={(e) => {
        if (nav) {
          nav.onClick(e);
          return;
        }
        if (!e.defaultPrevented) {
          const target = e.target as HTMLElement;
          if (!target.closest("a,button,input,select,textarea,[data-no-row-nav]")) onActivate?.();
        }
      }}
      className={cn(className, interactive && ROW_NAV_CLASS)}
    >
      {children}
    </tr>
  );
}

/**
 * Column chooser and reorderer, opened from the settings gear at the right end
 * of the header.
 *
 * Reordering lives here rather than on the header cells themselves: the grid
 * scrolls horizontally, and a drag started on a header is the same gesture as
 * a sideways swipe or a two-finger scroll. A vertical list inside a popover
 * has no such conflict, works with a keyboard, and lets someone move a column
 * that is currently scrolled out of sight.
 */
function ColumnPicker<T>({
  ordered,
  visible,
  setVisible,
  setOrder,
}: {
  ordered: DataColumn<T>[];
  visible: string[];
  setVisible: (v: string[]) => void;
  setOrder: (v: string[]) => void;
}) {
  const sensors = useSensors(
    // Without a distance threshold the picker eats plain taps on the checkbox.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const keys = ordered.map((c) => c.key);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setOrder(arrayMove(keys, from, to));
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          aria-label="Choose columns"
        >
          <Settings2 className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b px-3 py-2 text-[11.5px] text-muted-foreground">
          Show columns · drag to reorder
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={keys} strategy={verticalListSortingStrategy}>
              {ordered.map((c) => (
                <ColumnPickerRow
                  key={c.key}
                  id={c.key}
                  header={c.header}
                  identity={!!c.identity}
                  on={!!c.identity || visible.includes(c.key)}
                  onToggle={() =>
                    setVisible(
                      visible.includes(c.key)
                        ? visible.filter((k) => k !== c.key)
                        : [...visible, c.key],
                    )
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
        <div className="flex gap-1 border-t p-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 flex-1 text-[12px]"
            onClick={() => setVisible(ordered.map((c) => c.key))}
          >
            All
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 flex-1 text-[12px]"
            onClick={() => {
              setVisible(ordered.filter((c) => !c.defaultHidden).map((c) => c.key));
              // Reset means the table's own layout back, order included.
              setOrder([]);
            }}
          >
            Reset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ColumnPickerRow({
  id,
  header,
  identity,
  on,
  onToggle,
}: {
  id: string;
  header: string;
  identity: boolean;
  on: boolean;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1 pr-2 text-[12.5px]",
        isDragging && "relative z-10 rounded bg-accent shadow-sm",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${header}`}
        className="cursor-grab px-1 py-1.5 text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        disabled={identity}
        onClick={onToggle}
        className={cn(
          "flex flex-1 items-center gap-2 py-1.5 pr-1 text-left",
          on ? "font-medium text-primary" : "hover:bg-hover",
          identity && "opacity-60",
        )}
      >
        <Checkbox checked={on} className="pointer-events-none size-3.5" />
        {header}
      </button>
    </div>
  );
}
