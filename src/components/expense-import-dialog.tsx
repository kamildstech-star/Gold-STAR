/**
 * Upload an Excel / CSV breakdown of a job's expenses into its Expense
 * tracker (David, 15 Oct). Pick the file, see every row it will add and every
 * row it cannot read, then Import. Reading is src/lib/expense-sheet.ts.
 */
import { useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  parseExpenseImport,
  hasExpenseHeader,
  type ExpenseImportResult,
} from "@/lib/expense-sheet";
import { largeLossLabel, type LargeLossDraft } from "@/lib/large-loss-expenses";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export function ExpenseImportDialog({
  open,
  onOpenChange,
  onImport,
  busy,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImport: (drafts: LargeLossDraft[]) => Promise<void>;
  busy: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ExpenseImportResult | null>(null);

  function reset() {
    setFileName(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function choose(file: File) {
    setFileName(file.name);
    if (!/\.xlsx$/i.test(file.name)) {
      setResult(parseExpenseImport(await file.text()));
      return;
    }
    // Only an .xlsx pulls the workbook reader down, as the equipment import does.
    const { pickSheet, readWorkbook, sheetToImportText } = await import("@/lib/workbook-read");
    const book = readWorkbook(await file.arrayBuffer());
    if (!book.ok) {
      toast.error("That spreadsheet could not be read", { description: book.reason });
      reset();
      return;
    }
    const sheet = book.sheets[pickSheet(book.sheets, hasExpenseHeader)];
    setResult(sheet ? parseExpenseImport(sheetToImportText(sheet, hasExpenseHeader).text) : null);
  }

  const rows = result?.rows ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>Import expenses</DialogTitle>
          <DialogDescription>
            An .xlsx or .csv with a header row: Date and Amount, plus Category, Vendor and
            Description when you have them. An export from this tracker imports as it is.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void choose(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            onClick={() => fileRef.current?.click()}
          >
            <FileSpreadsheet className="mr-1.5 size-4" />
            {fileName ?? "Choose a spreadsheet"}
          </Button>

          {result?.error && <p className="text-xs text-destructive">{result.error}</p>}

          {result && !result.error && (
            <>
              <p className="text-xs text-muted-foreground">
                {rows.length} {rows.length === 1 ? "expense" : "expenses"} · {usd(result.total)}
                {result.problems.length ? ` · ${result.problems.length} rows cannot be read` : ""}
              </p>
              {rows.length > 0 && (
                <ul className="max-h-56 divide-y overflow-y-auto overscroll-contain rounded-md border text-xs">
                  {rows.map((r) => (
                    <li key={r.line} className="flex items-center gap-2 px-2 py-1.5">
                      <span className="w-20 shrink-0 tabular-nums text-muted-foreground">
                        {r.draft.spentOn}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {r.draft.vendor || largeLossLabel(r.draft.kind)}
                        <span className="text-muted-foreground">
                          {" "}
                          · {largeLossLabel(r.draft.kind)}
                          {r.categoryGuessed ? " (not recognized)" : ""}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">{usd(r.draft.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {result.problems.length > 0 && (
                <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs text-destructive">
                  {result.problems.map((p) => (
                    <li key={p.line}>
                      Row {p.line}: {p.reason} — not imported.
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || rows.length === 0}
            onClick={async () => {
              await onImport(rows.map((r) => r.draft));
              reset();
            }}
          >
            <Upload className="mr-1.5 size-4" />
            {busy ? "Importing…" : `Import ${rows.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
