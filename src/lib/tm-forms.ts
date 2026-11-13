/**
 * Gold Star's three daily T&M sheets, as records: the Crew Sign In/Out Sheet,
 * the Daily Crew Chief report and the Daily Supply List.
 *
 * Mark: "for a T&M job, there is a sign in sheet, rate codes and the three
 * pages that are used for each day. can we have these pdfs, fillable,
 * available under field form, only when T&M is selected, and the new ticket
 * currently there should be for insurance and cash jobs."
 *
 * One table, `job_tm_forms` (migration 20261007231000): a `kind`, the day, and
 * the sheet's contents as jsonb. The sheets are Gold Star's paper and change
 * when Gold Star reprints them; a payload absorbs that without a migration
 * per box, the same reasoning the field work ticket uses for its checkbox
 * slugs. Nothing reports across these payloads — the billing happens in
 * T&M Pro — so there is no column worth promoting yet.
 *
 * ONE SHEET PER KIND PER JOB PER DAY. That is how the paper works: one
 * sign-in sheet on the clipboard, signed by everyone who works that day. So
 * the write is keyed on (job, kind, day), never on a row id: opening today's
 * sign-in sheet on a second phone opens the same sheet, and two phones saving
 * it offline land on one row instead of the second being refused.
 *
 * Two phones signing the same sheet is the normal case, not an edge case, so
 * the sign-in write MERGES rows by their own id against what is stored
 * (`mergeSignIn`) instead of overwriting the sheet: the crew member who signs
 * on the foreman's phone and the one who signs on their own both end up on
 * it. A row removed on one phone is listed in `removed` so the merge does not
 * bring it back. The crew chief report and the supply list are one person's
 * sheet; the last save wins.
 *
 * Offline: every save goes through `writeOrQueue` (kind `tm_field_form`),
 * persisted on the device first, exactly as the field work ticket is held.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { ensureJobFolder, type DocumentScope } from "@/lib/documents";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { TmRateCode } from "@/lib/tm-rate-codes";

/* Not in the generated types until Lovable regenerates them after
   migration 20261007231000 is applied. */
const db = () => supabase as unknown as SupabaseClient;

export const TM_FORM_KINDS = ["sign_in", "crew_chief", "supply_list"] as const;
export type TmFormKind = (typeof TM_FORM_KINDS)[number];

export type TmFormMeta = {
  /** What the crew taps — plain words, not the paper's title. */
  title: string;
  /** The Spanish line under it. */
  es: string;
  /** The paper's own heading, used for the filed document's name. */
  paperTitle: string;
  /** The original Gold Star sheet, shipped with the app. */
  template: string;
  /** Stem of the downloaded / filed file name. */
  fileStem: string;
  /** A short label for the compact picker. */
  short: string;
  /**
   * The job folder each day's filed PDF goes into (David, 12 Oct). David,
   * 20 Oct: named for what is in it, and all three made on every T&M job when
   * its Documents open (`ensureTmJobFolders`), not by the first sheet filed.
   */
  folder: string;
  /**
   * The folder's names before 20 Oct. A job that already has one keeps it,
   * renamed, so the PDFs filed in it stay put (ensureJobFolder).
   */
  formerFolders: readonly string[];
};

export const TM_FORM_META: Readonly<Record<TmFormKind, TmFormMeta>> = {
  sign_in: {
    title: "Crew sign-in sheet",
    es: "Hoja de entrada y salida",
    paperTitle: "Crew Sign In/Out Sheet",
    template: "/forms/tm/crew-sign-in-sheet.pdf",
    fileStem: "crew-sign-in-sheet",
    short: "Sign-in",
    folder: "Daily Sign-In",
    formerFolders: ["Sign-in sheets"],
  },
  crew_chief: {
    title: "Daily crew chief report",
    es: "Reporte diario del jefe de equipo",
    paperTitle: "Daily Crew Chief",
    template: "/forms/tm/daily-crew-chief-report.pdf",
    fileStem: "daily-crew-chief-report",
    short: "Crew chief",
    folder: "Daily Crew Chief",
    formerFolders: ["Field forms"],
  },
  supply_list: {
    title: "Daily supply list",
    es: "Lista diaria de materiales",
    paperTitle: "Daily Supply List",
    template: "/forms/tm/daily-supply-list.pdf",
    fileStem: "daily-supply-list",
    short: "Supply list",
    folder: "Daily Supply List",
    formerFolders: ["Supply lists"],
  },
};

/**
 * Make sure a T&M job has its three daily folders under Documents — Daily
 * Sign-In, Daily Crew Chief, Daily Supply List (David, 20 Oct) — renaming any
 * it already has under the old names rather than adding a second set. Run when
 * a T&M job's Documents open; filing a sheet still makes its own folder if it
 * is missing. Never throws: the folders are tidiness, and a user who may not
 * add folders still sees the documents.
 */
export async function ensureTmJobFolders(
  scope: DocumentScope,
  userId: string | null,
  ensure: typeof ensureJobFolder = ensureJobFolder,
): Promise<void> {
  for (const kind of TM_FORM_KINDS) {
    const meta = TM_FORM_META[kind];
    try {
      const made = await ensure({ scope, name: meta.folder, userId, aliases: meta.formerFolders });
      // Folders not migrated on this database: nothing more to try.
      if (made === null) return;
    } catch {
      // Refused (RLS) or offline: the next filing or the next view tries again.
    }
  }
}

/**
 * The folder for a non-T&M job's daily field work tickets (David, 21 Oct).
 *
 * Self-pay (cash) jobs — and every other job type that carries the daily
 * field work ticket rather than the three T&M sheets (fieldFormsFor: insurance,
 * reconstruction, undetermined, no type yet) — file one ticket a day, so they
 * get one folder for them, made the same lazy way as the T&M three: when the
 * job's Documents first open, never twice, alongside any folder made by hand.
 * The ticket's scanned or photographed sheet is filed into it.
 */
export const DAILY_FIELD_FORMS_FOLDER = "Daily Field Forms";

/** The daily folders a job's Documents make, by its job type. */
export function dailyFolderNames(tmJob: boolean): readonly string[] {
  return tmJob ? TM_FORM_KINDS.map((k) => TM_FORM_META[k].folder) : [DAILY_FIELD_FORMS_FOLDER];
}

/** Never throws, like ensureTmJobFolders. */
export async function ensureDailyFieldFormsFolder(
  scope: DocumentScope,
  userId: string | null,
  ensure: typeof ensureJobFolder = ensureJobFolder,
): Promise<void> {
  try {
    await ensure({ scope, name: DAILY_FIELD_FORMS_FOLDER, userId });
  } catch {
    // Refused (RLS) or offline: the next view or the next ticket tries again.
  }
}

/**
 * The day the panel shows.
 *
 * David, 12 Oct: the supply list renews itself every day. Each kind is already
 * one sheet per day, so "renew" means the panel must never be left sitting on
 * yesterday: unless somebody picked a day (`chosen`), it is whatever today is
 * NOW, so a phone left open overnight opens a fresh sheet in the morning.
 * Picking today's own date goes back to following the calendar.
 */
export function sheetDay(chosen: string | null, today: string): string {
  return chosen && chosen !== today ? chosen : today;
}

/* ------------------------------------------------------------------ */
/* Payloads                                                            */
/* ------------------------------------------------------------------ */

/**
 * The paper's "Hotel - Per Diem" column.
 *
 * David, 12 Oct: on the phone this is a plain yes / blank toggle — the crew
 * either got hotel / per diem that day or they didn't. "yes" is the only value
 * the app writes now. The older three answers stay readable (and print as they
 * did) because sheets were saved with them before the toggle.
 */
export const LODGING_OPTIONS = [
  { key: "", label: "None", es: "Ninguno", short: "" },
  { key: "yes", label: "Yes", es: "Sí", short: "Yes" },
  // Legacy answers, from before the toggle. Never offered, still printed.
  { key: "per_diem", label: "Per diem", es: "Viáticos", short: "PD" },
  { key: "hotel", label: "Hotel", es: "Hotel", short: "Hotel" },
  { key: "hotel_per_diem", label: "Hotel + per diem", es: "Hotel + viáticos", short: "Hotel+PD" },
] as const;
export type Lodging = (typeof LODGING_OPTIONS)[number]["key"];

export type SignInRow = {
  /** The row's own id, so two phones' rows merge instead of overwriting. */
  id: string;
  /** The person's login when they have one; temps sign by name alone. */
  userId: string | null;
  employee: string;
  rateCode: string;
  /** "HH:MM", as the phone's time input gives it. */
  timeIn: string;
  lunchStart: string;
  lunchEnd: string;
  timeOut: string;
  lodging: Lodging;
  /** PNG data URL of the signature, small (see SIGNATURE_SIZE). */
  signature: string | null;
  signedAt: string | null;
  /**
   * 12 Nov: signed on the paper sheet that was scanned in. The signature
   * stays on the paper (filed as a PDF); the row counts as signed for the
   * T&M bill, the same as one signed on a phone. See `rowSigned`.
   */
  paperSigned?: boolean;
};

/** A row the crew member signed, on a phone or on the scanned paper sheet. */
export function rowSigned(r: Pick<SignInRow, "signature" | "paperSigned">): boolean {
  return Boolean(r.signature) || r.paperSigned === true;
}

/**
 * One paper sheet scanned onto this day's sheet (12 Nov): the photo's
 * SHA-256, so the same photo is not uploaded twice, and the PDF it was filed
 * as on the job's Documents.
 */
export type PaperScanRecord = { hash: string; documentId: string | null; at: string };

/** The paper scans a stored payload lists, read defensively. */
export function readPaperScans(raw: unknown): PaperScanRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PaperScanRecord[] = [];
  for (const v of raw) {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const hash = typeof o.hash === "string" && /^[0-9a-f]{64}$/.test(o.hash) ? o.hash : null;
    if (!hash) continue;
    out.push({
      hash,
      documentId: typeof o.documentId === "string" && o.documentId ? o.documentId : null,
      at: typeof o.at === "string" ? o.at : "",
    });
  }
  return out;
}

/** Both lists of scans, each photo once (the entry that knows its PDF wins). */
export function mergePaperScans(
  a: readonly PaperScanRecord[] | undefined,
  b: readonly PaperScanRecord[] | undefined,
): PaperScanRecord[] {
  const byHash = new Map<string, PaperScanRecord>();
  for (const r of [...(a ?? []), ...(b ?? [])]) {
    const had = byHash.get(r.hash);
    byHash.set(r.hash, had && !r.documentId ? had : r);
  }
  return [...byHash.values()];
}

/** `paperScans` on a payload only when there are some, so old sheets stay as they were. */
function withScans<T extends object>(p: T, scans: PaperScanRecord[]): T {
  return scans.length ? { ...p, paperScans: scans } : p;
}

export type SignInPayload = {
  jobName: string;
  jobLocation: string;
  rows: SignInRow[];
  /** Row ids removed on this device, so a merge does not resurrect them. */
  removed: string[];
  /** Paper sheets scanned onto this day (12 Nov). */
  paperScans?: PaperScanRecord[];
};

/** Twelve boxes on the paper: two columns of six. */
export const CREW_STAFF_SLOTS = 12;

export type CrewChiefPayload = {
  jobName: string;
  jobLocation: string;
  supervisor: string;
  workZone: string;
  crewChief: string;
  crewNumber: string;
  crewSize: string;
  staff: string[];
  notes: string;
};

export type SupplyLine = { code: string; qty: number };

export type SupplyListPayload = {
  jobName: string;
  jobLocation: string;
  totalCrew: string;
  /** Only lines with a quantity are kept; the sheet's blanks stay blank. */
  lines: SupplyLine[];
  /** Paper sheets scanned onto this day (12 Nov). */
  paperScans?: PaperScanRecord[];
};

export type TmPayloadByKind = {
  sign_in: SignInPayload;
  crew_chief: CrewChiefPayload;
  supply_list: SupplyListPayload;
};

/** A signature is stored at this size; the PDF's cell is 133 x 12 points. */
export const SIGNATURE_SIZE = { width: 360, height: 108 } as const;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const hhmm = (v: unknown): string => {
  const s = str(v).trim();
  return /^\d{2}:\d{2}$/.test(s) ? s : "";
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const LODGING_KEYS = new Set<string>(LODGING_OPTIONS.map((o) => o.key));

/** A stored payload is jsonb somebody else wrote; read it defensively. */
export function normaliseSignIn(raw: unknown): SignInPayload {
  const p = obj(raw);
  const rows = Array.isArray(p.rows) ? p.rows : [];
  return withScans<SignInPayload>(
    {
      jobName: str(p.jobName),
      jobLocation: str(p.jobLocation),
      rows: rows.map((r, i) => {
        const o = obj(r);
        const lodging = str(o.lodging);
        const sig = str(o.signature);
        return {
          id: str(o.id) || `row-${i}`,
          userId: str(o.userId) || null,
          employee: str(o.employee),
          rateCode: str(o.rateCode),
          timeIn: hhmm(o.timeIn),
          lunchStart: hhmm(o.lunchStart),
          lunchEnd: hhmm(o.lunchEnd),
          timeOut: hhmm(o.timeOut),
          lodging: (LODGING_KEYS.has(lodging) ? lodging : "") as Lodging,
          signature: sig.startsWith("data:image/png;base64,") ? sig : null,
          signedAt: str(o.signedAt) || null,
          ...(o.paperSigned === true ? { paperSigned: true } : {}),
        };
      }),
      removed: Array.isArray(p.removed) ? p.removed.map(str).filter(Boolean) : [],
    },
    readPaperScans(p.paperScans),
  );
}

export function normaliseCrewChief(raw: unknown): CrewChiefPayload {
  const p = obj(raw);
  const staff = Array.isArray(p.staff) ? p.staff.map(str) : [];
  return {
    jobName: str(p.jobName),
    jobLocation: str(p.jobLocation),
    supervisor: str(p.supervisor),
    workZone: str(p.workZone),
    crewChief: str(p.crewChief),
    crewNumber: str(p.crewNumber),
    crewSize: str(p.crewSize),
    staff: padStaff(staff),
    notes: str(p.notes),
  };
}

export function normaliseSupplyList(raw: unknown): SupplyListPayload {
  const p = obj(raw);
  const lines = Array.isArray(p.lines) ? p.lines : [];
  return withScans<SupplyListPayload>(
    {
      jobName: str(p.jobName),
      jobLocation: str(p.jobLocation),
      totalCrew: str(p.totalCrew),
      lines: keepQuantities(
        lines.map((l) => {
          const o = obj(l);
          return { code: str(o.code), qty: Number(o.qty) };
        }),
      ),
    },
    readPaperScans(p.paperScans),
  );
}

export function normalisePayload<K extends TmFormKind>(kind: K, raw: unknown): TmPayloadByKind[K] {
  if (kind === "sign_in") return normaliseSignIn(raw) as TmPayloadByKind[K];
  if (kind === "crew_chief") return normaliseCrewChief(raw) as TmPayloadByKind[K];
  return normaliseSupplyList(raw) as TmPayloadByKind[K];
}

function padStaff(names: string[]): string[] {
  const out = names.slice(0, CREW_STAFF_SLOTS);
  while (out.length < CREW_STAFF_SLOTS) out.push("");
  return out;
}

/**
 * "Only lines with a quantity are kept." A blank, zero, negative or non-number
 * box is a line nobody used; one code appears once, the last entry winning,
 * because a stepper that was tapped twice is still one line on the paper.
 */
export function keepQuantities(lines: readonly SupplyLine[]): SupplyLine[] {
  const byCode = new Map<string, number>();
  for (const l of lines) {
    const code = l.code.trim();
    if (!code) continue;
    const qty = Math.round(Number(l.qty) * 100) / 100;
    if (Number.isFinite(qty) && qty > 0) byCode.set(code, qty);
    else byCode.delete(code);
  }
  return [...byCode].map(([code, qty]) => ({ code, qty }));
}

/** The supply lines in the catalogue's order, which is the paper's. */
export function sortByCatalogue(
  lines: readonly SupplyLine[],
  catalogue: readonly TmRateCode[],
): SupplyLine[] {
  const order = new Map(catalogue.map((c, i) => [c.code, i]));
  return [...lines].sort(
    (a, b) =>
      (order.get(a.code) ?? 1e6) - (order.get(b.code) ?? 1e6) || a.code.localeCompare(b.code),
  );
}

/** A sign-in row worth printing: somebody's name, or a time, or a signature. */
export function rowIsFilled(r: SignInRow): boolean {
  return Boolean(
    r.employee.trim() ||
    r.timeIn ||
    r.timeOut ||
    r.signature ||
    r.paperSigned ||
    r.rateCode ||
    r.lodging,
  );
}

/** Trailing blank rows are what "Add person" leaves; they are not saved. */
export function trimSignIn(p: SignInPayload): SignInPayload {
  return { ...p, rows: p.rows.filter(rowIsFilled) };
}

/**
 * Two phones, one sheet. Rows are matched by their own id: a row this phone
 * has wins over the stored copy of the same row; a stored row this phone has
 * never seen is kept (somebody signed on the other phone); a stored row this
 * phone removed stays removed. Stored rows keep their place, new ones follow.
 */
export function mergeSignIn(stored: SignInPayload | null, local: SignInPayload): SignInPayload {
  if (!stored) return local;
  const localById = new Map(local.rows.map((r) => [r.id, r]));
  const removed = new Set([...stored.removed, ...local.removed]);
  const rows: SignInRow[] = [];
  const placed = new Set<string>();
  for (const s of stored.rows) {
    if (removed.has(s.id) && !localById.has(s.id)) continue;
    rows.push(localById.get(s.id) ?? s);
    placed.add(s.id);
  }
  for (const r of local.rows) if (!placed.has(r.id)) rows.push(r);
  return withScans<SignInPayload>(
    {
      jobName: local.jobName,
      jobLocation: local.jobLocation,
      rows,
      removed: [...removed].filter((id) => !localById.has(id)),
    },
    mergePaperScans(stored.paperScans, local.paperScans),
  );
}

/* ------------------------------------------------------------------ */
/* Pre-filling a new day                                               */
/* ------------------------------------------------------------------ */

export type JobFacts = {
  jobNumber: string | null;
  jobName: string | null;
  customerName: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
};

/** "Job Name" on the paper: the job's own name, else the customer, else its number. */
export function jobNameFor(job: JobFacts): string {
  return (job.jobName || job.customerName || job.jobNumber || "").trim();
}

export function jobLocationFor(job: JobFacts): string {
  const cityLine = [job.locality, [job.region, job.postalCode].filter(Boolean).join(" ")]
    .filter((s) => s && s.trim())
    .join(", ");
  return [job.address, cityLine].filter((s) => s && s.trim()).join(", ");
}

export type CrewMember = { userId: string; name: string; role: string };

/** A clocked span on the job, as `time_entries` holds it. */
export type ClockSpan = {
  userId: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  entryType: string;
};

/** Roles on the job that put a person on site; the office roles never sign the sheet. */
const SITE_ROLES = new Set(["crew_chief", "lead_technician", "technician", "project_manager"]);

/**
 * The job role tells the sheet a likely Labor Class; it is only a starting
 * point the crew can change. Technician has no default on purpose — Gold Star
 * bills a tech as GL, SL, DL, WE… depending on the day's work.
 */
const ROLE_RATE_CODE: Readonly<Record<string, string>> = {
  crew_chief: "CCF",
  project_manager: "PM",
};

/** "HH:MM" on this device's clock. */
export function localHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The device-local calendar day of an instant, "YYYY-MM-DD". */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A new day's sign-in sheet, before anyone touches it.
 *
 * Who clocked in on this job that day comes first, with their times: Time In
 * is their first clock-in, Time Out their last clock-out, and a gap between
 * two labour spans is read as lunch. Then everyone on the job's crew who has
 * not clocked in yet, with blank times. Then (FE8, 28 Oct) everyone else on
 * the job's last sheet — the names typed in by hand included — so a crew is
 * not retyped every morning; each is an ordinary row, edited or removed like
 * any other. Each person's rate code is the one they had on the last sheet
 * for this job, else their job role's default.
 * Standby and travel spans do not make someone "in" — they are not on site.
 */
export function prefillSignIn(input: {
  job: JobFacts;
  day: string;
  spans: readonly ClockSpan[];
  crew: readonly CrewMember[];
  previous: SignInPayload | null;
  newId: () => string;
}): SignInPayload {
  const lastCode = new Map<string, string>();
  for (const r of input.previous?.rows ?? []) {
    if (r.rateCode) lastCode.set(r.userId ?? `name:${r.employee.trim().toLowerCase()}`, r.rateCode);
  }
  const roleOf = new Map(input.crew.map((c) => [c.userId, c.role]));
  const codeFor = (userId: string, name: string) =>
    lastCode.get(userId) ??
    lastCode.get(`name:${name.trim().toLowerCase()}`) ??
    ROLE_RATE_CODE[roleOf.get(userId) ?? ""] ??
    "";

  const byUser = new Map<string, ClockSpan[]>();
  for (const s of input.spans) {
    if (s.entryType !== "labour") continue;
    if (localDay(s.startedAt) !== input.day) continue;
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }

  const rows: SignInRow[] = [];
  const blank = (userId: string | null, employee: string): SignInRow => ({
    id: input.newId(),
    userId,
    employee,
    rateCode: userId ? codeFor(userId, employee) : "",
    timeIn: "",
    lunchStart: "",
    lunchEnd: "",
    timeOut: "",
    lodging: "",
    signature: null,
    signedAt: null,
  });

  const clocked = [...byUser.entries()].sort(
    (a, b) => Date.parse(a[1][0]!.startedAt) - Date.parse(b[1][0]!.startedAt),
  );
  for (const [userId, spans] of clocked) {
    const sorted = [...spans].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const row = blank(userId, first.name);
    row.timeIn = localHHMM(first.startedAt);
    row.timeOut = last.endedAt ? localHHMM(last.endedAt) : "";
    if (sorted.length >= 2 && sorted[0]!.endedAt) {
      row.lunchStart = localHHMM(sorted[0]!.endedAt);
      row.lunchEnd = localHHMM(sorted[1]!.startedAt);
    }
    rows.push(row);
  }
  for (const c of input.crew) {
    if (!SITE_ROLES.has(c.role) || byUser.has(c.userId)) continue;
    if (rows.some((r) => r.userId === c.userId)) continue;
    rows.push(blank(c.userId, c.name));
  }
  const nameKey = (n: string) => n.trim().toLowerCase();
  for (const r of input.previous?.rows ?? []) {
    const name = r.employee.trim();
    if (!name) continue;
    const already = rows.some(
      (x) => (r.userId && x.userId === r.userId) || nameKey(x.employee) === nameKey(name),
    );
    if (already) continue;
    rows.push({ ...blank(r.userId, name), rateCode: r.rateCode || codeFor(r.userId ?? "", name) });
  }

  return {
    jobName: input.previous?.jobName || jobNameFor(input.job),
    jobLocation: input.previous?.jobLocation || jobLocationFor(input.job),
    rows,
    removed: [],
  };
}

/**
 * A new day's crew chief report: the job's crew chief, the rest of the site
 * crew in the staff boxes, and yesterday's supervisor, work zone and crew
 * number (they rarely change from one day to the next). Notes start empty —
 * they are the day's own.
 */
export function prefillCrewChief(input: {
  job: JobFacts;
  crewChiefName: string | null;
  crew: readonly CrewMember[];
  previous: CrewChiefPayload | null;
}): CrewChiefPayload {
  const chief = (input.crewChiefName ?? "").trim() || input.previous?.crewChief || "";
  const staff = input.crew
    .filter((c) => SITE_ROLES.has(c.role) && c.name.trim() && c.name.trim() !== chief)
    .map((c) => c.name.trim());
  const names = staff.length ? staff : (input.previous?.staff ?? []).filter((s) => s.trim());
  const size = names.length + (chief ? 1 : 0);
  return {
    jobName: input.previous?.jobName || jobNameFor(input.job),
    jobLocation: input.previous?.jobLocation || jobLocationFor(input.job),
    supervisor: input.previous?.supervisor ?? "",
    workZone: input.previous?.workZone ?? "",
    crewChief: chief,
    crewNumber: input.previous?.crewNumber ?? "",
    crewSize: size ? String(size) : "",
    staff: padStaff(names),
    notes: "",
  };
}

/** A new day's supply list: the header, and no quantities — they are the day's own. */
export function prefillSupplyList(input: {
  job: JobFacts;
  crewCount: number;
  previous: SupplyListPayload | null;
}): SupplyListPayload {
  return {
    jobName: input.previous?.jobName || jobNameFor(input.job),
    jobLocation: input.previous?.jobLocation || jobLocationFor(input.job),
    totalCrew: input.crewCount > 0 ? String(input.crewCount) : "",
    lines: [],
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export type TmFormSummary = {
  id: string;
  job_id: string;
  kind: TmFormKind;
  form_date: string;
  document_id: string | null;
  updated_at: string;
};

export type TmFormRecord<K extends TmFormKind = TmFormKind> = TmFormSummary & {
  kind: K;
  payload: TmPayloadByKind[K];
};

/** What one save writes. Keyed by (job, kind, day); `id` is used only when the row is new. */
export type TmFormWrite = {
  id: string;
  job_id: string;
  kind: TmFormKind;
  form_date: string;
  payload: Record<string, unknown>;
  /** When the crew pressed save, not when it reached the server. */
  captured_at: string;
  created_by: string | null;
};

const SUMMARY_COLUMNS = "id, job_id, kind, form_date, document_id, updated_at";

/**
 * Every sheet on the job, newest day first — without the payloads, which
 * carry signature images and are fetched one sheet at a time when opened.
 * `available: false` means the migration has not landed yet.
 */
export async function listTmForms(
  jobId: string,
  client: SupabaseClient = db(),
): Promise<{ available: boolean; rows: TmFormSummary[] }> {
  const { data, error } = await client
    .from("job_tm_forms")
    .select(SUMMARY_COLUMNS)
    .eq("job_id", jobId)
    .order("form_date", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) return { available: false, rows: [] };
    throw error;
  }
  return { available: true, rows: (data ?? []) as TmFormSummary[] };
}

export async function getTmForm<K extends TmFormKind>(
  jobId: string,
  kind: K,
  day: string,
  client: SupabaseClient = db(),
): Promise<TmFormRecord<K> | null> {
  const { data, error } = await client
    .from("job_tm_forms")
    .select(`${SUMMARY_COLUMNS}, payload`)
    .eq("job_id", jobId)
    .eq("kind", kind)
    .eq("form_date", day)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as TmFormSummary & { payload: unknown };
  return { ...row, kind, payload: normalisePayload(kind, row.payload) } as TmFormRecord<K>;
}

/** The most recent sheet of this kind before `day`, for carrying things forward. */
export async function previousTmForm<K extends TmFormKind>(
  jobId: string,
  kind: K,
  day: string,
  client: SupabaseClient = db(),
): Promise<TmPayloadByKind[K] | null> {
  const { data, error } = await client
    .from("job_tm_forms")
    .select("payload")
    .eq("job_id", jobId)
    .eq("kind", kind)
    .lt("form_date", day)
    .order("form_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return data ? normalisePayload(kind, (data as { payload: unknown }).payload) : null;
}

/**
 * The one write, for the first attempt and the offline replay alike. A
 * sign-in sheet is merged with what is stored first; the others overwrite.
 * The trigger keeps the stored row's id, author and day on an update.
 */
export async function writeTmForm(row: TmFormWrite, client: SupabaseClient = db()): Promise<void> {
  let payload = row.payload;
  const stored = await client
    .from("job_tm_forms")
    .select("payload")
    .eq("job_id", row.job_id)
    .eq("kind", row.kind)
    .eq("form_date", row.form_date)
    .maybeSingle();
  if (stored.error) throw stored.error;
  const storedPayload = stored.data ? (stored.data as { payload: unknown }).payload : null;
  if (row.kind === "sign_in") {
    const merged = mergeSignIn(
      storedPayload ? normaliseSignIn(storedPayload) : null,
      normaliseSignIn(payload),
    );
    payload = merged as unknown as Record<string, unknown>;
  } else if (storedPayload) {
    // A sheet opened before a paper scan landed must not drop the scan's record.
    const scans = mergePaperScans(
      readPaperScans(obj(storedPayload).paperScans),
      readPaperScans(payload.paperScans),
    );
    if (scans.length) payload = { ...payload, paperScans: scans };
  }
  const { error } = await client
    .from("job_tm_forms")
    .upsert({ ...row, payload }, { onConflict: "job_id,kind,form_date" });
  if (error) throw error;
}

/**
 * The day this photo was already scanned onto, if it was (12 Nov: "make sure
 * they cannot upload a duplicate sheet again and again"). Any kind, any day
 * on the job: the same photo is the same paper wherever it went.
 */
export async function findPaperScan(
  jobId: string,
  hash: string,
  client: SupabaseClient = db(),
): Promise<{ kind: TmFormKind; form_date: string } | null> {
  const { data, error } = await client
    .from("job_tm_forms")
    .select("kind, form_date")
    .eq("job_id", jobId)
    .contains("payload", { paperScans: [{ hash }] })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return (data as { kind: TmFormKind; form_date: string } | null) ?? null;
}

/** Point the sheet at its newest filed PDF. */
export async function setTmFormDocument(
  jobId: string,
  kind: TmFormKind,
  day: string,
  documentId: string,
  client: SupabaseClient = db(),
): Promise<void> {
  const { error } = await client
    .from("job_tm_forms")
    .update({ document_id: documentId })
    .eq("job_id", jobId)
    .eq("kind", kind)
    .eq("form_date", day);
  if (error) throw error;
}

/** What the sync list calls a held sheet. */
export function tmFormQueueLabel(row: Pick<TmFormWrite, "kind" | "form_date">): string {
  return `${TM_FORM_META[row.kind].title} ${row.form_date}`;
}

/**
 * The newest save of this sheet still waiting on the device, if any. Opening
 * a sheet that was saved in a basement must show what was saved, not the
 * older copy on the server.
 */
export function heldPayload<K extends TmFormKind>(
  items: readonly { kind: string; payload: Record<string, unknown>; createdAt: number }[],
  jobId: string,
  kind: K,
  day: string,
): TmPayloadByKind[K] | null {
  const mine = items
    .filter(
      (i) =>
        i.kind === "tm_field_form" &&
        i.payload.job_id === jobId &&
        i.payload.kind === kind &&
        i.payload.form_date === day,
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  return mine[0] ? normalisePayload(kind, mine[0].payload.payload) : null;
}

/** File name for a filled or blank sheet. */
export function tmFormFilename(kind: TmFormKind, day: string | null, jobNumber?: string | null) {
  const stem = TM_FORM_META[kind].fileStem;
  const job = (jobNumber ?? "").replace(/[^A-Za-z0-9-]+/g, "");
  return day ? `${stem}${job ? `-${job}` : ""}-${day}.pdf` : `${stem}-blank.pdf`;
}
