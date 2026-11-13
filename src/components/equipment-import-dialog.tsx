import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FileUp, Upload } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { LocationPicker } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import {
  detectColumns,
  registerTagIndex,
  type RegisterTagIndex,
  IMPORT_COLUMN_LABEL,
  importPatch,
  parseEquipmentImport,
  type TypeOption,
} from "@/lib/equipment-import";

/**
 * Which row of a sheet is the header row — asked with the importer's own
 * column matching, so a workbook and a paste agree on what a header is.
 */
const hasTagHeader = (cells: string[]) => detectColumns(cells).tag != null;

/** A workbook sheet once it has been flattened to import text. */
type LoadedSheet = { name: string; text: string; headerRow: number };

/**
 * Import the equipment register from a spreadsheet — paste it, or hand over
 * the .xlsx or .csv file itself.
 *
 * David, 24 Sep: "We're going to have to upload that spreadsheet that I sent
 * you... or if this is a section where we could upload it, then we can have
 * that done as well."
 *
 * Mark, beside this button with 388 units on the register: "need to accept
 * .xslx". He means .xlsx, and he is right that it was the gap — until now
 * this dialog read a CSV and told him to go convert the file himself.
 *
 * An .xlsx is turned into the same delimited text a paste produces by
 * `workbook-read.ts`, and then goes through `parseEquipmentImport` like
 * everything else. There is deliberately no second import path: one set of
 * column rules, one preview, one set of error messages, whichever way the
 * rows arrived.
 *
 * Same shape as the price-list import: say which columns are expected, parse
 * on every edit, preview what will happen line by line, and write only the
 * good rows on Import. A tag already in the register UPDATES that unit; a new
 * tag adds one. Nothing is written until Import is pressed.
 */
export function EquipmentImportDialog({
  types,
  onImported,
}: {
  types: readonly TypeOption[];
  onImported: () => void;
}) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [defaultOffice, setDefaultOffice] = useState("");
  const [existing, setExisting] = useState<RegisterTagIndex>(new Map());
  const [loadingTags, setLoadingTags] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sheets, setSheets] = useState<LoadedSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The note below the box describes the sheet we loaded. Once the text has
  // been edited by hand it no longer does, so it stops claiming to.
  const loaded = sheets[sheetIndex];
  const showingSheet = loaded && loaded.text === text ? loaded : null;

  async function chooseFile(file: File) {
    if (!/\.xlsx$/i.test(file.name)) {
      setSheets([]);
      setText(await file.text());
      return;
    }
    // Only an .xlsx pulls the workbook reader down. A field tablet that never
    // opens one never pays for the kilobytes.
    const { pickSheet, readWorkbook, sheetToImportText } = await import("@/lib/workbook-read");
    const result = readWorkbook(await file.arrayBuffer());
    if (!result.ok) {
      toast.error("That spreadsheet could not be read", { description: result.reason });
      return;
    }
    const flattened = result.sheets.map((s) => ({
      name: s.name,
      ...sheetToImportText(s, hasTagHeader),
    }));
    const pick = pickSheet(result.sheets, hasTagHeader);
    setSheets(flattened);
    setSheetIndex(pick);
    setText(flattened[pick]?.text ?? "");
  }

  const offices = useMemo(
    () => app.visibleLocations.map((l) => ({ id: l.id, code: l.code, name: l.name })),
    [app.visibleLocations],
  );

  // The tags already on the register, so a row knows whether it adds or updates.
  async function loadExisting() {
    setLoadingTags(true);
    const units: { id: string; asset_tag: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("equipment")
        .select("id, asset_tag")
        .range(from, from + 999);
      if (error) {
        toastDbError(error, { action: "read the register" });
        break;
      }
      units.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    setExisting(registerTagIndex(units));
    setLoadingTags(false);
  }

  const result = useMemo(
    () =>
      parseEquipmentImport(text, {
        types,
        offices,
        defaultOfficeId: defaultOffice || null,
        existing,
      }),
    [text, types, offices, defaultOffice, existing],
  );
  const rows = result.kind === "rows" ? result.rows : [];
  const adds = rows.filter((r) => !r.existingId).length;
  const updates = rows.length - adds;
  const typeLabel = (key: string) => types.find((t) => t.key === key)?.label ?? key;
  const officeLabel = (id: string) => {
    const o = offices.find((x) => x.id === id);
    return o ? `${o.code} · ${o.name}` : "—";
  };

  async function commit() {
    setSaving(true);
    let done = 0;
    const failed: string[] = [];
    // New units in one insert; updates one by one (each is its own row).
    const inserts = rows
      .filter((r) => !r.existingId)
      .map((r) => ({ asset_tag: r.tag, created_by: app.userId, ...importPatch(r) }));
    for (let i = 0; i < inserts.length; i += 200) {
      const chunk = inserts.slice(i, i + 200);
      const { error } = await supabase.from("equipment").insert(chunk as never);
      if (error) failed.push(`${chunk.length} new units: ${error.message}`);
      else done += chunk.length;
    }
    for (const r of rows.filter((x) => x.existingId)) {
      const { data, error } = await supabase
        .from("equipment")
        .update(importPatch(r) as never)
        .eq("id", r.existingId!)
        .select("id");
      // RLS refuses by matching no row: an office this user does not manage.
      if (error || (data ?? []).length === 0)
        failed.push(`${r.tag}: ${error?.message ?? "not yours to change"}`);
      else done += 1;
    }
    setSaving(false);
    if (failed.length) {
      toast.error(`${done} imported, ${failed.length} not`, {
        description: failed.slice(0, 5).join(" · "),
      });
    } else {
      toast.success(`${done} unit${done === 1 ? "" : "s"} imported`);
      setOpen(false);
      setText("");
      setSheets([]);
    }
    onImported();
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-11 md:h-9"
        onClick={() => {
          setOpen(true);
          void loadExisting();
        }}
      >
        <Upload className="mr-1.5 size-4" /> Import register
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import the equipment register</DialogTitle>
            <DialogDescription>
              One row per unit, under a header row naming <b>Tag</b>, <b>Type</b> and <b>Office</b>{" "}
              (code or name), and optionally <b>Serial</b>, <b>Make</b>, <b>Model</b>, <b>Notes</b>{" "}
              — in any order. A tag already on the register updates that unit; a new tag adds one.
              Types are matched to the register (Dehu, LGR, Scrubber XL, XXL, Air mover…); anything
              else comes in as Other with its name kept.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <LocationPicker
              value={defaultOffice}
              onChange={setDefaultOffice}
              label="Office for rows that name none"
              noPrefill
            />
            <div className="flex items-end">
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) await chooseFile(f);
                }}
              />
              <Button
                variant="outline"
                className="h-11 md:h-9"
                onClick={() => fileRef.current?.click()}
              >
                <FileUp className="mr-1.5 size-4" /> Upload a spreadsheet
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="equipment-import-text">Or paste from the spreadsheet</Label>
            <Textarea
              id="equipment-import-text"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"Tag\tType\tOffice\tSerial\nGSR-AM00034-NJ\tAir mover\tNJ\t88213"}
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Takes .xlsx and .csv. Dates and numbers come across as they read on screen, and rows
              above the header — a title, a blank row, a merged banner — are skipped.
            </p>
            {sheets.length > 1 ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Label htmlFor="equipment-import-sheet" className="text-[11px]">
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
                  <SelectTrigger id="equipment-import-sheet" className="h-8 w-56 text-xs">
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
            {showingSheet ? (
              <p className="text-[11px] text-muted-foreground">
                Reading <b>{showingSheet.name}</b>
                {sheets.length > 1 ? ` of ${sheets.length} sheets` : ""}
                {showingSheet.headerRow > 1
                  ? `, headers found on row ${showingSheet.headerRow}`
                  : ""}
                .
              </p>
            ) : null}
          </div>

          {result.kind !== "rows" ? (
            <p className="rounded-md border border-dashed bg-muted/30 p-3 text-sm">
              {result.reason}
            </p>
          ) : text.trim() ? (
            <div className="space-y-2 text-sm">
              <p>
                {loadingTags ? "Checking the register… " : ""}
                <b>{adds}</b> new · <b>{updates}</b> update{updates === 1 ? "" : "s"}
                {result.problems.length ? ` · ${result.problems.length} to look at` : ""}
                <span className="text-muted-foreground">
                  {" "}
                  — columns found: {result.columns.map((c) => IMPORT_COLUMN_LABEL[c]).join(", ")}
                </span>
              </p>
              {result.problems.length ? (
                <ul className="max-h-32 overflow-y-auto rounded-md border bg-warning/5 p-2 text-xs">
                  {result.problems.slice(0, 25).map((p, i) => (
                    <li key={i}>
                      Line {p.line}: {p.reason}{" "}
                      <span className="text-muted-foreground">{p.text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr className="text-left">
                      <th className="p-1.5">Tag</th>
                      <th className="p-1.5">Type</th>
                      <th className="p-1.5">Office</th>
                      <th className="p-1.5">Serial</th>
                      <th className="p-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((r) => (
                      <tr key={r.tag} className="border-t">
                        <td className="p-1.5 font-mono">{r.tag}</td>
                        <td className="p-1.5">
                          {typeLabel(r.typeKey)}
                          {r.typeDetail ? ` (${r.typeDetail})` : ""}
                        </td>
                        <td className="p-1.5">{officeLabel(r.officeId)}</td>
                        <td className="p-1.5">{r.serial ?? ""}</td>
                        <td className="p-1.5 text-muted-foreground">
                          {r.existingId ? "update" : "new"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 50 ? (
                  <p className="p-1.5 text-xs text-muted-foreground">
                    …and {rows.length - 50} more.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="h-11 md:h-9"
              disabled={rows.length === 0 || saving || loadingTags || app.writesDisabled}
              onClick={() => void commit()}
            >
              {saving ? "Importing…" : `Import ${rows.length} unit${rows.length === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
