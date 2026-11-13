import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { AlertTriangle, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Pager, usePaged } from "@/components/billing-costs/pager";
import { CommitInput } from "@/components/commit-input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastDbError } from "@/lib/db-errors";
import { loadSupplyCharges, setSupplyCharge } from "@/lib/supply-charges";
import {
  BLANK_SUPPLY_DRAFT,
  addSupplyItem,
  archiveSupplyItem,
  duplicateSupplyName,
  listSupplyCosts,
  setSupplyCost,
  updateSupplyItem,
  type SupplyCostRow,
  type SupplyItemDraft,
  type SupplyItemPatch,
} from "@/lib/running-cost";

/**
 * Billing & Costs › Cost › Supplies book (prompt 3): the supply catalogue the
 * supply request form picks from — each item's unit cost and its charge — as
 * it was on Settings › Cost rates › Materials & supplies, moved here whole
 * when that page was retired. The Supplies catalogue stays its own book (P2
 * answer 2); it is not the T&M Consumables.
 */
export function SupplyBook({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const supplyQ = useQuery({ queryKey: ["supply-costs"], queryFn: listSupplyCosts });
  /** What each supply is charged to the customer (supply-charges.ts). */
  const chargesQ = useQuery({ queryKey: ["supply-charges"], queryFn: loadSupplyCharges });

  /* ------------------------------------------------- the supply catalogue */

  const [draft, setDraft] = useState<SupplyItemDraft>(BLANK_SUPPLY_DRAFT);
  const [archiving, setArchiving] = useState<SupplyCostRow | null>(null);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const supplies = (supplyQ.data ?? []).filter(
    (s) => !needle || `${s.name} ${s.category ?? ""}`.toLowerCase().includes(needle),
  );
  const paged = usePaged(supplies, needle);

  /** True when the row now matches what was typed — the box keeps the edit. */
  async function saveItem(s: SupplyCostRow, patch: SupplyItemPatch): Promise<boolean> {
    try {
      await updateSupplyItem(s.id, patch);
      qc.invalidateQueries({ queryKey: ["supply-costs"] });
      return true;
    } catch (err) {
      const clash = duplicateSupplyName(err, patch.name ?? s.name);
      if (clash) toast.error(clash);
      else toastDbError(err, { action: "Could not save the item" });
      return false;
    }
  }

  const add = useMutation({
    mutationFn: () => addSupplyItem(draft),
    onSuccess: () => {
      toast.success("Item added");
      setDraft(BLANK_SUPPLY_DRAFT);
      qc.invalidateQueries({ queryKey: ["supply-costs"] });
    },
    onError: (err) => {
      const clash = duplicateSupplyName(err, draft.name);
      if (clash) toast.error(clash);
      // A refused draft — no name, a negative cost — is our own Error, and
      // its message is already the sentence to show.
      else if (err instanceof Error && !("code" in err)) toast.error(err.message);
      else toastDbError(err, { action: "Could not add the item" });
    },
  });

  const archive = useMutation({
    mutationFn: (s: SupplyCostRow) => archiveSupplyItem(s.id),
    onSuccess: (_void, s) => {
      toast.success(`${s.name} archived`);
      setArchiving(null);
      qc.invalidateQueries({ queryKey: ["supply-costs"] });
    },
    onError: (err) => toastDbError(err, { action: "Could not archive the item" }),
  });

  return (
    <div className="space-y-3" data-supply-book>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Supply unit costs</CardTitle>
          <p className="text-xs text-muted-foreground">
            The list the supply request form picks from, and the prices the running cost charges a
            job.
            {canEdit &&
              " Name, unit, category and cost each save when you leave the box; the last row adds a new item. Removing archives it, so the jobs that already used it keep their history."}
          </p>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search supplies by name or category"
            aria-label="Search supplies"
            className="mt-2 h-11 md:h-8"
          />
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="w-40">Unit</TableHead>
                <TableHead className="w-44">Category</TableHead>
                <TableHead className="w-32">Unit cost ($)</TableHead>
                <TableHead
                  className="w-32"
                  title="What the customer is charged — the job ledger uses it"
                >
                  Charge ($)
                </TableHead>
                {canEdit && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!canEdit &&
                paged.rows.map((s) => {
                  const charge = chargesQ.data?.get(s.id)?.price;
                  return (
                    <TableRow key={s.id}>
                      <TableCell>{s.name}</TableCell>
                      <TableCell>{s.unit || "each"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.category || "Uncategorized"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {s.unit_cost == null ? "Not set" : `$${s.unit_cost.toFixed(2)}`}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {charge == null ? "Not set" : `$${charge.toFixed(2)}`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              {canEdit &&
                paged.rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <CommitInput
                        value={s.name}
                        aria-label={`Name of ${s.name}`}
                        onCommit={(next) => saveItem(s, { name: next })}
                      />
                    </TableCell>
                    <TableCell>
                      <CommitInput
                        value={s.unit}
                        placeholder="each"
                        aria-label={`Unit of ${s.name}`}
                        onCommit={(next) => saveItem(s, { unit: next })}
                      />
                    </TableCell>
                    <TableCell>
                      <CommitInput
                        value={s.category}
                        placeholder="Uncategorized"
                        aria-label={`Category of ${s.name}`}
                        onCommit={(next) => saveItem(s, { category: next })}
                      />
                    </TableCell>
                    <TableCell>
                      <NumberInput
                        className="h-8"
                        decimals={2}
                        defaultValue={s.unit_cost}
                        onCommit={async (next) => {
                          try {
                            await setSupplyCost(s.id, next);
                            qc.invalidateQueries({ queryKey: ["supply-costs"] });
                          } catch (err) {
                            toastDbError(err, { action: "Could not save the unit cost" });
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <NumberInput
                        className="h-8"
                        decimals={2}
                        aria-label={`Charge for ${s.name}`}
                        defaultValue={chargesQ.data?.get(s.id)?.price ?? null}
                        key={`${s.id}:${chargesQ.data?.get(s.id)?.price ?? "none"}`}
                        onCommit={async (next) => {
                          if (next == null) return;
                          try {
                            await setSupplyCharge(s.id, next);
                            qc.invalidateQueries({ queryKey: ["supply-charges"] });
                          } catch (err) {
                            toastDbError(err, { action: "Could not save the charge" });
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="size-7 p-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${s.name}`}
                        onClick={() => setArchiving(s)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              {/*
               * The add row lives at the bottom of the table rather than in a
               * dialog because its four boxes ARE the four columns — typed
               * under the last item, a new row reads as the next one. Every
               * other control on this page edits in place too, so a modal
               * would be the only mode switch on the screen.
               */}
              {canEdit && (
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell>
                    <Input
                      className="h-8"
                      placeholder="New item"
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") add.mutate();
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8"
                      placeholder="each"
                      value={draft.unit}
                      onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8"
                      placeholder="Category"
                      value={draft.category}
                      onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                    />
                  </TableCell>
                  <TableCell>
                    <NumberInput
                      className="h-8"
                      decimals={2}
                      value={draft.unitCost ?? ""}
                      onValueChange={(n) => setDraft((d) => ({ ...d, unitCost: n }))}
                    />
                  </TableCell>
                  <TableCell className="text-[11px] text-muted-foreground">
                    Set after adding
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={add.isPending}
                      onClick={() => add.mutate()}
                    >
                      Add
                    </Button>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <Pager paged={paged} noun="supplies" />
        </CardContent>
      </Card>
      <AlertDialog open={!!archiving} onOpenChange={(o) => !o && setArchiving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiving?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from the supply request form and from this list. Nothing is deleted:
              past requests, stock movements and the cost already charged to finished jobs all keep
              pointing at it. Adding an item with the same name later brings it back as a new row,
              so archive rather than rename when something is simply no longer bought.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => archiving && archive.mutate(archiving)}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Units of the register with no day cost: they accrue nothing on a job until costed. */
export function UnpricedUnitsNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-sm border border-warning/40 bg-warning/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <span>
        <strong>{count}</strong> unit{count === 1 ? "" : "s"} have no daily cost — they accrue
        nothing on a job until costed. Set the type&rsquo;s day cost below, or a unit&rsquo;s own on
        its page in{" "}
        <Link to="/equipment" search={{ type: "all", status: "all", q: "" }} className="underline">
          Equipment
        </Link>
        .
      </span>
    </div>
  );
}
