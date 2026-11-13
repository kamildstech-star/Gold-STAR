import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Boxes,
  ClipboardList,
  Clock3,
  DollarSign,
  Package,
  Plus,
  ScanLine,
  Trash2,
  Warehouse,
} from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { LocationPicker, useDefaultLocationId } from "@/components/location-picker";
import { MetricStrip } from "@/components/metric-strip";
import { CodeScanDialog } from "@/components/code-scan-dialog";
import type { ScanRejection } from "@/lib/code-scan";
import { SupplyOrderForm, type SupplyOrderDraft } from "@/components/supply-order-form";
import { SupplyDeliveryDialog } from "@/components/supply-delivery-dialog";
import { SupplyReceiptPanel } from "@/components/supply-receipt-panel";
import { listSupplyReceipts } from "@/lib/supply-receipts";
import { SupplyCatalogAdmin } from "@/components/supply-catalog-admin";
import { SupplyPurchaseHistory } from "@/components/supply-purchase-history";
import { OrderCardItems, OrderDetailDialog } from "@/components/supply-order-detail";
import { lineVendorId, listSupplyVendors, presetVendor, vendorKey } from "@/lib/supply-vendors";
import { orderDeliveryAddress } from "@/lib/supply-delivery-address";
import { listVendorPrices, priceBook, vendorPriceFor } from "@/lib/supply-vendor-prices";
import { deliveryLines, deliveryProgress } from "@/lib/supply-delivery";
import { VendorOrderEmailPanel } from "@/components/vendor-order-email-panel";
import { PageHeader } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { canViewFinance } from "@/lib/finance";
import {
  depleteStock,
  listPurchases,
  listStock,
  listStockMoves,
  recordPurchase,
  STOCK_REASON_LABEL,
  type StockMoveReason,
} from "@/lib/supply-inventory";
import { supplyItemCode, supplyScanOutcome } from "@/lib/supply-scan";
import {
  composeVendorOrder,
  listVendorEmails,
  listVendorOrderEmails,
  recordVendorOrderEmail,
  vendorNameFor,
} from "@/lib/vendor-order-email";
import {
  itemPriceSpread,
  purchaseItemName,
  spendByItem,
  spendByMonth,
  spendBySupplier,
  spendTotal,
  type SpendGroup,
} from "@/lib/supply-spend";
import { roundMoneyLoose } from "@/lib/money";
import {
  availableTransitions,
  canCancel,
  stageIndex,
  SUPPLY_STAGE_FLOW,
  SUPPLY_STAGE_HINT,
  SUPPLY_STAGE_LABEL,
  VENDOR_EMAIL_ON_APPROVAL,
  type SupplyActor,
} from "@/lib/supply-workflow";
import {
  SUPPLY_STATUSES,
  SUPPLY_STATUS_TONE,
  type SupplyItem,
  type SupplyRequestFull,
  type SupplyStatus,
  cancelRequest,
  catalogueDetailLine,
  catalogueSupplier,
  createRequest,
  describeLines,
  listItems,
  listMyRequests,
  listQueue,
  saveItem,
  setItemActive,
  setStatus,
} from "@/lib/supplies";
import { cn } from "@/lib/utils";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/supplies/")({
  head: () => ({
    meta: [
      { title: "Supplies — Recovery Hub" },
      {
        name: "description",
        content:
          "Ask for gloves, bags, tape and masks in a few taps. Office managers approve, order and mark delivered from a phone.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SuppliesPage,
});

const MANAGER_ROLES = ["owner", "admin", "dev", "regional", "location_manager", "office"];

/** A requester never reads purchasing prices (RLS), so their view has none. */
const EMPTY_BOOK = priceBook([]);

/** Supplies are dollars and cents, not rounded thousands. */
const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function SuppliesPage() {
  const app = useAppContext();
  const userId = app.userId!;
  const isManager = app.roles.some((r) => MANAGER_ROLES.includes(r));
  const isAdmin = app.roles.some((r) => ["owner", "admin", "dev"].includes(r));
  // Spend is money, so it is gated the way the rest of the app gates money —
  // the same test public.can_view_finance() applies to the rows themselves.
  const seesSpend = canViewFinance(app.roles) || isManager;
  const actor: SupplyActor = { userId, isManager };

  const mineQ = useQuery({
    queryKey: ["supply-requests", "mine", userId],
    queryFn: () => listMyRequests(userId),
  });
  const queueQ = useQuery({
    queryKey: ["supply-requests", "queue"],
    queryFn: () => listQueue({}),
    enabled: isManager,
    refetchInterval: 60_000,
  });

  const mine = mineQ.data ?? [];
  const queue = queueQ.data ?? [];
  const openMine = mine.filter((r) => r.status === "requested" || r.status === "approved").length;
  const pendingQueue = queue.filter((r) => r.status === "requested").length;
  const ordered = queue.filter((r) => r.status === "ordered").length;

  return (
    <div className="space-y-3">
      <PageHeader title="Supplies" subtitle="Consumables — gloves, bags, tape, masks">
        <NewRequestSheet userId={userId} />
      </PageHeader>

      <MetricStrip
        metrics={[
          {
            label: "My open requests",
            value: openMine.toLocaleString("en-US"),
            icon: ClipboardList,
          },
          ...(isManager
            ? [
                {
                  label: "Awaiting approval",
                  value: pendingQueue.toLocaleString("en-US"),
                  icon: Clock3,
                  tone: pendingQueue > 0 ? ("warning" as const) : ("default" as const),
                },
                {
                  label: "Pending delivery",
                  value: ordered.toLocaleString("en-US"),
                  icon: Package,
                },
              ]
            : []),
        ]}
      />

      <Tabs defaultValue={isManager && pendingQueue > 0 ? "queue" : "mine"}>
        <TabsList>
          <TabsTrigger value="mine">My requests</TabsTrigger>
          {isManager && (
            <TabsTrigger value="queue">
              Queue
              {pendingQueue > 0 && (
                <Badge className="ml-1.5 h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums">
                  {pendingQueue}
                </Badge>
              )}
            </TabsTrigger>
          )}
          {isManager && <TabsTrigger value="inventory">Inventory</TabsTrigger>}
          {seesSpend && <TabsTrigger value="spend">Spending</TabsTrigger>}
          {/* 6 Nov (David): "purchase history" — every purchase, by item for
              the year and by order, the company and each office. */}
          {seesSpend && <TabsTrigger value="history">Purchase history</TabsTrigger>}
          {isAdmin && <TabsTrigger value="catalog">Catalog</TabsTrigger>}
        </TabsList>

        <TabsContent value="mine" className="pt-2">
          <MyRequests rows={mine} loading={mineQ.isLoading} actor={actor} />
        </TabsContent>

        {isManager && (
          <TabsContent value="queue" className="pt-2">
            <ManagerQueue
              rows={queue}
              loading={queueQ.isLoading}
              actor={actor}
              uploaderName={app.fullName ?? "A colleague"}
            />
          </TabsContent>
        )}

        {isManager && (
          <TabsContent value="inventory" className="pt-2">
            <InventoryPanel userId={userId} />
          </TabsContent>
        )}

        {seesSpend && (
          <TabsContent value="spend" className="pt-2">
            <SpendPanel userId={userId} uploaderName={app.fullName ?? "A colleague"} />
          </TabsContent>
        )}

        {seesSpend && (
          <TabsContent value="history" className="pt-2">
            <SupplyPurchaseHistory />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="catalog" className="pt-2">
            {/* The same screen as Settings → Rates & catalogs → Supply catalog. */}
            <SupplyCatalogAdmin />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/* Shared bits --------------------------------------------------------------- */

function StatusChip({ status }: { status: SupplyStatus }) {
  return (
    <Badge className={cn("rounded-full border-0 text-[11px]", SUPPLY_STATUS_TONE[status])}>
      {SUPPLY_STAGE_LABEL[status]}
    </Badge>
  );
}

/**
 * Where the order has got to, as a line rather than a word.
 *
 * David's ask was that a requester can see their request move: requested →
 * approved → pending delivery → delivered. A single status chip answers "what
 * is it now" but not "how far is it", which is the question somebody waiting on
 * a box of gloves is actually asking.
 */
function StageTrail({ status }: { status: SupplyStatus }) {
  if (status === "denied") return null;
  const at = stageIndex(status);
  return (
    <div
      className="mt-1 flex items-center gap-1"
      aria-label={`Stage: ${SUPPLY_STAGE_LABEL[status]}`}
    >
      {SUPPLY_STAGE_FLOW.map((s, i) => (
        <span
          key={s}
          title={SUPPLY_STAGE_LABEL[s]}
          className={cn("h-1 w-8 rounded-full", i <= at ? "bg-primary" : "bg-muted")}
        />
      ))}
      <span className="ml-1.5 text-[11px] text-muted-foreground">{SUPPLY_STAGE_LABEL[status]}</span>
    </div>
  );
}

/**
 * The body of an order card. The items come first — one or two by name, more
 * as "View items" (David, 22 Sep) — then when, for which job, and the note.
 */
function RequestSummary({
  r,
  trail,
  onView,
}: {
  r: SupplyRequestFull;
  trail?: boolean;
  onView: () => void;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <OrderCardItems request={r} onView={onView} />
      <div className="truncate text-xs text-muted-foreground">
        {new Date(r.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
        {r.jobs ? ` · ${r.jobs.job_number} — ${r.jobs.address}` : ""}
        {r.note ? ` · ${r.note}` : ""}
      </div>
      {trail && <StageTrail status={r.status} />}
      {r.status === "denied" && r.denial_reason && (
        <div className="mt-1 text-xs text-destructive">Denied — {r.denial_reason}</div>
      )}
    </div>
  );
}

/* My requests --------------------------------------------------------------- */

function MyRequests({
  rows,
  loading,
  actor,
}: {
  rows: SupplyRequestFull[];
  loading: boolean;
  actor: SupplyActor;
}) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (id: string) => cancelRequest(id),
    onSuccess: () => {
      toast.success("Request withdrawn");
      qc.invalidateQueries({ queryKey: ["supply-requests"] });
    },
    onError: (e) => toastDbError(e, { action: "withdraw the supply request" }),
  });
  /* The requester's own view of an order: the same line list, read-only —
     vendors, prices, adjustments and receipts belong to the approver. */
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewing = rows.find((r) => r.id === viewingId) ?? null;
  const itemsQ = useQuery({
    queryKey: ["supply-items", "all"],
    queryFn: () => listItems({ includeInactive: true }),
    enabled: !!viewing,
  });
  const vendorsQ = useQuery({
    queryKey: ["supply-vendors"],
    queryFn: listSupplyVendors,
    enabled: !!viewing,
  });
  const itemById = useMemo(() => new Map((itemsQ.data ?? []).map((i) => [i.id, i])), [itemsQ.data]);

  if (loading)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  if (rows.length === 0)
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No supply requests yet. Use “New request” to ask for what you need.
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardContent className="divide-y p-0">
        {rows.map((r) => (
          <div key={r.id} className="flex items-start gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <RequestSummary r={r} trail onView={() => setViewingId(r.id)} />
              <p className="mt-1 text-xs text-muted-foreground">{SUPPLY_STAGE_HINT[r.status]}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusChip status={r.status} />
              {canCancel(r, actor) && r.requester_id === actor.userId && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Withdraw request"
                  onClick={() => cancel.mutate(r.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
      {viewing && (
        <OrderDetailDialog
          request={viewing}
          requesterName="you"
          open
          onOpenChange={(v) => !v && setViewingId(null)}
          canManage={false}
          itemById={itemById}
          vendors={vendorsQ.data ?? []}
          book={EMPTY_BOOK}
          office={null}
          receipts={[]}
          userId={actor.userId}
          uploaderName=""
        />
      )}
    </Card>
  );
}

/* Manager queue -------------------------------------------------------------- */

/**
 * Was this order approved with the email deliberately skipped?
 *
 * Read through a narrow cast: the column arrives with 20260918150000 and the
 * generated types lag a migration applied by hand after merge.
 */
function vendorEmailSkipped(r: SupplyRequestFull): boolean {
  return !!(r as { vendor_email_skipped?: boolean }).vendor_email_skipped;
}

/** What a single press along the chain actually did, beyond the status change. */
type MoveResult =
  | { kind: "stocked"; stocked: number; skipped: number }
  | { kind: "composed"; missingRecipient: boolean; usedDefaultWording: boolean }
  | { kind: "emailFailed" }
  | { kind: "none" };

function describeMoveResult(result: MoveResult, skipEmail?: boolean): string | undefined {
  if (result.kind === "stocked") {
    const n = `${result.stocked} item${result.stocked === 1 ? "" : "s"} added to inventory.`;
    if (result.skipped === 0) return n;
    return `${n} ${result.skipped} free-text line${result.skipped === 1 ? "" : "s"} could not be — they are not catalog items.`;
  }
  if (result.kind === "composed") {
    if (result.missingRecipient) return "Vendor email composed — but no supplier email is on file.";
    return result.usedDefaultWording
      ? "Vendor email composed from the built-in default wording."
      : "Vendor email composed and ready to open.";
  }
  // The order is approved either way. This says what happened to the email.
  if (result.kind === "emailFailed") {
    return "Approved. The vendor email could not be composed — approve is unaffected.";
  }
  return skipEmail ? "Approved without emailing the supplier." : undefined;
}

function ManagerQueue({
  rows,
  loading,
  actor,
  uploaderName,
}: {
  rows: SupplyRequestFull[];
  loading: boolean;
  actor: SupplyActor;
  /** For the receipt reviewer's alert: "a receipt was uploaded by so-and-so". */
  uploaderName: string;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<SupplyStatus | "all">("requested");
  const [reason, setReason] = useState<Record<string, string>>({});
  /** The order whose delivery is being counted, if any. */
  const [deliveringId, setDeliveringId] = useState<string | null>(null);
  /** The order opened into its line list, if any. */
  const [viewingId, setViewingId] = useState<string | null>(null);

  const namesQ = useQuery({
    queryKey: ["supply-requester-names"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("user_id, full_name");
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name ?? p.user_id.slice(0, 8)]));
    },
  });

  /*
   * Everything the vendor email needs, loaded once for the whole queue rather
   * than per row: who supplies each item, that supplier's address, the office
   * the order ships to, and the wording staff have edited in Admin.
   */
  // Every item, hidden ones too: an order placed before an item was hidden
  // still needs that item's usual vendor.
  const itemsQ = useQuery({
    queryKey: ["supply-items", "all"],
    queryFn: () => listItems({ includeInactive: true }),
  });
  const vendorsQ = useQuery({ queryKey: ["supply-vendors"], queryFn: listSupplyVendors });
  const vendors = vendorsQ.data ?? [];
  const pricesQ = useQuery({ queryKey: ["supply-vendor-prices"], queryFn: listVendorPrices });
  const book = useMemo(() => priceBook(pricesQ.data ?? []), [pricesQ.data]);
  // Receipts attached to these orders, in one read for the whole queue.
  const orderReceiptsQ = useQuery({
    queryKey: ["supply-receipts", "orders", rows.map((r) => r.id).join(",")],
    queryFn: () => listSupplyReceipts(null, { requestIds: rows.map((r) => r.id) }),
    enabled: rows.length > 0,
  });
  const receiptsFor = (requestId: string) =>
    (orderReceiptsQ.data ?? []).filter((x) => x.request_id === requestId);
  const itemById = useMemo(() => new Map((itemsQ.data ?? []).map((i) => [i.id, i])), [itemsQ.data]);
  const vendorEmailsQ = useQuery({
    queryKey: ["supply-vendor-emails", "directory"],
    queryFn: () => listVendorEmails(),
  });
  const emailsQ = useQuery({
    queryKey: ["supply-vendor-emails", rows.map((r) => r.id).join(",")],
    queryFn: () => listVendorOrderEmails(rows.map((r) => r.id)),
    enabled: rows.length > 0,
  });
  const officesQ = useQuery({
    queryKey: ["supply-order-offices"],
    queryFn: async () => {
      const { data } = await supabase
        .from("locations")
        .select("id, name, legal_entity_name, address, office_phone");
      return new Map(
        (data ?? []).map((l) => [
          l.id,
          {
            company: l.legal_entity_name?.trim() || l.name,
            phone: l.office_phone,
            address: l.address,
          },
        ]),
      );
    },
  });
  const templatesQ = useQuery({
    queryKey: ["email-templates", "vendor_order"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_templates")
        .select("key, subject, body, is_active")
        .eq("key", "vendor_order");
      if (error) throw error;
      return (data ?? []) as { key: string; subject: string; body: string; is_active: boolean }[];
    },
  });

  /** The item's usual vendor — the list's preset, else the old free text. */
  const supplierOf = (itemId: string) => {
    const item = itemById.get(itemId);
    if (!item) return null;
    return presetVendor(item, vendors)?.vendor.name ?? catalogueSupplier(item);
  };
  /** A vendor chosen on the line itself, which beats the item's usual one. */
  const lineVendorOf = (line: SupplyRequestFull["supply_request_lines"][number]) => {
    const id = lineVendorId(line);
    return id ? (vendors.find((v) => v.id === id)?.name ?? null) : null;
  };

  /** Everything the approve press needs to hand the mutation. */
  const emailContextFor = (r: SupplyRequestFull) => {
    const vendorName = vendorNameFor(r, supplierOf, lineVendorOf);
    return {
      vendorName,
      vendorEmail: vendorName ? (vendorEmailsQ.data?.get(vendorName.toLowerCase()) ?? null) : null,
      requestedBy: namesQ.data?.get(r.requester_id) ?? null,
      office: officesQ.data?.get(r.location_id) ?? null,
      templates: templatesQ.data,
    };
  };

  /**
   * One move along the chain.
   *
   * Three things hang off a single press and they are deliberately ordered
   * worst-first-to-lose: the status change, then inventory, then the vendor
   * email. If stocking the shelf fails the order is still delivered and the
   * manager is told to check inventory — the alternative, refusing to record a
   * delivery that physically happened, is the worse of the two.
   */
  const move = useMutation({
    mutationFn: async (v: {
      r: SupplyRequestFull;
      status: SupplyStatus;
      why?: string;
      /** "Approve without emailing" — the per-order opt-out. */
      skipEmail?: boolean;
      vendorName?: string | null;
      vendorEmail?: string | null;
      requestedBy?: string | null;
      office?: { company: string; phone: string | null; address: string | null } | null;
      templates?: readonly { key: string; subject: string; body: string; is_active?: boolean }[];
    }) => {
      await setStatus({
        request: v.r,
        status: v.status,
        denialReason: v.why,
        deciderId: actor.userId,
      });

      /*
       * Delivery no longer comes through here. It is counted line by line in
       * SupplyDeliveryDialog, which stocks the shelf and sets the status
       * itself — one path, so there is no way to stock an order twice by
       * reaching it from two directions.
       */

      if (v.status === "approved" && VENDOR_EMAIL_ON_APPROVAL && !v.skipEmail) {
        /*
         * APPROVAL MUST NEVER FAIL BECAUSE OF EMAIL. The status change above has
         * already committed; everything in here is wrapped so that a missing
         * template, a missing address, an unapplied migration or a dead network
         * leaves the order approved and tells the manager what happened to the
         * email instead of undoing their decision.
         */
        try {
          const composed = composeVendorOrder(
            {
              request: v.r,
              vendorName: v.vendorName ?? null,
              requestedBy: v.requestedBy ?? null,
              // The order's own ship-to, else its office's (older orders).
              deliveryAddress: orderDeliveryAddress(v.r, v.office),
              companyName: v.office?.company ?? "Gold Star Restoration",
              companyPhone: v.office?.phone ?? null,
            },
            v.vendorEmail ?? null,
            v.templates,
          );
          await recordVendorOrderEmail({
            requestId: v.r.id,
            locationId: v.r.location_id,
            composed,
            userId: actor.userId,
          });
          return {
            kind: "composed",
            missingRecipient: composed.missingRecipient,
            usedDefaultWording: composed.usedDefaultWording,
          } as MoveResult;
        } catch (err) {
          console.error("[supplies] the vendor email could not be composed", err);
          return { kind: "emailFailed" } as MoveResult;
        }
      }

      if (v.status === "approved" && v.skipEmail) {
        // Recorded rather than inferred: "no email row" would otherwise mean
        // both "we chose not to" and "composing went wrong".
        const { error } = await supabase
          .from("supply_requests")
          .update({ vendor_email_skipped: true } as never)
          .eq("id", v.r.id);
        if (error) console.error("[supplies] could not record the email opt-out", error);
      }
      return { kind: "none" } as MoveResult;
    },
    onSuccess: (result, v) => {
      toast.success(`Marked ${SUPPLY_STAGE_LABEL[v.status].toLowerCase()}`, {
        description: describeMoveResult(result, v.skipEmail),
      });
      qc.invalidateQueries({ queryKey: ["supply-requests"] });
      qc.invalidateQueries({ queryKey: ["supply-stock"] });
      qc.invalidateQueries({ queryKey: ["supply-vendor-emails"] });
    },
    onError: (e) => toastDbError(e, { action: "update the supply request" }),
  });

  const delivering = rows.find((r) => r.id === deliveringId) ?? null;
  const viewing = rows.find((r) => r.id === viewingId) ?? null;

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {(["all", ...SUPPLY_STATUSES] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={filter === s ? "default" : "outline"}
            onClick={() => setFilter(s as SupplyStatus | "all")}
          >
            {s === "all" ? "All" : SUPPLY_STAGE_LABEL[s as SupplyStatus]}
            {s !== "all" && (
              <span className="ml-1 text-[11px] opacity-70">
                {rows.filter((r) => r.status === s).length}
              </span>
            )}
          </Button>
        ))}
      </div>

      {VENDOR_EMAIL_ON_APPROVAL ? (
        <p className="px-1 text-xs text-muted-foreground">
          Approving composes the supplier&rsquo;s purchase order. Nothing is sent by Recovery Hub —
          you open it as a draft in your own email client.
        </p>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          Approving does not email the supplier — orders are still placed by hand.
        </p>
      )}

      <Card>
        <CardContent className="divide-y p-0">
          {loading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
          {!loading && visible.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">Nothing here.</div>
          )}
          {visible.map((r) => {
            const moves = availableTransitions(r, actor);
            return (
              <div key={r.id} className="space-y-2 px-3 py-2.5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    {/*
                      David, repeatedly, on these screens: "who was this for? I
                      don't even know who that was for... it doesn't show who
                      it's delivered to." It was a muted caption above the
                      items; it is now the first thing the row says, in the
                      foreground, at every stage.
                    */}
                    <div className="text-sm font-semibold">
                      For {namesQ.data?.get(r.requester_id) ?? "an employee"}
                    </div>
                    <RequestSummary r={r} trail onView={() => setViewingId(r.id)} />
                    <OutstandingLine request={r} />
                  </div>
                  <StatusChip status={r.status} />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {moves.map((t) =>
                    t.to === "denied" ? (
                      <div key={t.to} className="flex items-center gap-2">
                        <Input
                          className="h-8 w-56"
                          placeholder="Reason to deny"
                          value={reason[r.id] ?? ""}
                          onChange={(e) => setReason((p) => ({ ...p, [r.id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={move.isPending}
                          onClick={() => {
                            const why = (reason[r.id] ?? "").trim();
                            if (!why) {
                              toast.error("A denial needs a reason.");
                              return;
                            }
                            move.mutate({ r, status: "denied", why });
                          }}
                        >
                          {t.label}
                        </Button>
                      </div>
                    ) : t.to === "approved" && VENDOR_EMAIL_ON_APPROVAL ? (
                      <div key={t.to} className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          disabled={move.isPending}
                          onClick={() => move.mutate({ r, status: t.to, ...emailContextFor(r) })}
                        >
                          {t.label}
                        </Button>
                        {/*
                          The edge case must never block the approval itself —
                          a repeat order already placed by phone, say. Same
                          approval, no email composed, and the opt-out recorded.
                        */}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={move.isPending}
                          onClick={() => move.mutate({ r, status: t.to, skipEmail: true })}
                        >
                          Approve without emailing
                        </Button>
                      </div>
                    ) : t.to === "delivered" ? (
                      /*
                        Delivery is no longer one press. David, 17 Sep: "we
                        should have a place where we can put in exactly what
                        was delivered." The dialog takes a count per line and
                        decides for itself whether the order is finished.
                      */
                      <Button
                        key={t.to}
                        size="sm"
                        disabled={move.isPending}
                        onClick={() => setDeliveringId(r.id)}
                      >
                        {t.label}
                      </Button>
                    ) : (
                      <Button
                        key={t.to}
                        size="sm"
                        disabled={move.isPending}
                        onClick={() => move.mutate({ r, status: t.to })}
                      >
                        {t.label}
                      </Button>
                    ),
                  )}
                  {moves.length === 0 && (
                    <span className="text-xs text-muted-foreground">
                      {SUPPLY_STAGE_HINT[r.status]}
                    </span>
                  )}
                </div>

                {emailsQ.data?.get(r.id) ? (
                  <VendorOrderEmailPanel
                    email={emailsQ.data.get(r.id)!}
                    vendorName={vendorNameFor(r, supplierOf, lineVendorOf)}
                    userId={actor.userId}
                  />
                ) : vendorEmailSkipped(r) ? (
                  <p className="text-xs text-muted-foreground">
                    Approved without emailing the supplier.
                  </p>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {viewing && (
        <OrderDetailDialog
          request={viewing}
          requesterName={namesQ.data?.get(viewing.requester_id) ?? "an employee"}
          open
          onOpenChange={(v) => !v && setViewingId(null)}
          canManage
          itemById={itemById}
          vendors={vendors}
          book={book}
          office={officesQ.data?.get(viewing.location_id) ?? null}
          receipts={receiptsFor(viewing.id)}
          userId={actor.userId}
          uploaderName={uploaderName}
        />
      )}

      {delivering && (
        <SupplyDeliveryDialog
          request={delivering}
          requesterName={namesQ.data?.get(delivering.requester_id) ?? "an employee"}
          actorId={actor.userId}
          open
          onOpenChange={(v) => !v && setDeliveringId(null)}
        />
      )}
    </div>
  );
}

/**
 * What is still owed on an order, on the row itself.
 *
 * Only when something is outstanding: a complete order saying "nothing
 * pending" on every line would be noise on every row in the queue.
 */
function OutstandingLine({ request }: { request: SupplyRequestFull }) {
  const progress = deliveryProgress(deliveryLines(request));
  if (progress.complete || progress.untouched) return null;
  return <p className="mt-1 text-xs font-medium text-warning">{progress.summary}</p>;
}

/* New request ---------------------------------------------------------------- */

function NewRequestSheet({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const defaultLocation = useDefaultLocationId();
  const [locationId, setLocationId] = useState<string>("");
  const qc = useQueryClient();

  const itemsQ = useQuery({ queryKey: ["supply-items", "active"], queryFn: () => listItems() });

  const submit = useMutation({
    mutationFn: (draft: SupplyOrderDraft) =>
      createRequest({
        requesterId: userId,
        locationId: draft.locationId || defaultLocation || "",
        jobId: draft.jobId,
        note: draft.note,
        neededBy: draft.neededBy,
        deliveryAddress: draft.deliveryAddress,
        lines: draft.lines,
      }),
    onSuccess: () => {
      toast.success("Request sent for approval");
      qc.invalidateQueries({ queryKey: ["supply-requests"] });
      setOpen(false);
    },
    onError: (e) => toastDbError(e, { action: "send the supply request" }),
  });

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 size-4" /> New request
      </Button>
      {/*
        A centred dialog, not the right-hand sheet it used to be. David, 17
        Sep: "I happen to not really like the way it comes up on the right side
        of the screen... it should be a pop-up in the middle... no side parts."

        Wide, because the form is a list of named rows with a number beside
        each and the names truncate in a narrow column — and because he said
        two columns would be fine, which is what the extra width buys inside
        the category sections.
      */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] w-[calc(100vw-1.5rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Request supplies</DialogTitle>
          </DialogHeader>

          <div className="py-1">
            {/*
            Remounting on each open is what resets the form. The draft lives
            inside SupplyOrderForm, and a half-filled request from last time is
            not something anyone wants to find.
          */}
            {open && (
              <SupplyOrderForm
                items={itemsQ.data ?? []}
                locationId={locationId}
                onLocationChange={setLocationId}
                submitting={submit.isPending}
                onSubmit={(draft) => submit.mutate(draft)}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* Inventory ------------------------------------------------------------------ */

/**
 * What is on the shelf at one location, and taking it back off again.
 *
 * DEFAULT, and an open question for the client: depletion is manual. Somebody
 * says "we used four of those" and the count goes down. Scanning was the
 * alternative and is not built — see depleteStock() for the seam it would use.
 */
function InventoryPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const defaultLocation = useDefaultLocationId();
  const [locationId, setLocationId] = useState<string>("");
  const locId = locationId || defaultLocation || "";
  const [use, setUse] = useState<Record<string, number>>({});

  const stockQ = useQuery({
    queryKey: ["supply-stock", locId],
    queryFn: () => listStock(locId),
    enabled: !!locId,
  });
  const movesQ = useQuery({
    queryKey: ["supply-stock", "moves", locId],
    queryFn: () => listStockMoves(locId),
    enabled: !!locId,
  });

  /*
   * THE one depletion mechanism, and both ways in go through it.
   *
   * David, 16 Sep, point 21: depletion shipped manual-first with the seam that
   * scan could be added with no enum change. It has been, and this is still the
   * only write path — same depleteStock, same ledger row, same running total,
   * same permissions. A scan is a faster way to PICK the item, nothing more.
   * The only thing that reaches the database differently is the movement's
   * reason, which the ledger has accepted as "scan" since it was written.
   */
  const deplete = useMutation({
    mutationFn: (v: { itemId: string; quantity: number; scanned?: boolean }) =>
      depleteStock({
        locationId: locId,
        itemId: v.itemId,
        quantity: v.quantity,
        userId,
        reason: v.scanned ? "scan" : "manual_adjust",
      }),
    onSuccess: (_d, v) => {
      toast.success(v.scanned ? "Scanned out" : "Stock marked down");
      setUse((p) => ({ ...p, [v.itemId]: 0 }));
      setScanned(null);
      qc.invalidateQueries({ queryKey: ["supply-stock"] });
    },
    onError: (e) => toastDbError(e, { action: "mark the stock down" }),
  });

  /*
   * What the camera resolved to, waiting on the same confirm the manual path
   * uses. A scan never writes by itself: the quantity is editable and somebody
   * presses the button, exactly as when they pick the item off the list.
   */
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState<{ item: SupplyItem; qty: number } | null>(null);
  const [scanProblem, setScanProblem] = useState<string | null>(null);

  const itemsQ = useQuery({ queryKey: ["supply-items", "active"], queryFn: () => listItems() });

  /*
   * A miss keeps the scanner open with the message — before, the dialog shut on
   * every read and a code that matched nothing looked like a scanner that had
   * stopped working. The same message stays on the page after it is closed.
   */
  const handleScan = (raw: string): ScanRejection | void => {
    if (!itemsQ.data) {
      const message = "The item list has not loaded yet. Try the scan again in a moment.";
      setScanProblem(message);
      return { rejected: true, title: "Items still loading", message };
    }
    const outcome = supplyScanOutcome(raw, itemsQ.data);
    if (outcome.kind === "fill") {
      setScanned({ item: outcome.item, qty: outcome.qty });
      setScanProblem(null);
      return;
    }
    // Never guess an item. The message names the code and points at the list.
    setScanned(null);
    setScanProblem(outcome.message);
    return { rejected: true, title: outcome.title, message: outcome.message };
  };

  const rows = stockQ.data ?? [];
  // `null` is the migration not being applied here, which is a different thing
  // from a shelf that happens to be empty, and the page says which.
  const notInstalled = stockQ.isSuccess && stockQ.data === null;

  return (
    <div className="space-y-2">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <LocationPicker value={locationId} onChange={setLocationId} label="Location" />
          <Button
            size="sm"
            variant="outline"
            disabled={!locId}
            onClick={() => {
              setScanProblem(null);
              setScanOpen(true);
            }}
          >
            <ScanLine className="mr-1.5 size-4" /> Scan out
          </Button>
        </CardContent>
      </Card>

      <CodeScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        onScanned={handleScan}
        title="Scan an item off the shelf"
        description="Point at the code on the bin. It fills in the same mark-down form you would fill by hand — nothing comes off the shelf until you confirm."
        manualLabel="Or type the code on the bin"
        manualPlaceholder="BIN-12"
        dismissLabel="Cancel"
        fallbackNote="This device has no built-in barcode reader, so QR and Code 128 labels are read in software — hold the label still a moment longer. Any other format needs the code typed in."
      />

      {scanProblem && (
        <Card className="border-warning/50 bg-warning/10" role="alert">
          <CardContent className="flex flex-wrap items-center gap-3 p-3">
            {/* Body text, not text-warning-foreground: that token is white in
                the light theme, which made this message invisible on a white
                card. */}
            <p className="min-w-0 flex-1 text-sm">{scanProblem}</p>
            <Button size="sm" variant="outline" onClick={() => setScanProblem(null)}>
              Use the list below
            </Button>
          </CardContent>
        </Card>
      )}

      {scanned && (
        <Card className="border-primary/40">
          <CardContent className="flex flex-wrap items-center gap-3 p-3">
            <ScanLine className="size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{scanned.item.name}</div>
              <div className="text-xs text-muted-foreground">
                {supplyItemCode(scanned.item)} · per {scanned.item.unit}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <NumberInput
                decimals={0}
                className="w-20"
                aria-label={`Scanned ${scanned.item.name} quantity`}
                value={scanned.qty}
                onValueChange={(n) => setScanned((p) => (p ? { ...p, qty: n ?? 0 } : p))}
              />
              <Button
                size="sm"
                disabled={deplete.isPending || scanned.qty <= 0}
                onClick={() =>
                  deplete.mutate({
                    itemId: scanned.item.id,
                    quantity: scanned.qty,
                    scanned: true,
                  })
                }
              >
                Mark used
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setScanned(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {notInstalled && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Inventory is not switched on for this database yet — the supplies inventory migration
            has not been applied. Requests, approvals and deliveries all work without it.
          </CardContent>
        </Card>
      )}

      {!notInstalled && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">On hand</CardTitle>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {stockQ.isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
            {!stockQ.isLoading && rows.length === 0 && (
              <div className="p-6 text-sm text-muted-foreground">
                Nothing in stock here yet. Items land here when an order is marked delivered.
              </div>
            )}
            {rows.map((r) => (
              <div key={r.item_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Warehouse className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{r.item_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.on_hand.toLocaleString("en-US")} {r.unit}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <NumberInput
                    decimals={0}
                    className="w-20"
                    aria-label={`Use ${r.item_name}`}
                    value={use[r.item_id] ?? 0}
                    onValueChange={(n) => setUse((p) => ({ ...p, [r.item_id]: n ?? 0 }))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deplete.isPending || !(use[r.item_id] ?? 0)}
                    onClick={() =>
                      deplete.mutate({ itemId: r.item_id, quantity: use[r.item_id] ?? 0 })
                    }
                  >
                    Mark used
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!notInstalled && (movesQ.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent movements</CardTitle>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {(movesQ.data ?? []).map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                <span
                  className={cn(
                    "w-16 tabular-nums",
                    m.qty < 0 ? "text-destructive" : "text-success",
                  )}
                >
                  {m.qty > 0 ? "+" : ""}
                  {m.qty}
                </span>
                <span className="min-w-0 truncate">{m.item_name ?? "Item"}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {STOCK_REASON_LABEL[m.reason as StockMoveReason] ?? m.reason} ·{" "}
                  {new Date(m.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* Spending ------------------------------------------------------------------- */

function SpendTable({
  title,
  rows,
  unitLabel,
}: {
  title: string;
  rows: SpendGroup[];
  unitLabel?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {rows.map((g) => (
          <div key={g.key} className="flex items-center gap-3 px-3 py-1.5 text-sm">
            <span className="min-w-0 truncate">{g.label || "—"}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {g.quantity.toLocaleString("en-US")} {unitLabel ?? "units"} · {g.purchases} purchase
              {g.purchases === 1 ? "" : "s"}
            </span>
            <span className="w-24 shrink-0 text-right tabular-nums">{usd(g.total)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** First of January this year, so a new year does not open on an empty report. */
function defaultFrom() {
  const d = new Date();
  return `${d.getFullYear()}-01-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

function SpendPanel({ userId, uploaderName }: { userId: string; uploaderName: string }) {
  const qc = useQueryClient();
  const defaultLocation = useDefaultLocationId();
  const [locationId, setLocationId] = useState<string>("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const locId = locationId || defaultLocation || "";

  const itemsQ = useQuery({ queryKey: ["supply-items", "active"], queryFn: () => listItems() });
  const purchasesQ = useQuery({
    queryKey: ["supply-purchases", locId, from, to],
    queryFn: () => listPurchases({ locationId: locId || null, from, to }),
    enabled: !!from && !!to,
  });

  const rows = purchasesQ.data ?? [];
  const bySupplier = useMemo(() => spendBySupplier(rows), [rows]);
  const byItem = useMemo(() => spendByItem(rows), [rows]);
  const byMonth = useMemo(() => spendByMonth(rows), [rows]);
  const spread = useMemo(() => itemPriceSpread(rows), [rows]);
  const total = useMemo(() => spendTotal(rows), [rows]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["supply-purchases"] });

  return (
    <div className="space-y-2">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <LocationPicker value={locationId} onChange={setLocationId} label="Location" />
          <div className="space-y-1.5">
            <Label htmlFor="spend-from">From</Label>
            <Input
              id="spend-from"
              type="date"
              className="w-40"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="spend-to">To</Label>
            <Input
              id="spend-to"
              type="date"
              className="w-40"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs text-muted-foreground">Total spend</div>
            <div className="text-xl font-semibold tabular-nums">{usd(total)}</div>
          </div>
        </CardContent>
      </Card>

      {/*
        David, 17 Sep: "they should be able to take a picture of the receipt and
        upload it to the system... at the very minimum it should send an alert
        to somebody." It sits above the typed form because photographing one is
        the quicker path and the one a tech at a till will take.
      */}
      <SupplyReceiptPanel locationId={locId} userId={userId} uploaderName={uploaderName} />

      <RecordPurchase
        userId={userId}
        locationId={locId}
        items={itemsQ.data ?? []}
        onSaved={invalidate}
      />

      {purchasesQ.isLoading && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      )}
      {!purchasesQ.isLoading && rows.length === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nothing bought in this window. Record a purchase above and it will be counted here, by
            month, by supplier and by item.
          </CardContent>
        </Card>
      )}

      <SpendTable title="By month" rows={byMonth} />
      <SpendTable title="By supplier" rows={bySupplier} />
      <SpendTable title="By item" rows={byItem} />

      {spread.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Same item, different price</CardTitle>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {spread.map((s) => (
              <div
                key={s.itemKey}
                className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-sm"
              >
                <span className="min-w-0 truncate">{s.itemName}</span>
                <span className="text-xs text-muted-foreground">
                  {s.suppliers} suppliers · {usd(s.low)}–{usd(s.high)} · avg{" "}
                  {usd(s.weightedAverage)}
                </span>
                <span className="ml-auto w-28 shrink-0 text-right tabular-nums text-success">
                  {usd(s.potentialSaving)}
                </span>
              </div>
            ))}
            <p className="p-3 text-xs text-muted-foreground">
              The figure on the right is what buying every unit at the cheapest price already paid
              would have saved. It is an argument for a phone call, not a forecast.
            </p>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Purchases</CardTitle>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {rows.slice(0, 100).map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-sm">
                <span className="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {p.purchased_on}
                </span>
                <span className="min-w-0 truncate">{purchaseItemName(p)}</span>
                <span className="text-xs text-muted-foreground">
                  {p.quantity.toLocaleString("en-US")} × {usd(p.unit_price)} · {p.supplier_name}
                </span>
                <span className="ml-auto w-24 shrink-0 text-right tabular-nums">
                  {usd(p.total_cost)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * The purchaser's line: what was paid, to whom, for what, on what date.
 *
 * Supplier is free text with the catalogue's usual supplier prefilled. Gold
 * Star buys from a builders' merchant as often as from a vendor already on the
 * books, and forcing every receipt through the accounts table would mean
 * inventing an account before a price could be typed in.
 */
function RecordPurchase({
  userId,
  locationId,
  items,
  onSaved,
}: {
  userId: string;
  locationId: string;
  items: SupplyItem[];
  onSaved: () => void;
}) {
  const [itemId, setItemId] = useState("");
  const [label, setLabel] = useState("");
  const [supplier, setSupplier] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState(0);
  /** Typed by hand — the vendor's price never overwrites what was actually paid. */
  const [priceTouched, setPriceTouched] = useState(false);
  const [purchasedOn, setPurchasedOn] = useState(today);

  const vendorsQ = useQuery({ queryKey: ["supply-vendors"], queryFn: listSupplyVendors });
  const pricesQ = useQuery({ queryKey: ["supply-vendor-prices"], queryFn: listVendorPrices });
  const book = useMemo(() => priceBook(pricesQ.data ?? []), [pricesQ.data]);
  /*
   * The price the vendor charges, picked up automatically. David: "the system
   * should automatically pick it up... I want it to be automatic really." It
   * fills the box as a starting point; what is saved is whatever the box says
   * when the purchase is recorded — the actual, not the expectation.
   */
  const expected = (() => {
    const vendor = (vendorsQ.data ?? []).find((v) => vendorKey(v.name) === vendorKey(supplier));
    const price = vendorPriceFor(book, itemId || null, vendor?.id);
    return price == null || !vendor ? null : { vendor: vendor.name, price };
  })();
  const shownPrice = !priceTouched && expected ? expected.price : unitPrice;

  const save = useMutation({
    mutationFn: () =>
      recordPurchase({
        locationId,
        itemId: itemId || null,
        itemLabel: itemId ? null : label.trim(),
        supplierName: supplier,
        quantity,
        unitPrice: shownPrice,
        purchasedOn,
        userId,
      }),
    onSuccess: () => {
      toast.success("Purchase recorded");
      setQuantity(1);
      setUnitPrice(0);
      setPriceTouched(false);
      setLabel("");
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "record the purchase" }),
  });

  const ready = !!locationId && !!supplier.trim() && quantity > 0 && (!!itemId || !!label.trim());

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Record a purchase</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2 p-3 pt-0">
        <div className="space-y-1.5">
          <Label>Item</Label>
          <Select
            value={itemId || "other"}
            onValueChange={(v) => {
              const next = v === "other" ? "" : v;
              setItemId(next);
              const found = items.find((i) => i.id === next);
              // Prefill, never a rule — the supplier is still free text.
              const usual = found
                ? (presetVendor(found, vendorsQ.data ?? [])?.vendor.name ??
                  catalogueSupplier(found))
                : null;
              if (usual && !supplier.trim()) setSupplier(usual);
            }}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Pick an item" />
            </SelectTrigger>
            <SelectContent>
              {items.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name}
                </SelectItem>
              ))}
              <SelectItem value="other">Not in the catalog…</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {!itemId && (
          <div className="space-y-1.5">
            <Label htmlFor="buy-label">What was it?</Label>
            <Input
              id="buy-label"
              className="w-48"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Dehumidifier filter"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="buy-supplier">Supplier</Label>
          <Input
            id="buy-supplier"
            className="w-44"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Home Depot"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="buy-qty">Quantity</Label>
          <NumberInput
            id="buy-qty"
            decimals={0}
            className="w-20"
            value={quantity}
            onValueChange={(n) => setQuantity(n ?? 0)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="buy-price">Unit price</Label>
          <NumberInput
            id="buy-price"
            decimals={2}
            className="w-24"
            value={shownPrice}
            onValueChange={(n) => {
              setPriceTouched(true);
              setUnitPrice(n ?? 0);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="buy-date">Date</Label>
          <Input
            id="buy-date"
            type="date"
            className="w-36"
            value={purchasedOn}
            onChange={(e) => setPurchasedOn(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="flex h-9 items-center text-sm font-medium tabular-nums">
            {usd(roundMoneyLoose(quantity * shownPrice))}
          </div>
        </div>
        {expected && (
          <p className="w-full text-xs text-muted-foreground">
            {expected.vendor} charges {usd(expected.price)} on the price list
            {priceTouched && unitPrice !== expected.price
              ? ` — you are recording ${usd(unitPrice)}, what was actually paid.`
              : " — change it if the receipt says otherwise."}
          </p>
        )}
        <Button size="sm" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
          <DollarSign className="mr-1 size-3.5" /> Save
        </Button>
      </CardContent>
    </Card>
  );
}
