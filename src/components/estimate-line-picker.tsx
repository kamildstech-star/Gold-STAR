import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Plus, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import {
  CATALOG_ITEM_SELECT,
  fmtMoney,
  type CatalogHeader,
  type CatalogItemPublic,
} from "@/lib/estimates";
import { EMPTY_PRICE_BOOK, resolveCatalogPrice, type PriceBook } from "@/lib/price-lists";

/**
 * "Add Line Items" — search across the catalog, filter by header, tick several
 * at once. Multi-select matters: a mold scope is eight lines, and adding them
 * one dialog at a time is the thing estimators complain about.
 */
export function EstimateLinePicker({
  open,
  onOpenChange,
  onAdd,
  priceBook = EMPTY_PRICE_BOOK,
  agreementLabel = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (items: CatalogItemPublic[]) => void | Promise<void>;
  /*
   * The customer's agreement and the branch's list, already resolved for this
   * document (src/lib/price-lists.ts). The price shown here has to be the
   * price that lands on the line, or an estimator picks $95 off the screen and
   * finds $80 on the estimate — so the same book resolves both, and the editor
   * that owns the insert is the one that owns the book.
   */
  priceBook?: PriceBook;
  /** "Falcon 2026", drawn at the top so nobody wonders why prices moved. */
  agreementLabel?: string | null;
}) {
  const [q, setQ] = useState("");
  const [headerId, setHeaderId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, CatalogItemPublic>>({});
  const [saving, setSaving] = useState(false);

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

  // The picker never shows cost, and since 20260909100000 the editors no
  // longer copy it either: a BEFORE INSERT trigger fills unit_cost from the
  // catalog server-side, for every user, so the cost never has to pass
  // through a client that may not be allowed to see it.
  const headers = headersQ.data ?? [];
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (headerId && it.header_id !== headerId) return false;
      if (!needle) return true;
      return (
        it.name.toLowerCase().includes(needle) ||
        it.code.toLowerCase().includes(needle) ||
        (it.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [items, q, headerId]);

  const pickedList = Object.values(picked);

  function toggle(it: CatalogItemPublic) {
    setPicked((cur) => {
      const next = { ...cur };
      if (next[it.id]) delete next[it.id];
      else next[it.id] = it;
      return next;
    });
  }

  async function commit() {
    setSaving(true);
    try {
      await onAdd(pickedList);
      setPicked({});
      setQ("");
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88svh] w-[min(58rem,calc(100vw-1.5rem))] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Add line items</DialogTitle>
        </DialogHeader>

        {agreementLabel && (
          <div className="rounded-sm border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
            <span className="font-semibold">Priced from {agreementLabel}.</span> Items this
            agreement does not name keep the catalog price.
          </div>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search code, name or description"
            className="pl-8"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setHeaderId(null)}
            className={`rounded-sm border px-2 py-1 text-xs transition-colors ${
              headerId === null
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All
          </button>
          {headers.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => setHeaderId(h.id)}
              className={`rounded-sm border px-2 py-1 text-xs transition-colors ${
                headerId === h.id
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {h.name}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-sm border">
          {itemsQ.isLoading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading catalog…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Nothing matches. Admins can add items in Admin → Estimate catalog.
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {filtered.map((it) => {
                  const on = !!picked[it.id];
                  return (
                    <tr
                      key={it.id}
                      onClick={() => toggle(it)}
                      className={`cursor-pointer border-b last:border-0 ${
                        on ? "bg-primary/5" : "hover:bg-muted/50"
                      }`}
                    >
                      <td className="w-8 px-3 py-2">
                        <span
                          className={`flex size-4 items-center justify-center rounded-[3px] border ${
                            on
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-input"
                          }`}
                        >
                          {on && <Check className="size-3" />}
                        </span>
                      </td>
                      <td className="hidden w-24 px-2 py-2 font-mono text-[12px] text-muted-foreground sm:table-cell">
                        {it.code}
                      </td>
                      <td className="min-w-[14rem] px-2 py-2">
                        <div className="text-[15px] font-semibold leading-snug">{it.name}</div>
                        {it.description && (
                          <div className="line-clamp-1 text-[13px] text-muted-foreground">
                            {it.description}
                          </div>
                        )}
                        {/* The code still has to be findable when its column is gone. */}
                        <div className="font-mono text-[11px] text-muted-foreground sm:hidden">
                          {it.code}
                        </div>
                      </td>
                      <td className="w-14 px-2 py-2 text-[13px] text-muted-foreground">{it.uom}</td>
                      <td className="w-28 px-3 py-2 text-right text-[15px] font-medium tabular-nums">
                        {(() => {
                          const price = resolveCatalogPrice(it, priceBook);
                          // Nothing prices it (Billing & Costs P4): it goes in
                          // at $0, and the picker says so — never a silent zero.
                          if (price.source === "none")
                            return (
                              <span
                                className="text-[12px] font-normal text-warning"
                                title="No Standard rate or agreement prices this item. It is added at $0 — type the price on the line, or set it in Billing & Costs › General Rates."
                                data-no-rate
                              >
                                $0 · set rate
                              </span>
                            );
                          if (
                            price.source === "default" ||
                            price.unit_price === Number(it.default_unit_price)
                          )
                            return fmtMoney(price.unit_price);
                          // The catalog price stays on screen, struck through:
                          // "the unit price is $95 ... Falcon has a price that
                          // I'm charging them only $80" is a comparison the
                          // estimator is making, and hiding the 95 hides it.
                          return (
                            <>
                              <div className="text-[11px] font-normal text-muted-foreground line-through">
                                {fmtMoney(it.default_unit_price)}
                              </div>
                              <div className="text-primary">{fmtMoney(price.unit_price)}</div>
                            </>
                          );
                        })()}
                      </td>
                      <td className="hidden w-20 px-2 py-2 sm:table-cell">
                        {!it.taxable && (
                          <Badge variant="outline" className="text-[10px]">
                            No tax
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <span className="text-sm text-muted-foreground">{pickedList.length} selected</span>
          {/* Wait for costs when the viewer may see them, so a privileged user's
              lines never land with a zero cost because they clicked fast. */}
          <Button disabled={pickedList.length === 0 || saving} onClick={() => void commit()}>
            <Plus className="mr-2 size-4" />
            {saving ? "Adding…" : `Add ${pickedList.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
