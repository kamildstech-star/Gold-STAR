/**
 * The Expense tracker on the job's Billing tab (named "Large-loss expenses"
 * until David, 15 Oct: "simply Expense tracker"). The code keeps its
 * large-loss names; only what the user sees changed.
 *
 * David, 13 Oct: on a large job, record what was spent on third-party
 * contractors, supplies and equipment, each with its receipt. Switched on per
 * job (`jobs.is_large_loss`) so ordinary jobs stay as they are. Switched off
 * it is only its switch (David, 20 Oct). Since 21 Oct it sits in Billing's
 * money column where Cost by work component was (jobs.$id.tsx).
 *
 * Every entry is an expense on the job, so the running cost above picks it up
 * at once; the receipt is filed on the job's Documents in "Expense receipts".
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Paperclip, Receipt, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExpenseImportDialog } from "@/components/expense-import-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { SIGNED_URL_OPEN_SECONDS, signStoredFile } from "@/lib/signed-url";
import { DOCUMENT_BUCKET, fileIntoJobFolder, uploadDocumentFile } from "@/lib/documents";
import {
  EXPENSE_TRACKER_TITLE,
  expenseExportSheet,
  insertImportedExpenses,
} from "@/lib/expense-sheet";
import { downloadCsvSheet, downloadXlsx } from "@/lib/export-table";
import {
  LARGE_LOSS_ALWAYS_ON,
  LARGE_LOSS_CATEGORIES,
  RECEIPTS_FOLDER,
  addLargeLossExpense,
  deleteLargeLossExpense,
  fetchLargeLossFlag,
  largeLossLabel,
  largeLossTotals,
  listLargeLossExpenses,
  setLargeLossFlag,
  type LargeLossDraft,
  type LargeLossKind,
} from "@/lib/large-loss-expenses";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

export function LargeLossExpensesCard({
  job,
}: {
  job: { id: string; location_id: string; account_id: string | null; job_number: string | null };
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [kind, setKind] = useState<LargeLossKind>("job_contractor");
  const [amount, setAmount] = useState<number | null>(null);
  const [spentOn, setSpentOn] = useState(today);
  const [vendor, setVendor] = useState("");
  const [description, setDescription] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const flagQ = useQuery({
    queryKey: ["large-loss-flag", job.id],
    queryFn: () => fetchLargeLossFlag(job.id),
  });
  const on = flagQ.data?.on ?? false;
  const listQ = useQuery({
    queryKey: ["large-loss-expenses", job.id],
    enabled: on,
    queryFn: () => listLargeLossExpenses(job.id),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["large-loss-expenses", job.id] });
    // The running cost reads every expense on the job.
    void qc.invalidateQueries({ queryKey: ["job-running-cost", job.id] });
    void qc.invalidateQueries({ queryKey: ["running-cost", job.id] });
    void qc.invalidateQueries({ queryKey: ["job-documents", job.id] });
  };

  const toggle = useMutation({
    mutationFn: (next: boolean) => setLargeLossFlag(job.id, next),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["large-loss-flag", job.id] }),
    onError: (e) => toastDbError(e, { action: "Switch the expense tracker" }),
  });

  const add = useMutation({
    mutationFn: async () => {
      if (!app.userId) throw new Error("You must be signed in.");
      const scope = { locationId: job.location_id, jobId: job.id, accountId: job.account_id };
      return addLargeLossExpense(
        {
          draft: { kind, amount: amount ?? 0, spentOn, vendor, description },
          jobId: job.id,
          locationId: job.location_id,
          accountId: job.account_id,
          userId: app.userId,
          receipt,
        },
        {
          upload: (file) =>
            uploadDocumentFile({
              file,
              scope,
              docType: "other",
              userId: app.userId ?? null,
              name: `Receipt — ${vendor.trim() || largeLossLabel(kind)} (${spentOn})`,
            }),
          file: (documentId) =>
            fileIntoJobFolder({
              documentId,
              scope,
              folderName: RECEIPTS_FOLDER,
              userId: app.userId ?? null,
            }),
        },
      );
    },
    onSuccess: () => {
      toast.success("Expense added", { description: "It is in the job's running cost now." });
      setAmount(null);
      setVendor("");
      setDescription("");
      setReceipt(null);
      if (fileRef.current) fileRef.current.value = "";
      refresh();
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "Add the expense" });
    },
  });

  const importRows = useMutation({
    mutationFn: async (drafts: LargeLossDraft[]) => {
      if (!app.userId) throw new Error("You must be signed in.");
      return insertImportedExpenses({
        drafts,
        jobId: job.id,
        locationId: job.location_id,
        userId: app.userId,
      });
    },
    onSuccess: (n) => {
      toast.success(`${n} ${n === 1 ? "expense" : "expenses"} imported`, {
        description: "They are in the job's running cost now.",
      });
      setImportOpen(false);
      refresh();
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "Import the expenses" });
    },
  });

  const exportName = `expenses${job.job_number ? `-${job.job_number}` : ""}`;

  const remove = useMutation({
    mutationFn: (id: string) => deleteLargeLossExpense(id),
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "Delete the expense" }),
  });

  async function openReceipt(path: string) {
    const { data, error } = await signStoredFile(supabase, DOCUMENT_BUCKET, path, {
      seconds: SIGNED_URL_OPEN_SECONDS,
    });
    if (error || !data) return toast.error("The receipt could not be opened.");
    window.open(data.signedUrl, "_blank", "noopener");
  }

  if (flagQ.isLoading) return null;
  const available = flagQ.data?.available ?? false;
  const rows = listQ.data ?? [];
  const totals = largeLossTotals(rows);
  const busy = add.isPending || app.writesDisabled;
  /*
   * David, 20 Oct: switched off, the section is just its switch — the room
   * on Billing is for a job that uses it. What it is for moves into the
   * switch's tooltip.
   */
  const collapsed = available && !on;

  return (
    <Card data-large-loss>
      <CardHeader
        className={`flex flex-row items-center justify-between gap-2 space-y-0 ${collapsed ? "py-3" : "pb-2"}`}
      >
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Receipt className="size-4" /> {EXPENSE_TRACKER_TITLE}
          {on && rows.length > 0 ? (
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              · {usd(totals.total)}
            </span>
          ) : null}
        </CardTitle>
        <div className="flex items-center gap-1">
          {on && available ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label="Export the expenses"
                    title="Export to Excel or CSV"
                    disabled={rows.length === 0}
                  >
                    <Download className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => downloadXlsx(exportName, expenseExportSheet(rows))}
                  >
                    Excel (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => downloadCsvSheet(exportName, expenseExportSheet(rows))}
                  >
                    CSV
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label="Import expenses from a spreadsheet"
                title="Import from Excel or CSV"
                disabled={app.writesDisabled}
                onClick={() => setImportOpen(true)}
              >
                <Upload className="size-4" />
              </Button>
            </>
          ) : null}
          {!LARGE_LOSS_ALWAYS_ON && available ? (
            <label
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title={
                on
                  ? undefined
                  : "For large-loss, T&M and reconstruction jobs: track contractors, supplies and equipment with their receipts. The costs go into the running cost."
              }
            >
              {on ? "On" : "Off"}
              <Switch
                checked={on}
                disabled={toggle.isPending || app.writesDisabled}
                aria-label="Use the expense tracker on this job"
                onCheckedChange={(v) => toggle.mutate(v)}
              />
            </label>
          ) : null}
        </div>
      </CardHeader>
      {collapsed ? null : (
        <CardContent className="space-y-3 text-sm">
          {!available ? (
            <p className="text-xs text-muted-foreground">
              Waiting on database update 20261014120000 — then switch it on for large, T&amp;M or
              reconstruction jobs.
            </p>
          ) : (
            <>
              {rows.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {LARGE_LOSS_CATEGORIES.filter((c) => totals.byKind[c.kind] > 0).map((c) => (
                      <span key={c.kind}>
                        {c.label}:{" "}
                        <span className="tabular-nums">{usd(totals.byKind[c.kind])}</span>
                      </span>
                    ))}
                    <span>
                      {totals.withReceipt} of {totals.count} with a receipt
                    </span>
                  </div>
                  <ul className="divide-y rounded-md border">
                    {rows.map((r) => (
                      <li key={r.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                        <span className="w-20 shrink-0 tabular-nums text-muted-foreground">
                          {r.spent_on}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">
                            {r.merchant || largeLossLabel(r.kind)}
                          </span>
                          <span className="text-muted-foreground">
                            {" "}
                            · {largeLossLabel(r.kind)}
                            {r.description ? ` · ${r.description}` : ""}
                          </span>
                        </span>
                        {r.receipt_path ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label="Open the receipt"
                            onClick={() => void openReceipt(r.receipt_path!)}
                          >
                            <Paperclip className="size-3.5" />
                          </Button>
                        ) : null}
                        <span className="w-20 shrink-0 text-right font-medium tabular-nums">
                          {usd(r.amount)}
                        </span>
                        {r.user_id === app.userId ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            aria-label="Delete this expense"
                            disabled={remove.isPending || app.writesDisabled}
                            onClick={() => remove.mutate(r.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : listQ.isError ? (
                <p className="text-xs text-destructive">
                  The expenses could not be loaded — this is not an empty list.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
              )}

              <div className="grid gap-2 rounded-md border p-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">For</Label>
                  <Select value={kind} onValueChange={(v) => setKind(v as LargeLossKind)}>
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LARGE_LOSS_CATEGORIES.map((c) => (
                        <SelectItem key={c.kind} value={c.kind}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Vendor / contractor</Label>
                  <Input
                    className="h-9 text-xs"
                    value={vendor}
                    onChange={(e) => setVendor(e.target.value)}
                    placeholder="ABC Drywall"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Amount</Label>
                  <NumberInput
                    className="h-9 text-xs"
                    decimals={2}
                    value={amount ?? ""}
                    onValueChange={(n) => setAmount(n ?? null)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Date</Label>
                  <Input
                    type="date"
                    className="h-9 text-xs"
                    value={spentOn}
                    onChange={(e) => setSpentOn(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">What for (optional)</Label>
                  <Input
                    className="h-9 text-xs"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Demo and haul-away, 2nd floor"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Paperclip className="mr-1 size-3.5" />
                    {receipt ? receipt.name : "Attach receipt"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="ml-auto h-9"
                    disabled={busy}
                    onClick={() => add.mutate()}
                  >
                    {add.isPending ? "Saving…" : "Add expense"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      )}
      <ExpenseImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        busy={importRows.isPending}
        onImport={async (drafts) => {
          await importRows.mutateAsync(drafts).catch(() => undefined);
        }}
      />
    </Card>
  );
}
