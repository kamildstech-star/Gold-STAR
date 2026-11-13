import { useState } from "react";
import { ChevronRight, Tag } from "lucide-react";

import { NumberInput } from "@/components/ui/number-input";
import { vendorPriceFor, vendorPriceSummary, type PriceBook } from "@/lib/supply-vendor-prices";
import type { SupplyVendor } from "@/lib/supply-vendors";
import { cn } from "@/lib/utils";

/**
 * What each vendor charges for one catalog item.
 *
 * David, 22 Sep: "one guy charges $9, the other guy charges $10, then we
 * should be able to put it in for each vendor and the system should
 * automatically pick it up." Mark, 13 Oct: "if he wants to put his price for
 * a vendor on an item he wants to have a way to input that."
 *
 * The price boxes existed, but only once at least one vendor did — with an
 * empty vendor list the row drew nothing at all, so there was no sign that a
 * price could be entered anywhere. Now the row always says where prices go:
 * with no vendors it points at the Vendors card; with vendors it is a button
 * showing the price an order will pick up ("$12.50 at Acme") or "Add a price".
 *
 * Opened, one box per vendor, the usual vendor first and marked, each saving
 * when you leave it like every other box on the page. A box left empty means
 * no price from that vendor — the order line then shows none rather than
 * borrowing another vendor's.
 *
 * Presentational: the caller saves. That keeps this testable without a
 * database, and keeps who-may-write in one place (the catalog screen, which
 * only catalog admins reach, and the table's RLS behind it).
 */
export function VendorPriceEditor({
  item,
  vendors,
  book,
  usualVendorId,
  onCommit,
}: {
  item: { id: string; name: string; unit: string };
  vendors: readonly SupplyVendor[];
  book: PriceBook;
  usualVendorId: string | null;
  onCommit: (vendorId: string, next: number | null) => void;
}) {
  const [open, setOpen] = useState(false);

  if (vendors.length === 0) {
    return (
      <p className="flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground">
        <Tag className="size-3.5" aria-hidden />
        <span>
          <span className="font-medium">Prices</span> — add a vendor in the Vendors card above, then
          set what each vendor charges for this item here.
        </span>
      </p>
    );
  }

  const summary = vendorPriceSummary(book, item.id, vendors, usualVendorId);

  return (
    <div data-vendor-prices={item.id}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Prices for ${item.name}: ${summary.label}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md border px-2 text-left text-xs hover:bg-muted",
          summary.priced === 0 && "border-dashed text-muted-foreground",
        )}
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <Tag className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">Prices</span>
        <span className="truncate" data-price-label>
          {summary.label}
        </span>
      </button>
      {open && (
        <div className="mt-1 grid gap-2 rounded-md border bg-muted/30 p-2 sm:grid-cols-2 lg:grid-cols-3">
          {summary.rows.map(({ vendor: v, usual }) => (
            <label
              key={v.id}
              data-price-vendor={v.id}
              className={cn(
                "flex items-center gap-2 rounded px-1 text-sm",
                usual && "bg-primary/5 font-medium",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {v.name}
                {usual ? (
                  <span className="text-xs font-normal text-muted-foreground"> (usual)</span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground" aria-hidden>
                $
              </span>
              <NumberInput
                key={`${v.id}:${vendorPriceFor(book, item.id, v.id) ?? ""}`}
                className="h-11 w-28 md:h-8"
                decimals={2}
                placeholder="—"
                aria-label={`${item.name} price from ${v.name}, per ${item.unit}`}
                defaultValue={vendorPriceFor(book, item.id, v.id)}
                onCommit={(next) => {
                  if (next === vendorPriceFor(book, item.id, v.id)) return;
                  onCommit(v.id, next);
                }}
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
            Per {item.unit}. An order line picks up the price of the vendor it goes to — the usual
            one unless the order chooses another. What was actually paid is still recorded on each
            purchase under Spending. Clear a box to remove that vendor&rsquo;s price.
          </p>
        </div>
      )}
    </div>
  );
}
