import { useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { US_STATES, normalizeStateCode, stateName } from "@/lib/us-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { CATALOG_ITEM_SELECT, fmtMoney, num, type CatalogItemPublic } from "@/lib/estimates";
import {
  PRICE_SCOPE_LABEL,
  assignmentApplies,
  assignmentScope,
  catalogCodeIndex,
  detectPriceColumns,
  fetchPriceListAssignments,
  fetchPriceListItems,
  fetchPriceLists,
  parsePriceListCsv,
  today,
  upsertPriceListItems,
  type PriceImportResult,
  type PriceListAssignmentRow,
  type PriceScope,
} from "@/lib/price-lists";

/**
 * PRICE LISTS — "I want to be able to put in price lists for each."
 *
 * David, on the call: "There's a default price list, right? And then I have
 * customers that I have an agreement with that we have different pricing ...
 * I want to be able to differentiate prices based off location and based off
 * client. There's a default across the board. But when you select certain
 * clients, those clients override the default."
 *
 * The default price list is Admin → Estimate catalog, and it is NOT edited
 * here. This screen is only the override layer: a named list of prices, and
 * the customers or branches it applies to. An item a list does not name keeps
 * the catalog price, which is why an agreement is usually four rows and not
 * thirty-four.
 *
 * Resolution — customer, then location, then catalog — lives in
 * src/lib/price-lists.ts and is unit-tested there. Nothing on this screen
 * decides a price; it only stores one.
 */
export const Route = createFileRoute("/_authenticated/admin/price-lists")({
  head: () => ({
    meta: [
      { title: "Price lists · Recovery Hub" },
      {
        name: "description",
        content:
          "Customer agreements and per-location rates that override the default estimate catalog price.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PriceListsAdmin,
});

function PriceListsAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const listsQ = useQuery({ queryKey: ["price-lists"], queryFn: fetchPriceLists });
  const lists = useMemo(() => listsQ.data ?? [], [listsQ.data]);
  const list = lists.find((l) => l.id === selected) ?? lists[0] ?? null;

  const refreshLists = () => void qc.invalidateQueries({ queryKey: ["price-lists"] });

  const addList = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("price_lists")
        .insert({ name: `Price list ${lists.length + 1}`, created_by: app.userId })
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: (id) => {
      setSelected(id);
      refreshLists();
    },
    onError: (e) => toastDbError(e, { action: "Create price list" }),
  });

  const patchList = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string; description?: string | null; is_active?: boolean };
    }) => {
      const { error } = await supabase.from("price_lists").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: refreshLists,
    onError: (e) => toastDbError(e, { action: "Save price list" }),
  });

  return (
    <div className="space-y-3">
      {/* Billing & Costs, prompt 4: agreements and Standard rates moved. */}
      <Card data-price-lists-moved>
        <CardContent className="space-y-1 p-3 text-sm">
          <p className="font-medium">Client agreements now live in Billing &amp; Costs.</p>
          <p className="text-muted-foreground">
            Client agreements and Standard rates (each office&rsquo;s own prices) are edited in{" "}
            <Link
              to="/admin/billing-costs"
              search={{ tab: "client-agreements" }}
              className="font-medium text-link hover:underline"
            >
              Billing &amp; Costs › General Rates
            </Link>
            . A list assigned to a branch here no longer prices anything — office prices are
            Standard rates. State lists still apply, and are edited here.
          </p>
        </CardContent>
      </Card>
      <div className="grid gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm">Price lists</CardTitle>
            <Button
              size="sm"
              variant="outline"
              disabled={app.writesDisabled}
              onClick={() => addList.mutate()}
            >
              <Plus className="size-3.5" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-1.5 p-2">
            {listsQ.isLoading ? (
              <div className="p-2 text-sm text-muted-foreground">Loading…</div>
            ) : lists.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                No price lists yet. Everything is billed at the Estimate catalog price until one is
                created and assigned.
              </p>
            ) : (
              lists.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSelected(l.id)}
                  className={`w-full rounded-sm border px-2 py-1.5 text-left text-sm transition-colors ${
                    list?.id === l.id
                      ? "border-primary bg-primary/10 font-medium"
                      : "hover:bg-accent"
                  }`}
                >
                  <span className="block truncate">{l.name}</span>
                  {!l.is_active && (
                    <Badge variant="secondary" className="mt-1 text-[10px]">
                      Retired
                    </Badge>
                  )}
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {list ? (
          <div className="space-y-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">List</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <Label className="text-xs">Name</Label>
                  <Input
                    key={`${list.id}-name`}
                    defaultValue={list.name}
                    placeholder="Falcon 2026"
                    onBlur={(e) =>
                      e.target.value !== list.name &&
                      patchList.mutate({ id: list.id, patch: { name: e.target.value } })
                    }
                  />
                </div>
                <div className="min-w-56 flex-[2]">
                  <Label className="text-xs">Note</Label>
                  <Input
                    key={`${list.id}-desc`}
                    defaultValue={list.description ?? ""}
                    placeholder="Agreed with Dave R., renews each January"
                    onBlur={(e) =>
                      patchList.mutate({
                        id: list.id,
                        patch: { description: e.target.value || null },
                      })
                    }
                  />
                </div>
                <label className="flex h-9 items-center gap-2 text-sm">
                  <Switch
                    checked={list.is_active}
                    onCheckedChange={(v) =>
                      patchList.mutate({ id: list.id, patch: { is_active: v } })
                    }
                  />
                  Active
                </label>
              </CardContent>
            </Card>

            <AssignmentsCard listId={list.id} />
            <ListPricesCard listId={list.id} />
          </div>
        ) : (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Create a price list to start. Until a list is assigned to a customer or an office,
              every estimate and invoice prices from the Estimate catalog exactly as it does today.
            </CardContent>
          </Card>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        <Label className="text-xs">Note</Label> Changing a price here never changes a line already
        written. Estimates and invoices store the price each line was added at, so an agreement
        signed today does not move a number the customer has already been shown — it prices the
        lines added from now on.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- assignments */

/**
 * Who a list applies to. Three rules, one row each, because they resolve
 * differently:
 *
 *   a customer  — the negotiated agreement ("Falcon pays $80")
 *   a state     — the standing rate across every office in it ("$70 in New
 *                 York and California versus $65 in Jersey"), added by
 *                 20260913110000
 *   an office   — one branch that has its own sheet
 *
 * The state scope is the one David actually described. Before it existed the
 * only way to say "New Jersey" was to assign the list to each New Jersey
 * office by hand, which is why the office row used to be labelled
 * "An office / state" — it was standing in for something the table could not
 * express.
 */
function AssignmentsCard({ listId }: { listId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [scope, setScope] = useState<PriceScope>("account");
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [locationId, setLocationId] = useState<string>("");
  const [stateCode, setStateCode] = useState<string>("");
  const [from, setFrom] = useState(today);

  const rowsQ = useQuery({
    queryKey: ["price-list-assignments", listId],
    queryFn: () => fetchPriceListAssignments(listId),
  });
  const rows = useMemo(() => rowsQ.data ?? [], [rowsQ.data]);

  // Account names for the rows on screen. The picker only knows what was just
  // chosen, and a row saved last month still has to read as "Falcon".
  const accountIds = rows.map((r) => r.account_id).filter((v): v is string => !!v);
  const namesQ = useQuery({
    queryKey: ["price-list-assignment-accounts", accountIds.join(",")],
    enabled: accountIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id, name")
        .in("id", accountIds);
      if (error) throw error;
      return new Map((data ?? []).map((a) => [a.id, a.name]));
    },
  });

  const locations = app.visibleLocations;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["price-list-assignments", listId] });

  const add = useMutation({
    mutationFn: async () => {
      if (scope === "account" && !account) throw new Error("Choose a customer.");
      if (scope === "location" && !locationId) throw new Error("Choose an office.");
      if (scope === "state" && !stateCode) throw new Error("Choose a state.");
      // Exactly one scope per row: the CHECK refuses anything else, and the
      // resolver ranks the rules rather than merging them.
      const { error } = await supabase.from("price_list_assignments").insert({
        price_list_id: listId,
        account_id: scope === "account" ? account!.id : null,
        location_id: scope === "location" ? locationId : null,
        // Stored normalized, so a job carrying "NJ" matches a list created
        // from the picker without either side guessing. Cast because the
        // column arrives with 20260913110000 and `types.ts` is generated from
        // the applied schema; assigning a STATE fails until it is applied,
        // which is the honest behaviour — customer and office still work.
        state_code: scope === "state" ? normalizeStateCode(stateCode) : null,
        effective_from: from,
        created_by: app.userId,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      setAccount(null);
      setLocationId("");
      setStateCode("");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "Assign price list" }),
  });

  const end = useMutation({
    mutationFn: async (row: PriceListAssignmentRow) => {
      // Ending rather than deleting: the row is the record of what applied
      // while it applied, and a document priced under it still refers to it.
      const { error } = await supabase
        .from("price_list_assignments")
        .update({ effective_to: today() })
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "End assignment" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("price_list_assignments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "Remove assignment" }),
  });

  const now = today();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Applies to</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as PriceScope)}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="account">A customer</SelectItem>
                <SelectItem value="state">A state</SelectItem>
                <SelectItem value="location">An office</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scope === "account" && (
            <div className="min-w-64 flex-1">
              <AccountPicker
                value={account}
                onChange={setAccount}
                label="Customer"
                allowCreate={false}
              />
            </div>
          )}
          {scope === "state" && (
            <div>
              <Label className="text-xs">State</Label>
              <Select value={stateCode} onValueChange={setStateCode}>
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Choose a state" />
                </SelectTrigger>
                <SelectContent>
                  {US_STATES.map((st) => (
                    <SelectItem key={st.code} value={st.code}>
                      {st.name} ({st.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {scope === "location" && (
            <div>
              <Label className="text-xs">Office</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Choose an office" />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-xs">Effective from</Label>
            <Input
              type="date"
              className="w-[160px]"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <Button disabled={add.isPending || app.writesDisabled} onClick={() => add.mutate()}>
            {add.isPending ? "Saving…" : "Assign"}
          </Button>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Not assigned to anyone yet, so this list changes nothing. A customer assignment beats an
            office one, an office beats a state, and all three beat the Estimate catalog.
          </p>
        ) : (
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-sm">
              <thead className="border-y bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left">Applies to</th>
                  <th className="w-28 px-2 py-1.5 text-left">Scope</th>
                  <th className="w-28 px-2 py-1.5 text-left">From</th>
                  <th className="w-28 px-2 py-1.5 text-left">To</th>
                  <th className="w-24 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const live = assignmentApplies(r, now);
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-3 py-1.5">
                        {r.account_id
                          ? (namesQ.data?.get(r.account_id) ?? "Customer")
                          : r.state_code
                            ? (stateName(r.state_code) ?? r.state_code)
                            : (locations.find((l) => l.id === r.location_id)?.name ?? "Office")}
                        {live && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            In force
                          </Badge>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">
                        {PRICE_SCOPE_LABEL[assignmentScope(r) ?? "location"]}
                      </td>
                      <td className="px-2 py-1.5 text-xs tabular-nums">{r.effective_from}</td>
                      <td className="px-2 py-1.5 text-xs tabular-nums">{r.effective_to ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right">
                        {live ? (
                          <Button size="sm" variant="ghost" onClick={() => end.mutate(r)}>
                            End today
                          </Button>
                        ) : (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7 text-destructive"
                            title="Remove"
                            onClick={() => remove.mutate(r.id)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ prices */

function ListPricesCard({ listId }: { listId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  // Explicit columns only: estimate_catalog_items has no table-wide SELECT
  // grant, so `select("*")` (or naming default_cost) is "permission denied"
  // for every user. See CATALOG_ITEM_PUBLIC_COLUMNS. Cost has no business on
  // this screen anyway — a price list holds sell prices only.
  const catalogQ = useQuery({
    queryKey: ["estimate-catalog-items"],
    queryFn: async (): Promise<CatalogItemPublic[]> => {
      const { data, error } = await supabase
        .from("estimate_catalog_items")
        .select(CATALOG_ITEM_SELECT)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const catalog = useMemo(() => catalogQ.data ?? [], [catalogQ.data]);
  const byId = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);

  const itemsQ = useQuery({
    queryKey: ["price-list-items", listId],
    queryFn: () => fetchPriceListItems(listId),
  });
  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["price-list-items", listId] });

  const setPrice = useMutation({
    mutationFn: async ({ id, unit_price }: { id: string; unit_price: number }) => {
      const { error } = await supabase.from("price_list_items").update({ unit_price }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "Save price" }),
  });

  const addItem = useMutation({
    mutationFn: async (catalogItemId: string) => {
      const fallback = num(byId.get(catalogItemId)?.default_unit_price);
      await upsertPriceListItems(listId, [
        { catalog_item_id: catalogItemId, unit_price: fallback },
      ]);
    },
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "Add item to price list" }),
  });

  const removeItem = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("price_list_items").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "Remove item from price list" }),
  });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .map((it) => ({ it, item: byId.get(it.catalog_item_id) }))
      .filter(({ item }) => {
        if (!needle) return true;
        return [item?.name, item?.code]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle));
      })
      .sort((a, b) => (a.item?.name ?? "").localeCompare(b.item?.name ?? ""));
  }, [items, byId, q]);

  const unlisted = useMemo(() => {
    const on = new Set(items.map((i) => i.catalog_item_id));
    return catalog.filter((c) => c.is_active && !on.has(c.id));
  }, [catalog, items]);

  return (
    <Card>
      <CardHeader className="gap-2 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto text-sm">Prices on this list</CardTitle>
          <div className="relative min-w-48">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              className="pl-8"
            />
          </div>
          <Select value="" onValueChange={(v) => addItem.mutate(v)}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Add a catalog item" />
            </SelectTrigger>
            <SelectContent>
              {unlisted.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 size-4" /> Import
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full text-sm">
            <thead className="border-y bg-muted text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left">Item</th>
                <th className="w-20 px-2 py-1.5 text-left">UOM</th>
                <th className="w-28 px-2 py-1.5 text-right">Catalog</th>
                <th className="w-28 px-2 py-1.5 text-right">This list</th>
                <th className="w-10 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    Nothing on this list yet. Every item falls through to the Estimate catalog price
                    until it is named here.
                  </td>
                </tr>
              ) : (
                rows.map(({ it, item }) => (
                  <tr key={it.id} className="border-b last:border-0">
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{item?.name ?? "Retired item"}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {item?.code ?? it.catalog_item_id}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">
                      {item?.uom ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right text-xs text-muted-foreground tabular-nums">
                      {fmtMoney(item?.default_unit_price)}
                    </td>
                    <td className="px-2 py-1.5">
                      <NumberInput
                        decimals={2}
                        defaultValue={it.unit_price}
                        className="h-7 px-1 text-right"
                        onCommit={(n) => {
                          const v = n ?? 0;
                          if (v !== num(it.unit_price))
                            setPrice.mutate({ id: it.id, unit_price: v });
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 text-destructive"
                        title="Remove from this list"
                        disabled={app.writesDisabled}
                        onClick={() => removeItem.mutate(it.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardContent>

      <ImportPricesDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        listId={listId}
        catalog={catalog}
        onImported={refresh}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ import */

/**
 * Which row of a sheet is the header row — asked with the price import's own
 * column matching, so a workbook and a paste agree on what a header is.
 */
const hasPriceHeader = (cells: string[]) => detectPriceColumns(cells) != null;

/** A workbook sheet once it has been flattened to import text. */
type LoadedSheet = { name: string; text: string; headerRow: number };

/**
 * "I should have an area somewhere where I could upload a price list."
 *
 * A price list arrives as a spreadsheet of two columns: the item code and the
 * agreed price. Matching on CODE is what makes it work — a code is the thing
 * our catalog and the customer's sheet have in common, where a name differs by
 * a space and a capital letter.
 *
 * The file is never applied blind. Rows and problems are shown first, and the
 * good rows can be written while the bad ones are still on screen to be fixed:
 * a 200-line sheet with three typos should import 197 lines, not be refused
 * whole. Parsing is a pure function in src/lib/price-lists.ts, tested there.
 *
 * A vendor's price list usually arrives as an Excel file, and until now this
 * dialog only read a CSV — the admin had to open the workbook and save it as
 * CSV first. The equipment import closed the same gap (#272) with
 * `workbook-read.ts`, and this does exactly what it does: the workbook is
 * turned into the same delimited text a paste produces and goes through
 * `parsePriceListCsv` like everything else. One parser, one preview, one set
 * of problems, whichever way the rows arrived.
 */
function ImportPricesDialog({
  open,
  onOpenChange,
  listId,
  catalog,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  listId: string;
  catalog: readonly CatalogItemPublic[];
  onImported: () => void;
}) {
  const app = useAppContext();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [sheets, setSheets] = useState<LoadedSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // The note below the box describes the sheet we loaded. Once the text has
  // been edited by hand it no longer does, so it stops claiming to — and the
  // problem list goes back to counting lines of the box, not rows of a sheet.
  const loaded = sheets[sheetIndex];
  const showingSheet = loaded && loaded.text === text ? loaded : null;
  const firstLine = showingSheet && showingSheet.headerRow > 0 ? showingSheet.headerRow : 1;

  const codes = useMemo(() => catalogCodeIndex(catalog), [catalog]);
  const result: PriceImportResult = useMemo(
    () => parsePriceListCsv(text, codes, { firstLine }),
    [text, codes, firstLine],
  );

  async function chooseFile(file: File) {
    if (!/\.xlsx$/i.test(file.name)) {
      setSheets([]);
      setText(await file.text());
      return;
    }
    // Only an .xlsx pulls the workbook reader down; the page itself never
    // carries it.
    const { pickSheet, readWorkbook, sheetToImportText } = await import("@/lib/workbook-read");
    const read = readWorkbook(await file.arrayBuffer());
    if (!read.ok) {
      toast.error("That spreadsheet could not be read", { description: read.reason });
      return;
    }
    const flattened = read.sheets.map((s) => ({
      name: s.name,
      ...sheetToImportText(s, hasPriceHeader),
    }));
    const pick = pickSheet(read.sheets, hasPriceHeader);
    setSheets(flattened);
    setSheetIndex(pick);
    setText(flattened[pick]?.text ?? "");
  }

  async function apply() {
    setSaving(true);
    try {
      const n = await upsertPriceListItems(listId, result.rows);
      toast.success(`${n} price${n === 1 ? "" : "s"} imported`);
      setText("");
      setSheets([]);
      onImported();
      onOpenChange(false);
    } catch (e) {
      toastDbError(e, { action: "Import prices" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88svh] w-[min(46rem,calc(100vw-1.5rem))] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import prices</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Choose the vendor's .xlsx or .csv file, or paste straight from a spreadsheet. Give it a
          header row naming the <b>Code</b> and <b>Price</b> columns and the rest of the sheet —
          descriptions, units, a list price beside the agreed one — is left alone; without a header
          it reads two columns, code then price. Prices formatted as currency ($1,234.50) come
          across as the number. A code already on this list is updated rather than duplicated.
        </p>

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              // Clear the input so choosing the same file twice still fires.
              e.target.value = "";
              if (file) await chooseFile(file);
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            Choose a file
          </Button>
          <span className="text-xs text-muted-foreground">or paste below</span>
        </div>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Code,Price\nDEHU-DAY,80\nLAB-TECH,65"}
          className="min-h-32 font-mono text-xs"
        />

        {sheets.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="price-import-sheet" className="text-xs">
              Sheet
            </Label>
            <Select
              value={String(sheetIndex)}
              onValueChange={(v) => {
                const i = Number(v);
                setSheetIndex(i);
                setText(sheets[i]?.text ?? "");
              }}
            >
              <SelectTrigger id="price-import-sheet" className="h-8 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sheets.map((s, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {showingSheet || result.columns ? (
          <p className="text-xs text-muted-foreground">
            {showingSheet ? (
              <>
                Reading <b>{showingSheet.name}</b>
                {sheets.length > 1 ? ` of ${sheets.length} sheets` : ""}
                {showingSheet.headerRow > 1
                  ? `, headers found on row ${showingSheet.headerRow}`
                  : ""}
                {result.columns ? "; " : "."}
              </>
            ) : null}
            {result.columns ? (
              <>
                {showingSheet ? "codes" : "Codes"} from <b>{result.columns.code}</b>, prices from{" "}
                <b>{result.columns.price}</b>.
              </>
            ) : null}
          </p>
        ) : null}

        {text.trim() && (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            <div className="text-sm">
              <span className="font-semibold">{result.rows.length}</span> price
              {result.rows.length === 1 ? "" : "s"} ready
              {result.problems.length > 0 && (
                <>
                  {", "}
                  <span className="font-semibold text-destructive">
                    {result.problems.length}
                  </span>{" "}
                  row{result.problems.length === 1 ? "" : "s"} to look at
                </>
              )}
            </div>
            {result.problems.length > 0 && (
              <ul className="space-y-1 rounded-sm border border-destructive/40 bg-destructive/5 p-2 text-xs">
                {result.problems.slice(0, 25).map((p, i) => (
                  <li key={`${p.line}-${i}`}>
                    <span className="font-mono">
                      {showingSheet ? "row" : "line"} {p.line}
                    </span>{" "}
                    — {p.reason}
                  </li>
                ))}
                {result.problems.length > 25 && (
                  <li className="text-muted-foreground">and {result.problems.length - 25} more</li>
                )}
              </ul>
            )}
            {result.rows.length > 0 && (
              <table className="w-full text-xs">
                <tbody>
                  {result.rows.slice(0, 50).map((r) => (
                    <tr key={r.catalog_item_id} className="border-b last:border-0">
                      <td className="py-1 font-mono">{r.code}</td>
                      <td className="py-1">
                        {catalog.find((c) => c.id === r.catalog_item_id)?.name}
                      </td>
                      <td className="py-1 text-right tabular-nums">{fmtMoney(r.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={result.rows.length === 0 || saving || app.writesDisabled}
            onClick={() => void apply()}
          >
            {saving ? "Importing…" : `Import ${result.rows.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
