/**
 * Vendor prices as a spreadsheet: one row per item, one column per vendor.
 *
 * David, 13 Oct: "each vendor has its own price column per item" so he can
 * type a price per vendor the way his sheet works, plus a preferred vendor per
 * item. Same data as the per-item price editor below it — `setVendorPrice`
 * (`supply_item_vendor_prices`) for a cell, `setItemVendor`
 * (`supply_items.default_vendor_id`) for the star — so the two views can
 * never disagree. An empty cell clears that vendor's price.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toastDbError } from "@/lib/db-errors";
import type { SupplyItem } from "@/lib/supplies";
import { setVendorPrice, vendorPriceGrid, type PriceBook } from "@/lib/supply-vendor-prices";
import { setItemVendor, type SupplyVendor } from "@/lib/supply-vendors";
import { cn } from "@/lib/utils";
import { roundMoney } from "@/lib/money";

/** A price cell: commits on blur or Enter, blank clears. */
function PriceCell({
  value,
  label,
  cheapest,
  preferred,
  disabled,
  onCommit,
}: {
  value: number | null;
  label: string;
  cheapest: boolean;
  preferred: boolean;
  disabled: boolean;
  onCommit: (next: number | null) => void;
}) {
  const shown = value == null ? "" : value.toFixed(2);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  const commit = () => {
    setFocused(false);
    const t = text.trim().replace(/^\$/, "");
    const next = t === "" ? null : Number(t);
    if (next != null && (!Number.isFinite(next) || next < 0)) {
      toast.error("A price is a number, $0 or more.");
      setText(shown);
      return;
    }
    if ((next == null && value == null) || (next != null && value != null && next === value))
      return;
    onCommit(next == null ? null : roundMoney(next));
  };
  return (
    <Input
      inputMode="decimal"
      aria-label={label}
      className={cn(
        "h-8 w-24 text-right text-xs tabular-nums",
        preferred && "border-primary/60 bg-primary/5",
        cheapest && !preferred && "border-success/50",
      )}
      disabled={disabled}
      value={focused ? text : shown}
      placeholder="—"
      onFocus={() => {
        setText(shown);
        setFocused(true);
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function VendorPriceGrid({
  items,
  vendors,
  book,
}: {
  items: SupplyItem[];
  vendors: SupplyVendor[];
  book: PriceBook;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const t = filter.trim().toLowerCase();
    const shown = t ? items.filter((i) => i.name.toLowerCase().includes(t)) : items;
    return vendorPriceGrid(shown, vendors, book);
  }, [items, vendors, book, filter]);

  async function savePrice(itemId: string, vendorId: string, next: number | null) {
    try {
      await setVendorPrice({ itemId, vendorId, unitPrice: next, userId: app.userId });
      void qc.invalidateQueries({ queryKey: ["supply-vendor-prices"] });
    } catch (e) {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "save the vendor price" });
    }
  }

  async function prefer(itemId: string, vendor: SupplyVendor | null) {
    try {
      await setItemVendor(itemId, vendor);
      void qc.invalidateQueries({ queryKey: ["supply-items"] });
    } catch (e) {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "set the preferred vendor" });
    }
  }

  return (
    <Card data-vendor-price-grid>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Vendor prices</CardTitle>
        <p className="text-xs text-muted-foreground">
          One column per vendor. Type each vendor&rsquo;s price; a blank box means that vendor has
          no price. The star marks the item&rsquo;s preferred vendor — the one new orders use unless
          a line says otherwise. The cheapest price on a row is outlined green.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {vendors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add vendors in the Vendors card first — each one becomes a column here.
          </p>
        ) : (
          <>
            <Input
              className="h-8 max-w-xs text-xs"
              placeholder="Filter items"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-md border">
              <table className="w-full border-collapse text-xs">
                <thead className="bg-muted">
                  <tr>
                    <th className="sticky left-0 z-10 bg-muted/90 px-2 py-1.5 text-left font-semibold">
                      Item
                    </th>
                    {vendors.map((v) => (
                      <th
                        key={v.id}
                        className="px-2 py-1.5 text-right font-semibold whitespace-nowrap"
                      >
                        {v.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={r.itemId}>
                      <td className="sticky left-0 z-10 max-w-[16rem] truncate bg-background px-2 py-1">
                        {r.label}
                      </td>
                      {r.cells.map((c, i) => {
                        const vendor = vendors[i]!;
                        return (
                          <td key={c.vendorId} className="px-2 py-1">
                            <div className="flex items-center justify-end gap-1">
                              <PriceCell
                                value={c.price}
                                label={`${r.label} at ${vendor.name}`}
                                cheapest={c.cheapest}
                                preferred={c.preferred}
                                disabled={app.writesDisabled}
                                onCommit={(next) => void savePrice(r.itemId, c.vendorId, next)}
                              />
                              <button
                                type="button"
                                aria-pressed={c.preferred}
                                aria-label={
                                  c.preferred
                                    ? `${vendor.name} is preferred for ${r.label} — clear`
                                    : `Make ${vendor.name} preferred for ${r.label}`
                                }
                                title={c.preferred ? "Preferred vendor" : "Make preferred"}
                                disabled={app.writesDisabled}
                                className="rounded p-1 text-muted-foreground hover:text-primary disabled:opacity-50"
                                onClick={() => void prefer(r.itemId, c.preferred ? null : vendor)}
                              >
                                <Star
                                  className={cn(
                                    "size-3.5",
                                    c.preferred && "fill-primary text-primary",
                                  )}
                                />
                              </button>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
