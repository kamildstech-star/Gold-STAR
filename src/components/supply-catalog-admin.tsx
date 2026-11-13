import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { CommitInput } from "@/components/commit-input";
import { VendorPriceEditor } from "@/components/supply-vendor-price-editor";
import { VendorPriceGrid } from "@/components/supply-vendor-price-grid";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LoadError } from "@/components/ui-density";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { duplicateSupplyName, updateSupplyItem, type SupplyItemPatch } from "@/lib/running-cost";
import {
  catalogueSize,
  listItems,
  saveItem,
  setItemActive,
  setItemCode,
  type SupplyItem,
} from "@/lib/supplies";
import { codeTakenBy, normalizeSupplyCode, supplyItemCode } from "@/lib/supply-scan";
import { receiptReviewerId, setReceiptReviewer } from "@/lib/supply-receipts";
import {
  listVendorPrices,
  priceBook,
  setVendorPrice,
  type PriceBook,
} from "@/lib/supply-vendor-prices";
import {
  BLANK_VENDOR_DRAFT,
  deleteSupplyVendor,
  duplicateVendorName,
  listSupplyVendors,
  presetVendor,
  saveSupplyVendor,
  setItemVendor,
  type SupplyVendor,
  type VendorDraft,
} from "@/lib/supply-vendors";

/** Select value for "no preset" — Radix refuses an empty string. */
const NO_VENDOR = "__none__";

/**
 * The supply catalog admin — the ONE screen, with two doorways.
 *
 * David, 22 Sep, hunting for it: "Where is this in the backend?... I don't
 * want to call you, drive you crazy... The purchasing lists, if we could get
 * it built into here — probably rates and catalogs... if we could have that
 * items catalog here, that'll be great."
 *
 * It lived only as the Catalog tab on /supplies, where nobody looking under
 * Settings would think to go. It is now also Settings → Rates & catalogs →
 * Supply catalog. Both doorways render this component against the same
 * `supply_items` rows, so an edit in one is the edit in the other — there is
 * no second catalog to fall out of step.
 *
 * Unit COSTS stay on Cost rates. Those are what the running-cost engine
 * charges a job, a different number from what a vendor charges us, and the
 * screen that owns the margin floor is the right home for them.
 */
export function SupplyCatalogAdmin() {
  const qc = useQueryClient();
  const itemsQ = useQuery({
    queryKey: ["supply-items", "all"],
    queryFn: () => listItems({ includeInactive: true }),
  });
  const [draft, setDraft] = useState({ name: "", unit: "each", category: "", size: "" });

  // Both caches read supply_items: this screen, and Cost rates beside it.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["supply-items"] });
    void qc.invalidateQueries({ queryKey: ["supply-costs"] });
  };

  const add = useMutation({
    mutationFn: () =>
      saveItem({
        name: draft.name,
        unit: draft.unit,
        category: draft.category || null,
        size: draft.size || null,
      }),
    onSuccess: () => {
      toast.success("Item added");
      setDraft({ name: "", unit: "each", category: "", size: "" });
      refresh();
    },
    onError: (e) => {
      const clash = duplicateSupplyName(e, draft.name);
      if (clash) toast.error(clash);
      else toastDbError(e, { action: "add the supply item" });
    },
  });

  const toggle = useMutation({
    mutationFn: (v: { item: SupplyItem; active: boolean }) => setItemActive(v.item.id, v.active),
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "update the supply item" }),
  });

  /** True when the row now matches what was typed — CommitInput keeps the edit. */
  async function saveField(item: SupplyItem, patch: SupplyItemPatch): Promise<boolean> {
    try {
      await updateSupplyItem(item.id, patch);
      refresh();
      return true;
    } catch (err) {
      const clash = duplicateSupplyName(err, patch.name ?? item.name);
      if (clash) toast.error(clash);
      else toastDbError(err, { action: "save the supply item" });
      return false;
    }
  }

  const vendorsQ = useQuery({ queryKey: ["supply-vendors"], queryFn: listSupplyVendors });
  const vendors = vendorsQ.data ?? [];

  const preset = useMutation({
    mutationFn: (v: { item: SupplyItem; vendorId: string }) =>
      setItemVendor(v.item.id, vendors.find((x) => x.id === v.vendorId) ?? null),
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "set the item's vendor" }),
  });

  const pricesQ = useQuery({ queryKey: ["supply-vendor-prices"], queryFn: listVendorPrices });
  const book = useMemo(() => priceBook(pricesQ.data ?? []), [pricesQ.data]);

  const items = itemsQ.data ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Add an item</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 p-3 pt-0 sm:flex sm:flex-wrap sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">Item</Label>
            <Input
              id="cat-name"
              className="sm:w-56"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Nitrile gloves"
            />
          </div>
          <div className="grid grid-cols-3 gap-2 sm:contents">
            <div className="space-y-1.5">
              <Label htmlFor="cat-size">Size</Label>
              <Input
                id="cat-size"
                className="sm:w-32"
                value={draft.size}
                onChange={(e) => setDraft((d) => ({ ...d, size: e.target.value }))}
                placeholder={"21x19x2"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-unit">Unit</Label>
              <Input
                id="cat-unit"
                className="sm:w-28"
                value={draft.unit}
                onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
                placeholder="24 Case"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-category">Category</Label>
              <Input
                id="cat-category"
                className="sm:w-40"
                value={draft.category}
                onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                placeholder="PPE"
              />
            </div>
          </div>
          <Button
            className="h-11 sm:h-9"
            disabled={!draft.name.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            <Plus className="mr-1 size-3.5" /> Add
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Category is what the request form groups by — items sharing a category become one
            section of the form, so it is worth filling in. Two items may share a name as long as
            their sizes differ, which is how David’s sheet lists five sizes of the same filter. Unit
            is the pack it is ordered in: “24 Case”, “1 Roll”.
          </p>
          <p className="w-full text-xs text-muted-foreground">
            Give an item a scan code to print a QR or barcode for its shelf bin — scanning it on the
            Inventory tab fills in the same mark-down form. A code may only belong to one item.
          </p>
        </CardContent>
      </Card>

      <VendorListCard vendors={vendors} loading={vendorsQ.isLoading} error={vendorsQ.error} />

      {/* David, 13 Oct: every vendor's price for every item, side by side. */}
      <VendorPriceGrid items={items} vendors={vendors} book={book} />

      <ReceiptReviewerCard />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Items</CardTitle>
          <p className="text-xs text-muted-foreground">
            Each box saves when you leave it. Renaming a category here renames it on the one item;
            give every item in a section the same category to keep them together on the form. Hidden
            items stay on every past order and simply leave the request form.
          </p>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {/* Without this a failed read shows every item as "Add a price". */}
          {pricesQ.isError ? (
            <div className="p-3">
              <LoadError what="the vendor prices" error={pricesQ.error} />
            </div>
          ) : null}
          {itemsQ.isError ? (
            <div className="p-3">
              <LoadError what="the supply catalog" error={itemsQ.error} />
            </div>
          ) : itemsQ.isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No items yet — add the first above.</p>
          ) : (
            items.map((it) => (
              <div
                key={it.id}
                data-catalog-row
                className="grid grid-cols-2 gap-2 px-3 py-2.5 lg:grid-cols-[minmax(0,2fr)_7rem_7rem_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="col-span-2 lg:col-span-1">
                  <CommitInput
                    value={it.name}
                    aria-label={`Name of ${it.name}`}
                    onCommit={(next) => saveField(it, { name: next })}
                  />
                </div>
                <CommitInput
                  value={catalogueSize(it)}
                  placeholder="Size"
                  aria-label={`Size of ${it.name}`}
                  onCommit={(next) => saveField(it, { size: next })}
                />
                <CommitInput
                  value={it.unit}
                  placeholder="each"
                  aria-label={`Unit of ${it.name}`}
                  onCommit={(next) => saveField(it, { unit: next })}
                />
                <CommitInput
                  value={it.category}
                  placeholder="Category"
                  aria-label={`Category of ${it.name}`}
                  onCommit={(next) => saveField(it, { category: next })}
                />
                {/*
                  The preset. David: "We'll select which vendor we generally
                  purchase it from or preset." An order line can still pick a
                  different one at order time; this is only where it starts.
                */}
                <Select
                  value={presetVendor(it, vendors)?.vendor.id ?? NO_VENDOR}
                  onValueChange={(v) =>
                    preset.mutate({ item: it, vendorId: v === NO_VENDOR ? "" : v })
                  }
                  disabled={vendors.length === 0}
                >
                  <SelectTrigger className="h-8" aria-label={`Usual vendor for ${it.name}`}>
                    <SelectValue placeholder="Usual vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_VENDOR}>No usual vendor</SelectItem>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-end gap-2">
                  <ItemCodeField item={it} items={items} />
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    {it.is_active ? "Active" : "Hidden"}
                    <Switch
                      checked={it.is_active}
                      aria-label={`Toggle ${it.name}`}
                      onCheckedChange={(v) => toggle.mutate({ item: it, active: v })}
                    />
                  </label>
                </div>
                <div className="col-span-2 lg:col-span-6">
                  <ItemVendorPrices
                    item={it}
                    vendors={vendors}
                    book={book}
                    usualVendorId={presetVendor(it, vendors)?.vendor.id ?? null}
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The code printed on an item's shelf bin.
 *
 * David, 16 Sep, point 21: scan-out alongside manual depletion. His sheet had
 * no SKUs, so this is a code the team assigns: the office prints a QR for a
 * bin and types its value here once. Saved on blur, because a row of Save
 * buttons for one short field is noise.
 *
 * The duplicate check runs here so the refusal is a sentence rather than a
 * Postgres error — but the unique index on lower(sku) is still the real
 * boundary, and two people typing the same code at once are stopped by it.
 */
function ItemCodeField({ item, items }: { item: SupplyItem; items: SupplyItem[] }) {
  const qc = useQueryClient();
  const current = supplyItemCode(item) ?? "";
  const [draft, setDraft] = useState(current);

  const save = useMutation({
    mutationFn: (value: string) => setItemCode(item.id, value),
    onSuccess: () => {
      toast.success("Scan code saved");
      void qc.invalidateQueries({ queryKey: ["supply-items"] });
    },
    onError: (e) => {
      setDraft(current);
      toastDbError(e, { action: "save the scan code" });
    },
  });

  const commit = () => {
    const value = draft.trim() ? normalizeSupplyCode(draft) : "";
    if (value === current) return;
    const clash = codeTakenBy(value, items, item.id);
    if (clash) {
      // Named, so the person knows which item to go and fix.
      toast.error(`“${value}” is already the code for ${clash.name}.`);
      setDraft(current);
      return;
    }
    setDraft(value);
    save.mutate(value);
  };

  return (
    <Input
      className="h-8 w-28 font-mono text-xs"
      aria-label={`Scan code for ${item.name}`}
      placeholder="Scan code"
      value={draft}
      disabled={save.isPending}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/**
 * What each vendor charges for this item.
 *
 * David, 22 Sep: "one guy charges $9, the other guy charges $10, then we
 * should be able to put it in for each vendor and the system should
 * automatically pick it up." The editor itself (supply-vendor-price-editor)
 * draws the row; this saves what it commits and refreshes every screen that
 * reads prices — the order detail and Record a purchase share the cache key.
 */
function ItemVendorPrices({
  item,
  vendors,
  book,
  usualVendorId,
}: {
  item: SupplyItem;
  vendors: SupplyVendor[];
  book: PriceBook;
  usualVendorId: string | null;
}) {
  const app = useAppContext();
  const qc = useQueryClient();

  async function commit(vendorId: string, next: number | null) {
    try {
      await setVendorPrice({ itemId: item.id, vendorId, unitPrice: next, userId: app.userId });
      void qc.invalidateQueries({ queryKey: ["supply-vendor-prices"] });
    } catch (e) {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "save the vendor price" });
    }
  }

  return (
    <VendorPriceEditor
      item={item}
      vendors={vendors}
      book={book}
      usualVendorId={usualVendorId}
      onCommit={(vendorId, next) => void commit(vendorId, next)}
    />
  );
}

/**
 * The vendors items are bought from.
 *
 * David, 22 Sep: "I'll have five, 10 vendors in here." The same rows the
 * vendor-order email drafts write into when an approver types an address, so
 * the list also grows on its own; this is where it is tidied.
 */
function VendorListCard({
  vendors,
  loading,
  error,
}: {
  vendors: SupplyVendor[];
  loading: boolean;
  error: unknown;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<VendorDraft>(BLANK_VENDOR_DRAFT);
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["supply-vendors"] });
    void qc.invalidateQueries({ queryKey: ["supply-vendor-emails"] });
    void qc.invalidateQueries({ queryKey: ["supply-items"] });
  };

  const add = useMutation({
    mutationFn: () => saveSupplyVendor(draft),
    onSuccess: () => {
      toast.success("Vendor added");
      setDraft(BLANK_VENDOR_DRAFT);
      refresh();
    },
    onError: (e) => {
      const clash = duplicateVendorName(e, draft.name);
      if (clash) toast.error(clash);
      else if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "add the vendor" });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSupplyVendor(id),
    onSuccess: () => {
      toast.success("Vendor removed");
      setRemoving(null);
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "remove the vendor" }),
  });

  async function saveField(v: SupplyVendor, field: keyof VendorDraft, next: string) {
    const current: VendorDraft = {
      name: v.name,
      email: v.email ?? "",
      phone: v.phone ?? "",
      note: v.note ?? "",
    };
    try {
      await saveSupplyVendor({ ...current, [field]: next }, { id: v.id });
      refresh();
      return true;
    } catch (e) {
      const clash = duplicateVendorName(e, next);
      if (clash) toast.error(clash);
      else if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "save the vendor" });
      return false;
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Vendors</CardTitle>
        <p className="text-xs text-muted-foreground">
          Who supplies are bought from. Pick one as each item&rsquo;s usual vendor below; an order
          can still choose a different one line by line. The email is where the purchase order goes.
          Each item&rsquo;s Prices button below takes what every vendor charges for it.
        </p>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {error ? (
          <div className="p-3">
            <LoadError what="the vendor list" error={error} />
          </div>
        ) : loading ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : vendors.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No vendors yet — add the first below.</p>
        ) : (
          vendors.map((v) => (
            <div
              key={v.id}
              data-vendor-row
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-3 py-2.5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_9rem_minmax(0,1fr)_auto] lg:items-center"
            >
              <CommitInput
                value={v.name}
                aria-label={`Name of vendor ${v.name}`}
                onCommit={(next) => saveField(v, "name", next)}
              />
              <Button
                size="sm"
                variant="ghost"
                className="size-11 p-0 text-muted-foreground hover:text-destructive lg:order-last lg:size-8"
                aria-label={`Remove ${v.name}`}
                onClick={() => setRemoving(removing === v.id ? null : v.id)}
              >
                <Trash2 className="size-4" />
              </Button>
              <div className="col-span-2 grid grid-cols-2 gap-2 lg:contents">
                <CommitInput
                  value={v.email}
                  type="email"
                  placeholder="orders@vendor.com"
                  aria-label={`Email for ${v.name}`}
                  onCommit={(next) => saveField(v, "email", next)}
                />
                <CommitInput
                  value={v.phone}
                  type="tel"
                  placeholder="Phone"
                  aria-label={`Phone for ${v.name}`}
                  onCommit={(next) => saveField(v, "phone", next)}
                />
                <div className="col-span-2 lg:col-span-1">
                  <CommitInput
                    value={v.note}
                    placeholder="Note (account number, rep…)"
                    aria-label={`Note for ${v.name}`}
                    onCommit={(next) => saveField(v, "note", next)}
                  />
                </div>
              </div>
              {removing === v.id && (
                <div className="col-span-2 flex flex-wrap items-center gap-2 rounded-md bg-destructive/5 p-2 text-xs lg:col-span-5">
                  <span className="flex-1">
                    Remove {v.name}? Items that use it lose their usual vendor, and open orders that
                    chose it go back to the item&rsquo;s. Past purchases keep the name.
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                    Keep
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(v.id)}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
        <div className="grid gap-2 bg-muted/40 px-3 py-2.5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_9rem_minmax(0,1fr)_auto] lg:items-center">
          <Input
            className="h-8"
            placeholder="New vendor"
            aria-label="New vendor name"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <div className="grid grid-cols-2 gap-2 lg:contents">
            <Input
              className="h-8"
              type="email"
              placeholder="Email"
              aria-label="New vendor email"
              value={draft.email}
              onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
            />
            <Input
              className="h-8"
              type="tel"
              placeholder="Phone"
              aria-label="New vendor phone"
              value={draft.phone}
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            />
          </div>
          <Input
            className="h-8"
            placeholder="Note"
            aria-label="New vendor note"
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          />
          <Button
            className="h-11 lg:h-8"
            disabled={!draft.name.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            <Plus className="mr-1 size-3.5" /> Add vendor
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Who hears about an uploaded receipt.
 *
 * David named the recipient as "to be determined", so it is a setting rather
 * than a role baked into the code. Leaving it unset does not mean silence:
 * `alertReceiptReviewer` falls back to the managers of the office the receipt
 * was uploaded against, which is a sensible answer rather than nobody.
 */
function ReceiptReviewerCard() {
  const qc = useQueryClient();
  const current = useQuery({ queryKey: ["receipt-reviewer"], queryFn: receiptReviewerId });
  const people = useQuery({
    queryKey: ["supply-requester-names"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("user_id, full_name");
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name ?? p.user_id.slice(0, 8)]));
    },
  });

  const save = useMutation({
    mutationFn: (id: string | null) => setReceiptReviewer(id),
    onSuccess: () => {
      toast.success("Receipt reviewer saved");
      void qc.invalidateQueries({ queryKey: ["receipt-reviewer"] });
    },
    onError: (e) => toastDbError(e, { action: "set the receipt reviewer" }),
  });

  const options = [...(people.data ?? [])].sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 p-3">
        <div className="w-full space-y-1.5 sm:w-auto">
          <Label>Receipt reviewer</Label>
          <Select
            value={current.data ?? "managers"}
            onValueChange={(v) => save.mutate(v === "managers" ? null : v)}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="managers">The office&rsquo;s managers</SelectItem>
              {options.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground sm:min-w-[16rem]">
          Told whenever anybody photographs a receipt, whether or not it could be read. Left on the
          office&rsquo;s managers, the alert still goes somewhere.
        </p>
      </CardContent>
    </Card>
  );
}
