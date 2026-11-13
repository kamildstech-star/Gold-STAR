import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil } from "lucide-react";

import { OrderReceipts } from "@/components/supply-receipt-panel";
import {
  LineVendorSelect,
  lineLabel,
  lineQuantity,
  type OrderLine,
} from "@/components/supply-order-lines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { toastDbError } from "@/lib/db-errors";
import { adjustLineQuantity, type SupplyItem, type SupplyRequestFull } from "@/lib/supplies";
import { lineDelivered } from "@/lib/supply-delivery";
import { orderCardSummary } from "@/lib/supply-order-card";
import { orderDeliveryAddress, type OfficeAddress } from "@/lib/supply-delivery-address";
import {
  expectedOrderTotal,
  priceLine,
  type LinePricing,
  type PriceBook,
  groupLinesByVendor,
  type VendorGroup,
} from "@/lib/supply-vendor-prices";
import type { SupplyReceipt } from "@/lib/supply-receipts";
import type { SupplyVendor } from "@/lib/supply-vendors";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** Orders a manager can still change: nothing is decided for good yet. */
export const isAdjustable = (r: SupplyRequestFull) =>
  r.status === "requested" || r.status === "approved" || r.status === "ordered";

/**
 * The items on an order card.
 *
 * David, 22 Sep: "If there's only one item, two items, that should come up
 * here. If not, then it should say view items and click on it." One or two
 * lines are named in full with their quantity; more collapse to a count and
 * the button into the list.
 */
export function OrderCardItems({
  request,
  onView,
}: {
  request: SupplyRequestFull;
  onView: () => void;
}) {
  const summary = orderCardSummary(
    request.supply_request_lines.map((l) => ({ label: lineLabel(l), quantity: lineQuantity(l) })),
  );
  if (!summary) return <p className="text-sm text-muted-foreground">No items.</p>;
  if (summary.kind === "inline") {
    return (
      <div className="space-y-1">
        <ul className="space-y-0.5 text-sm">
          {summary.lines.map((l, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{l.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{l.quantity}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onView}
          className="min-h-9 text-xs font-medium text-primary hover:underline"
        >
          Open order
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="min-w-0 truncate">
        {summary.first.label}
        <span className="text-muted-foreground"> and {summary.count - 1} more</span>
      </span>
      <Button size="sm" variant="outline" className="h-11 md:h-8" onClick={onView}>
        View items ({summary.count})
      </Button>
    </div>
  );
}

/**
 * One order, opened: who it is for, where it goes, and the line list.
 *
 * David, 22 Sep: "it has to be a list. Each item should come up here — the
 * item, the quantity. And then I should have a section here that I could
 * either choose the vendor or the vendor should be preset. You should also
 * have a line item edit or adjust."
 *
 * Laid out like the Spending purchases table on a desktop — item, quantity,
 * expected price, vendor, one action at the end of the row — and as a stack of
 * line cards on a phone, because this is used standing in a warehouse with a
 * box in one hand. Every target is 44px there.
 */
export function OrderDetailDialog({
  request,
  requesterName,
  open,
  onOpenChange,
  canManage,
  itemById,
  vendors,
  book,
  office,
  receipts,
  userId,
  uploaderName,
}: {
  request: SupplyRequestFull;
  requesterName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A manager of this order's office: vendor, adjust, receipts and prices. */
  canManage: boolean;
  itemById: Map<string, SupplyItem>;
  vendors: SupplyVendor[];
  book: PriceBook;
  office: OfficeAddress | null;
  receipts: SupplyReceipt[];
  userId: string;
  uploaderName: string;
}) {
  const adjustable = canManage && isAdjustable(request);
  const pricings = request.supply_request_lines.map((l) =>
    priceLine(l, l.item_id ? (itemById.get(l.item_id) ?? null) : null, vendors, book),
  );
  const shipTo = orderDeliveryAddress(request, office);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto p-4 sm:p-6">
        <DialogHeader className="text-left">
          {/* Who it is for leads, as it does on the card (David, 17 Sep: "who was this for?"). */}
          <DialogTitle className="text-base">For {requesterName}</DialogTitle>
          <DialogDescription className="space-y-0.5 text-xs">
            <span className="block">
              {new Date(request.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
              {request.jobs ? ` · ${request.jobs.job_number} — ${request.jobs.address}` : ""}
              {request.needed_by ? ` · needed by ${request.needed_by}` : ""}
            </span>
            {shipTo ? <span className="block">Deliver to {shipTo}</span> : null}
            {request.note ? <span className="block">{request.note}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border">
          <div className="hidden grid-cols-[minmax(0,1fr)_7rem_6rem_12rem_5.5rem] md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 gap-3 border-b bg-muted px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
            <span>Item</span>
            <span className="text-right">Quantity</span>
            <span className="text-right">{canManage ? "Expected" : ""}</span>
            <span>Vendor</span>
            <span />
          </div>
          <ul className="divide-y">
            {request.supply_request_lines.map((l, i) => (
              <OrderLineRow
                key={l.id}
                line={l}
                item={l.item_id ? (itemById.get(l.item_id) ?? null) : null}
                vendors={vendors}
                pricing={pricings[i]!}
                canManage={canManage}
                adjustable={adjustable}
              />
            ))}
          </ul>
        </div>
        {canManage ? <ExpectedTotal pricings={pricings} /> : null}

        {canManage ? (
          <VendorBreakdown
            groups={groupLinesByVendor(request.supply_request_lines, itemById, vendors, book)}
          />
        ) : null}

        {canManage ? (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Receipts</h3>
            <OrderReceipts
              requestId={request.id}
              locationId={request.location_id}
              userId={userId}
              uploaderName={uploaderName}
              receipts={receipts}
            />
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function OrderLineRow({
  line,
  item,
  vendors,
  pricing,
  canManage,
  adjustable,
}: {
  line: OrderLine;
  item: SupplyItem | null;
  vendors: SupplyVendor[];
  pricing: LinePricing;
  canManage: boolean;
  adjustable: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState<number | null>(Number(line.quantity));
  const delivered = lineDelivered(line);

  const save = useMutation({
    mutationFn: () => adjustLineQuantity({ lineId: line.id, quantity: qty ?? 0, delivered }),
    onSuccess: () => {
      toast.success("Line adjusted");
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["supply-requests"] });
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "adjust the line" });
    },
  });

  const unit = line.unit ?? line.supply_items?.unit ?? "";

  return (
    <li
      data-order-line
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_7rem_6rem_12rem_5.5rem] sm:items-center"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{lineLabel(line)}</p>
        {delivered > 0 ? (
          <p className="text-xs text-muted-foreground">{delivered} arrived</p>
        ) : null}
      </div>

      <div className="text-right text-sm tabular-nums">
        {editing ? (
          <div className="flex items-center justify-end gap-1">
            <NumberInput
              decimals={0}
              className="h-11 w-20 md:h-8"
              aria-label={`New quantity for ${lineLabel(line)}`}
              value={qty ?? 0}
              onValueChange={(n) => setQty(n)}
            />
            <span className="text-xs text-muted-foreground">{unit}</span>
          </div>
        ) : (
          lineQuantity(line)
        )}
      </div>

      <div className="text-right text-xs tabular-nums sm:order-none">
        {canManage ? <LinePrice pricing={pricing} /> : null}
      </div>

      <div className="col-span-2 sm:col-span-1">
        <LineVendorSelect line={line} item={item} vendors={vendors} canEdit={adjustable} />
      </div>

      <div className="col-span-2 flex justify-end gap-2 sm:col-span-1">
        {adjustable ? (
          editing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-11 md:h-8"
                onClick={() => {
                  setEditing(false);
                  setQty(Number(line.quantity));
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-11 md:h-8"
                disabled={save.isPending}
                onClick={() => save.mutate()}
              >
                Save
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-11 w-full sm:w-auto md:h-8"
              aria-label={`Adjust ${lineLabel(line)}`}
              onClick={() => setEditing(true)}
            >
              <Pencil className="mr-1 size-3.5" /> Adjust
            </Button>
          )
        ) : null}
      </div>
    </li>
  );
}

/**
 * What a line should cost from its vendor. David: "the system should
 * automatically pick it up." No price on file says so — it is never a zero.
 */
export function LinePrice({ pricing }: { pricing: LinePricing }) {
  if (pricing.total == null) {
    return (
      <span className="text-muted-foreground">{pricing.vendor ? "No price on file" : "—"}</span>
    );
  }
  return <span title={`${usd(pricing.unitPrice!)} each`}>{usd(pricing.total)}</span>;
}

/** The order's expected cost — said to be partial when some lines have no price. */
export function ExpectedTotal({ pricings }: { pricings: LinePricing[] }) {
  const t = expectedOrderTotal(pricings);
  if (t.priced === 0) return null;
  return (
    <p className="text-right text-xs text-muted-foreground">
      Expected {usd(t.total)}
      {t.priced < t.lines ? ` for ${t.priced} of ${t.lines} lines` : ""} · what is paid is recorded
      under Spending
    </p>
  );
}

/**
 * The order, by vendor — who to call for what.
 *
 * David, 13 Oct: when a supply order comes in he wants to see which items go
 * to which vendor. Each line goes to its own vendor if one was picked, else
 * the item's preferred vendor — the same rule the Vendor column above uses.
 *
 * Read-only and INTERNAL: ordering from a vendor stays manual (David's
 * decision the same day). Nothing here emails anyone.
 */
export function VendorBreakdown({
  groups,
}: {
  groups: VendorGroup<SupplyRequestFull["supply_request_lines"][number]>[];
}) {
  if (!groups.length) return null;
  return (
    <section className="space-y-2" data-vendor-breakdown>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">By vendor</h3>
        <span className="text-[11px] text-muted-foreground">
          For ordering by hand — nothing is sent to a vendor.
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.vendor?.id ?? "none"} className="rounded-md border p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className={`text-sm font-medium ${g.vendor ? "" : "text-warning"}`}>
                {g.vendor?.name ?? "No vendor yet"}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {g.expected.priced
                  ? `$${g.expected.total.toFixed(2)}${g.expected.priced < g.expected.lines ? ` for ${g.expected.priced} of ${g.expected.lines}` : ""}`
                  : `${g.lines.length} item${g.lines.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {g.vendor?.phone || g.vendor?.email ? (
              <p className="text-[11px] text-muted-foreground">
                {[g.vendor.phone, g.vendor.email].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            <ul className="mt-1 space-y-0.5 text-xs">
              {g.lines.map(({ line }) => (
                <li key={line.id} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{lineLabel(line)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {lineQuantity(line)}
                  </span>
                </li>
              ))}
            </ul>
            {!g.vendor ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Pick a vendor on these lines above, or set the item&rsquo;s preferred vendor.
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
