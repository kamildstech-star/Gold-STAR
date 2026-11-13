import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";

import { LocationPicker } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateUS } from "@/lib/date-format";
import { listPurchases } from "@/lib/supply-inventory";
import { itemHistory, purchaseOrders, purchaseItemName, spendTotal } from "@/lib/supply-spend";
import { cn } from "@/lib/utils";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const yearStart = () => `${new Date().getFullYear()}-01-01`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Supplies › Purchase history (David, 6 Nov): his 2026 spreadsheet, in the
 * app. "Every single supply that we bought in any of our locations … tabs by
 * each order — order number, supplier, total, and a breakdown of what was
 * bought — then how many rolls of duct tape we bought throughout the entire
 * year, the company on a whole and each location individually."
 *
 * Two views over the same purchases (`supply_purchases`, the rows Spending
 * already reads): the year by item, each with its split by office, and the
 * orders one by one. All locations by default, year to date by default.
 */
export function SupplyPurchaseHistory() {
  const [locationId, setLocationId] = useState<string>("");
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today);
  const [view, setView] = useState<"items" | "orders">("items");
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  const purchasesQ = useQuery({
    queryKey: ["supply-purchase-history", locationId, from, to],
    queryFn: () => listPurchases({ locationId: locationId || null, from, to }),
    enabled: !!from && !!to,
  });
  const rows = purchasesQ.data ?? [];
  const items = useMemo(() => itemHistory(rows), [rows]);
  const orders = useMemo(() => purchaseOrders(rows), [rows]);
  const total = useMemo(() => spendTotal(rows), [rows]);
  const multiLocation = useMemo(
    () => new Set(rows.map((r) => r.location_id ?? r.location_name ?? "")).size > 1,
    [rows],
  );

  return (
    <div className="space-y-2" data-purchase-history>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="flex items-end gap-2">
            <LocationPicker
              value={locationId}
              onChange={setLocationId}
              label="Location"
              placeholder="All locations"
              noPrefill
            />
            {locationId && (
              <Button variant="ghost" size="sm" className="h-10" onClick={() => setLocationId("")}>
                All locations
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="history-from">From</Label>
            <Input
              id="history-from"
              type="date"
              className="w-40"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="history-to">To</Label>
            <Input
              id="history-to"
              type="date"
              className="w-40"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="ml-auto text-right">
            <div className="text-xs text-muted-foreground">Bought in this window</div>
            <div className="text-xl font-semibold tabular-nums">{usd(total)}</div>
            <div className="text-xs text-muted-foreground">
              {rows.length} line{rows.length === 1 ? "" : "s"} · {orders.length} order
              {orders.length === 1 ? "" : "s"}
            </div>
          </div>
        </CardContent>
      </Card>

      <div
        className="inline-flex flex-wrap gap-0.5 rounded-md border bg-muted p-0.5"
        role="tablist"
      >
        {(
          [
            ["items", "By item"],
            ["orders", "By order"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={view === k}
            onClick={() => setView(k)}
            className={cn(
              "rounded px-3 py-1 text-sm",
              view === k
                ? "bg-card font-semibold text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {purchasesQ.isLoading && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      )}
      {!purchasesQ.isLoading && rows.length === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Nothing bought in this window. Purchases recorded on the Spending tab, and approved
            receipts, are counted here.
          </CardContent>
        </Card>
      )}

      {view === "items" && items.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Every item, this window</CardTitle>
            <p className="text-xs text-muted-foreground">
              How much of each thing was bought and what it cost, the company as a whole. Open an
              item for the split by office and the purchases behind it.
            </p>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {items.map((it) => {
              const open = openItem === it.key;
              const lines = rows.filter(
                (r) => (r.item_id ?? purchaseItemName(r).toLowerCase()) === it.key,
              );
              return (
                <div key={it.key} data-history-item={it.label}>
                  <button
                    type="button"
                    onClick={() => setOpenItem(open ? null : it.key)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
                  >
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        !open && "-rotate-90",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{it.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {it.quantity.toLocaleString("en-US")} units · {it.purchases} purchase
                      {it.purchases === 1 ? "" : "s"}
                    </span>
                    <span className="w-24 shrink-0 text-right tabular-nums">{usd(it.total)}</span>
                  </button>
                  {open && (
                    <div className="space-y-2 bg-muted/30 px-3 pb-3 pl-10 pt-1 text-sm">
                      {multiLocation && (
                        <ul className="space-y-0.5" aria-label={`${it.label} by location`}>
                          {it.byLocation.map((l) => (
                            <li key={l.location} className="flex items-center gap-3">
                              <span className="min-w-0 flex-1 truncate">{l.location}</span>
                              <span className="text-xs text-muted-foreground">
                                {l.quantity.toLocaleString("en-US")} units
                              </span>
                              <span className="w-24 text-right tabular-nums">{usd(l.total)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <ul className="space-y-0.5 text-xs text-muted-foreground">
                        {lines.map((p) => (
                          <li key={p.id} className="flex items-center gap-3">
                            <span className="w-24 shrink-0 tabular-nums">
                              {formatDateUS(p.purchased_on)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {p.quantity.toLocaleString("en-US")} × {usd(p.unit_price)} ·{" "}
                              {p.supplier_name}
                              {p.location_name ? ` · ${p.location_name}` : ""}
                            </span>
                            <span className="w-24 shrink-0 text-right tabular-nums text-foreground">
                              {usd(p.total_cost)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {view === "orders" && orders.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Orders, newest first</CardTitle>
            <p className="text-xs text-muted-foreground">
              One supplier on one day at one office is an order. Open one for what was on it.
            </p>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {orders.map((o) => {
              const open = openOrder === o.key;
              return (
                <div key={o.key} data-history-order={o.key}>
                  <button
                    type="button"
                    onClick={() => setOpenOrder(open ? null : o.key)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
                  >
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        !open && "-rotate-90",
                      )}
                      aria-hidden
                    />
                    <span className="w-24 shrink-0 tabular-nums">
                      {formatDateUS(o.purchased_on)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{o.supplier}</span>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                      {o.location} · {o.lines.length} line{o.lines.length === 1 ? "" : "s"}
                    </span>
                    <span className="w-24 shrink-0 text-right tabular-nums">{usd(o.total)}</span>
                  </button>
                  {open && (
                    <ul className="space-y-0.5 bg-muted/30 px-3 pb-3 pl-10 pt-1 text-xs text-muted-foreground">
                      {o.lines.map((p) => (
                        <li key={p.id} className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-foreground">
                            {purchaseItemName(p)}
                          </span>
                          <span className="shrink-0">
                            {p.quantity.toLocaleString("en-US")} × {usd(p.unit_price)}
                          </span>
                          <span className="w-24 shrink-0 text-right tabular-nums text-foreground">
                            {usd(p.total_cost)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
