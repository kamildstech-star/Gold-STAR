import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { PlainNumberInput } from "@/components/calc-input";
import { ReportFiltersButton } from "@/components/report-filters-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { toastDbError } from "@/lib/db-errors";
import {
  CATALOG_ITEM_SELECT,
  UOMS,
  discountLabel,
  fmtMoney,
  num,
  round2,
  type CatalogHeader,
  type CatalogItemPublic,
  type EstimateLine,
  type EstimateScope,
} from "@/lib/estimates";
import {
  FEE_PRESETS,
  buildSheet,
  customLineValues,
  filterSheet,
  quantityDecimals,
  quantityWrite,
  rowUnitPrice,
  sheetTotals,
  type SheetCatalogRow,
  type SheetWrite,
} from "@/lib/estimate-sheet";
import { useCan } from "@/lib/permissions";
import type { DocumentPricing } from "@/lib/price-lists";
import { cn } from "@/lib/utils";

/**
 * Text under 16px makes iOS zoom the page in on focus and never zoom back, so
 * every box is a thumb-sized 44px with 16px text below the breakpoint and the
 * dense desktop size above it — the same rule the table view follows.
 */
const MOBILE_FIELD = "h-11 text-base sm:h-8 sm:text-[13px]";

/** The name the PDF already gives an estimate that has no scope of its own. */
const DEFAULT_SCOPE_NAME = "Scope of work";

/**
 * The estimate as a sheet: David's Job Calculator, on the estimate's own
 * lines. See src/lib/estimate-sheet.ts for why this exists and what it is
 * allowed to touch.
 *
 * One scope at a time. The sheet has one quantity box per catalogue rate, so
 * it can only speak for one line per item — and an estimate with a
 * dehumidifier in the kitchen AND the basement has two. Most estimates have
 * one scope and never see the chooser; with several, the sheet fills the one
 * chosen at the top and the totals bar still reads the whole document.
 */
export function EstimateSheet({
  estimateId,
  scopes,
  lines,
  pricing,
  rate,
  onChanged,
  onLinePatched,
}: {
  estimateId: string;
  scopes: EstimateScope[];
  /** Every line on the estimate; the sheet picks the chosen scope's out. */
  lines: EstimateLine[];
  /** The customer / branch / state price book resolved for THIS document. */
  pricing: DocumentPricing;
  rate: number;
  /** The set of lines or scopes changed — everything refetches. */
  onChanged: () => void;
  /** One line was edited in place — only the server-computed totals refetch. */
  onLinePatched: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  // Same flag the editor keys the lines query on; the optimistic patch
  // below must land in that cache entry.
  const canSeeCosts = useCan("job.view_costs");
  const disabled = app.writesDisabled;
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState<string | null>(scopes[0]?.id ?? null);
  // Writes in flight, so the bar can say "Saving…" honestly: the sheet saves
  // each box as it is left, exactly as the table saves each cell.
  const [pending, setPending] = useState(0);

  // A deleted scope, or the first scope arriving after a blank estimate.
  useEffect(() => {
    if (!scopes.some((s) => s.id === scopeId)) setScopeId(scopes[0]?.id ?? null);
  }, [scopes, scopeId]);

  // Same query keys as the line picker, so one catalogue read serves both.
  const headersQ = useQuery({
    queryKey: ["estimate-headers"],
    queryFn: async (): Promise<CatalogHeader[]> => {
      const { data, error } = await supabase
        .from("estimate_headers")
        .select("id, code, name, sort_order, is_active")
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Explicit columns only: the table has no table-wide SELECT grant, so a
  // `select("*")` (or naming default_cost) is "permission denied" for every
  // user. See CATALOG_ITEM_PUBLIC_COLUMNS.
  const itemsQ = useQuery({
    queryKey: ["estimate-catalog"],
    queryFn: async (): Promise<CatalogItemPublic[]> => {
      const { data, error } = await supabase
        .from("estimate_catalog_items")
        .select(CATALOG_ITEM_SELECT)
        .eq("is_active", true)
        .order("sort_order")
        .limit(2000);
      if (error) throw error;
      return data ?? [];
    },
  });

  const scopeLines = useMemo(() => lines.filter((l) => l.scope_id === scopeId), [lines, scopeId]);

  const sheet = useMemo(
    () =>
      buildSheet({
        headers: headersQ.data ?? [],
        items: itemsQ.data ?? [],
        lines: scopeLines,
        book: pricing.book,
      }),
    [headersQ.data, itemsQ.data, scopeLines, pricing.book],
  );
  const shown = useMemo(() => filterSheet(sheet, query), [sheet, query]);
  const totals = useMemo(() => sheetTotals(lines, rate), [lines, rate]);

  const track = async <T,>(work: Promise<T>): Promise<T> => {
    setPending((n) => n + 1);
    try {
      return await work;
    } finally {
      setPending((n) => n - 1);
    }
  };

  /**
   * The scope a write goes into. An estimate that has none yet gets one the
   * first time a quantity is typed — named the way the PDF already names a
   * scope-less estimate — so the sheet never asks anyone to "add a scope"
   * before they can price a dehumidifier.
   */
  const ensureScope = async (): Promise<string> => {
    if (scopeId) return scopeId;
    const { data, error } = await supabase
      .from("estimate_scopes")
      .insert({ estimate_id: estimateId, name: DEFAULT_SCOPE_NAME, position: 0 })
      .select("id")
      .single();
    if (error) throw error;
    setScopeId(data.id);
    void qc.invalidateQueries({ queryKey: ["estimate-scopes", estimateId] });
    return data.id;
  };

  /** One line edited in place: patch the cache the way the table does. */
  const patchCache = (lineId: string, patch: TablesUpdate<"estimate_lines">) => {
    // `subtotal` is generated in the database as quantity * unit_price.
    // Repeating that one multiplication here is what lets an edited box skip
    // the refetch that would redraw the whole sheet mid-edit.
    qc.setQueryData<EstimateLine[]>(
      ["estimate-lines", estimateId, { costs: canSeeCosts }],
      (prev) =>
        prev?.map((l) => {
          if (l.id !== lineId) return l;
          const next = { ...l, ...patch } as EstimateLine;
          return { ...next, subtotal: round2(num(next.quantity) * num(next.unit_price)) };
        }),
    );
  };

  const patchLine = useMutation({
    mutationFn: ({ lineId, patch }: { lineId: string; patch: TablesUpdate<"estimate_lines"> }) =>
      track(
        (async () => {
          const { error } = await supabase.from("estimate_lines").update(patch).eq("id", lineId);
          if (error) throw error;
        })(),
      ),
    onSuccess: (_r, { lineId, patch }) => {
      patchCache(lineId, patch);
      onLinePatched();
    },
    onError: (e) => toastDbError(e, { action: "Saving the line" }),
  });

  const removeLine = useMutation({
    mutationFn: (lineId: string) =>
      track(
        (async () => {
          const { error } = await supabase.from("estimate_lines").delete().eq("id", lineId);
          if (error) throw error;
        })(),
      ),
    onSuccess: onChanged,
    onError: (e) => toastDbError(e, { action: "Removing the line" }),
  });

  const insertLine = useMutation({
    mutationFn: (values: TablesInsert<"estimate_lines">) =>
      track(
        (async () => {
          const scope_id = await ensureScope();
          const { error } = await supabase.from("estimate_lines").insert({ ...values, scope_id });
          if (error) throw error;
        })(),
      ),
    onSuccess: onChanged,
    onError: (e) => toastDbError(e, { action: "Adding the line" }),
  });

  /** A quantity was committed on a catalogue row. */
  const commitQuantity = (row: SheetCatalogRow, qty: number | null) => {
    const write: SheetWrite = quantityWrite(row, qty, {
      estimateId,
      // `scopeId` may still be null here; the insert resolves the real one.
      scopeId: scopeId ?? "",
      position: scopeLines.length,
    });
    if (write.kind === "insert") insertLine.mutate(write.values);
    else if (write.kind === "update")
      patchLine.mutate({ lineId: write.lineId, patch: write.patch });
    else if (write.kind === "remove") removeLine.mutate(write.lineId);
  };

  const addCustom = (preset?: { name: string; uom: string }) =>
    insertLine.mutate(
      customLineValues({
        estimateId,
        scopeId: scopeId ?? "",
        position: scopeLines.length,
        name: preset?.name,
        uom: preset?.uom,
      }),
    );

  const loading = headersQ.isLoading || itemsQ.isLoading;
  const agreement = pricing.labels[0] ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {scopes.length > 1 && (
          <Select value={scopeId ?? ""} onValueChange={setScopeId}>
            <SelectTrigger className={cn(MOBILE_FIELD, "w-full sm:w-60")} aria-label="Scope">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {[s.name, s.room_name].filter(Boolean).join(" — ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find an item"
            aria-label="Find an item"
            className={cn(MOBILE_FIELD, "pl-8")}
          />
        </div>
      </div>

      {/* Which prices the sheet is on, said out loud: a number that quietly
          changed because the customer has an agreement, with nothing on
          screen saying so, is the failure this line exists to prevent. */}
      <p className="text-xs text-muted-foreground" data-testid="sheet-price-source">
        {agreement
          ? `Priced from ${agreement}. Items the agreement does not name keep the catalog price.`
          : "Catalog prices. Type a quantity to put an item on the estimate; clear it to take it off."}
      </p>

      {loading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">Loading catalog…</div>
      ) : sheet.sections.length === 0 ? (
        <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          The catalog is empty. Admins can add items in Admin → Estimate catalog.
        </div>
      ) : (
        shown.sections.map((section) => (
          <Card key={section.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{section.name}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-0 pt-0">
              {section.rows.map((row) => (
                <CatalogRow
                  key={row.item.id}
                  row={row}
                  disabled={disabled}
                  onCommit={(n) => commitQuantity(row, n)}
                />
              ))}
            </CardContent>
          </Card>
        ))
      )}

      {/* The calculator's "Other fees", plus anything the sheet has no rate
          for. All of it is ordinary custom lines — a fee is a lump-sum line
          named for the fee whose price is the amount — so the table shows
          every one of them and nothing new is stored. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Other fees and custom lines</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-0 pt-0">
          {shown.custom.length > 0 && (
            <div className="hidden md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_6.5rem_5.5rem_5.5rem_2rem] gap-2 border-b bg-card pb-1 text-[10px] uppercase tracking-wide text-muted-foreground sm:grid">
              <span>Item</span>
              <span>Unit</span>
              <span className="text-right">Unit price</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Total</span>
              <span />
            </div>
          )}
          {shown.custom.map((line) => (
            <CustomRow
              key={line.id}
              line={line}
              disabled={disabled}
              onPatch={(patch) => patchLine.mutate({ lineId: line.id, patch })}
              onRemove={() => removeLine.mutate(line.id)}
            />
          ))}
          {sheet.custom.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">
              Nothing yet. A fee or an item that is not in the catalog goes here.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {FEE_PRESETS.map((fee) => (
              <Button
                key={fee.name}
                size="sm"
                variant="outline"
                className="h-11 sm:h-7"
                disabled={disabled || insertLine.isPending}
                onClick={() => addCustom(fee)}
              >
                <Plus className="mr-1.5 size-3.5" /> {fee.name}
              </Button>
            ))}
            <Button
              size="sm"
              className="h-11 sm:h-7"
              disabled={disabled || insertLine.isPending}
              onClick={() => addCustom()}
            >
              <Plus className="mr-1.5 size-3.5" /> Add custom line
            </Button>
          </div>
        </CardContent>
      </Card>

      {/*
       * Sticky, not fixed: fixed at bottom-0 would sit under the app's mobile
       * bottom nav, which is also fixed there and a layer higher. Same bar,
       * same reason, as the calculator's.
       *
       * `bottom-0`, NOT `above-mobile-nav`. This bar is sticky inside the app
       * shell's <main>, and <main> already reserves pb-[calc(4rem+env(safe-area-
       * inset-bottom))] below md for the fixed phone nav. A sticky element is held
       * inside its scroll container's padding edge, so bottom-0 already docks it
       * on top of the nav — notched iPhones included, since the padding carries
       * the same inset the nav does. above-mobile-nav (4rem) is for something
       * positioned against the VIEWPORT; here it counted the nav twice and
       * floated the bar 71px clear of it at 375px, rows showing underneath.
       */}
      <div className="sticky bottom-0 z-30 -mx-3 border-t bg-background/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="flex items-end justify-between gap-3">
          {/* Two lines, whatever the width: the breakdown in small type, the
              one number being watched under it. A phone has no room for a
              stacked totals card between the rows and the keyboard. */}
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {[
                { key: "sub", label: "Subtotal", value: fmtMoney(totals.subtotal) },
                ...totals.discounts.map((d) => ({
                  key: d.line.id,
                  label: discountLabel(d.line, lines),
                  value: `−${fmtMoney(d.amount)}`,
                })),
                { key: "tax", label: `Tax (${fmtRate(rate)}%)`, value: fmtMoney(totals.tax) },
              ].map((part, i) => (
                <span key={part.key} className="whitespace-nowrap">
                  {i > 0 ? " · " : ""}
                  {part.label} <span className="tabular-nums text-foreground">{part.value}</span>
                </span>
              ))}
            </p>
            <p className="flex items-baseline gap-2">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Total</span>
              <span className="text-lg font-bold tabular-nums" data-testid="sheet-total">
                {fmtMoney(totals.total)}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground" data-testid="sheet-save-state">
              {pending > 0 ? "Saving…" : "Saved as you go"}
            </span>
            <ReportFiltersButton kind="estimate" id={estimateId} label="PDF" variant="outline" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** "6.625", the way the table's Totals card prints the rate. */
function fmtRate(rate: number) {
  return (rate * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * One rate on the sheet: name, price per unit, one quantity box. The box is
 * uncontrolled and keyed on the stored quantity, so it resyncs when the table
 * (or another tab) moves the line and is never stamped on mid-edit.
 */
function CatalogRow({
  row,
  disabled,
  onCommit,
}: {
  row: SheetCatalogRow;
  disabled: boolean;
  onCommit: (qty: number | null) => void;
}) {
  const { item, line } = row;
  const price = rowUnitPrice(row);
  const overridden = !line && row.price.source !== "default";
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-3 border-b py-2 last:border-0",
        line && "bg-primary/5 -mx-2 px-2",
      )}
      data-testid="sheet-row"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {overridden ? (
            <>
              <span className="line-through">{fmtMoney(item.default_unit_price)}</span>{" "}
              <span className="text-primary">{fmtMoney(price)}</span>
            </>
          ) : (
            fmtMoney(price)
          )}
          {` / ${item.uom}`}
          {line ? <span className="tabular-nums"> · {fmtMoney(line.subtotal)}</span> : null}
        </p>
      </div>
      <NumberInput
        key={`${item.id}:${row.quantity}`}
        aria-label={`${item.name} quantity`}
        decimals={quantityDecimals(item.uom)}
        defaultValue={row.quantity || null}
        placeholder="0"
        disabled={disabled}
        enterKeyHint="done"
        className={cn(MOBILE_FIELD, "text-right")}
        onCommit={onCommit}
        onKeyDown={(e) => {
          // Enter saves the way leaving the box does — the calculator habit.
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </div>
  );
}

/** A line the sheet has no rate for, editable in place. */
function CustomRow({
  line,
  disabled,
  onPatch,
  onRemove,
}: {
  line: EstimateLine;
  disabled: boolean;
  onPatch: (patch: TablesUpdate<"estimate_lines">) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 border-b py-2 last:border-0 sm:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_6.5rem_5.5rem_5.5rem_2rem] sm:items-center">
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <Input
          defaultValue={line.name}
          placeholder="Item"
          disabled={disabled}
          aria-label="Custom line name"
          className={cn(MOBILE_FIELD, "font-medium")}
          onBlur={(e) => e.target.value !== line.name && onPatch({ name: e.target.value })}
        />
        {line.code && (
          <span className="font-mono text-[10px] text-muted-foreground">{line.code}</span>
        )}
      </div>
      <Field label="Unit">
        <Select value={line.uom} disabled={disabled} onValueChange={(v) => onPatch({ uom: v })}>
          <SelectTrigger className={MOBILE_FIELD} aria-label="Unit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[...new Set([line.uom, ...UOMS])].map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {/* A rate is copied off a sheet, not computed in the box — David:
          "unit price needs no calculator". */}
      <Field label="Unit price">
        <PlainNumberInput
          value={num(line.unit_price)}
          disabled={disabled}
          title="The rate itself — a plain number"
          className={cn(MOBILE_FIELD, "text-right")}
          onCommit={(v) => onPatch({ unit_price: v })}
        />
      </Field>
      {/* A viewer without job.view_costs has no Cost field at all. */}
      {line.unit_cost != null && (
        <Field label="Cost">
          <PlainNumberInput
            value={num(line.unit_cost)}
            disabled={disabled}
            title="What it costs us — a plain number"
            className={cn(MOBILE_FIELD, "text-right")}
            onCommit={(v) => onPatch({ unit_cost: v })}
          />
        </Field>
      )}
      <Field label="Qty">
        <NumberInput
          key={`${line.id}:${line.quantity}`}
          aria-label={`${line.name} quantity`}
          decimals={quantityDecimals(line.uom)}
          defaultValue={num(line.quantity)}
          disabled={disabled}
          enterKeyHint="done"
          className={cn(MOBILE_FIELD, "text-right")}
          onCommit={(n) => {
            const q = round2(Math.max(0, num(n)));
            if (q !== round2(num(line.quantity))) onPatch({ quantity: q });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </Field>
      <div className="flex items-center justify-between gap-2 sm:contents">
        <Field label="Total">
          <span className="block py-1 text-right text-sm font-medium tabular-nums sm:py-0">
            {fmtMoney(line.subtotal)}
          </span>
        </Field>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete line"
          disabled={disabled}
          className="size-11 text-destructive sm:size-7"
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** A label that only shows on a phone, where the header row is gone. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
        {label}
      </span>
      {children}
    </label>
  );
}
