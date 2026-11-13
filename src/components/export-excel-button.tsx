import { FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useExportGate } from "@/lib/export-guard";
import {
  downloadXlsx,
  sheetFromColumns,
  type ExportColumn,
  type ExportSheet,
} from "@/lib/export-table";
import { cn } from "@/lib/utils";

/**
 * "Export to Excel" for a report or list screen. Goes through the export
 * gate like every other file the app hands out, so it renders nothing for
 * people who may not export and every download is logged as `xlsx`.
 *
 * Give it the rows the screen is showing right now — filtered and sorted —
 * because that is what gets shared and re-sorted in Excel afterwards.
 */
export type ExportSheetSpec<T> = {
  name: string;
  rows: readonly T[];
  columns: readonly ExportColumn<T>[];
  /** A totals row, written above the header and frozen with it. */
  totals?: T | null;
  /** How to read `totals`, when it is keyed differently from a row. */
  totalsColumns?: readonly ExportColumn<T>[];
};

type Props = {
  /** Filename stem: `<report>-<yyyy-mm-dd>.xlsx`. */
  report: string;
  /** Audit surface, e.g. "reports", "profitability". */
  surface: string;
  /** Audit entity. Defaults to the report stem. */
  entity?: string;
  /** Active filters, recorded with the export. */
  filters?: Record<string, unknown>;
  /** One or more sheets. Row count in the audit is the sum. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sheets: ExportSheetSpec<any>[];
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  label?: string;
};

export function ExportExcelButton({
  report,
  surface,
  entity,
  filters,
  sheets,
  disabled,
  size = "sm",
  className,
  label = "Excel",
}: Props) {
  const gate = useExportGate({ entity: entity ?? report });
  const count = sheets.reduce((n, s) => n + s.rows.length, 0);
  if (!gate.allowed) return null;

  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      className={cn(className)}
      disabled={disabled || count === 0}
      title="Download what is on screen as an Excel workbook"
      onClick={() =>
        void gate.runExport({
          surface,
          entity: entity ?? report,
          recordCount: count,
          format: "xlsx",
          filters,
          download: () => {
            const built: ExportSheet[] = sheets.map((s) => {
              const sheet = sheetFromColumns(s.name, s.rows, s.columns);
              if (s.totals) {
                const totals = s.totals;
                sheet.totals = (s.totalsColumns ?? s.columns).map((c) => c.get(totals));
              }
              return sheet;
            });
            downloadXlsx(report, built);
          },
        })
      }
    >
      <FileSpreadsheet className="mr-1.5 size-3.5" />
      {label}
    </Button>
  );
}
