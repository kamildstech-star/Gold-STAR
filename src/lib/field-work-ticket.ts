/**
 * Gold Star's field work ticket — the paper sheet a crew fills on site.
 *
 * The labels live here rather than in the panel because the ticket is
 * bilingual by necessity, not decoration: the crews are Spanish-speaking and
 * the printed form carries both languages on every line. Keeping the pairs in
 * one exported table is what stops the phone form and any later print/PDF from
 * drifting into two different Spanish translations of the same checkbox.
 *
 * These are fixed printed labels, so they are not routed through
 * `translations` / WorkOrderTranslation — that machinery exists for per-job
 * free text a supervisor may correct, and it needs an API round trip the first
 * time. A checkbox list must render identically on a phone with no signal.
 * Work Notes, the one free-text field here, stays translatable that way.
 */
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

/**
 * `approved_at`/`approved_by` ship in 20260917120000 and are not in the
 * generated types until it is applied, so they are declared optional here
 * rather than being cast at every use. `ticketApprovalSupported()` is how the
 * UI finds out whether they are really there.
 */
export type FieldWorkTicket = Tables<"field_work_tickets"> & {
  approved_at?: string | null;
  approved_by?: string | null;
};
export type FieldWorkTicketInsert = TablesInsert<"field_work_tickets">;

/** English label, Spanish label. Order is the order printed on the paper. */
export type Bilingual = { key: string; en: string; es: string };

export const TICKET_SECTION = {
  jobAddress: { en: "Job Address", es: "Dirección de trabajo" },
  unit: { en: "Unit #", es: "Unidad" },
  date: { en: "Date", es: "Fecha" },
  startTime: { en: "Job Start Time", es: "Hora de inicio del trabajo" },
  endTime: { en: "Job End Time", es: "Hora de finalización del trabajo" },
  crewChief: { en: "Crew Chief", es: "Jefe de equipo" },
  gsrCrew: { en: "GSR Crew Size", es: "Tamaño de la cuadrilla GSR" },
  tempCrew: { en: "TEMP Crew Size", es: "Tamaño del equipo temporal" },
  jobType: { en: "Job Type", es: "Tipo de trabajo" },
  scope: { en: "Scope of Work Completed", es: "Trabajo Completado" },
  materials: { en: "Materials Used", es: "Materiales Utilizados" },
  equipment: { en: "Equipment Left", es: "Equipo restante (escribe en número)" },
  notes: { en: "Work Notes", es: "Notas de trabajo" },
  trash: { en: "Trash", es: "Basura" },
  completed: { en: "Job Completed", es: "Trabajo completado" },
  moreWork: { en: "More work needed", es: "Se necesita más trabajo" },
} as const;

export const JOB_TYPE_OPTIONS: Bilingual[] = [
  { key: "water", en: "Water", es: "Agua" },
  { key: "fire", en: "Fire", es: "Fuego" },
  { key: "mold", en: "Mold", es: "Moho" },
  { key: "sewage", en: "Sewage", es: "Aguas negras" },
  { key: "bio", en: "BIO", es: "BIO" },
  { key: "vandalism", en: "Vandalism", es: "Vandalismo" },
  { key: "air_sample", en: "Air Sample", es: "Muestra de aire" },
];

export const SCOPE_OPTIONS: Bilingual[] = [
  { key: "extraction", en: "Extraction", es: "Extracción" },
  { key: "pump_out", en: "Pump out", es: "Bombeo" },
  { key: "mop_floor", en: "Mop Floor", es: "Trapear piso" },
  { key: "smoke_clean", en: "Smoke Clean", es: "Limpieza de humo" },
  { key: "wipe_down", en: "Wipe down", es: "Limpiar superficies" },
  { key: "demo", en: "Demo", es: "Demolición" },
  { key: "clean_sanitize", en: "Clean/Sanitize", es: "Limpiar/Desinfectar" },
  { key: "board_up", en: "Board Up", es: "Tapiado" },
  { key: "fogging", en: "Fogging", es: "Nebulización" },
  { key: "sketch", en: "Sketch", es: "Croquis" },
  { key: "write_up", en: "Write Up", es: "Informe" },
  { key: "dry_log", en: "Dry Log", es: "Registro de secado" },
];

export const MATERIAL_OPTIONS: Bilingual[] = [
  { key: "containment", en: "Containment", es: "Contención" },
  { key: "zipper", en: "Zipper", es: "Cierre" },
  { key: "ram_board", en: "Ram Board", es: "Ram Board" },
  { key: "degreaser", en: "Degreaser", es: "Desengrasante" },
  // The printed sheet reads "Antimicrobail". Spelled correctly here.
  { key: "antimicrobial", en: "Antimicrobial", es: "Antimicrobiano" },
  { key: "ppe", en: "PPE", es: "EPP" },
  { key: "rags", en: "Rags", es: "Trapos" },
  { key: "trash_bags", en: "Trash Bags", es: "Bolsas de basura" },
  { key: "filters", en: "Filters", es: "Filtros" },
  { key: "tarp", en: "Tarp", es: "Lona" },
  { key: "boxes", en: "Boxes", es: "Cajas" },
  { key: "truck_mount", en: "Truck Mount", es: "Unidad de camión" },
  { key: "encapsulation_paint", en: "Encapsulation / Paint", es: "Encapsulado / Pintura" },
  { key: "lay_flat_ducting", en: "Lay Flat Ducting", es: "Ducto plano" },
];

/** Column suffix on `field_work_tickets`, i.e. `equip_${key}`. */
export const EQUIPMENT_LEFT_OPTIONS: Bilingual[] = [
  { key: "dehumidifier", en: "Dehumidifier", es: "Deshumidificador" },
  { key: "air_mover", en: "Air Mover", es: "Ventilador" },
  { key: "scrubber", en: "Scrubber", es: "Purificador de aire" },
  { key: "injector", en: "Injector", es: "Inyector" },
  { key: "ozone", en: "Ozone", es: "Ozono" },
  { key: "hydroxyl", en: "Hydroxl", es: "Hidroxilo" },
  { key: "generator", en: "Generator", es: "Generador" },
];

export const TRASH_OPTIONS: Bilingual[] = [
  { key: "none", en: "No trash", es: "Sin basura" },
  { key: "shop", en: "Brought trash to shop", es: "Basura llevada al taller" },
  { key: "job_site_dumpster", en: "Used job site dumpster", es: "Contenedor del sitio" },
  { key: "gsr_dumpster", en: "GSR Dumpster / Live load", es: "Contenedor GSR / Carga en vivo" },
];

export type EquipmentLeftKey = (typeof EQUIPMENT_LEFT_OPTIONS)[number]["key"];

/**
 * Ticket count → the `equipment.equipment_type` values that count as the same
 * thing. Empty means Gold Star does not asset-tag that class of unit, so the
 * ticket number is the only record there will ever be of it.
 */
export const EQUIPMENT_LEFT_TO_ASSET_TYPES: Record<string, string[]> = {
  dehumidifier: ["dehumidifier"],
  air_mover: ["air_mover"],
  scrubber: ["air_scrubber", "hepa"],
  injector: [],
  ozone: [],
  hydroxyl: [],
  generator: ["generator"],
};

export function equipColumn(key: string): keyof FieldWorkTicket {
  return `equip_${key}` as keyof FieldWorkTicket;
}

/**
 * Stored keys → their printed labels, in the order of the paper form.
 *
 * A key the option list no longer knows is passed through as its own label
 * rather than dropped: an old ticket ticked what the form offered that day,
 * and silently omitting a retired checkbox would show that shift's crew doing
 * less work than they did.
 */
export function ticketLabels(options: Bilingual[], keys: string[] | null): Bilingual[] {
  const chosen = new Set(keys ?? []);
  const known = options.filter((o) => chosen.has(o.key));
  const unknown = [...chosen]
    .filter((k) => !options.some((o) => o.key === k))
    .map((k) => ({ key: k, en: k, es: k }));
  return [...known, ...unknown];
}

/** The equipment count written on a ticket line; null means never filled in. */
export function ticketEquipCount(ticket: FieldWorkTicket, key: string): number | null {
  const value = ticket[equipColumn(key)];
  return typeof value === "number" ? value : null;
}

/** `equipment.equipment_type` → the ticket line it counts towards, or null. */
export function ticketKeyForAssetType(assetType: string): string | null {
  for (const [key, types] of Object.entries(EQUIPMENT_LEFT_TO_ASSET_TYPES)) {
    if (types.includes(assetType)) return key;
  }
  return null;
}

/**
 * The asset tags a crew scanned onto this ticket.
 *
 * Read defensively rather than as `ticket.equipment_left_tags`: the column
 * arrives with a migration that is written but not applied, and until it lands
 * `select *` simply returns a row without the field. An older ticket filed
 * before scanning existed also has none, and that is not a fault either.
 */
export function ticketEquipmentTags(ticket: Partial<FieldWorkTicket>): string[] {
  const raw = (ticket as { equipment_left_tags?: unknown }).equipment_left_tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * `available: false` means the migration has not been applied — the panel says
 * so instead of showing an empty list. Any other failure throws, because a
 * crew shown "no tickets" for a job that has one will fill a second one.
 */
export async function listFieldWorkTickets(
  jobId: string,
): Promise<{ rows: FieldWorkTicket[]; available: boolean }> {
  const { data, error } = await supabase
    .from("field_work_tickets")
    .select("*")
    .eq("job_id", jobId)
    .order("work_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) return { rows: [], available: false };
    throw error;
  }
  return { rows: (data ?? []) as FieldWorkTicket[], available: true };
}

/**
 * Open placements on the job, in the ticket's own equipment vocabulary: how
 * many of each line, and which asset tags they are. The tags are what let a
 * ticket be checked unit by unit instead of only number against number.
 *
 * Returns null when placements cannot be read at all — an unreadable inventory
 * must not be rendered as "inventory says zero", which would accuse every
 * honest ticket of over-reporting.
 */
export type PlacementInventory = {
  counts: Record<string, number>;
  tags: Record<string, string[]>;
  /**
   * Every unit currently out on the job, by equipment id, including the lines
   * Gold Star does not asset-tag onto a ticket. The counts above answer "does
   * the ticket agree with the log"; this answers "has this machine I just
   * scanned already been logged out", which is a different question and the
   * one the setup scan asks before it places anything.
   */
  openIds: Set<string>;
};

export async function openPlacementInventory(jobId: string): Promise<PlacementInventory | null> {
  const { data, error } = await supabase
    .from("equipment_placements")
    .select("equipment_id, equipment:equipment_id(equipment_type, asset_tag)")
    .eq("job_id", jobId)
    .is("retrieved_at", null);
  if (error) return null;

  const counts: Record<string, number> = {};
  const tags: Record<string, string[]> = {};
  // Only the lines Gold Star asset-tags get an entry at all. An ozone machine
  // has no placement row to compare against, so a count there is the record.
  for (const opt of EQUIPMENT_LEFT_OPTIONS) {
    if ((EQUIPMENT_LEFT_TO_ASSET_TYPES[opt.key] ?? []).length === 0) continue;
    counts[opt.key] = 0;
    tags[opt.key] = [];
  }

  const rows = (data ?? []) as unknown as {
    equipment_id: string;
    equipment: { equipment_type: string; asset_tag: string } | null;
  }[];
  const openIds = new Set<string>();
  for (const row of rows) {
    if (row.equipment_id) openIds.add(row.equipment_id);
    const type = row.equipment?.equipment_type;
    if (!type) continue;
    const key = ticketKeyForAssetType(type);
    if (!key || !(key in counts)) continue;
    counts[key] = (counts[key] ?? 0) + 1;
    if (row.equipment?.asset_tag) tags[key]!.push(row.equipment.asset_tag);
  }
  return { counts, tags, openIds };
}

export type EquipmentDisagreement = {
  key: string;
  en: string;
  es: string;
  ticket: number;
  placements: number;
  /** On the ticket but not placed on this job. */
  onlyOnTicket: string[];
  /** Placed on this job but absent from the ticket. */
  onlyInLog: string[];
};

/** Which ticket line a tag sits on according to the placement log. */
function logLineFor(inventory: PlacementInventory, tag: string): string | null {
  for (const [key, tags] of Object.entries(inventory.tags)) {
    if (tags.some((t) => t.toUpperCase() === tag)) return key;
  }
  return null;
}

/**
 * Where the ticket and the placement log disagree. Only lines Gold Star
 * asset-tags can disagree — an ozone machine has no placement row to differ
 * from, so a count there is simply the record.
 *
 * When the crew scanned the units, the disagreement is named rather than only
 * counted: "ticket 4, log 3" sends someone to walk the whole job, while
 * "GSR-AM00034-NJ is on the ticket and not in the log" is one machine to go
 * and find. That is what the tags buy.
 */
export function equipmentDisagreements(
  ticket: FieldWorkTicket,
  inventory: PlacementInventory | null,
): EquipmentDisagreement[] {
  if (!inventory) return [];
  const scanned = ticketEquipmentTags(ticket).map((t) => t.toUpperCase());
  const scannedSet = new Set(scanned);
  const out: EquipmentDisagreement[] = [];

  for (const opt of EQUIPMENT_LEFT_OPTIONS) {
    if (!(opt.key in inventory.counts)) continue;
    const written = ticket[equipColumn(opt.key)];
    if (typeof written !== "number") continue;
    const placed = inventory.tags[opt.key] ?? [];
    const placedSet = new Set(placed.map((t) => t.toUpperCase()));

    // Tag-level comparison only where the crew actually scanned. A ticket with
    // no tags is the old count-only ticket and is compared the old way.
    const onlyInLog = scanned.length ? placed.filter((t) => !scannedSet.has(t.toUpperCase())) : [];
    const onlyOnTicket = scanned.filter(
      (t) => !placedSet.has(t) && logLineFor(inventory, t) === opt.key,
    );

    if (written !== inventory.counts[opt.key] || onlyInLog.length || onlyOnTicket.length) {
      out.push({
        key: opt.key,
        en: opt.en,
        es: opt.es,
        ticket: written,
        placements: inventory.counts[opt.key] ?? 0,
        onlyOnTicket,
        onlyInLog,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * The single write both paths use: the online submit, and the offline queue
 * draining hours later. Upsert on the client-generated id, so a retry after a
 * response that never arrived updates the row it already wrote instead of
 * filing a duplicate ticket.
 *
 * `jobs.additional_work_pending` is raised by a database trigger rather than a
 * second statement here — a crew's phone may not be allowed to update the job
 * row, and a two-statement version would half-apply when the tab dies between
 * them.
 */
export async function writeFieldWorkTicket(
  row: FieldWorkTicketInsert,
  client: typeof supabase = supabase,
): Promise<void> {
  const { error } = await client
    .from("field_work_tickets")
    .upsert(row as never, { onConflict: "id" });
  if (!error) return;
  // `equipment_left_tags` arrives in a migration of its own, and until it is
  // applied PostgREST refuses the whole upsert over that one unknown column.
  // Losing the scanned tags is bad; losing the crew's entire shift because of
  // them is worse, so the ticket is written without them.
  if (isMissingSchema(error) && "equipment_left_tags" in row) {
    const { equipment_left_tags: _tags, ...rest } = row;
    const retry = await client
      .from("field_work_tickets")
      .upsert(rest as never, { onConflict: "id" });
    if (retry.error) throw retry.error;
    return;
  }
  throw error;
}

/**
 * Can this database store scanned tags yet? Asked once per panel so the crew
 * is told "scanning is not stored yet" up front rather than after they have
 * scanned six machines onto a ticket that will silently drop them.
 */
export async function equipmentTagsSupported(): Promise<boolean> {
  const { error } = await supabase
    .from("field_work_tickets")
    .select("equipment_left_tags")
    .limit(1);
  return !(error && isMissingSchema(error));
}

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

/**
 * A ticket a supervisor has accepted.
 *
 * David, 16 Sep, asked for a clear "accept the form / approve the entries"
 * step. Tickets had no such state — a crew saved one and that was the end of
 * it, so nobody could tell a sheet that had been read from one that had not.
 *
 * `approved_at`/`approved_by` arrive in 20260917120000. Until that migration is
 * applied the panel reports approval as unavailable rather than pretending
 * every ticket is outstanding.
 */
export type TicketApproval = { approved_at: string | null; approved_by: string | null };

export function isTicketApproved(t: Partial<TicketApproval> | null | undefined): boolean {
  return !!t?.approved_at;
}

/** False when the approval columns are not in this database yet. */
export async function ticketApprovalSupported(): Promise<boolean> {
  const { error } = await supabase.from("field_work_tickets").select("approved_at").limit(1);
  return !(error && isMissingSchema(error));
}

export async function setFieldWorkTicketApproval(
  id: string,
  approvedBy: string | null,
  approved: boolean,
): Promise<void> {
  const patch = approved
    ? { approved_at: new Date().toISOString(), approved_by: approvedBy }
    : { approved_at: null, approved_by: null };
  const { error } = await supabase
    .from("field_work_tickets")
    .update(patch as never)
    .eq("id", id);
  if (error) throw error;
}

/** Short human line for the offline queue list: "12 Oak St · 14 Aug". */
export function ticketQueueLabel(row: FieldWorkTicketInsert): string {
  const where = (row.job_address ?? "").trim() || "Field work ticket";
  return `${where} · ${row.work_date ?? ""}`.trim();
}
