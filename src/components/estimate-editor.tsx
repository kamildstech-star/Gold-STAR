import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isMissingSchema } from "@/lib/schema-fallback";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
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
  ArrowLeft,
  BookmarkPlus,
  GripVertical,
  Layers,
  Percent,
  Plus,
  Receipt,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { cn } from "@/lib/utils";
import { BillingRail, useBillingRailTarget } from "@/components/billing-rail";
import { CalcInput, CalculatorPanel, PlainNumberInput } from "@/components/calc-input";
import { normalizeStateCode } from "@/lib/us-states";
import { LineItemCard } from "@/components/line-item-card";
import { EstimateLinePicker } from "@/components/estimate-line-picker";
import { EstimateSheet } from "@/components/estimate-sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import { ReportFiltersButton } from "@/components/report-filters-dialog";
import { DocumentPreviewButton } from "@/components/document-preview-button";
import { RevisionHistoryButton } from "@/components/revision-history";
import { syncDraftRevision } from "@/lib/revisions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RecordHistoryCard } from "@/components/record-timeline";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { convertEstimateToInvoice } from "@/lib/estimate-invoice";
import { toastDbError } from "@/lib/db-errors";
import { useNavigate } from "@tanstack/react-router";
import { RoomNamePicker } from "@/components/room-name-picker";
import { fetchJobRooms, type JobRoom } from "@/lib/job-rooms";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { AccountDiscountCallout } from "@/components/standing-notes";
import {
  applyScopeTemplate,
  discountAmount,
  discountBase,
  discountCode,
  discountIsTaxable,
  discountLabel,
  discountPercent,
  discountResolved,
  discountTargetMark,
  discountTargets,
  discountTaxable,
  discountUnitPrice,
  ESTIMATE_STATUS_LABEL,
  ESTIMATE_STATUS_TONE,
  ESTIMATE_STATUSES,
  estimateLabel,
  fmtMoney,
  fmtQuantity,
  lineTax,
  lineTotal,
  num,
  round2,
  saveScopeAsTemplate,
  scopeSubtotal,
  scopeTotal,
  splitDiscounts,
  type CatalogItemPublic,
  type EstimateLine,
  type EstimateScope,
  type EstimateStatus,
  UOMS,
} from "@/lib/estimates";
import { ESTIMATE_LINE_SELECT, fetchEstimateLineCosts, mergeLineCosts } from "@/lib/line-costs";
import { ESTIMATE_VIEWS, useEstimateView, type EstimateView } from "@/lib/estimate-sheet";
import { fetchDocumentPricing, NO_DOCUMENT_PRICING, resolveCatalogPrice } from "@/lib/price-lists";
import { useCan } from "@/lib/permissions";
import { refreshJobMoney } from "@/lib/use-job-commission";
/**
 * Text under 16px makes iOS zoom the page in on focus and never zoom back, so
 * every field grows to a thumb-sized 44px box with 16px text below the
 * breakpoint and returns to the dense desktop size above it. This belongs in
 * the Input primitive; it lives here until that lands.
 */
const MOBILE_FIELD = "h-11 text-base sm:h-8 sm:text-[13px]";

interface FullEstimate {
  current_version: number;
  id: string;
  job_id: string;
  account_id: string | null;
  location_id: string;
  seq: number;
  status: EstimateStatus;
  title: string | null;
  call_date: string | null;
  estimate_date: string;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  office_name: string | null;
  office_phone: string | null;
  office_email: string | null;
  office_address: string | null;
  tax_rate: number;
  notes: string | null;
  closing_statement: string | null;
  subtotal: number;
  tax: number;
  total: number;
}

/**
 * The estimate builder. Rendered full-page at /estimates/$id and inline on a
 * job's Billing tab — a child record is never worth a trip to a list page.
 */
export function EstimateEditor({
  estimateId: id,
  embedded = false,
  onChanged,
}: {
  estimateId: string;
  /** Inline on a parent record: drop the back link and page padding. */
  embedded?: boolean;
  onChanged?: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [pickerScope, setPickerScope] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const navigate = useNavigate();
  /* Whether this editor's rail cards go to the page's own rail instead of into
     a second column of our own. A hook, so it must run before the early
     returns below for a missing record. */
  const railed = useBillingRailTarget() != null;
  /*
   * Sheet or table. Mark: "job calculator he likes better than the current
   * estimate system can we copy that style and add custom line item options".
   * The sheet (src/components/estimate-sheet.tsx) is a second presentation of
   * the same lines, remembered per person; the table below is untouched.
   */
  const { view, setView } = useEstimateView(app.userId, !app.writesDisabled);

  const estimateQ = useQuery({
    queryKey: ["estimate", id],
    // Nothing on this page may unmount while it refetches — the editor is
    // autosaving under the user's hands.
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<FullEstimate> => {
      /*
       * closing_statement shipped ahead of its migration. PostgREST fails the
       * whole read on one unknown column, so asking for it unconditionally
       * takes down the entire estimate rather than the one field.
       */
      const base =
        "id, current_version, job_id, account_id, location_id, seq, status, title, call_date, estimate_date, job_number, customer_name, address, address_line2, locality, region, postal_code, office_name, office_phone, office_email, office_address, tax_rate, notes, subtotal, tax, total";
      const full = await supabase
        .from("estimates")
        .select(`${base}, closing_statement`)
        .eq("id", id)
        .single();
      if (!full.error) return full.data as FullEstimate;
      if (!isMissingSchema(full.error)) throw full.error;
      const fallback = await supabase.from("estimates").select(base).eq("id", id).single();
      if (fallback.error) throw fallback.error;
      return { ...(fallback.data as object), closing_statement: null } as FullEstimate;
    },
  });

  // The job's rooms, for the scope room picker. Same query key as the Rooms
  // tab, so a room added there is offered here without a reload.
  const roomsQ = useQuery({
    queryKey: ["job-rooms", estimateQ.data?.job_id],
    queryFn: () => fetchJobRooms(estimateQ.data!.job_id),
    enabled: !!estimateQ.data?.job_id,
  });
  const rooms = roomsQ.data?.rooms ?? [];

  const scopesQ = useQuery({
    queryKey: ["estimate-scopes", id],
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<EstimateScope[]> => {
      const { data, error } = await supabase
        .from("estimate_scopes")
        .select("id, estimate_id, name, room_name, notes, position")
        .eq("estimate_id", id)
        .order("position");
      if (error) throw error;
      return data ?? [];
    },
  });

  /*
   * Explicit columns: estimate_lines has no table-wide SELECT grant, so a
   * `select("*")` (or naming unit_cost) is "permission denied" for every user.
   * Cost comes through the RPC, only for job.view_costs holders, and is
   * merged here so the optimistic patch below keeps working on one shape; a
   * line whose cost the viewer may not see carries unit_cost: null.
   */
  const canSeeCosts = useCan("job.view_costs");
  const linesQ = useQuery({
    queryKey: ["estimate-lines", id, { costs: canSeeCosts }],
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<EstimateLine[]> => {
      const [{ data, error }, costs] = await Promise.all([
        supabase
          .from("estimate_lines")
          .select(ESTIMATE_LINE_SELECT)
          .eq("estimate_id", id)
          .order("position"),
        canSeeCosts ? fetchEstimateLineCosts(id) : Promise.resolve(null),
      ]);
      if (error) throw error;
      // subtotal is a generated column, typed nullable; it is never null.
      return mergeLineCosts(data ?? [], costs) as EstimateLine[];
    },
  });

  /*
   * Snapshotting the document is five round-trips, and the parent callback
   * reloads the whole Billing tab. Neither belongs on a field blur, so both
   * run once the typing pauses. Cancelled on unmount: a timer that fires into
   * a dead component writes a revision nobody asked for.
   */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );
  const settleLater = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      // Keeps the working version in step; if the last one has already been
      // sent, this opens the next version rather than touching the frozen
      // snapshot.
      void syncDraftRevision("estimate", id).catch(() => null);
      onChanged?.();
    }, 2000);
  };

  /**
   * A line was edited in place. Its own row is already correct in the cache, so
   * only the header comes back — `subtotal`, `tax` and `total` are generated
   * columns and the database is the only thing that knows them.
   */
  const refreshTotals = () => {
    void qc.invalidateQueries({ queryKey: ["estimate", id] });
    // The total is the commission's base: re-read the job's running cost so
    // the Commissions card "auto calculate[s] as the charges get added".
    refreshJobMoney(qc, estimateQ.data?.job_id);
    settleLater();
  };

  /** The set of lines or scopes changed: everything has to come back. */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["estimate", id] });
    void qc.invalidateQueries({ queryKey: ["estimate-lines", id] });
    void qc.invalidateQueries({ queryKey: ["estimate-scopes", id] });
    refreshJobMoney(qc, estimateQ.data?.job_id);
    settleLater();
  };

  const est = estimateQ.data;
  const scopes = scopesQ.data ?? [];
  const lines = useMemo(() => linesQ.data ?? [], [linesQ.data]);
  const rate = num(est?.tax_rate);

  const byScope = useMemo(() => {
    const map = new Map<string, EstimateLine[]>();
    for (const l of lines) {
      const key = l.scope_id ?? "__none";
      const arr = map.get(key) ?? [];
      arr.push(l);
      map.set(key, arr);
    }
    return map;
  }, [lines]);

  // Discounts are deductions, not work: they are listed in the totals stack.
  const discounts = useMemo(() => splitDiscounts(lines).discounts, [lines]);

  /*
   * The customer's agreement and the branch's list, resolved for THIS document
   * (src/lib/price-lists.ts). Priced on the estimate's own date rather than
   * today, so reopening a January estimate in June still resolves the
   * agreement that was in force when it was written.
   *
   * This only affects lines added from here on. Lines already on the estimate
   * hold the price they were written with — `unit_price` is a stored value and
   * nothing in this feature rewrites one — so signing a new agreement never
   * moves the number a customer has already been shown.
   */
  const pricingQ = useQuery({
    queryKey: [
      "document-pricing",
      est?.job_id,
      est?.account_id,
      est?.location_id,
      est?.region,
      est?.estimate_date,
    ],
    enabled: !!est && !!(est.job_id || est.account_id || est.location_id || est.region),
    queryFn: () =>
      fetchDocumentPricing({
        jobId: est!.job_id ?? null,
        accountId: est!.account_id,
        locationId: est!.location_id,
        // The property address on the estimate, which is where the work is.
        stateCode: normalizeStateCode(est!.region),
        onDate: est!.estimate_date,
      }),
  });
  const pricing = pricingQ.data ?? NO_DOCUMENT_PRICING;

  const patchEstimate = useMutation({
    mutationFn: async (patch: TablesUpdate<"estimates">) => {
      const { error } = await supabase.from("estimates").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const addScope = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("estimate_scopes").insert({
        estimate_id: id,
        name: "New scope",
        position: scopes.length,
      });
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const addLines = useMutation({
    mutationFn: async ({ scopeId, items }: { scopeId: string; items: CatalogItemPublic[] }) => {
      const start = (byScope.get(scopeId) ?? []).length;
      const { error } = await supabase.from("estimate_lines").insert(
        items.map((it, i) => ({
          estimate_id: id,
          scope_id: scopeId,
          catalog_item_id: it.id,
          code: it.code,
          name: it.name,
          description: it.description,
          uom: it.uom,
          quantity: 1,
          // unit_cost is deliberately not sent: the client may not be allowed
          // to read the catalog cost, so estimate_lines_fill_cost copies it
          // from the catalog server-side, for every user.
          //
          // The PRICE is resolved here and snapshotted onto the line: the
          // customer's agreement, else the branch list, else the catalog
          // default. Resolving at insert is what makes an agreement change
          // safe — it cannot reach back into a line already written.
          unit_price: resolveCatalogPrice(it, pricing.book).unit_price,
          taxable: it.taxable,
          position: start + i,
        })),
      );
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  // Only the first paint has nothing to draw. A failed background refetch is
  // reported by the global query-error toast; it must not blank a document
  // that is on screen, and an error must never read as "no estimate".
  if (!est) {
    if (estimateQ.error) {
      return (
        <div className="p-6 text-sm text-destructive">{(estimateQ.error as Error).message}</div>
      );
    }
    if (estimateQ.isLoading) {
      return <div className="p-6 text-sm text-muted-foreground">Loading estimate…</div>;
    }
    return <div className="p-6 text-sm text-destructive">Estimate not found.</div>;
  }

  const address = [est.address, est.address_line2, est.locality, est.region, est.postal_code]
    .filter(Boolean)
    .join(", ");

  return (
    <div className={embedded ? "space-y-3" : "space-y-3 p-4"}>
      {/* Pricing arrangements must be impossible to miss while scoping */}
      <AccountDiscountCallout accountId={est.account_id ?? null} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {!embedded && (
            <Button asChild variant="ghost" size="sm" className="-ml-2 h-7 px-2 text-xs">
              <BackLink fallbackTo="/estimates" label="Estimates">
                <ArrowLeft className="mr-1 size-3.5" /> Estimates
              </BackLink>
            </Button>
          )}
          <h1 className="display-heavy text-[19px] leading-tight">
            {estimateLabel(est.seq)}
            {est.title ? <span className="text-muted-foreground"> · {est.title}</span> : null}
          </h1>
          <p className="text-xs text-muted-foreground">
            <Link
              to="/jobs/$id"
              params={{ id: est.job_id }}
              className="text-primary hover:underline"
            >
              {est.job_number ?? "Job"}
            </Link>
            {" · "}
            {est.customer_name ?? "No customer"}
            {address ? ` · ${address}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            aria-label="Line items view"
            value={view}
            onValueChange={(v) => {
              if ((ESTIMATE_VIEWS as readonly string[]).includes(v)) setView(v as EstimateView);
            }}
          >
            <ToggleGroupItem value="sheet" aria-label="Sheet view" className="h-8 px-2.5 text-xs">
              Sheet
            </ToggleGroupItem>
            <ToggleGroupItem value="table" aria-label="Table view" className="h-8 px-2.5 text-xs">
              Table
            </ToggleGroupItem>
          </ToggleGroup>
          {/* Any status converts: the office bills off a draft when the carrier
              approves verbally, and waiting on a status flag stalls the job. */}
          <Button
            size="sm"
            disabled={app.writesDisabled || converting}
            onClick={async () => {
              setConverting(true);
              try {
                const res = await convertEstimateToInvoice(est.id, app.userId);
                toast.success(
                  res.existing
                    ? "This estimate already has an invoice — opening it."
                    : "Invoice created from the estimate.",
                );
                onChanged?.();
                if (!embedded) navigate({ to: "/jobs/$id", params: { id: est.job_id } });
              } catch (e) {
                toastDbError(e, { action: "Converting the estimate to an invoice" });
              } finally {
                setConverting(false);
              }
            }}
          >
            <Receipt className="mr-1.5 size-4" />
            {converting ? "Converting…" : "Convert to invoice"}
          </Button>
          <DocumentPreviewButton kind="estimate" id={est.id} variant="outline" />
          <RevisionHistoryButton
            kind="estimate"
            recordId={est.id}
            numberLabel={estimateLabel(est.seq)}
            variant="outline"
          />
          <ReportFiltersButton kind="estimate" id={est.id} />
          <Badge variant="outline" className="font-mono text-[11px]">
            v{est.current_version ?? 1}
          </Badge>
          <Badge className={ESTIMATE_STATUS_TONE[est.status]}>
            {ESTIMATE_STATUS_LABEL[est.status]}
          </Badge>
          <Select
            value={est.status}
            onValueChange={(v) =>
              patchEstimate.mutate({
                status: v as EstimateStatus,
                sent_at: v === "sent" ? new Date().toISOString() : undefined,
                decided_at:
                  v === "approved" || v === "declined" ? new Date().toISOString() : undefined,
              })
            }
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ESTIMATE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {ESTIMATE_STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* One column once the rail has gone to the page aside: the
          nine-column line table gets the width back. */}
      <div className={cn("grid gap-3", !railed && "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="space-y-3">
          {/* The narrative belongs where the customer reads first, so it is
              edited above the work and printed above the detail table rather
              than filed after the totals. It sits here rather than in the
              sidebar because it is the only copy of the field — two boxes on
              one column would desync the moment someone typed in both. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={4}
                className="text-base sm:text-[13px]"
                placeholder="What we will do — prints above the line items."
                defaultValue={est.notes ?? ""}
                onBlur={(e) =>
                  e.target.value !== (est.notes ?? "") &&
                  patchEstimate.mutate({ notes: e.target.value || null })
                }
              />
            </CardContent>
          </Card>

          {/* After the description because that is the order the PDF prints in:
              the editor should read the way the document reads. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Closing statement</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={3}
                className="text-base sm:text-[13px]"
                placeholder="Terms, what happens next — prints after the totals."
                defaultValue={est.closing_statement ?? ""}
                onBlur={(e) =>
                  e.target.value !== (est.closing_statement ?? "") &&
                  patchEstimate.mutate({ closing_statement: e.target.value || null })
                }
              />
            </CardContent>
          </Card>

          {view === "sheet" ? (
            <EstimateSheet
              estimateId={id}
              scopes={scopes}
              lines={lines}
              pricing={pricing}
              rate={rate}
              onChanged={refresh}
              onLinePatched={refreshTotals}
            />
          ) : scopes.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <Layers className="mx-auto mb-2 size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  An estimate is built from scopes — a trade plus a room, each with its own lines.
                </p>
                <Button className="mt-3" onClick={() => addScope.mutate()}>
                  <Plus className="mr-2 size-4" /> Add first scope
                </Button>
              </CardContent>
            </Card>
          ) : (
            scopes.map((scope) => (
              <ScopeCard
                key={scope.id}
                scope={scope}
                lines={byScope.get(scope.id) ?? []}
                docLines={lines}
                rate={rate}
                estimateId={id}
                locationId={est.location_id}
                rooms={rooms}
                onChanged={refresh}
                onLinePatched={refreshTotals}
                onAddLines={() => setPickerScope(scope.id)}
              />
            ))
          )}

          {view === "table" && scopes.length > 0 && (
            <Button variant="outline" onClick={() => addScope.mutate()}>
              <Plus className="mr-2 size-4" /> Add scope
            </Button>
          )}
        </div>

        <BillingRail label={estimateLabel(est.seq)}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Totals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {/* Subtotal is the gross work: the stored one is already net of
                  the discounts, which belong on their own deduction lines. */}
              <Row label="Subtotal" value={fmtMoney(scopeSubtotal(lines))} />
              {discounts.map((d) => (
                <Row
                  key={d.id}
                  label={discountLabel(d, lines)}
                  value={`−${fmtMoney(discountAmount(d))}`}
                />
              ))}
              <Row
                label={`Tax (${(rate * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%)`}
                value={fmtMoney(est.tax)}
              />
              <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{fmtMoney(est.total)}</span>
              </div>
              <div className="pt-2">
                <Label className="text-xs">Tax rate override</Label>
                <Input
                  type="number"
                  step="0.0001"
                  inputMode="decimal"
                  className={MOBILE_FIELD}
                  defaultValue={rate}
                  onBlur={(e) => {
                    const v = num(e.target.value);
                    if (v !== rate) patchEstimate.mutate({ tax_rate: v });
                  }}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Defaults to the rate in Admin → Estimate catalog.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Below Totals, collapsed by default: the number people came to the
              sidebar for must never be pushed off the screen by a keypad. */}
          <CalculatorPanel />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="space-y-1">
                {/* The column is still `title` — it is referenced elsewhere —
                    but what goes in it is a sentence the customer reads above
                    the work, not a filing label, so it gets room to be one. */}
                <Label className="text-xs">Opening statement</Label>
                <Textarea
                  rows={3}
                  className="text-base sm:text-[13px]"
                  placeholder="How the document opens — prints above the description."
                  defaultValue={est.title ?? ""}
                  onBlur={(e) => {
                    if (e.target.value !== (est.title ?? ""))
                      patchEstimate.mutate({ title: e.target.value || null });
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Call date</Label>
                  <Input
                    type="date"
                    className={MOBILE_FIELD}
                    defaultValue={est.call_date ?? ""}
                    onBlur={(e) => patchEstimate.mutate({ call_date: e.target.value || null })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Estimate date</Label>
                  <Input
                    type="date"
                    className={MOBILE_FIELD}
                    defaultValue={est.estimate_date}
                    onBlur={(e) =>
                      e.target.value && patchEstimate.mutate({ estimate_date: e.target.value })
                    }
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/*
           * No "Office" card — the invoice's twin went for the same reason.
           * Since the rail cards moved into the page rail (#110) this sat in
           * the same column as the job's Bill to card, which already ends with
           * "Bills as <entity>".
           *
           * David, looking at the invoice version of it: "billing office is
           * bill as over here also. So technically it's quite repetitious."
           *
           * And this card was the less trustworthy of the two: est.office_* is
           * a snapshot of the job's operating location taken at creation,
           * while the PDF brands itself from `est.job.billing_location ??
           * est.location` — the live office the Bills-as line names and edits.
           */}
        </BillingRail>
      </div>

      <EstimateLinePicker
        open={!!pickerScope}
        onOpenChange={(v) => setPickerScope(v ? pickerScope : null)}
        priceBook={pricing.book}
        agreementLabel={pricing.labels[0] ?? null}
        onAdd={async (items) => {
          if (!pickerScope) return;
          await addLines.mutateAsync({ scopeId: pickerScope, items });
        }}
      />

      <RecordHistoryCard type="estimate" id={id} />

      {!app.userId && null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/**
 * A line row that only its grip can drag. The row is wall-to-wall inputs, so a
 * whole-row drag would fight text selection in every cell.
 */
function SortableLineRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <tr
      ref={setNodeRef}
      style={{
        // x is pinned: a row that drifts sideways escapes the table it belongs to.
        transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null),
        transition,
      }}
      className={`group border-b align-top last:border-0 ${
        isDragging ? "relative z-10 bg-muted/60 shadow-sm" : ""
      }`}
    >
      <td className="w-8 px-1 py-2 align-middle">
        <button
          type="button"
          aria-label="Drag to reorder line"
          disabled={disabled}
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing disabled:pointer-events-none disabled:opacity-40"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      </td>
      {children}
    </tr>
  );
}

/**
 * A deduction taken off the whole document: percentage or flat dollars, its
 * reason, and what it comes to. There is deliberately no line picker here any
 * more — a discount aimed at one line is created from that line's own Discount
 * button, which is the only place the `LN:` targeting marker is now written.
 */
function DiscountRow({
  line,
  docLines,
  disabled,
  focused,
  onPatch,
  onRemove,
}: {
  line: EstimateLine;
  /** Every line on the estimate: an untargeted discount is off the whole job. */
  docLines: EstimateLine[];
  disabled: boolean;
  /** Just created or just jumped to from a line's Discount button. */
  focused?: boolean;
  onPatch: (patch: TablesUpdate<"estimate_lines">) => void;
  onRemove: () => void;
}) {
  const pct = discountPercent(line);
  const amount = discountAmount(line);
  // Measured against the lines it was aimed at, or the whole document when it
  // was aimed at none, and never worth more than that.
  const base = discountBase(line, docLines);
  const cap = (v: number) => Math.min(v, Math.max(base, 0));
  return (
    // Wraps rather than scrolls: a discount is five controls wide and a phone
    // has room for two of them per line.
    <div
      id={`discount-${line.id}`}
      className={`flex flex-wrap items-center gap-1.5 rounded-sm ${
        focused ? "ring-2 ring-primary ring-offset-1" : ""
      }`}
    >
      <Select
        value={pct == null ? "amount" : "percent"}
        onValueChange={(v) => {
          // Switching kind holds the money still: the percent that produces
          // today's dollars, or the dollars today's percent produces.
          const next = v === "percent" ? (base > 0 ? round2((amount / base) * 100) : 0) : null;
          onPatch({
            code: discountCode(next),
            unit_price: discountUnitPrice(cap(next == null ? amount : (base * next) / 100)),
          });
        }}
      >
        <SelectTrigger className="h-11 w-[6.5rem] shrink-0 text-base sm:h-7 sm:w-[5.5rem] sm:text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="amount">$ off</SelectItem>
          <SelectItem value="percent">% off</SelectItem>
        </SelectContent>
      </Select>
      {/* A dollar discount groups as it is typed; a percent one never reaches
          a comma. `num()` is parseFloat-based and would read "1,250" as 1, so
          the parsed number comes from the box, never its text. */}
      <NumberInput
        key={pct == null ? "amount" : "percent"}
        decimals={2}
        disabled={disabled}
        defaultValue={pct ?? amount}
        className="h-11 w-24 shrink-0 px-1 text-right text-base sm:h-7 sm:text-[13px]"
        onCommit={(n) => {
          const v = Math.abs(n ?? 0);
          onPatch(
            pct == null
              ? { unit_price: discountUnitPrice(cap(v)) }
              : { code: discountCode(v), unit_price: discountUnitPrice(cap((base * v) / 100)) },
          );
        }}
      />
      {/* The figure the deduction is a percentage of. Without it a discount on
          the whole job, typed into whichever scope was open, reads as a number
          that does not divide into anything on the card. */}
      <span className="shrink-0 text-xs text-muted-foreground">of {fmtMoney(base)}</span>
      <Input
        defaultValue={line.note ?? ""}
        placeholder="Reason for the discount"
        disabled={disabled}
        className="h-11 w-full min-w-0 shrink px-2 text-base sm:ml-auto sm:h-7 sm:w-[16rem] sm:text-xs"
        onBlur={(e) =>
          e.target.value !== (line.note ?? "") && onPatch({ note: e.target.value || null })
        }
      />
      <span className="w-24 shrink-0 text-right text-sm tabular-nums">−{fmtMoney(amount)}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 text-destructive sm:size-7"
        title="Remove discount"
        aria-label="Remove discount"
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function ScopeCard({
  scope,
  lines,
  docLines,
  rate,
  estimateId,
  locationId,
  rooms,
  onChanged,
  onLinePatched,
  onAddLines,
}: {
  scope: EstimateScope;
  lines: EstimateLine[];
  /**
   * Every line on the estimate. A discount with no line targets is off the
   * whole job, so it cannot be resolved from the scope it was typed into.
   */
  docLines: EstimateLine[];
  rate: number;
  estimateId: string;
  locationId: string;
  /** The job's rooms, offered for the scope's room. */
  rooms: JobRoom[];
  /** The set of lines or scopes changed — everything refetches. */
  onChanged: () => void;
  /** One line was edited in place — only the server-computed totals refetch. */
  onLinePatched: () => void;
  onAddLines: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  // Same flag the editor keys the lines query on; the optimistic patch
  // below must land in that cache entry.
  const canSeeCosts = useCan("job.view_costs");
  const isMobile = useIsMobile();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState(scope.name);

  const patchScope = useMutation({
    mutationFn: async (patch: TablesUpdate<"estimate_scopes">) => {
      const { error } = await supabase.from("estimate_scopes").update(patch).eq("id", scope.id);
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e: Error) => toast.error(e.message),
  });

  const removeScope = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("estimate_scopes").delete().eq("id", scope.id);
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e: Error) => toast.error(e.message),
  });

  const patchLine = useMutation({
    mutationFn: async ({
      lineId,
      patch,
    }: {
      lineId: string;
      patch: TablesUpdate<"estimate_lines">;
    }) => {
      const { error } = await supabase.from("estimate_lines").update(patch).eq("id", lineId);
      if (error) throw error;
    },
    onSuccess: (_r, { lineId, patch }) => {
      // `subtotal` is generated in the database as quantity * unit_price.
      // Repeating that one multiplication here is what lets an edited line
      // skip the refetch that used to redraw the whole document mid-edit.
      qc.setQueryData<EstimateLine[]>(
        ["estimate-lines", estimateId, { costs: canSeeCosts }],
        (prev) =>
          prev?.map((l) => {
            if (l.id !== lineId) return l;
            const next = { ...l, ...patch } as EstimateLine;
            return { ...next, subtotal: round2(num(next.quantity) * num(next.unit_price)) };
          }),
      );
      onLinePatched();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeLine = useMutation({
    mutationFn: async (lineId: string) => {
      const { error } = await supabase.from("estimate_lines").delete().eq("id", lineId);
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e: Error) => toast.error(e.message),
  });

  // A discount is a deduction, not work: it stays out of the table, out of the
  // drag ordering, and is reconciled against the scope subtotal below.
  const { items, discounts } = useMemo(() => splitDiscounts(lines), [lines]);
  const gross = scopeSubtotal(lines);

  // The dropped row has to land before the write and the refetch behind it.
  // The override goes stale the moment the scope gains or loses a line, which
  // is what the length check below falls back on.
  const [order, setOrder] = useState<string[] | null>(null);
  const ordered = useMemo(() => {
    if (!order) return items;
    const byId = new Map(items.map((l) => [l.id, l]));
    const next = order.flatMap((lineId) => byId.get(lineId) ?? []);
    return next.length === items.length ? next : items;
  }, [items, order]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Renumber the whole scope rather than swapping the two rows: gaps in
  // `position` are what make the next inserted line land in the middle.
  const reorder = useMutation({
    mutationFn: async ({ ids }: { ids: string[]; previous: string[] }) => {
      const results = await Promise.all(
        ids.map((lineId, i) =>
          supabase.from("estimate_lines").update({ position: i }).eq("id", lineId),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    },
    onSuccess: onChanged,
    onError: (e, vars) => {
      setOrder(vars.previous);
      toastDbError(e, { action: "Reordering the line items" });
    },
  });

  const move = (from: number, to: number) => {
    const previous = ordered.map((l) => l.id);
    if (from < 0 || to < 0 || from >= previous.length || to >= previous.length) return;
    const ids = arrayMove(previous, from, to);
    setOrder(ids);
    reorder.mutate({ ids, previous });
  };

  const onLineDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const previous = ordered.map((l) => l.id);
    move(previous.indexOf(active.id as string), previous.indexOf(over.id as string));
  };

  // A discount carries its reason rather than being shaved off a unit price —
  // the give-away has to stay auditable. See the encoding note in estimates.ts.
  const addDiscount = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("estimate_lines").insert({
        estimate_id: estimateId,
        scope_id: scope.id,
        name: "Discount",
        uom: "LS",
        quantity: 1,
        unit_price: 0,
        unit_cost: 0,
        code: null,
        // Off the whole job, so its taxability follows the whole job.
        taxable: discountIsTaxable(docLines),
        is_discount: true,
        note: "",
        position: lines.length,
      });
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e: Error) => toast.error(e.message),
  });

  /*
   * Straight into the table rather than through a dialog: the row is already
   * fully inline-editable, and someone adding a subcontractor charge or an odd
   * material knows perfectly well it is not in the catalog. No catalog item and
   * no code is what marks it ad hoc.
   */
  const addCustomLine = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("estimate_lines").insert({
        estimate_id: estimateId,
        scope_id: scope.id,
        catalog_item_id: null,
        code: null,
        name: "Custom item",
        description: null,
        uom: "EA",
        quantity: 1,
        unit_cost: 0,
        unit_price: 0,
        taxable: true,
        position: lines.length,
      });
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e) => toastDbError(e, { action: "Adding a custom line" }),
  });

  /*
   * The per-line discount shortcut. It is not a second discount mechanism: it
   * creates an ordinary discount row already carrying this line's id in the
   * `LN:` marker the targeting picker reads, so everything downstream — the
   * resolver, the totals stack, both PDFs — is untouched.
   */
  const [focusDiscount, setFocusDiscount] = useState<string | null>(null);
  useEffect(() => {
    if (!focusDiscount) return;
    // The discount strip lives under the table, so the row has to be brought
    // to the user rather than the user sent looking for it.
    document
      .getElementById(`discount-${focusDiscount}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setFocusDiscount(null), 2500);
    return () => clearTimeout(t);
  }, [focusDiscount]);

  const addLineDiscount = useMutation({
    mutationFn: async (lineId: string) => {
      // A targeted discount prints as its own row inside the scope table, in
      // position order with the work — so it has to sit directly under the line
      // it comes off, not at the bottom of the scope. Everything below shifts
      // down first, highest position first so no two rows collide mid-flight.
      const target = lines.find((l) => l.id === lineId);
      const at = (target ? num(target.position) : lines.length) + 1;
      const below = lines
        .filter((l) => num(l.position) >= at)
        .sort((a, b) => num(b.position) - num(a.position));
      for (const l of below) {
        const { error: shiftErr } = await supabase
          .from("estimate_lines")
          .update({ position: num(l.position) + 1 })
          .eq("id", l.id);
        if (shiftErr) throw shiftErr;
      }
      const { data, error } = await supabase
        .from("estimate_lines")
        .insert({
          estimate_id: estimateId,
          scope_id: scope.id,
          name: "Discount",
          uom: "LS",
          quantity: 1,
          unit_price: 0,
          unit_cost: 0,
          code: null,
          taxable: discountIsTaxable(target ? [target] : docLines),
          is_discount: true,
          note: "",
          description: discountTargetMark([lineId]),
          position: at,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (newId) => {
      setFocusDiscount(newId);
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "Discounting the line" }),
  });

  const discountLine = (lineId: string) => {
    // A second deduction against the same single line would just be confusing
    // arithmetic; jump to the one that is already there instead.
    const existing = discounts.find((d) => {
      const t = discountTargets(d);
      return t.length === 1 && t[0] === lineId;
    });
    if (existing) {
      setFocusDiscount(existing.id);
      return;
    }
    addLineDiscount.mutate(lineId);
  };

  /*
   * A percentage discount is stored as resolved dollars, because the database
   * sums the generated subtotal — so it has to be re-resolved whenever the work
   * it is measured against moves: its own lines, or every line on the document
   * when it targets none. The taxable flag is settled here too: taxable so the
   * discount pulls the taxable base down, non-taxable against exempt work so
   * it can never mint negative tax. Both settle on one pass and then stop.
   */
  const settled = discounts
    .map((d) => `${d.id}:${d.unit_price}:${d.taxable}:${d.description ?? ""}`)
    // Every work line on the document, not just this scope's: a discount off
    // the whole job moves when a line in any other scope is priced.
    .concat(splitDiscounts(docLines).items.map((l) => `${l.id}:${l.subtotal}:${l.taxable}`))
    .join("|");
  useEffect(() => {
    if (app.writesDisabled) return;
    for (const d of discounts) {
      const unit_price = discountUnitPrice(discountResolved(d, docLines));
      const taxable = discountTaxable(d, docLines);
      if (num(d.unit_price) === unit_price && d.taxable === taxable && num(d.quantity) === 1) {
        continue;
      }
      patchLine.mutate({ lineId: d.id, patch: { unit_price, taxable, quantity: 1 } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, app.writesDisabled]);

  const saveTemplate = useMutation({
    mutationFn: async () => {
      if (!app.userId) throw new Error("Not signed in");
      return saveScopeAsTemplate(templateName.trim(), lines, app.userId, locationId);
    },
    onSuccess: () => {
      toast.success("Scope saved as a template");
      setTemplateOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const total = scopeTotal(lines);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-2">
          <Input
            defaultValue={scope.name}
            placeholder="Scope (e.g. Mold Remediation)"
            className={`${MOBILE_FIELD} font-semibold`}
            onBlur={(e) =>
              e.target.value !== scope.name && patchScope.mutate({ name: e.target.value })
            }
          />
          <RoomNamePicker
            value={scope.room_name}
            rooms={rooms}
            className={MOBILE_FIELD}
            onChange={(room_name) => patchScope.mutate({ room_name })}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-sm font-semibold tabular-nums">{fmtMoney(total)}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 sm:size-7"
            title="Save as scope template"
            aria-label="Save as scope template"
            onClick={() => setTemplateOpen(true)}
          >
            <BookmarkPlus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 text-destructive sm:size-7"
            title="Delete scope"
            aria-label="Delete scope"
            onClick={() => removeScope.mutate()}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {/*
         * Two renderings of the same lines, chosen by width — never both. The
         * nine-column table is unusable at 390px (eight screens of sideways
         * scrolling to price one line), and a phone cannot drag-reorder while
         * the same vertical gesture scrolls the page, so the card carries
         * explicit up/down buttons instead of the grip.
         */}
        {isMobile ? (
          items.length === 0 ? (
            <div className="border-t px-3 py-6 text-center text-sm text-muted-foreground">
              No lines yet.
            </div>
          ) : (
            <div className="border-t">
              {ordered.map((l, i) => (
                <LineItemCard
                  key={l.id}
                  line={l}
                  rate={rate}
                  disabled={app.writesDisabled}
                  index={i}
                  count={ordered.length}
                  onPatch={(patch) => patchLine.mutate({ lineId: l.id, patch })}
                  onMove={(to) => move(i, to)}
                  onDiscount={() => discountLine(l.id)}
                  onRemove={() => removeLine.mutate(l.id)}
                />
              ))}
            </div>
          )
        ) : (
          <div className="overflow-x-auto">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              // Re-measure as rows swap, otherwise the gap lags the pointer.
              measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
              onDragEnd={onLineDragEnd}
            >
              {/*
               * A minimum width on the table, not just the wrapper: without it the
               * fixed numeric columns win and Item collapses to a few characters,
               * which is how "Soot" and "FIR-SOOT" ended up stacked vertically.
               * Below this width the container scrolls instead of crushing cells.
               */}
              <table className="w-full min-w-[64rem] text-sm">
                <thead className="border-y bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="w-8 px-1 py-1.5" />
                    <th className="min-w-[20rem] px-3 py-1.5 text-left">Item</th>
                    <th className="w-24 px-2 py-1.5 text-right">Qty</th>
                    <th className="w-24 px-2 py-1.5 text-left">UOM</th>
                    {canSeeCosts && <th className="w-28 px-2 py-1.5 text-right">Cost</th>}
                    <th className="w-28 px-2 py-1.5 text-right">Unit price</th>
                    <th className="w-28 px-2 py-1.5 text-right">Subtotal</th>
                    <th className="w-16 px-2 py-1.5 text-center">Tax</th>
                    <th className="w-28 px-2 py-1.5 text-right">Total</th>
                    <th className="w-10 px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td
                        colSpan={canSeeCosts ? 10 : 9}
                        className="px-3 py-6 text-center text-sm text-muted-foreground"
                      >
                        No lines yet.
                      </td>
                    </tr>
                  ) : (
                    <SortableContext
                      items={ordered.map((l) => l.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {ordered.map((l) => (
                        <SortableLineRow key={l.id} id={l.id} disabled={app.writesDisabled}>
                          <td className="px-3 py-1.5">
                            <Input
                              defaultValue={l.name}
                              className="h-7 border-transparent px-1 font-medium shadow-none hover:border-input focus-visible:border-input"
                              onBlur={(e) =>
                                e.target.value !== l.name &&
                                patchLine.mutate({ lineId: l.id, patch: { name: e.target.value } })
                              }
                            />
                            <Textarea
                              rows={1}
                              defaultValue={l.description ?? ""}
                              placeholder="Description"
                              className="mt-0.5 min-h-0 resize-y border-transparent px-1 py-0.5 text-xs text-muted-foreground shadow-none hover:border-input focus-visible:border-input"
                              onBlur={(e) =>
                                patchLine.mutate({
                                  lineId: l.id,
                                  patch: { description: e.target.value || null },
                                })
                              }
                            />
                            {l.code && (
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {l.code}
                              </span>
                            )}
                          </td>
                          {/* Qty takes a sum too. Measuring a wall is "12.5 * 3
                        + 4" far more often than it is one number, and a spinner
                        that only steps by 0.01 was no help with that. */}
                          <td className="px-2 py-1.5">
                            <CalcInput
                              value={num(l.quantity)}
                              title="Type a number or a sum, e.g. 12.5 * 3 + 4"
                              format={fmtQuantity}
                              className="h-7 px-1 text-right"
                              onCommit={(v) =>
                                patchLine.mutate({ lineId: l.id, patch: { quantity: v } })
                              }
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <Select
                              value={l.uom}
                              onValueChange={(v) =>
                                patchLine.mutate({ lineId: l.id, patch: { uom: v } })
                              }
                            >
                              <SelectTrigger className="h-7 px-1.5 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {[...new Set([l.uom, ...UOMS])].map((u) => (
                                  <SelectItem key={u} value={u}>
                                    {u}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          {/* Cost takes a sum rather than a number — the rate
                        someone is given is often "1250 / 3". A viewer without
                        job.view_costs has no Cost column at all. */}
                          {canSeeCosts && (
                            <td className="px-2 py-1.5">
                              {l.unit_cost == null ? null : (
                                <CalcInput
                                  value={num(l.unit_cost)}
                                  title="Type a number or a sum, e.g. 1250 / 3"
                                  className="h-7 px-1 text-right"
                                  onCommit={(v) =>
                                    patchLine.mutate({ lineId: l.id, patch: { unit_cost: v } })
                                  }
                                />
                              )}
                            </td>
                          )}
                          <td className="px-2 py-1.5">
                            {/* A rate is copied off a sheet, not computed in
                                the box — David: "unit price needs no
                                calculator". Qty still takes a sum. */}
                            <PlainNumberInput
                              value={num(l.unit_price)}
                              title="The rate itself — a plain number"
                              className="h-7 px-1 text-right"
                              onCommit={(v) =>
                                patchLine.mutate({ lineId: l.id, patch: { unit_price: v } })
                              }
                            />
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {fmtMoney(l.subtotal)}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <Switch
                              checked={l.taxable}
                              onCheckedChange={(v) =>
                                patchLine.mutate({ lineId: l.id, patch: { taxable: v } })
                              }
                            />
                            <div className="text-[10px] text-muted-foreground tabular-nums">
                              {fmtMoney(lineTax(l, rate))}
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right font-medium tabular-nums">
                            {fmtMoney(lineTotal(l, rate))}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="flex items-center justify-end gap-0.5">
                              {/* Hidden until the row is hovered: it is a rare action
                            and nine columns of chrome is already a lot. Touch
                            reaches it through the stacked card instead. */}
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Discount this line"
                                title="Take a discount off this line"
                                disabled={app.writesDisabled}
                                className="size-7 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                                onClick={() => discountLine(l.id)}
                              >
                                <Percent className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete line"
                                className="size-7 text-destructive"
                                onClick={() => removeLine.mutate(l.id)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </td>
                        </SortableLineRow>
                      ))}
                    </SortableContext>
                  )}
                </tbody>
              </table>
            </DndContext>
          </div>
        )}
        {discounts.length > 0 && (
          <div className="space-y-1.5 border-t bg-muted/20 p-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Scope subtotal</span>
              <span className="tabular-nums">{fmtMoney(gross)}</span>
            </div>
            {discounts.map((d) => (
              <DiscountRow
                key={d.id}
                line={d}
                docLines={docLines}
                disabled={app.writesDisabled}
                focused={focusDiscount === d.id}
                onPatch={(patch) => patchLine.mutate({ lineId: d.id, patch })}
                onRemove={() => removeLine.mutate(d.id)}
              />
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t p-2">
          <Button size="sm" className="h-11 sm:h-7" onClick={onAddLines}>
            <Plus className="mr-1.5 size-3.5" /> Add line items
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-11 sm:h-7"
            disabled={app.writesDisabled || addCustomLine.isPending}
            onClick={() => addCustomLine.mutate()}
          >
            <Plus className="mr-1.5 size-3.5" /> Custom line
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-11 sm:h-7"
            onClick={() => addDiscount.mutate()}
          >
            Add discount
          </Button>
          <ApplyTemplateButton
            estimateId={estimateId}
            scopeId={scope.id}
            startPosition={lines.length}
            onApplied={onChanged}
          />
        </div>
      </CardContent>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save scope as template</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Template name</Label>
            <Input
              className={MOBILE_FIELD}
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Saves {lines.length} line(s) for reuse on future estimates.
            </p>
          </div>
          <DialogFooter>
            <Button
              disabled={!templateName.trim() || saveTemplate.isPending}
              onClick={() => saveTemplate.mutate()}
            >
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function ApplyTemplateButton({
  estimateId,
  scopeId,
  startPosition,
  onApplied,
}: {
  estimateId: string;
  scopeId: string;
  startPosition: number;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);

  const templatesQ = useQuery({
    enabled: open,
    queryKey: ["estimate-scope-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("estimate_scope_templates")
        .select("id, name, description")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const apply = useMutation({
    mutationFn: (templateId: string) =>
      applyScopeTemplate(templateId, estimateId, scopeId, startPosition),
    onSuccess: (count) => {
      toast.success(`${count} line(s) added`);
      setOpen(false);
      onApplied();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <Button size="sm" variant="outline" className="h-11 sm:h-7" onClick={() => setOpen(true)}>
        <Layers className="mr-1.5 size-3.5" /> Apply template
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply a scope template</DialogTitle>
          </DialogHeader>
          <div className="max-h-[50svh] overflow-y-auto rounded-sm border">
            {(templatesQ.data ?? []).length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No templates saved yet. Build a scope, then use the bookmark icon to save it.
              </div>
            ) : (
              (templatesQ.data ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={apply.isPending}
                  onClick={() => apply.mutate(t.id)}
                  className="block min-h-11 w-full border-b px-3 py-2.5 text-left text-sm last:border-0 hover:bg-muted/50"
                >
                  <span className="font-medium">{t.name}</span>
                  {t.description && (
                    <span className="block text-xs text-muted-foreground">{t.description}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
