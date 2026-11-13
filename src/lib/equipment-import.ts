/**
 * Importing the equipment register from a spreadsheet.
 *
 * David, 24 Sep, after a scan came back "this piece of equipment is not in
 * the database": "We're going to have to upload that spreadsheet that I sent
 * you... or if this is a section where we could upload it, then we can have
 * that done as well."
 *
 * One ROW PER UNIT: a tag, a type, an office, and optionally serial, make,
 * model and notes. Columns are found by their HEADER, in any order, because
 * his sheets do not share a column order. A sheet laid out as counts — one
 * column per type, a number under each (the Equipment Tracking layout) — says
 * how many machines, not which ones, so it cannot make register rows; it is
 * recognised and refused in words instead of importing nonsense.
 *
 * Pure: the dialog previews what this returns and writes only on confirm.
 */

import { assetTagKey, cleanAssetTag, matchAssetTag } from "@/lib/equipment-scan";
import { splitCsvLine } from "@/lib/price-lists";

export type ImportColumn = "tag" | "type" | "office" | "serial" | "make" | "model" | "notes";

/** Header words each column answers to, lower-cased and trimmed of punctuation. */
const HEADER_ALIASES: Record<ImportColumn, string[]> = {
  tag: [
    "tag",
    "asset tag",
    "asset",
    "asset #",
    "asset number",
    "tag #",
    "tag number",
    "unit",
    "unit #",
    "barcode",
    "id",
  ],
  type: ["type", "equipment type", "equipment", "item", "category", "kind"],
  office: ["office", "location", "branch", "office code", "location code", "state"],
  serial: ["serial", "serial #", "serial number", "sn", "s/n"],
  make: ["make", "brand", "manufacturer"],
  model: ["model", "model #", "model number"],
  notes: ["notes", "note", "comments", "comment"],
};

export const IMPORT_COLUMN_LABEL: Record<ImportColumn, string> = {
  tag: "Tag",
  type: "Type",
  office: "Office",
  serial: "Serial",
  make: "Make",
  model: "Model",
  notes: "Notes",
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * David's own names for things, onto the register's type keys. The managed
 * option list may hold more keys; an exact key or label match wins first.
 */
const TYPE_ALIASES: Record<string, string> = {
  "air mover": "air_mover",
  "air movers": "air_mover",
  airmover: "air_mover",
  am: "air_mover",
  blower: "air_mover",
  fan: "air_mover",
  dehu: "dehumidifier",
  dehus: "dehumidifier",
  dehumidifier: "dehumidifier",
  dehumidifiers: "dehumidifier",
  lgr: "dehumidifier",
  "lgr dehu": "dehumidifier",
  scrubber: "air_scrubber",
  "air scrubber": "air_scrubber",
  "scrubber xl": "air_scrubber",
  "xl scrubber": "air_scrubber",
  xxl: "hepa",
  "scrubber xxl": "hepa",
  hepa: "hepa",
  "hepa scrubber": "hepa",
  heater: "heater",
  generator: "generator",
  gen: "generator",
  "moisture meter": "moisture_meter",
  meter: "moisture_meter",
};

export type TypeOption = { key: string; label: string };
export type OfficeOption = { id: string; code: string | null; name: string };

/** The register type for what the sheet says, or "other" with the words kept. */
export function mapEquipmentType(
  raw: string,
  options: readonly TypeOption[],
): { key: string; detail: string | null } {
  const n = norm(raw);
  if (!n) return { key: "other", detail: null };
  const direct = options.find((o) => norm(o.key.replace(/_/g, " ")) === n || norm(o.label) === n);
  if (direct) return { key: direct.key, detail: null };
  const alias = TYPE_ALIASES[n] ?? TYPE_ALIASES[n.replace(/s$/, "")];
  if (alias && options.some((o) => o.key === alias)) return { key: alias, detail: null };
  // Honest, not guessed: it lands as Other and keeps what the sheet called it.
  return { key: "other", detail: raw.trim().slice(0, 80) };
}

/** An office by its code ("NJ", "LW") or its name. */
export function mapOffice(raw: string, offices: readonly OfficeOption[]): OfficeOption | null {
  const n = norm(raw);
  if (!n) return null;
  return (
    offices.find((o) => o.code && norm(o.code) === n) ??
    offices.find((o) => norm(o.name) === n) ??
    offices.find((o) => norm(o.name).includes(n) && n.length >= 3) ??
    null
  );
}

export type ImportRow = {
  line: number;
  tag: string;
  typeKey: string;
  typeDetail: string | null;
  officeId: string;
  serial: string | null;
  make: string | null;
  model: string | null;
  notes: string | null;
  /** Set when this tag is already in the register: the row updates it. */
  existingId: string | null;
};

export type ImportProblem = { line: number; text: string; reason: string };

export type ImportResult =
  | { kind: "rows"; columns: ImportColumn[]; rows: ImportRow[]; problems: ImportProblem[] }
  | { kind: "count_sheet"; reason: string }
  | { kind: "no_header"; reason: string };

/** Which column is which, from the header line. */
export function detectColumns(header: string[]): Partial<Record<ImportColumn, number>> {
  const found: Partial<Record<ImportColumn, number>> = {};
  header.forEach((cell, i) => {
    const n = norm(cell);
    for (const col of Object.keys(HEADER_ALIASES) as ImportColumn[]) {
      if (found[col] == null && HEADER_ALIASES[col].includes(n)) found[col] = i;
    }
  });
  return found;
}

/**
 * Is this the count layout — a header of equipment types with numbers under
 * them and no tag column? Then it cannot make register rows.
 */
export function looksLikeCountSheet(
  header: string[],
  body: string[][],
  options: readonly TypeOption[],
): boolean {
  const typeHeaders = header.filter(
    (h) => h.trim() && mapEquipmentType(h, options).key !== "other",
  ).length;
  if (typeHeaders < 2) return false;
  const cells = body.flatMap((r) => r.slice(1)).filter((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^\d+$/.test(c.trim()));
}

/**
 * The key a register tag is looked up by — the scanner's own matching rule
 * (`assetTagKey`, 22 Oct): separators and case ignored, so a unit typed by
 * hand as "GSR AM00034 NJ" or GSR-AM00034-NJ or GSRAM00034NJ is found when
 * any of the others comes back in a sheet, and is not added a second time.
 */
export function existingTagKey(tag: string): string {
  return assetTagKey(tag);
}

/** One unit already on the register. */
export type RegisterTag = { id: string; tag: string };

/**
 * The register's tags by key. A list per key, not one id: GSR-001 and GSR001
 * can both exist (the unique index is exact), and the import must then say so
 * rather than quietly update whichever one a Map kept.
 */
export type RegisterTagIndex = ReadonlyMap<string, readonly RegisterTag[]>;

export function registerTagIndex(
  units: readonly { id: string; asset_tag: string }[],
): RegisterTagIndex {
  const out = new Map<string, RegisterTag[]>();
  for (const u of units) {
    const key = existingTagKey(u.asset_tag);
    if (!key) continue;
    const list = out.get(key) ?? [];
    list.push({ id: u.id, tag: u.asset_tag });
    out.set(key, list);
  }
  return out;
}

export function parseEquipmentImport(
  text: string,
  ctx: {
    types: readonly TypeOption[];
    offices: readonly OfficeOption[];
    /** Used when a row names no office, or the sheet has no office column. */
    defaultOfficeId: string | null;
    /** The register, by `existingTagKey` — see registerTagIndex. */
    existing: RegisterTagIndex;
  },
): ImportResult {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, cells: splitCsvLine(l) }))
    .filter((l) => l.cells.some((c) => c.trim()));
  if (lines.length === 0) return { kind: "rows", columns: [], rows: [], problems: [] };

  const header = lines[0]!.cells;
  const cols = detectColumns(header);
  if (cols.tag == null) {
    if (
      looksLikeCountSheet(
        header,
        lines.slice(1).map((l) => l.cells),
        ctx.types,
      )
    ) {
      return {
        kind: "count_sheet",
        reason:
          "This looks like a count sheet — one column per equipment type with a number under each. That says how many machines, not which ones, so it cannot add units to the register. Paste a list with one row per unit and its tag.",
      };
    }
    return {
      kind: "no_header",
      reason:
        "No Tag column found. The first row must be headers, and one of them must be Tag (or Asset tag, Asset #, Unit #, Barcode).",
    };
  }

  // Keyed by tag: a tag that appears twice is the later line, and the earlier
  // one is reported rather than silently written twice.
  const byTag = new Map<string, ImportRow>();
  const problems: ImportProblem[] = [];
  const get = (cells: string[], c: ImportColumn) =>
    cols[c] == null ? "" : (cells[cols[c]!] ?? "").trim();

  for (const { line, cells } of lines.slice(1)) {
    const text = cells.join(", ");
    const tag = cleanAssetTag(get(cells, "tag"));
    if (!tag) {
      problems.push({ line, text, reason: "No tag." });
      continue;
    }
    const officeRaw = get(cells, "office");
    const office = officeRaw ? mapOffice(officeRaw, ctx.offices) : null;
    const officeId = office?.id ?? (officeRaw ? null : ctx.defaultOfficeId);
    if (!officeId) {
      problems.push({
        line,
        text,
        reason: officeRaw
          ? `Office "${officeRaw}" is not one of yours.`
          : "No office — choose a default office above.",
      });
      continue;
    }
    // Which unit this row is: the register's matching rule, exact first, and
    // "which one?" — a problem, not a guess — when two units tie.
    const onRegister = matchAssetTag(
      tag,
      ctx.existing.get(existingTagKey(tag)) ?? [],
      (r) => r.tag,
    );
    if (onRegister.kind === "ambiguous") {
      problems.push({
        line,
        text,
        reason: `Tag ${tag} matches ${onRegister.items.length} units on the register (${onRegister.items
          .map((r) => r.tag)
          .join(", ")}) once dashes are ignored — which one? Write it exactly as on the register.`,
      });
      continue;
    }
    // The same tag twice in the sheet, however it is spelt: the later line wins.
    const key = existingTagKey(tag);
    const prior = byTag.get(key);
    if (prior) {
      problems.push({
        line: prior.line,
        text: prior.tag,
        reason:
          prior.tag === tag
            ? `Tag ${tag} appears again on line ${line}; the later line is used.`
            : `Tag ${prior.tag} appears again on line ${line} as ${tag}; the later line is used.`,
      });
      byTag.delete(key);
    }
    const t = mapEquipmentType(get(cells, "type"), ctx.types);
    // A note is the one free-text column, and an exported register carries its
    // notes back in whole: capping it at 200 would quietly cut every longer
    // note the moment someone re-imported the export. Still bounded.
    const opt = (c: ImportColumn) => get(cells, c).slice(0, c === "notes" ? 4000 : 200) || null;
    byTag.set(key, {
      line,
      tag,
      typeKey: t.key,
      typeDetail: t.detail,
      officeId,
      serial: opt("serial"),
      make: opt("make"),
      model: opt("model"),
      notes: opt("notes"),
      existingId: onRegister.kind === "match" ? onRegister.item.id : null,
    });
  }
  const rows = [...byTag.values()].sort((a, b) => a.line - b.line);
  const columns = (Object.keys(cols) as ImportColumn[]).sort(
    (a, b) => (cols[a] ?? 0) - (cols[b] ?? 0),
  );
  return { kind: "rows", columns, rows, problems };
}

/**
 * What a row writes. A new unit gets every field; an existing one only the
 * fields the sheet actually filled, so a sparse sheet never blanks a make or
 * model somebody typed in by hand.
 */
export function importPatch(row: ImportRow): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    equipment_type: row.typeKey,
    location_id: row.officeId,
  };
  if (row.typeDetail) patch.equipment_type_detail = row.typeDetail;
  if (row.serial) patch.serial_number = row.serial;
  if (row.make) patch.make = row.make;
  if (row.model) patch.model = row.model;
  if (row.notes) patch.notes = row.notes;
  return patch;
}
