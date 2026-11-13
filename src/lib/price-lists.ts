import { supabase } from "@/integrations/supabase/client";
import { num, round2 } from "@/lib/estimates";
import { isMissingSchema } from "@/lib/schema-fallback";
import { normalizeStateCode } from "@/lib/us-states";

/**
 * PRICE LISTS — the customer agreement and the state rate, over the default
 * catalog.
 *
 * David, on the call: "You see the unit price is $95 ... but what's if I have
 * different clients that I have different pricing with? Let's say Falcon has a
 * price that I'm charging them only $80 and everyone else in charging 95 ...
 * There's a default price list, right? And then I have customers that I have
 * an agreement with ... Different states, you know, let's say New York and
 * California, I charge for labor $70 versus Jersey. I can charge $65 ...
 * There's a default across the board. But when you select certain clients,
 * those clients override the default."
 *
 * THE DEFAULT PRICE LIST ALREADY EXISTS. It is
 * `estimate_catalog_items.default_unit_price` — the number the line picker
 * copies onto a line today. There is no second catalog here, only an override
 * layer: a named list of prices (`price_lists` + `price_list_items`) and the
 * rows that say who it applies to (`price_list_assignments`, account or
 * location, effective-dated).
 *
 * RESOLUTION IS ONE PURE FUNCTION, and it is the whole point of this module:
 *
 *     customer agreement -> branch list -> state list -> catalog default
 *
 * The state layer (20260913110000) is the second half of what David asked for
 * and was missing: the first build read "different states" as the branch list,
 * which is not the same thing — a state holds several branches, and the rate
 * he described is charged across all of them. Both scopes now exist and the
 * NARROWER one wins, so a branch that has negotiated its own sheet keeps it
 * and every other branch in the state follows the state rate. With no branch
 * list assigned, which is the ordinary case, the order is exactly the one he
 * stated: customer, then state, then default.
 *
 * Fall-through is PER ITEM, not per list. Falcon's agreement covers the four
 * lines that were negotiated; every other line on Falcon's estimate still
 * comes off the default catalog. A list that had to restate all 34 items to
 * change one of them is a list nobody keeps current.
 *
 * A PRICED LINE NEVER CHANGES AFTERWARDS. `estimate_lines.unit_price` and
 * `invoice_lines.unit_price` are values, written when the line is added.
 * Resolution runs at that moment and never again — there is no trigger, view
 * or recompute anywhere that reaches back into a document. Signing a new
 * agreement with Falcon on Tuesday does not rewrite the estimate they approved
 * on Monday, and does not move an invoice that has been sent. A line added to
 * that old estimate afterwards DOES price at the new agreement, which is
 * exactly what already happens when someone edits a catalog default.
 *
 * NO COST LIVES HERE. `estimate_catalog_items.default_cost` and the two
 * `unit_cost` columns are behind column-level grants and a job.view_costs RPC
 * (migrations 20260909090000 / 20260909100000). A price list has no cost
 * column at all — an agreed sell price says nothing about our margin — so
 * there is nothing in this module to withhold from anyone. Adding a cost
 * column to a price list would mean inheriting the whole of that policy first.
 */

/* ------------------------------------------------------------------ types */

export interface PriceList {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
}

export interface PriceListItemRow {
  id: string;
  price_list_id: string;
  catalog_item_id: string;
  unit_price: number;
}

/**
 * Which of David's rules an assignment expresses, NARROWEST FIRST. The array
 * is the precedence: `buildPriceBook` walks it in reverse so the narrowest
 * scope is written last and wins, and adding a scope means adding it here
 * rather than editing three functions.
 */
export const PRICE_SCOPES = ["account", "location", "state"] as const;
export type PriceScope = (typeof PRICE_SCOPES)[number];

export const PRICE_SCOPE_LABEL: Record<PriceScope, string> = {
  account: "Customer",
  location: "Branch",
  state: "State",
};

export interface PriceListAssignmentRow {
  id: string;
  price_list_id: string;
  account_id: string | null;
  location_id: string | null;
  /** Two-letter code, already normalized. Null on the other two scopes. */
  state_code: string | null;
  /** Inclusive, `YYYY-MM-DD`. */
  effective_from: string;
  /** Inclusive, or null for "still in force". */
  effective_to: string | null;
  created_at: string;
}

/** What a document is being priced for. */
export interface PriceContext {
  accountId: string | null;
  locationId: string | null;
  /**
   * The state the WORK is in, not the office that sold it — a New York branch
   * drying out a New Jersey building charges the New Jersey rate. Callers
   * pass it through `normalizeStateCode`, or leave it null to skip the layer.
   */
  stateCode: string | null;
  /** `YYYY-MM-DD`. The document's date, not necessarily today. */
  onDate: string;
  /** The job the document is for: its frozen / custom rates and chosen source win. */
  jobId?: string | null;
}

/**
 * Where a unit price came from, so a screen can say so out loud. Billing &
 * Costs prompt 4 adds the job's own frozen line ("job"), a line typed for the
 * job ("custom"), and "none" — nothing prices the item; it goes in at $0 and
 * the screen asks for a rate.
 */
export type PriceSource = PriceScope | "default" | "job" | "custom" | "tm" | "none";

export interface ResolvedPrice {
  unit_price: number;
  source: PriceSource;
  /** null when the price is the catalog default. */
  price_list_id: string | null;
  assignment_id: string | null;
}

/**
 * The overrides that apply to one document, catalog item id -> price. Only
 * overrides: an item nobody negotiated is simply absent, and `resolvePrice`
 * answers it from the catalog.
 */
export type PriceBook = ReadonlyMap<string, ResolvedPrice>;

export const EMPTY_PRICE_BOOK: PriceBook = new Map();

/* -------------------------------------------------------------- resolution */

/** Today as the `YYYY-MM-DD` the date columns are compared against. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Is this assignment in force on `onDate`? Both ends are inclusive: an
 * agreement that runs "to the 31st" covers the 31st, and one that starts today
 * covers today. Dates are `YYYY-MM-DD`, which compares correctly as a string,
 * so no Date object is constructed and no timezone can shift a boundary by a
 * day — the bug that would make a rate start the evening before.
 */
export function assignmentApplies(a: PriceListAssignmentRow, onDate: string): boolean {
  if (a.effective_from > onDate) return false;
  if (a.effective_to && a.effective_to < onDate) return false;
  return true;
}

/** The scope an assignment row expresses, or null if it names none of them. */
export function assignmentScope(a: PriceListAssignmentRow): PriceScope | null {
  if (a.account_id) return "account";
  if (a.location_id) return "location";
  if (a.state_code) return "state";
  return null;
}

/**
 * Rank two applicable assignments of the SAME scope. Overlapping agreements
 * are not forbidden in the database — superseding one agreement with another
 * mid-day creates an overlap, and a constraint that rejected it would block an
 * ordinary act of admin — so the tie has to be broken here, and broken the
 * same way every time. Two people looking at the same estimate must not see
 * two prices.
 *
 * Newest wins, on three keys so the answer is total rather than merely usual:
 *   1. later `effective_from` — the agreement negotiated most recently
 *   2. then later `created_at` — two rows starting the same day
 *   3. then the greater `id` — identical timestamps from one import batch
 *
 * Returns > 0 when `a` should win.
 */
export function compareAssignments(a: PriceListAssignmentRow, b: PriceListAssignmentRow): number {
  if (a.effective_from !== b.effective_from) return a.effective_from < b.effective_from ? -1 : 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The winning assignment for each scope, or null where the customer has no
 * agreement / the branch has no list. Rows for a different account or a
 * different location are ignored, so the caller may pass everything it read.
 */
export function winningAssignments(
  assignments: readonly PriceListAssignmentRow[],
  ctx: PriceContext,
): Record<PriceScope, PriceListAssignmentRow | null> {
  const winners: Record<PriceScope, PriceListAssignmentRow | null> = {
    account: null,
    location: null,
    state: null,
  };
  // Normalized on both sides: the column holds a code, but a context built
  // from a free-typed `accounts.state` may still be carrying "New Jersey".
  const wantState = normalizeStateCode(ctx.stateCode);
  for (const a of assignments) {
    const scope = assignmentScope(a);
    if (!scope) continue;
    if (scope === "account" && (!ctx.accountId || a.account_id !== ctx.accountId)) continue;
    if (scope === "location" && (!ctx.locationId || a.location_id !== ctx.locationId)) continue;
    if (scope === "state" && (!wantState || normalizeStateCode(a.state_code) !== wantState)) {
      continue;
    }
    if (!assignmentApplies(a, ctx.onDate)) continue;
    const held = winners[scope];
    if (!held || compareAssignments(a, held) > 0) winners[scope] = a;
  }
  return winners;
}

/**
 * The override table for one document: catalog item id -> the price that beats
 * the catalog, with the scope it came from.
 *
 * Built lowest-priority first so the customer agreement simply overwrites the
 * location entry for the items it names, and leaves the rest of the location
 * list standing. That is the per-item fall-through, expressed as two passes
 * rather than a lookup chain nobody can hold in their head.
 *
 * `items` may hold rows from any list; only the two winning lists are read.
 */
export function buildPriceBook(
  assignments: readonly PriceListAssignmentRow[],
  items: readonly PriceListItemRow[],
  ctx: PriceContext,
): PriceBook {
  const winners = winningAssignments(assignments, ctx);
  const book = new Map<string, ResolvedPrice>();
  // Widest first so the narrowest is written last and wins: state, then
  // branch, then customer. `PRICE_SCOPES` is narrowest-first, so this walks
  // it backwards and a new scope needs no edit here.
  for (const scope of [...PRICE_SCOPES].reverse()) {
    const winner = winners[scope];
    if (!winner) continue;
    for (const item of items) {
      if (item.price_list_id !== winner.price_list_id) continue;
      book.set(item.catalog_item_id, {
        // PostgREST serialises `numeric` as a string often enough that a
        // coercion here is cheaper than a surprise "80" + 5 = "805" later.
        unit_price: round2(num(item.unit_price)),
        source: scope,
        price_list_id: winner.price_list_id,
        assignment_id: winner.id,
      });
    }
  }
  return book;
}

/**
 * What to charge for one catalog item. The agreement if there is one, else the
 * catalog default the item has always carried.
 *
 * `defaultUnitPrice` is `estimate_catalog_items.default_unit_price` — the
 * caller already has the row, and passing it keeps this function pure and the
 * default price list exactly where it lives today.
 */
export function resolvePrice(
  catalogItemId: string,
  defaultUnitPrice: number | string | null | undefined,
  book: PriceBook = EMPTY_PRICE_BOOK,
): ResolvedPrice {
  const hit = book.get(catalogItemId);
  // A zero is a price someone typed on purpose ("no travel charge for
  // Falcon"), so the test is presence in the map, never truthiness of the
  // number.
  if (hit) return hit;
  return {
    unit_price: round2(num(defaultUnitPrice)),
    source: "default",
    price_list_id: null,
    assignment_id: null,
  };
}

/** Convenience for a catalog row straight off the picker. */
export function resolveCatalogPrice(
  item: { id: string; default_unit_price: number | string },
  book: PriceBook = EMPTY_PRICE_BOOK,
): ResolvedPrice {
  return resolvePrice(item.id, item.default_unit_price, book);
}

/* ------------------------------------------------------------------ reads */

export async function fetchPriceLists(): Promise<PriceList[]> {
  const { data, error } = await supabase
    .from("price_lists")
    .select("id, name, description, is_active, created_at")
    .order("name");
  if (error) throw error;
  return (data ?? []) as PriceList[];
}

export async function fetchPriceListItems(priceListId: string): Promise<PriceListItemRow[]> {
  const { data, error } = await supabase
    .from("price_list_items")
    .select("id, price_list_id, catalog_item_id, unit_price")
    .eq("price_list_id", priceListId);
  if (error) throw error;
  return (data ?? []) as PriceListItemRow[];
}

/**
 * The assignment columns, with and without the state scope.
 *
 * `state_code` arrives with 20260913110000. Naming a column PostgREST does not
 * know fails the WHOLE read, so every assignment query asks for it, and falls
 * back to the pre-state column list when the schema has not caught up — the
 * same shape `estimate-editor.tsx` and `job-billing-panel.tsx` already use for
 * their own unshipped columns. On the old schema a state assignment cannot
 * exist, so reading rows without the column loses nothing.
 */
const ASSIGNMENT_COLUMNS =
  "id, price_list_id, account_id, location_id, state_code, effective_from, effective_to, created_at";
const ASSIGNMENT_COLUMNS_LEGACY =
  "id, price_list_id, account_id, location_id, effective_from, effective_to, created_at";

/** A row read from the old schema, given the null state the resolver expects. */
function withStateCode(rows: unknown): PriceListAssignmentRow[] {
  return ((rows ?? []) as Record<string, unknown>[]).map(
    (r) => ({ state_code: null, ...r }) as unknown as PriceListAssignmentRow,
  );
}

export async function fetchPriceListAssignments(
  priceListId?: string,
): Promise<PriceListAssignmentRow[]> {
  const read = async (columns: string) => {
    let q = supabase
      .from("price_list_assignments")
      .select(columns)
      .order("effective_from", { ascending: false });
    if (priceListId) q = q.eq("price_list_id", priceListId);
    return q;
  };

  let { data, error } = (await read(ASSIGNMENT_COLUMNS)) as { data: unknown; error: unknown };
  if (error && isMissingSchema(error)) {
    ({ data, error } = (await read(ASSIGNMENT_COLUMNS_LEGACY)) as {
      data: unknown;
      error: unknown;
    });
  }
  if (error) throw error;
  return withStateCode(data);
}

/** Everything one document needs to price a line: the book, and what to call it. */
export interface DocumentPricing {
  book: PriceBook;
  /** Winning list names, customer agreement first. Empty means catalog only. */
  labels: string[];
  /** list id -> name, so a screen can name the list ONE price came from. */
  nameOfList: ReadonlyMap<string, string>;
}

export const NO_DOCUMENT_PRICING: DocumentPricing = {
  book: EMPTY_PRICE_BOOK,
  labels: [],
  nameOfList: new Map(),
};

/**
 * The price book for one document, in two round-trips.
 *
 * Reads only the assignments that could possibly apply, resolves the winner
 * for each scope here, then reads the items of at most two lists — rather than
 * pulling every price list in the company to the browser. A document with no
 * account and no location resolves to nothing without a query at all.
 */
export async function fetchDocumentPricing(ctx: PriceContext): Promise<DocumentPricing> {
  const chain = await fetchChainPricing(ctx);
  if (chain) return chain;
  return fetchListPricing(ctx);
}

/** Labels for a chain source, customer-facing words kept short. */
export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  account: "Client agreement",
  location: "Standard (this office)",
  state: "State price list",
  default: "Standard",
  job: "This job's rates",
  custom: "Custom for this job",
  tm: "T&M rate (this T&M job)",
  none: "No rate",
};

/**
 * Billing & Costs prompt 4: the whole book from one database function,
 * regular_price_book — job line → client agreement → office Standard → state
 * list → company Standard → none. null before migration 20261101120000, and
 * the caller falls back to the price-list read below.
 */
async function fetchChainPricing(ctx: PriceContext): Promise<DocumentPricing | null> {
  const { data, error } = await supabase.rpc(
    "regular_price_book" as never,
    {
      _job_id: ctx.jobId ?? null,
      _account_id: ctx.accountId,
      _location_id: ctx.locationId,
      _state: normalizeStateCode(ctx.stateCode),
      _on: ctx.onDate,
    } as never,
  );
  if (error) {
    if (isMissingSchema(error) || (error as { code?: string }).code === "PGRST202") return null;
    throw error;
  }
  return chainToPricing(
    (data ?? []) as {
      catalog_item_id: string;
      unit_price: number | string | null;
      source: PriceSource;
      price_list_id: string | null;
    }[],
    await listNames(
      ((data ?? []) as { price_list_id: string | null }[])
        .map((r) => r.price_list_id)
        .filter((v): v is string => !!v),
    ),
  );
}

async function listNames(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { data } = await supabase.from("price_lists").select("id, name").in("id", unique);
  return new Map(((data ?? []) as { id: string; name: string }[]).map((l) => [l.id, l.name]));
}

/** The chain's rows as the book every picker already reads. Pure. */
export function chainToPricing(
  rows: readonly {
    catalog_item_id: string;
    unit_price: number | string | null;
    source: PriceSource;
    price_list_id: string | null;
  }[],
  nameOf: ReadonlyMap<string, string>,
): DocumentPricing {
  const book = new Map<string, ResolvedPrice>();
  const lists: string[] = [];
  for (const r of rows) {
    book.set(r.catalog_item_id, {
      unit_price: r.unit_price == null ? 0 : round2(num(r.unit_price)),
      source: r.unit_price == null ? "none" : r.source,
      price_list_id: r.price_list_id,
      assignment_id: null,
    });
    if (
      r.price_list_id &&
      (r.source === "account" || r.source === "state") &&
      !lists.includes(r.price_list_id)
    )
      lists.push(r.price_list_id);
  }
  return {
    book,
    labels: lists.map((id) => nameOf.get(id)).filter((n): n is string => !!n),
    nameOfList: nameOf,
  };
}

/** Before 20261101120000: the price lists over the catalog default. */
async function fetchListPricing(ctx: PriceContext): Promise<DocumentPricing> {
  const stateCode = normalizeStateCode(ctx.stateCode);
  if (!ctx.accountId && !ctx.locationId && !stateCode) return NO_DOCUMENT_PRICING;

  const filters: string[] = [];
  if (ctx.accountId) filters.push(`account_id.eq.${ctx.accountId}`);
  if (ctx.locationId) filters.push(`location_id.eq.${ctx.locationId}`);
  if (stateCode) filters.push(`state_code.eq.${stateCode}`);
  const read = (columns: string, where: string[]) =>
    supabase.from("price_list_assignments").select(columns).or(where.join(","));

  let { data, error } = (await read(ASSIGNMENT_COLUMNS, filters)) as {
    data: unknown;
    error: unknown;
  };
  if (error && isMissingSchema(error)) {
    // Pre-state schema: drop the state filter too, or PostgREST rejects the
    // `or` clause for naming a column it does not have.
    const legacy = filters.filter((f) => !f.startsWith("state_code."));
    if (!legacy.length) return NO_DOCUMENT_PRICING;
    ({ data, error } = (await read(ASSIGNMENT_COLUMNS_LEGACY, legacy)) as {
      data: unknown;
      error: unknown;
    });
  }
  if (error) throw error;

  const assignments = withStateCode(data);
  const winners = winningAssignments(assignments, ctx);
  // Narrowest first, so `labels` reads the way someone asks about it: the
  // customer's agreement is the one they want named.
  const listIds = PRICE_SCOPES.map((scope) => winners[scope]?.price_list_id).filter(
    (v): v is string => !!v,
  );
  if (!listIds.length) return NO_DOCUMENT_PRICING;

  const [{ data: items, error: itemsErr }, { data: lists, error: listsErr }] = await Promise.all([
    supabase
      .from("price_list_items")
      .select("id, price_list_id, catalog_item_id, unit_price")
      .in("price_list_id", listIds),
    supabase.from("price_lists").select("id, name").in("id", listIds),
  ]);
  if (itemsErr) throw itemsErr;
  if (listsErr) throw listsErr;

  const nameOf = new Map((lists ?? []).map((l) => [l.id, l.name]));
  return {
    book: buildPriceBook(assignments, (items ?? []) as PriceListItemRow[], ctx),
    // Customer first: it is the one that wins, and the one a person asks about.
    labels: listIds.map((id) => nameOf.get(id)).filter((n): n is string => !!n),
    nameOfList: nameOf,
  };
}

/* ----------------------------------------------------------------- import */

/**
 * "I should have an area somewhere where I could upload a price list."
 *
 * A price list arrives as a spreadsheet of two columns someone already keeps:
 * the item code and the agreed price. Matching on CODE rather than name is the
 * whole reason this works — codes are what the catalog and the customer's
 * sheet have in common, and a name differs by a space and a capital letter.
 *
 * Rows are reported one by one rather than the file being accepted or rejected
 * whole: a 200-line sheet with three unknown codes should import 197 lines and
 * tell someone about the three, not refuse everything and leave them to find
 * the typo. The caller decides whether to write the good rows.
 */
export interface PriceImportRow {
  line: number;
  code: string;
  catalog_item_id: string;
  unit_price: number;
}

export interface PriceImportProblem {
  line: number;
  text: string;
  reason: string;
}

export interface PriceImportResult {
  rows: PriceImportRow[];
  problems: PriceImportProblem[];
  /**
   * The header cells the code and price were read from, when the sheet had a
   * header we recognised. Null means the two-column positional reading — code
   * first, price second — which is how this import has always worked.
   */
  columns: { code: string; price: string } | null;
}

/** Split one CSV line, honouring "quoted, fields" and doubled "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === "\t") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * A money cell as people actually type it: `$1,250.00`, `1250`, `(80)` is not
 * accepted because a negative price is not a price. Returns null when the cell
 * is not a number, so the row can be reported rather than silently imported as
 * zero — a silent zero is the failure that puts free work on an invoice.
 */
export function parsePriceCell(text: string): number | null {
  const cleaned = text.replace(/[$\s,]/g, "");
  if (!cleaned || !/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

/* ------------------------------------------------------------ the header */

const headerNorm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Header words the code column answers to, in `headerNorm` form, most
 * specific first. A vendor sheet laid out Item | Code | Price uses "Item" for
 * the description, so a bare "Item" only counts when nothing says code.
 */
const CODE_HEADERS: readonly (readonly string[])[] = [
  [
    "code",
    "item code",
    "catalog code",
    "cat code",
    "product code",
    "xactimate code",
    "selector",
    "sku",
  ],
  ["item #", "item no", "item number", "part #", "part no", "part number"],
  ["item", "part"],
];

/**
 * How much a price header sounds like THE price for this customer. A vendor
 * sheet often carries a list price beside the agreed one, and the agreed one
 * is the reason the sheet was sent; reading the list price instead would
 * import every line, cleanly, at the wrong number.
 */
function priceHeaderRank(header: string): number {
  if (!/\b(price|rate|cost|amount)\b/.test(header)) return 0;
  if (/\b(contract|agreed|negotiated|net|your|special|customer|discount|discounted)\b/.test(header))
    return 3;
  if (/\b(list|msrp|retail|standard)\b/.test(header)) return 1;
  return 2;
}

/**
 * Which columns hold the code and the price, from a header row — or null when
 * this is not a header we recognise. Both have to be found: a row naming only
 * one of them is more likely a title or a note than a header.
 *
 * This is also the question the workbook reader asks of every row to find
 * where the headers are (`findHeaderRow`), so a spreadsheet and a paste agree
 * on what a header is. There is no second set of header rules anywhere.
 */
export function detectPriceColumns(
  cells: readonly string[],
): { code: number; price: number } | null {
  const names = cells.map((c) => headerNorm(c ?? ""));
  let code = -1;
  for (const tier of CODE_HEADERS) {
    code = names.findIndex((n) => tier.includes(n));
    if (code >= 0) break;
  }
  if (code < 0) return null;
  let price = -1;
  let best = 0;
  names.forEach((n, i) => {
    if (i === code) return;
    const rank = priceHeaderRank(n);
    if (rank > best) {
      best = rank;
      price = i;
    }
  });
  return price < 0 ? null : { code, price };
}

/**
 * Parse a pasted or uploaded price sheet against the catalog.
 *
 * `catalogByCode` is code (case-insensitively, trimmed) -> catalog item id.
 * The first line is skipped when it looks like a header rather than data —
 * "Code,Price" has no price in it, so the test is simply whether the second
 * cell parses as money. A sheet whose first row IS data is not lost to a
 * guess.
 *
 * When the first row IS a header we recognise (`detectPriceColumns`), the
 * code and price are read from the columns it names, in any order — a vendor
 * list is usually Code, Description, Unit, Price, not two tidy columns.
 * Otherwise it is the two-column reading it always was.
 *
 * A code repeated in the file keeps the LAST occurrence, matching the way a
 * person reads a list top to bottom and the way the database upsert behaves,
 * and the earlier one is reported so nobody is surprised.
 *
 * `firstLine` is the sheet row the text starts on. A workbook whose headers
 * sit on row 4 is handed over from row 4, and "line 7" should mean row 7 in
 * Excel, not the seventh line of text nobody can see.
 */
export function parsePriceListCsv(
  text: string,
  catalogByCode: ReadonlyMap<string, string>,
  opts: { firstLine?: number } = {},
): PriceImportResult {
  const rows: PriceImportRow[] = [];
  const problems: PriceImportProblem[] = [];
  const seen = new Map<string, number>();
  const offset = Math.max(1, Math.floor(opts.firstLine ?? 1));

  const lines = text.split(/\r\n|\r|\n/);
  const first = lines.findIndex((l) => l.trim());
  const headerCells = first >= 0 ? splitCsvLine(lines[first]!) : [];
  const header = first >= 0 ? detectPriceColumns(headerCells) : null;
  const codeAt = header?.code ?? 0;
  const priceAt = header?.price ?? 1;
  const columns = header
    ? { code: headerCells[codeAt] ?? "", price: headerCells[priceAt] ?? "" }
    : null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + offset;
    if (!raw.trim()) continue;
    if (i === first && header) continue;

    const cells = splitCsvLine(raw);
    const code = (cells[codeAt] ?? "").trim();
    const priceCell = (cells[priceAt] ?? "").trim();
    const price = parsePriceCell(priceCell);

    // A header line we did not recognise: the first row, with no usable
    // price. Skipped silently — nobody wants "line 1: Price is not a number"
    // on every import.
    if (i === first && price === null) continue;

    if (!code) {
      problems.push({
        line: lineNo,
        text: raw.trim(),
        reason: columns
          ? `No item code under "${columns.code}"`
          : "No item code in the first column",
      });
      continue;
    }
    if (price === null) {
      problems.push({
        line: lineNo,
        text: raw.trim(),
        reason: priceCell
          ? `"${priceCell}" is not a price`
          : columns
            ? `No price under "${columns.price}"`
            : "No price in the second column",
      });
      continue;
    }
    const catalogItemId = catalogByCode.get(code.toLowerCase());
    if (!catalogItemId) {
      problems.push({
        line: lineNo,
        text: raw.trim(),
        reason: `No catalog item with code "${code}"`,
      });
      continue;
    }

    const earlier = seen.get(catalogItemId);
    if (earlier !== undefined) {
      problems.push({
        line: earlier,
        text: code,
        reason: `Repeated later in the file; the price on line ${lineNo} is the one used`,
      });
      rows.splice(
        rows.findIndex((r) => r.catalog_item_id === catalogItemId),
        1,
      );
    }
    seen.set(catalogItemId, lineNo);
    rows.push({ line: lineNo, code, catalog_item_id: catalogItemId, unit_price: price });
  }

  return { rows, problems, columns };
}

/** code -> id, lowercased, for `parsePriceListCsv`. */
export function catalogCodeIndex(
  items: readonly { id: string; code: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const it of items) map.set(it.code.trim().toLowerCase(), it.id);
  return map;
}

/* ----------------------------------------------------------------- writes */

/**
 * Write an imported sheet onto a list. An upsert on the (list, item) unique
 * key, so re-uploading a corrected sheet updates the prices already there
 * instead of failing halfway or doubling them.
 */
export async function upsertPriceListItems(
  priceListId: string,
  rows: readonly { catalog_item_id: string; unit_price: number }[],
): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await supabase.from("price_list_items").upsert(
    rows.map((r) => ({
      price_list_id: priceListId,
      catalog_item_id: r.catalog_item_id,
      unit_price: r.unit_price,
    })),
    { onConflict: "price_list_id,catalog_item_id" },
  );
  if (error) throw error;
  return rows.length;
}
