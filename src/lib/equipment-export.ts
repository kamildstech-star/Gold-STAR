/**
 * Exporting the equipment register in the shape the import reads.
 *
 * #272 taught the Equipment page's Import register to take an .xlsx, and its
 * QC line was "export the register to xlsx, re-import it" — but the page had
 * no export to do that with. This is that export, and the whole point of it
 * is the pairing: the file it writes is a file the import takes back WITHOUT
 * EDITING, header for header. So the columns here are not chosen for the
 * screen; they are the import's own columns, under the import's own labels
 * (`IMPORT_COLUMN_LABEL`), in the order its help text names them.
 *
 * That is also why the export carries nothing else. Status, cost, live
 * location and the job a unit is on are on screen but are not things the
 * import reads — and an extra header is not free: "Location" or "Equipment"
 * would be taken as the Office or Type column by the import's header aliases.
 *
 * Each value is written the way the import reads it back to the same unit:
 *   - Type is the register's label for the type, which the import matches
 *     exactly. A unit typed Other carries its own words in the Type column,
 *     because that is exactly how the import files an unknown type: Other,
 *     with the words kept as the detail.
 *   - Office is the office code, which the import tries before the name.
 *   - Everything is text, so a serial like 00123 or a 20-digit one survives.
 *   - A line break or tab inside a note becomes a space. The import is
 *     line-oriented — a CSV row split across two lines is a unit with no tag
 *     — and the workbook reader flattens them the same way, so writing them
 *     would only make the CSV and the .xlsx disagree.
 */

import {
  IMPORT_COLUMN_LABEL,
  mapEquipmentType,
  type ImportColumn,
  type OfficeOption,
  type TypeOption,
} from "@/lib/equipment-import";
import type { ExportColumn } from "@/lib/export-table";

/** The fields of a register row the export reads. */
export type ExportableUnit = {
  asset_tag: string;
  equipment_type: string;
  equipment_type_detail: string | null;
  location_id: string;
  serial_number: string | null;
  make: string | null;
  model: string | null;
  notes: string | null;
};

/** The import's columns, in the order its dialog lists them. */
export const EQUIPMENT_EXPORT_ORDER: readonly ImportColumn[] = [
  "tag",
  "type",
  "office",
  "serial",
  "make",
  "model",
  "notes",
];

/** One line, trimmed: what the import would make of the cell anyway. */
function oneLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s*[\r\n\t]+\s*/g, " ").trim();
}

/**
 * What the Type column says for a unit. The label when the register knows the
 * type; for Other, the unit's own words — unless those words are themselves a
 * type the import would recognise ("fan" is an air mover), in which case the
 * honest answer is Other and the words stay where they are.
 */
export function exportTypeCell(unit: ExportableUnit, types: readonly TypeOption[]): string {
  const detail = oneLine(unit.equipment_type_detail);
  if (unit.equipment_type === "other" && detail) {
    if (mapEquipmentType(detail, types).key === "other") return detail;
  }
  return types.find((t) => t.key === unit.equipment_type)?.label ?? unit.equipment_type;
}

/** The office code, which the import tries first; the name when there is none. */
export function exportOfficeCell(unit: ExportableUnit, offices: readonly OfficeOption[]): string {
  const office = offices.find((o) => o.id === unit.location_id);
  if (!office) return "";
  return office.code?.trim() || office.name;
}

export function equipmentExportColumns(ctx: {
  types: readonly TypeOption[];
  offices: readonly OfficeOption[];
}): ExportColumn<ExportableUnit>[] {
  const get: Record<ImportColumn, (u: ExportableUnit) => string> = {
    tag: (u) => oneLine(u.asset_tag),
    type: (u) => exportTypeCell(u, ctx.types),
    office: (u) => exportOfficeCell(u, ctx.offices),
    serial: (u) => oneLine(u.serial_number),
    make: (u) => oneLine(u.make),
    model: (u) => oneLine(u.model),
    notes: (u) => oneLine(u.notes),
  };
  return EQUIPMENT_EXPORT_ORDER.map((col) => ({
    key: col,
    label: IMPORT_COLUMN_LABEL[col],
    type: "text" as const,
    get: get[col],
  }));
}
