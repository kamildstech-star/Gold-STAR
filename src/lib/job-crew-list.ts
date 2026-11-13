/**
 * The job's crew list: the names the sign-in sheet offers under "Add person".
 *
 * David, 12 Oct: the crew are hired labourers with no login, so "Add person"
 * listing every system user was the wrong list — the only system user on the
 * sheet is the crew chief. The office uploads a spreadsheet of names (just
 * names, one per cell or row, nothing else) and from then on those names are
 * the job's dropdown, so nobody retypes the same people every morning.
 *
 * One list per job (`job_crew_lists`, migration 20261013090000). Uploading
 * again replaces it: the sheet the office has is the crew as it stands.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { splitCsvLine } from "@/lib/price-lists";
import { isMissingSchema } from "@/lib/schema-fallback";

/* Not in the generated types until Lovable regenerates them after
   migration 20261013090000 is applied. */
const db = () => supabase as unknown as SupabaseClient;

/** A crew list longer than this is a wrong file, not a crew. */
export const MAX_CREW_NAMES = 200;
/** Longer than any real name; a cell this long is a note, not a person. */
export const MAX_CREW_NAME_LENGTH = 80;

/** A first cell that labels the column rather than naming anybody. */
const HEADER_CELL = /^(names?|employees?|crew( names?)?|workers?|labou?rers?|full name)$/i;

/** One name as it should be stored: single spaces, no stray punctuation at the ends. */
export function cleanCrewName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[\s,;.-]+|[\s,;.-]+$/g, "")
    .trim();
}

/**
 * Every name in a grid of cells, in reading order.
 *
 * Names only: every non-empty cell is one person, whether the office put them
 * down a column or across a row. A header cell ("Name", "Crew") is skipped,
 * blanks and numbers-only cells are dropped, and a name already seen (in any
 * case) is kept once.
 */
export function crewNamesFromRows(rows: readonly (readonly string[])[]): {
  names: string[];
  skipped: number;
} {
  const names: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const row of rows) {
    for (const cell of row) {
      const name = cleanCrewName(cell ?? "");
      if (!name) continue;
      if (HEADER_CELL.test(name) || /^[\d\s.,/-]+$/.test(name)) {
        skipped += 1;
        continue;
      }
      if (name.length > MAX_CREW_NAME_LENGTH) {
        skipped += 1;
        continue;
      }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      if (names.length >= MAX_CREW_NAMES) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      names.push(name);
    }
  }
  return { names, skipped };
}

/** CSV or pasted text: one line per row, commas or tabs between cells. */
export function parseCrewNames(text: string): { names: string[]; skipped: number } {
  const rows = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => splitCsvLine(line));
  return crewNamesFromRows(rows);
}

/**
 * A chosen file to names. An .xlsx goes through the repo's own workbook
 * reader (every sheet, since a names-only file has no header to pick by);
 * anything else is read as CSV text.
 */
export async function readCrewNamesFile(
  file: File,
): Promise<{ ok: true; names: string[]; skipped: number } | { ok: false; reason: string }> {
  if (/\.xls$/i.test(file.name)) {
    return {
      ok: false,
      reason: "Save the sheet as .xlsx or .csv first — old .xls files can't be read.",
    };
  }
  if (/\.xlsx$/i.test(file.name)) {
    const { readWorkbook } = await import("@/lib/workbook-read");
    const result = readWorkbook(await file.arrayBuffer());
    if (!result.ok) return { ok: false, reason: result.reason };
    const parsed = crewNamesFromRows(result.sheets.flatMap((s) => s.rows));
    return { ok: true, ...parsed };
  }
  return { ok: true, ...parseCrewNames(await file.text()) };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export type JobCrewList = {
  /** False until migration 20261013090000 is applied. */
  available: boolean;
  names: string[];
  updatedAt: string | null;
};

export async function fetchJobCrewList(
  jobId: string,
  client: SupabaseClient = db(),
): Promise<JobCrewList> {
  const { data, error } = await client
    .from("job_crew_lists")
    .select("names, updated_at")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return { available: false, names: [], updatedAt: null };
    throw error;
  }
  const row = data as { names: unknown; updated_at: string } | null;
  const names = Array.isArray(row?.names)
    ? crewNamesFromRows([row!.names.map((n) => String(n ?? ""))]).names
    : [];
  return { available: true, names, updatedAt: row?.updated_at ?? null };
}

/** Replace the job's crew list with these names. */
export async function saveJobCrewList(
  jobId: string,
  names: readonly string[],
  client: SupabaseClient = db(),
): Promise<void> {
  const clean = crewNamesFromRows([names.map(String)]).names;
  const { error } = await client
    .from("job_crew_lists")
    .upsert({ job_id: jobId, names: clean }, { onConflict: "job_id" });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* The picker                                                          */
/* ------------------------------------------------------------------ */

/** A name the sign-in sheet can offer. `userId` only for the crew chief. */
export type CrewPickPerson = { userId: string | null; name: string };

/**
 * What "Add person" offers: the job's crew chief (the one system user on the
 * sheet), then the uploaded names. Never the whole user list.
 *
 * The chief comes from the job's own `crew_chief` and its crew_chief
 * assignments; a name on the uploaded list that is the chief's is kept once,
 * with the chief's login.
 */
export function crewPickList(input: {
  assignments: readonly { userId: string; name: string; role: string }[];
  crewChiefId: string | null;
  uploaded: readonly string[];
}): CrewPickPerson[] {
  const out: CrewPickPerson[] = [];
  const seen = new Set<string>();
  const push = (p: CrewPickPerson) => {
    const name = cleanCrewName(p.name);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push({ userId: p.userId, name });
  };
  for (const a of input.assignments) {
    if (a.role === "crew_chief" || a.userId === input.crewChiefId) {
      push({ userId: a.userId, name: a.name });
    }
  }
  for (const name of input.uploaded) push({ userId: null, name });
  return out;
}
