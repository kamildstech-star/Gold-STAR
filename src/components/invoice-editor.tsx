import { InvoiceFollowupPanel } from "@/components/invoice-followup-panel";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isMissingSchema } from "@/lib/schema-fallback";
import { Link, useNavigate } from "@tanstack/react-router";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RoomNamePicker } from "@/components/room-name-picker";
import { fetchJobRooms, type JobRoom } from "@/lib/job-rooms";
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
import { ArrowLeft, GripVertical, Layers, Percent, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { cn } from "@/lib/utils";
import { BillingRail, useBillingRailTarget } from "@/components/billing-rail";
import { CalcInput, CalculatorPanel, PlainNumberInput } from "@/components/calc-input";
import { normalizeStateCode } from "@/lib/us-states";
import { LineItemCard } from "@/components/line-item-card";
import { EstimateLinePicker } from "@/components/estimate-line-picker";
import { useIsMobile } from "@/hooks/use-mobile";
import { AccountDiscountCallout } from "@/components/standing-notes";
import { ReportFiltersButton } from "@/components/report-filters-dialog";
import { DocumentPreviewButton } from "@/components/document-preview-button";
import { InvoiceEmailButton } from "@/components/invoice-email-button";
import { InvoicePhotosCard } from "@/components/invoice-photos";
import { InvoicePullPanel } from "@/components/invoice-pull-panel";
import { RevisionHistoryButton } from "@/components/revision-history";
import { syncDraftRevision } from "@/lib/revisions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import type { TablesUpdate } from "@/integrations/supabase/types";
import {
  INVOICE_STATUSES,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  type InvoiceStatus,
} from "@/lib/billing";
import { RecordHistoryCard } from "@/components/record-timeline";
import { invoiceVariance } from "@/lib/estimate-invoice";
import {
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
  fmtMoney,
  fmtQuantity,
  lineTax,
  lineTotal,
  num,
  round2,
  scopeSubtotal,
  scopeTotal,
  splitDiscounts,
  UOMS,
} from "@/lib/estimates";
import type { InvoiceLine, InvoiceScope } from "@/lib/invoices";
import type { CatalogItemPublic } from "@/lib/estimates";
import { INVOICE_LINE_SELECT, fetchInvoiceLineCosts, mergeLineCosts } from "@/lib/line-costs";
import { fetchDocumentPricing, NO_DOCUMENT_PRICING, resolveCatalogPrice } from "@/lib/price-lists";
import { JobRateSource } from "@/components/billing-costs/job-rate-source";
import { useCan } from "@/lib/permissions";
import { refreshJobMoney } from "@/lib/use-job-commission";

/**
 * Text under 16px makes iOS zoom the page in on focus and never zoom back, so
 * every field grows to a thumb-sized 44px box with 16px text below the
 * breakpoint and returns to the dense desktop size above it. Kept identical to
 * the estimate editor: the two line editors must not drift.
 */
const MOBILE_FIELD = "h-11 text-base sm:h-8 sm:text-[13px]";

interface FullInvoice {
  current_version: number;
  id: string;
  invoice_number: string;
  job_id: string | null;
  account_id: string | null;
  location_id: string;
  estimate_id: string | null;
  status: InvoiceStatus;
  title: string | null;
  issue_date: string;
  due_date: string | null;
  carrier: string | null;
  claim_number: string | null;
  adjuster_name: string | null;
  adjuster_email: string | null;
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
  billed_amount: number;
  line_itemized: boolean;
  /** Job Pictures grid ids, in print order. Null until the migration lands. */
  photo_ids: string[] | null;
  photo_share_link_id: string | null;
  /** False when the photo columns are not in the database yet. */
  photos_migrated: boolean;
}

/**
 * The invoice builder — the estimate builder's twin. Rendered inline on a job's
 * Billing tab. Totals come from the lines; the typed "billed amount" survives
 * only on a quick invoice.
 */
export function InvoiceEditor({
  invoiceId: id,
  embedded = false,
  onChanged,
  onMarkPaid,
  canMarkPaid = true,
}: {
  invoiceId: string;
  embedded?: boolean;
  onChanged?: () => void;
  /**
   * False when this person may not record the payment that Paid needs (not a
   * manager of the office, not who raised it): the status menu then has no
   * Paid option at all, rather than one that refuses.
   */
  canMarkPaid?: boolean;
  /**
   * Asked for instead of writing `status = 'paid'` here. Paid is derived from
   * `invoice_payments` by the rollup trigger, and this editor never loads the
   * collected figure, so it is in no position to decide whether money is still
   * owed — the owner of the payment dialog is. See `lib/invoice-paid.ts`.
   */
  onMarkPaid?: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pickerScope, setPickerScope] = useState<string | null>(null);
  /* Whether this editor's rail cards go to the page's own rail instead of into
     a second column of our own. A hook, so it must run before the early
     returns below for a missing record. */
  const railed = useBillingRailTarget() != null;

  const invoiceQ = useQuery({
    queryKey: ["invoice", id],
    // Nothing on this page may unmount while it refetches — the editor is
    // autosaving under the user's hands.
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<FullInvoice> => {
      /*
       * closing_statement, and now the photo columns, shipped ahead of their
       * migrations. PostgREST fails the whole read on one unknown column, so
       * asking for them unconditionally takes down the entire invoice rather
       * than the one field. Newest columns are dropped first.
       */
      const base =
        "id, invoice_number, current_version, job_id, account_id, location_id, estimate_id, status, title, issue_date, due_date, carrier, claim_number, adjuster_name, adjuster_email, job_number, customer_name, address, address_line2, locality, region, postal_code, office_name, office_phone, office_email, office_address, tax_rate, notes, subtotal, tax, total, billed_amount, line_itemized";
      const full = await supabase
        .from("invoices")
        .select(`${base}, closing_statement, photo_ids, photo_share_link_id`)
        .eq("id", id)
        .single();
      if (!full.error) return { ...(full.data as object), photos_migrated: true } as FullInvoice;
      if (!isMissingSchema(full.error)) throw full.error;
      const noPhotos = { photo_ids: null, photo_share_link_id: null, photos_migrated: false };
      const mid = await supabase
        .from("invoices")
        .select(`${base}, closing_statement`)
        .eq("id", id)
        .single();
      if (!mid.error) return { ...(mid.data as object), ...noPhotos } as FullInvoice;
      if (!isMissingSchema(mid.error)) throw mid.error;
      const fallback = await supabase.from("invoices").select(base).eq("id", id).single();
      if (fallback.error) throw fallback.error;
      return { ...(fallback.data as object), closing_statement: null, ...noPhotos } as FullInvoice;
    },
  });

  // The job's rooms, for the scope room picker. An invoice with no job has
  // no list to offer and keeps the text box.
  const roomsQ = useQuery({
    queryKey: ["job-rooms", invoiceQ.data?.job_id],
    queryFn: () => fetchJobRooms(invoiceQ.data!.job_id!),
    enabled: !!invoiceQ.data?.job_id,
  });
  const rooms = roomsQ.data?.rooms ?? [];

  const scopesQ = useQuery({
    queryKey: ["invoice-scopes", id],
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<InvoiceScope[]> => {
      const { data, error } = await supabase
        .from("invoice_scopes")
        .select("id, invoice_id, name, room_name, notes, position")
        .eq("invoice_id", id)
        .order("position");
      if (error) throw error;
      return data ?? [];
    },
  });

  /*
   * Explicit columns: invoice_lines has no table-wide SELECT grant, so a
   * `select("*")` (or naming unit_cost) is "permission denied" for every user.
   * Cost comes through the RPC, only for job.view_costs holders, and is
   * merged here so the optimistic patch below keeps working on one shape; a
   * line whose cost the viewer may not see carries unit_cost: null.
   */
  const canSeeCosts = useCan("job.view_costs");
  const linesQ = useQuery({
    queryKey: ["invoice-lines", id, { costs: canSeeCosts }],
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<InvoiceLine[]> => {
      const [{ data, error }, costs] = await Promise.all([
        supabase
          .from("invoice_lines")
          .select(INVOICE_LINE_SELECT)
          .eq("invoice_id", id)
          .order("position"),
        canSeeCosts ? fetchInvoiceLineCosts(id) : Promise.resolve(null),
      ]);
      if (error) throw error;
      // subtotal is a generated column, typed nullable; it is never null.
      return mergeLineCosts(data ?? [], costs) as InvoiceLine[];
    },
  });

  const sourceQ = useQuery({
    queryKey: ["invoice-source-estimate", invoiceQ.data?.estimate_id],
    enabled: !!invoiceQ.data?.estimate_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("estimates")
        .select("id, seq, total")
        .eq("id", invoiceQ.data!.estimate_id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  /*
   * Snapshotting the document is five round-trips, and the parent callback
   * reloads the whole Billing tab. Neither belongs on a field blur, so both
   * run once the typing pauses. Cancelled on unmount: a timer that fires into
   * a dead component writes a revision nobody asked for. Kept identical to the
   * estimate editor — the two must not drift.
   */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );
  /*
   * The save the person can see. David, 24 Sep: "where do I save this?... I
   * think we may want to have a save button." Every field still saves when
   * you leave it; this says so, and the button commits the field you are in
   * and writes the working version now instead of in two seconds.
   */
  const [settling, setSettling] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const mutating = useIsMutating() > 0;
  const settleNow = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = null;
    setSettling(false);
    // Keeps the working version in step; if the last one has already been
    // sent, this opens the next version rather than touching the frozen
    // snapshot.
    void syncDraftRevision("invoice", id).catch(() => null);
    onChanged?.();
    setSavedAt(new Date());
  };
  const settleLater = () => {
    if (settle.current) clearTimeout(settle.current);
    setSettling(true);
    settle.current = setTimeout(settleNow, 2000);
  };
  const saveNow = () => {
    // Leaving the field is what commits it; do that for them first.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.setTimeout(settleNow, 0);
  };

  /**
   * A line was edited in place. Its own row is already correct in the cache, so
   * only the header comes back — `subtotal`, `tax` and `total` are generated
   * columns and the database is the only thing that knows them.
   */
  const refreshTotals = () => {
    void qc.invalidateQueries({ queryKey: ["invoice", id] });
    // The total is the commission's base: re-read the job's running cost so
    // the Commissions card "auto calculate[s] as the charges get added".
    refreshJobMoney(qc, invoiceQ.data?.job_id);
    settleLater();
  };

  /** The set of lines or scopes changed: everything has to come back. */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["invoice", id] });
    void qc.invalidateQueries({ queryKey: ["invoice-lines", id] });
    void qc.invalidateQueries({ queryKey: ["invoice-scopes", id] });
    refreshJobMoney(qc, invoiceQ.data?.job_id);
    settleLater();
  };

  const inv = invoiceQ.data;
  const scopes = scopesQ.data ?? [];
  const lines = useMemo(() => linesQ.data ?? [], [linesQ.data]);
  const rate = num(inv?.tax_rate);

  const byScope = useMemo(() => {
    const map = new Map<string, InvoiceLine[]>();
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
   * The customer agreement and the branch list for THIS invoice, kept
   * identical to the estimate editor — the two must not drift, or the same
   * work would be quoted at one price and billed at another. Priced on the
   * issue date, and only for lines added from here on: a line already on the
   * invoice keeps the price it was written with, because unit_price is a
   * stored value and nothing in this feature rewrites one. See
   * src/lib/price-lists.ts.
   */
  const pricingQ = useQuery({
    queryKey: [
      "document-pricing",
      inv?.job_id,
      inv?.account_id,
      inv?.location_id,
      inv?.region,
      inv?.issue_date,
    ],
    enabled: !!inv && !!(inv.job_id || inv.account_id || inv.location_id || inv.region),
    queryFn: () =>
      fetchDocumentPricing({
        jobId: inv!.job_id,
        accountId: inv!.account_id,
        locationId: inv!.location_id,
        // The property address on the invoice, which is where the work was.
        stateCode: normalizeStateCode(inv!.region),
        onDate: inv!.issue_date,
      }),
  });
  const pricing = pricingQ.data ?? NO_DOCUMENT_PRICING;

  const patchInvoice = useMutation({
    mutationFn: async (patch: TablesUpdate<"invoices">) => {
      const { error } = await supabase.from("invoices").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  const addScope = useMutation({
    mutationFn: async (): Promise<string> => {
      const { data, error } = await supabase
        .from("invoice_scopes")
        .insert({
          invoice_id: id,
          name: "New scope",
          position: scopes.length,
        })
        .select("id")
        .single();
      if (error) throw error;
      // First scope on a quick invoice promotes it to a real line-item invoice.
      if (!inv?.line_itemized) {
        await supabase.from("invoices").update({ line_itemized: true }).eq("id", id);
      }
      return (data as { id: string }).id;
    },
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  /*
   * 6 Nov (David): "I don't know if we should have this add scope first —
   * these options should be available right away." A new invoice offers Add
   * items at once: it opens the first scope for the person and goes straight
   * to the catalog picker, so the first thing they do is pick lines.
   */
  const addItemsNow = async () => {
    try {
      const scopeId = await addScope.mutateAsync();
      setPickerScope(scopeId);
    } catch {
      /* addScope already toasted */
    }
  };

  const addLines = useMutation({
    mutationFn: async ({ scopeId, items }: { scopeId: string; items: CatalogItemPublic[] }) => {
      const start = (byScope.get(scopeId) ?? []).length;
      const { error } = await supabase.from("invoice_lines").insert(
        items.map((it, i) => ({
          invoice_id: id,
          scope_id: scopeId,
          catalog_item_id: it.id,
          code: it.code,
          name: it.name,
          description: it.description,
          uom: it.uom,
          quantity: 1,
          // unit_cost is deliberately not sent: the client may not be allowed
          // to read the catalog cost, so invoice_lines_fill_cost copies it
          // from the catalog server-side, for every user.
          //
          // The PRICE is resolved here and snapshotted onto the line: the
          // customer's agreement, else the branch list, else the catalog
          // default. Resolving at insert is what makes an agreement change
          // safe — it cannot reach back into a line already billed.
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
  // that is on screen, and an error must never read as "no invoice".
  if (!inv) {
    if (invoiceQ.error) {
      return (
        <div className="p-6 text-sm text-destructive">{(invoiceQ.error as Error).message}</div>
      );
    }
    if (invoiceQ.isLoading) {
      return <div className="p-6 text-sm text-muted-foreground">Loading invoice…</div>;
    }
    return <div className="p-6 text-sm text-destructive">Invoice not found.</div>;
  }

  const address = [inv.address, inv.address_line2, inv.locality, inv.region, inv.postal_code]
    .filter(Boolean)
    .join(", ");
  const variance = sourceQ.data ? invoiceVariance(inv.billed_amount, sourceQ.data.total) : null;

  return (
    <div className={embedded ? "space-y-3" : "space-y-3 p-4"}>
      <AccountDiscountCallout accountId={inv.account_id ?? null} />
      {/* The customer's open balance (FE9) is on the Follow-ups card in the
          rail, beside its on-the-invoice switch — not up here as well. */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {!embedded && (
            <Button asChild variant="ghost" size="sm" className="-ml-2 h-7 px-2 text-xs">
              <BackLink fallbackTo="/billing" label="Billing">
                <ArrowLeft className="mr-1 size-3.5" /> Billing
              </BackLink>
            </Button>
          )}
          <h1 className="display-heavy text-[19px] leading-tight">
            {inv.invoice_number}
            {inv.title ? <span className="text-muted-foreground"> · {inv.title}</span> : null}
          </h1>
          {/* Billing & Costs P4: which rates the job's lines price at. */}
          {inv.job_id && (
            <div className="mt-1">
              <JobRateSource job={{ id: inv.job_id, account_id: inv.account_id }} compact />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {inv.job_id ? (
              <Link
                to="/jobs/$id"
                params={{ id: inv.job_id }}
                className="text-primary hover:underline"
              >
                {inv.job_number ?? "Job"}
              </Link>
            ) : (
              (inv.job_number ?? "No job")
            )}
            {" · "}
            {inv.customer_name ?? "No customer"}
            {address ? ` · ${address}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite" data-save-state>
            {mutating || settling
              ? "Saving…"
              : savedAt
                ? `Saved ${savedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
                : "All changes saved"}
          </span>
          <Button
            size="sm"
            className="h-11 sm:h-8"
            onClick={saveNow}
            disabled={mutating}
            aria-label="Save the invoice"
          >
            Save
          </Button>
          <DocumentPreviewButton kind="invoice" id={inv.id} variant="outline" />
          <InvoiceEmailButton invoice={inv} />
          <RevisionHistoryButton
            kind="invoice"
            recordId={inv.id}
            numberLabel={inv.invoice_number}
            variant="outline"
          />
          <ReportFiltersButton kind="invoice" id={inv.id} />
          <Badge variant="outline" className="font-mono text-[11px]">
            v{inv.current_version ?? 1}
          </Badge>
          <Badge className={INVOICE_STATUS_TONE[inv.status]}>
            {INVOICE_STATUS_LABEL[inv.status]}
          </Badge>
          <Select
            value={inv.status}
            onValueChange={(v) => {
              const next = v as InvoiceStatus;
              // The same rule as the billing panel's row control: Paid follows
              // the money. Without a handler to ask for it, refuse rather than
              // write a paid invoice that collected nothing.
              if (next === "paid") {
                if (!onMarkPaid) {
                  return toast.error("Record the payment to mark this invoice paid.");
                }
                return onMarkPaid();
              }
              patchInvoice.mutate({
                status: next,
                sent_at: next === "sent" ? new Date().toISOString() : undefined,
              });
            }}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVOICE_STATUSES.filter(
                (s) => s !== "paid" || canMarkPaid || inv.status === "paid",
              ).map((s) => (
                <SelectItem key={s} value={s}>
                  {INVOICE_STATUS_LABEL[s]}
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
              than filed after the payment options. It sits here rather than in
              the sidebar because it is the only copy of the field — two boxes
              on one column would desync the moment someone typed in both. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={4}
                className="text-base sm:text-[13px]"
                placeholder="What we did — prints above the line items."
                defaultValue={inv.notes ?? ""}
                onBlur={(e) =>
                  e.target.value !== (inv.notes ?? "") &&
                  patchInvoice.mutate({ notes: e.target.value || null })
                }
              />
            </CardContent>
          </Card>

          {scopes.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center">
                <Layers className="mx-auto mb-2 size-5 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {inv.line_itemized
                    ? "An invoice bills scopes — a trade plus a room, each with its own lines."
                    : `Quick invoice: ${fmtMoney(inv.billed_amount)} billed with no lines. Add a scope to itemize it.`}
                </p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <Button onClick={() => void addItemsNow()} disabled={addScope.isPending}>
                    <Plus className="mr-2 size-4" /> Add items
                  </Button>
                  <Button variant="outline" onClick={() => addScope.mutate()}>
                    <Plus className="mr-2 size-4" /> Add scope
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            scopes.map((scope) => (
              <InvoiceScopeCard
                key={scope.id}
                scope={scope}
                lines={byScope.get(scope.id) ?? []}
                docLines={lines}
                rate={rate}
                invoiceId={id}
                rooms={rooms}
                onChanged={refresh}
                onLinePatched={refreshTotals}
                onAddLines={() => setPickerScope(scope.id)}
              />
            ))
          )}

          {scopes.length > 0 && (
            <Button variant="outline" onClick={() => addScope.mutate()}>
              <Plus className="mr-2 size-4" /> Add scope
            </Button>
          )}

          {/* David, 21 Oct: description above the line items, closing
              statement below them — the order the PDF prints in, so the
              editor reads the way the document reads. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Closing statement</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={3}
                className="text-base sm:text-[13px]"
                placeholder="Terms, what happens next — prints after the totals."
                defaultValue={inv.closing_statement ?? ""}
                onBlur={(e) =>
                  e.target.value !== (inv.closing_statement ?? "") &&
                  patchInvoice.mutate({ closing_statement: e.target.value || null })
                }
              />
            </CardContent>
          </Card>

          {/* After the work, because that is where the PDF prints them: the
              photographs follow the totals and the closing statement. Only
              the invoice row changes here, so only that query comes back. */}
          <InvoicePhotosCard
            invoice={inv}
            migrated={inv.photos_migrated}
            onChanged={() => {
              void qc.invalidateQueries({ queryKey: ["invoice", id] });
              settleLater();
            }}
          />
        </div>

        <BillingRail label={inv.invoice_number}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Totals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {inv.line_itemized ? (
                <>
                  {/* Subtotal is the gross work: the stored one is already net
                      of the discounts, which get their own deduction lines. */}
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
                    value={fmtMoney(inv.tax)}
                  />
                </>
              ) : null}
              <div className="flex items-center justify-between border-t pt-2 text-base font-semibold">
                <span>Billed</span>
                <span className="tabular-nums">{fmtMoney(inv.billed_amount)}</span>
              </div>
              {variance != null && (
                <div className="text-xs text-muted-foreground">
                  {variance === 0
                    ? "Matches the source estimate."
                    : `${variance > 0 ? "+" : "−"}${fmtMoney(Math.abs(variance))} vs the source estimate.`}
                </div>
              )}
              {!inv.line_itemized && (
                <div className="pt-2">
                  <Label className="text-xs">Billed amount</Label>
                  <NumberInput
                    decimals={2}
                    allowMath
                    defaultValue={inv.billed_amount}
                    onCommit={(n) => {
                      const v = n ?? 0;
                      if (v !== Number(inv.billed_amount))
                        patchInvoice.mutate({ billed_amount: v });
                    }}
                  />
                </div>
              )}
              {/* Billing & Costs P4: no tax toggles when generating an invoice —
                  the rate comes from the job and office and shows read only. */}
              <p className="pt-2 text-xs text-muted-foreground" data-tax-read-only>
                Tax rate {(rate * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}% — set by
                the job and office, not on the invoice.
              </p>
            </CardContent>
          </Card>

          {/*
            David, 24 Sep: "I'll see the breakdown on the side, I'll click a
            button to pull it into the invoice." Open by itself on an invoice
            with no lines yet — the quick path — folded otherwise.
          */}
          {/* Automated reminders while it is unpaid (client item 18, 21 Oct). */}
          <InvoiceFollowupPanel invoiceId={inv.id} />

          <InvoicePullPanel
            invoice={inv}
            scopeCount={scopes.length}
            defaultOpen={lines.length === 0}
            onPulled={refresh}
          />

          {/* Below Totals, collapsed by default: the number people came to the
              sidebar for must never be pushed off the screen by a keypad. */}
          <CalculatorPanel />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Carrier</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="space-y-1">
                <Label className="text-xs">Carrier</Label>
                <Input
                  defaultValue={inv.carrier ?? ""}
                  onBlur={(e) =>
                    e.target.value !== (inv.carrier ?? "") &&
                    patchInvoice.mutate({ carrier: e.target.value || null })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Claim #</Label>
                  <Input
                    defaultValue={inv.claim_number ?? ""}
                    onBlur={(e) =>
                      e.target.value !== (inv.claim_number ?? "") &&
                      patchInvoice.mutate({ claim_number: e.target.value || null })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Due date</Label>
                  <Input
                    type="date"
                    defaultValue={inv.due_date ?? ""}
                    onBlur={(e) => patchInvoice.mutate({ due_date: e.target.value || null })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input
                  defaultValue={inv.title ?? ""}
                  onBlur={(e) =>
                    e.target.value !== (inv.title ?? "") &&
                    patchInvoice.mutate({ title: e.target.value || null })
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/*
           * No "Billing office" card. Since the rail cards moved here (#110)
           * it sat two cards below the job's Bill to, which already ends with
           * "Bills as <entity>" — the same fact, twice, in one column.
           *
           * David, on the call, pointing at an open invoice: "billing office
           * is bill as over here also. So technically it's quite repetitious."
           *
           * The one that stays is the job's, and not only because it is the
           * shorter of the two. What this card printed was inv.office_name /
           * office_address / office_phone / office_email — a snapshot taken
           * from the job's OPERATING location when the invoice was created,
           * which setJobBillingLocation never rewrites. What actually prints
           * on the PDF is `inv.job.billing_location ?? inv.location`, the live
           * office behind "Bills as". So the two could disagree, and when they
           * did this card was the one that was wrong. The office's phone and
           * email now live in the Bills-as dialog, off the live row.
           *
           * The columns themselves stay — they back the Invoice.OfficeName
           * merge keys — this is only about showing them a second time.
           */}
          {sourceQ.data && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Source estimate</CardTitle>
              </CardHeader>
              <CardContent className="text-xs">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() =>
                    navigate({ to: "/estimates/$id", params: { id: sourceQ.data!.id } })
                  }
                >
                  ESTIMATE-{sourceQ.data.seq} · {fmtMoney(sourceQ.data.total)}
                </button>
              </CardContent>
            </Card>
          )}
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
      <RecordHistoryCard type="invoice" id={id} />
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
 * A line row that only its grip can drag — the twin of the estimate editor's.
 * The row is wall-to-wall inputs, so a whole-row drag would fight text
 * selection in every cell.
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
  line: InvoiceLine;
  /** Every line on the invoice: an untargeted discount is off the whole job. */
  docLines: InvoiceLine[];
  disabled: boolean;
  /** Just created or just jumped to from a line's Discount button. */
  focused?: boolean;
  onPatch: (patch: TablesUpdate<"invoice_lines">) => void;
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

function InvoiceScopeCard({
  scope,
  lines,
  docLines,
  rate,
  invoiceId,
  rooms,
  onChanged,
  onLinePatched,
  onAddLines,
}: {
  scope: InvoiceScope;
  lines: InvoiceLine[];
  /**
   * Every line on the invoice. A discount with no line targets is off the
   * whole job, so it cannot be resolved from the scope it was typed into.
   */
  docLines: InvoiceLine[];
  rate: number;
  invoiceId: string;
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

  const patchScope = useMutation({
    mutationFn: async (patch: TablesUpdate<"invoice_scopes">) => {
      const { error } = await supabase.from("invoice_scopes").update(patch).eq("id", scope.id);
      if (error) throw error;
    },
    onSuccess: onChanged,
    onError: (e: Error) => toast.error(e.message),
  });

  const removeScope = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("invoice_scopes").delete().eq("id", scope.id);
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
      patch: TablesUpdate<"invoice_lines">;
    }) => {
      const { error } = await supabase.from("invoice_lines").update(patch).eq("id", lineId);
      if (error) throw error;
    },
    onSuccess: (_r, { lineId, patch }) => {
      // `subtotal` is generated in the database as quantity * unit_price.
      // Repeating that one multiplication here is what lets an edited line
      // skip the refetch that used to redraw the whole document mid-edit.
      qc.setQueryData<InvoiceLine[]>(["invoice-lines", invoiceId, { costs: canSeeCosts }], (prev) =>
        prev?.map((l) => {
          if (l.id !== lineId) return l;
          const next = { ...l, ...patch } as InvoiceLine;
          return { ...next, subtotal: round2(num(next.quantity) * num(next.unit_price)) };
        }),
      );
      onLinePatched();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeLine = useMutation({
    mutationFn: async (lineId: string) => {
      const { error } = await supabase.from("invoice_lines").delete().eq("id", lineId);
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
          supabase.from("invoice_lines").update({ position: i }).eq("id", lineId),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    },
    onSuccess: onChanged,
    onError: (e: Error, vars) => {
      setOrder(vars.previous);
      toast.error(e.message);
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
      const { error } = await supabase.from("invoice_lines").insert({
        invoice_id: invoiceId,
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
   * no code is what marks it ad hoc. Kept identical to the estimate editor.
   */
  const addCustomLine = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("invoice_lines").insert({
        invoice_id: invoiceId,
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
          .from("invoice_lines")
          .update({ position: num(l.position) + 1 })
          .eq("id", l.id);
        if (shiftErr) throw shiftErr;
      }
      const { data, error } = await supabase
        .from("invoice_lines")
        .insert({
          invoice_id: invoiceId,
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
         * nine-column table is unusable at 390px, and a phone cannot
         * drag-reorder while the same vertical gesture scrolls the page, so the
         * card carries explicit up/down buttons instead of the grip.
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
              {/* Same minimum as the estimate table — the two must not drift. */}
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
                            <span
                              className="text-[11px] text-muted-foreground"
                              title="Taxable comes from the catalog item — not switched on the invoice."
                            >
                              {l.taxable ? "Yes" : "No"}
                            </span>
                            <div className="text-[10px] tabular-nums text-muted-foreground">
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
        <div className="flex flex-wrap gap-2 border-t p-2">
          <Button size="sm" variant="outline" className="h-11 sm:h-7" onClick={onAddLines}>
            <Plus className="mr-1.5 size-3.5" /> Add items
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
            variant="ghost"
            className="h-11 sm:h-7"
            onClick={() => addDiscount.mutate()}
          >
            Add discount
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
