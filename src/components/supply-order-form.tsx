import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Search, Trash2 } from "lucide-react";

import { JobSearchField, type PickedJob } from "@/components/job-search-field";
import { LocationPicker } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  formDeliveryAddress,
  jobSiteAddress,
  type OfficeAddress,
} from "@/lib/supply-delivery-address";
import { cn } from "@/lib/utils";
import {
  catalogueDetailLine,
  catalogueSize,
  type DraftLine,
  type SupplyItem,
} from "@/lib/supplies";

/**
 * Ordering supplies, laid out the way the Job Calculator prices a job.
 *
 * David, 16 Sep: the request form should work "like the Job Calculator" — a
 * clean fillable form with sections and line items — rather than the single
 * cramped column of item pickers it was. The calculator's shape is a card per
 * section and, inside it, one row per thing with a number box on the right; a
 * user runs down the list typing quantities against names they can already
 * read, instead of opening a dropdown, hunting for a name, and repeating that
 * for every line.
 *
 * The sections are the catalogue's own categories, so they are data and not a
 * list in this file. When the client's spreadsheet is imported, whatever
 * categories it carries become the sections with no code change — which is the
 * point of keeping the catalogue data-driven.
 */

/** A free-typed line, for the thing the catalogue does not have. */
type OtherLine = { label: string; quantity: number; unit: string };

const UNCATEGORISED = "Other supplies";

export type SupplyOrderDraft = {
  locationId: string;
  jobId: string | null;
  neededBy: string | null;
  note: string | null;
  /** Ship-to, as shown on the form: the office's address unless typed over. */
  deliveryAddress: string | null;
  lines: DraftLine[];
};

/** Catalogue grouped into the cards the form draws. Exported for the tests. */
export function groupCatalogue(items: readonly SupplyItem[]) {
  const by = new Map<string, SupplyItem[]>();
  for (const item of items) {
    const key = item.category?.trim() || UNCATEGORISED;
    by.set(key, [...(by.get(key) ?? []), item]);
  }
  return [...by.entries()]
    .map(([name, list]) => ({
      name,
      // The catalogue's own sort_order decides the running order inside a
      // card, so an admin arranges the form without touching this file.
      items: [...list].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) =>
      // The catch-all sits last however it sorts alphabetically.
      a.name === UNCATEGORISED ? 1 : b.name === UNCATEGORISED ? -1 : a.name.localeCompare(b.name),
    );
}

export function SupplyOrderForm({
  items,
  locationId,
  onLocationChange,
  disabled,
  submitting,
  onSubmit,
}: {
  items: SupplyItem[];
  locationId: string;
  onLocationChange: (id: string) => void;
  disabled?: boolean;
  submitting?: boolean;
  onSubmit: (draft: SupplyOrderDraft) => void;
}) {
  /** itemId -> quantity. Absent or zero means it is not being asked for. */
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [others, setOthers] = useState<OtherLine[]>([]);
  const [job, setJob] = useState<PickedJob | null>(null);
  const [neededBy, setNeededBy] = useState("");
  /* `null` until typed in: the address then follows the chosen office. */
  const [typedAddress, setTypedAddress] = useState<string | null>(null);
  const officesQ = useQuery({
    queryKey: ["supply-office-addresses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations")
        .select("id, address, locality, region, postal_code");
      if (error) throw error;
      return new Map((data ?? []).map((l) => [l.id, l as OfficeAddress]));
    },
    staleTime: 10 * 60_000,
  });
  const deliveryAddress = formDeliveryAddress(typedAddress, officesQ.data?.get(locationId) ?? null);
  const jobAddress = jobSiteAddress(job);
  const [note, setNote] = useState("");

  const [search, setSearch] = useState("");
  /** Category names the user has opened by hand. Closed is the default. */
  const [openNames, setOpenNames] = useState<Set<string>>(() => new Set());

  const query = search.trim().toLowerCase();
  const matching = useMemo(
    () =>
      query
        ? items.filter((i) =>
            `${i.name} ${catalogueSize(i) ?? ""} ${i.category ?? ""}`.toLowerCase().includes(query),
          )
        : items,
    [items, query],
  );
  const sections = useMemo(() => groupCatalogue(matching), [matching]);

  const toggleSection = (name: string) =>
    setOpenNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  /** How many of this category's items are already on the request. */
  const countIn = (section: { items: readonly SupplyItem[] }) =>
    section.items.filter((i) => (quantities[i.id] ?? 0) > 0).length;

  /*
   * Closed by default; a search opens everything, because a result hidden
   * inside a collapsed card is not a result.
   *
   * A category holding a quantity USED to be locked open (22 Sep): a number
   * hidden in a closed card is how an order goes out wrong. David, 24 Sep:
   * "once I drop something down and I fill in a number, I can't collapse it
   * anymore." The lock can go because the guard no longer depends on it:
   *   - a closed card says, prominently, how many of its items are on the
   *     request (the badge on its header);
   *   - the summary above Send lists every line and its quantity, so nothing
   *     folded away goes out unseen;
   *   - typing a quantity keeps its card open (below), so a card only ever
   *     closes over a number because the person closed it themselves — never
   *     because a search they cleared took it away.
   */
  const isOpen = (section: { name: string; items: readonly SupplyItem[] }) =>
    !!query || openNames.has(section.name);

  const setQuantity = (itemId: string, n: number, sectionName?: string) => {
    setQuantities((prev) => ({ ...prev, [itemId]: Math.max(0, n) }));
    if (sectionName && n > 0) setOpenNames((prev) => new Set(prev).add(sectionName));
  };

  const lines: DraftLine[] = useMemo(() => {
    const picked: DraftLine[] = items
      .filter((it) => (quantities[it.id] ?? 0) > 0)
      .map((it) => ({ itemId: it.id, quantity: quantities[it.id]!, unit: it.unit }));
    const typed: DraftLine[] = others
      .filter((o) => o.label.trim() && o.quantity > 0)
      .map((o) => ({
        itemId: null,
        otherLabel: o.label.trim(),
        quantity: o.quantity,
        unit: o.unit.trim() || null,
      }));
    return [...picked, ...typed];
  }, [items, quantities, others]);

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Where and when</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <LocationPicker
            value={locationId}
            onChange={onLocationChange}
            label="Office"
            disabled={disabled}
          />
          <div className="space-y-1.5">
            <Label htmlFor="supply-needed-by">Needed by (optional)</Label>
            <Input
              id="supply-needed-by"
              type="date"
              value={neededBy}
              disabled={disabled}
              onChange={(e) => setNeededBy(e.target.value)}
            />
          </div>
          {/*
            David, 22 Sep: "this address up here should be delivery address.
            And maybe have their location, their warehouse preset — or they
            should be able to type in a different address." The office's
            address is filled in and follows the office above until somebody
            types over it; then it is theirs.
          */}
          {/* Above the address now, so "Job site" below has a job to use. */}
          <div className="sm:col-span-2">
            <JobSearchField value={job} onChange={setJob} label="Job (optional)" />
          </div>
          {/*
            David, 24 Sep: "we have to switch the check-off shop or another
            location or whatever, shipped location." Three answers, each one
            tap: the shop (the office's address, the default), the job's site
            (once a job is picked), or anything typed.
          */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="supply-delivery-address">Delivery address</Label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ship to">
              <ShipToChip
                active={typedAddress === null}
                disabled={disabled}
                onClick={() => setTypedAddress(null)}
              >
                Shop
              </ShipToChip>
              <ShipToChip
                active={!!jobAddress && typedAddress === jobAddress}
                disabled={disabled || !jobAddress}
                onClick={() => jobAddress && setTypedAddress(jobAddress)}
              >
                Job site{job ? "" : " (pick a job)"}
              </ShipToChip>
              <ShipToChip
                active={typedAddress !== null && typedAddress !== jobAddress}
                disabled={disabled}
                onClick={() => {
                  setTypedAddress("");
                  document.getElementById("supply-delivery-address")?.focus();
                }}
              >
                Somewhere else
              </ShipToChip>
            </div>
            <Input
              id="supply-delivery-address"
              value={deliveryAddress}
              disabled={disabled}
              autoComplete="street-address"
              placeholder="Where the vendor should deliver"
              onChange={(e) => setTypedAddress(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {typedAddress === null
                ? "The shop — your office's address. Pick Job site or type to deliver elsewhere."
                : typedAddress === jobAddress
                  ? "Delivering to the job site."
                  : "Delivering somewhere other than the shop."}
            </p>
          </div>
        </CardContent>
      </Card>

      {/*
        Search across every category. David, 17 Sep: "If I'm just looking for
        one item, I don't have to see everything." A category he can collapse
        answers that when he knows where the item lives; this answers it when
        he does not, and it cuts across all six at once.
      */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          value={search}
          placeholder="Search every category…"
          aria-label="Search supplies"
          disabled={disabled}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/*
        One card per catalogue category, COLLAPSED until asked for. David: "with
        maybe dropdowns also, just to keep it cleaner — I don't have to see
        everything at once if I'm not looking for everything."
        
        A category holding something already on the request opens itself, so a
        quantity can never be hiding inside a closed section. So does everything
        while a search is running: a result nobody can see is not a result.
      */}
      {sections.map((section) => {
        const openSection = isOpen(section);
        return (
          <Card key={section.name}>
            <CardHeader className="p-0">
              <button
                type="button"
                aria-expanded={openSection}
                onClick={() => toggleSection(section.name)}
                className="flex w-full items-center gap-2 px-6 py-3 text-left"
              >
                <ChevronRight
                  className={cn("size-4 shrink-0 transition-transform", openSection && "rotate-90")}
                  aria-hidden
                />
                <CardTitle className="text-base">{section.name}</CardTitle>
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  {countIn(section) > 0 ? (
                    // Prominent on purpose: this is what stands in for the
                    // numbers when the card is folded.
                    <span
                      data-on-request
                      className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground"
                    >
                      {countIn(section)} on this request
                    </span>
                  ) : null}
                  <span>
                    {section.items.length} item{section.items.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            </CardHeader>
            {openSection && (
              <CardContent className="grid gap-x-6 py-0 sm:grid-cols-2">
                {section.items.map((item) => {
                  // Five of David's rows are called "Pleated Filter Merv 8". The
                  // size goes in the accessible name too, or a screen reader reads
                  // out five identical quantity boxes.
                  const size = catalogueSize(item);
                  return (
                    <div
                      key={item.id}
                      className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-3 border-b py-2 last:border-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        {/*
                      Size and pack, from David's own sheet. He lists five
                      Pleated Filter Merv 8 rows that differ only by size, so
                      the name alone does not tell the person ordering which
                      row they are putting a number against.
                    */}
                        <p className="truncate text-xs text-muted-foreground">
                          {catalogueDetailLine(item)}
                        </p>
                      </div>
                      <NumberInput
                        decimals={0}
                        aria-label={`${item.name}${size ? ` ${size}` : ""} quantity`}
                        value={quantities[item.id] ?? 0}
                        disabled={disabled}
                        onValueChange={(n) => setQuantity(item.id, n ?? 0, section.name)}
                      />
                    </div>
                  );
                })}
              </CardContent>
            )}
          </Card>
        );
      })}

      {items.length === 0 && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            The supply catalog is empty, so there is nothing to run down. An admin can add items
            under Catalog — or type what you need below, because a request should never dead-end on
            a missing list.
          </CardContent>
        </Card>
      )}

      {/*
        Anything the catalogue has no row for gets typed. The blank rows behave
        like the calculator's own "Add item", and keep the promise that a
        dropdown never dead-ends.
      */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Anything else</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {others.map((o, i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_2.25rem] items-center gap-2"
            >
              <Input
                value={o.label}
                placeholder="What do you need?"
                aria-label={`Other item ${i + 1}`}
                disabled={disabled}
                onChange={(e) =>
                  setOthers((p) =>
                    p.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)),
                  )
                }
              />
              <NumberInput
                decimals={0}
                aria-label={`Other item ${i + 1} quantity`}
                value={o.quantity}
                disabled={disabled}
                onValueChange={(n) =>
                  setOthers((p) => p.map((x, idx) => (idx === i ? { ...x, quantity: n ?? 0 } : x)))
                }
              />
              <Input
                value={o.unit}
                placeholder="unit"
                aria-label={`Other item ${i + 1} unit`}
                disabled={disabled}
                onChange={(e) =>
                  setOthers((p) =>
                    p.map((x, idx) => (idx === i ? { ...x, unit: e.target.value } : x)),
                  )
                }
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove other item ${i + 1}`}
                disabled={disabled}
                onClick={() => setOthers((p) => p.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setOthers((p) => [...p, { label: "", quantity: 1, unit: "each" }])}
          >
            <Plus className="mr-1 size-3.5" /> Add item
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Note for the approver</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={2}
            value={note}
            disabled={disabled}
            placeholder="What it is for, or anything the office should know"
            onChange={(e) => setNote(e.target.value)}
          />
          {/*
            Everything on the request, read back before Send — including the
            lines in categories folded shut. This is what made unlocking the
            categories safe (see isOpen).
          */}
          {lines.length > 0 ? (
            <ul
              data-request-summary
              className="divide-y rounded-md border text-sm"
              aria-label="On this request"
            >
              {lines.map((l, i) => {
                const item = l.itemId ? items.find((it) => it.id === l.itemId) : null;
                const size = item ? catalogueSize(item) : null;
                return (
                  <li
                    key={l.itemId ?? `other-${i}`}
                    className="flex items-baseline gap-2 px-3 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item?.name ?? l.otherLabel}
                      {size ? <span className="text-muted-foreground"> ({size})</span> : null}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {l.quantity} {l.unit ?? ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {lines.length === 0
                ? "Nothing requested yet — put a quantity against an item above."
                : `${lines.length} line${lines.length === 1 ? "" : "s"} on this request.`}
            </span>
            <Button
              disabled={disabled || submitting || lines.length === 0 || !locationId}
              onClick={() =>
                onSubmit({
                  locationId,
                  jobId: job?.id ?? null,
                  neededBy: neededBy || null,
                  note: note.trim() || null,
                  deliveryAddress: deliveryAddress.trim() || null,
                  lines,
                })
              }
            >
              {submitting ? "Sending…" : "Send for approval"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** One of the three ship-to answers, 44px on a phone. */
function ShipToChip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "min-h-11 rounded-full border px-3 text-xs sm:min-h-8",
        active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
        disabled && "opacity-50",
      )}
    >
      {children}
    </button>
  );
}
