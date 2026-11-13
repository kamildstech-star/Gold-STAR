import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { addressKey } from "@/lib/standing-notes";
import { optionsFrom, type ManagedOption } from "@/lib/managed-options";

/**
 * The hierarchy inside a customer company.
 *
 * Gold Star's customers are property managers, so a company is two structures
 * at once and the CRM has to hold both: the people (Owner/CEO -> Regional ->
 * Building Super, with Billing off to one side) and the buildings (the company
 * manages many, a Regional covers several, a Super runs one).
 *
 * The question this exists to answer is not "draw me a chart". It is: a pipe
 * burst at 12 Maple Avenue at 2am -- who runs THIS building, who is above them
 * when the super does not pick up, and who pays the invoice.
 *
 * Billing here is a POSITION, deliberately not a second answer to "who do we
 * invoice". The addressee of an invoice is jobs.bill_to_account_id (see
 * bill-to.ts) and stays there. This is the human at that company you ring about
 * a payment, which is a different fact and often a different person entirely.
 */

/* ------------------------------------------------------------------ */
/* Positions                                                           */
/* ------------------------------------------------------------------ */

/**
 * Fallback for the `contact_position` managed list -- the first render, and the
 * window before the migration is applied. The list in the database is the
 * source of truth and admin extends it without a deploy.
 */
export const CONTACT_POSITION_KEYS = [
  "owner_ceo",
  "executive",
  "regional",
  "asset_manager",
  "building_super",
  "maintenance",
  "billing",
  "admin_assistant",
  "other",
] as const;

/**
 * Guess someone's position in their company from the job title they typed.
 *
 * Positions were only ever settable after the fact, on the hierarchy panel, so
 * in practice almost nobody set one: 26 of 87 contacts had a position and not
 * one had a manager, which is why the org chart renders as a flat list. Asking
 * at the moment the contact is created is most of the fix; guessing from the
 * title they have already typed is the rest.
 *
 * These are the SAME rules, in the same order, as the backfill in migration
 * 20260903090000. Two different answers for one title -- one from the backfill,
 * one from this form -- would be worse than no guess at all. Order matters:
 * "regional billing manager" is billing, because whoever pays the invoice is
 * the more useful thing to know.
 *
 * It is only ever a suggestion. It fills an untouched field and never overrules
 * a person, and an unrecognised title returns null rather than a guess, which
 * shows as "No position" and is honest.
 */
const TITLE_RULES: { position: string; match: RegExp }[] = [
  {
    position: "billing",
    match: /billing|accounts payable|\ba\/?p\b|bookkeep|accounting|controller/i,
  },
  {
    position: "building_super",
    match: /superintendent|\bsuper\b|building manager|site manager|resident manager/i,
  },
  { position: "asset_manager", match: /asset/i },
  { position: "regional", match: /regional|district|portfolio manager/i },
  {
    position: "owner_ceo",
    match:
      /\bowner\b|\bceo\b|chief executive|\bpresident\b|\bprincipal\b|managing (member|partner)/i,
  },
  { position: "maintenance", match: /maintenance|facilit/i },
];

export function positionFromTitle(title: string | null | undefined): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  return TITLE_RULES.find((r) => r.match.test(t))?.position ?? null;
}

export const CONTACT_POSITION_LABEL: Record<string, string> = {
  owner_ceo: "Owner / CEO",
  executive: "Executive",
  regional: "Regional manager",
  asset_manager: "Asset manager",
  building_super: "Building super / manager",
  maintenance: "Maintenance",
  billing: "Billing / accounts payable",
  admin_assistant: "Office / admin",
  other: "Other",
};

export const CONTACT_POSITION_OPTIONS: ManagedOption[] = optionsFrom(
  CONTACT_POSITION_KEYS,
  CONTACT_POSITION_LABEL,
);

/**
 * Distance from the building, not seniority. It orders a site card so the
 * person who can open the door is first and the owner is last, and it orders
 * siblings in the chart so a company reads top-down.
 */
const POSITION_RANK: Record<string, number> = {
  building_super: 0,
  maintenance: 1,
  asset_manager: 2,
  regional: 3,
  executive: 4,
  owner_ceo: 5,
  admin_assistant: 6,
  billing: 7,
};

export function positionRank(key: string | null | undefined): number {
  if (!key) return 50;
  return POSITION_RANK[key] ?? 40;
}

/** The position that means "this person handles money", wherever we branch on it. */
export const BILLING_POSITION = "billing";

/* ------------------------------------------------------------------ */
/* The people tree                                                     */
/* ------------------------------------------------------------------ */

export interface HierarchyContact {
  id: string;
  full_name: string;
  title: string | null;
  position_key: string | null;
  reports_to_contact_id: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
}

export interface OrgNode {
  contact: HierarchyContact;
  depth: number;
  children: OrgNode[];
  /** Their manager is real but not in this set -- filtered out, or hidden by RLS. */
  detached: boolean;
  /** Their reporting line loops. Shown as a root, flagged, never followed. */
  inCycle: boolean;
}

export interface OrgTree {
  roots: OrgNode[];
  /** Ids whose chain loops. Non-empty means data the database should have refused. */
  cycleIds: string[];
}

const CONTACT_SORT = (a: HierarchyContact, b: HierarchyContact) =>
  positionRank(a.position_key) - positionRank(b.position_key) ||
  a.full_name.localeCompare(b.full_name);

/**
 * Walks upward from `startId` and reports whether the chain reaches `targetId`.
 * Every traversal in this file goes through here, because every one of them can
 * be handed a cycle: the database refuses new ones, but rows written before the
 * guard trigger existed are still in the table.
 */
function chainReaches(
  parentOf: (id: string) => string | null | undefined,
  startId: string | null | undefined,
  targetId: string,
  limit: number,
): boolean {
  let cur = startId ?? null;
  let hops = 0;
  const seen = new Set<string>();
  while (cur) {
    if (cur === targetId) return true;
    if (seen.has(cur) || ++hops > limit) return false;
    seen.add(cur);
    cur = parentOf(cur) ?? null;
  }
  return false;
}

/**
 * Assemble the reporting tree. Tolerant by design — a chart that refuses to
 * render because one row is odd is worse than a chart with one odd row in it:
 *  - no manager is normal (the CEO), and becomes a root;
 *  - a manager outside this set (RLS, a filter) becomes a root, flagged detached;
 *  - a loop becomes a root, flagged, and is never followed.
 */
export function buildOrgTree(rows: HierarchyContact[]): OrgTree {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parentOf = (id: string) => byId.get(id)?.reports_to_contact_id ?? null;
  const limit = rows.length + 1;

  const children = new Map<string, HierarchyContact[]>();
  const roots: HierarchyContact[] = [];
  const detached = new Set<string>();
  const cycleIds: string[] = [];

  for (const r of rows) {
    const mgr = r.reports_to_contact_id;
    if (!mgr || mgr === r.id) {
      if (mgr === r.id) cycleIds.push(r.id);
      roots.push(r);
      continue;
    }
    if (!byId.has(mgr)) {
      detached.add(r.id);
      roots.push(r);
      continue;
    }
    if (chainReaches(parentOf, mgr, r.id, limit)) {
      cycleIds.push(r.id);
      roots.push(r);
      continue;
    }
    const list = children.get(mgr);
    if (list) list.push(r);
    else children.set(mgr, [r]);
  }

  const cycleSet = new Set(cycleIds);
  const build = (c: HierarchyContact, depth: number): OrgNode => ({
    contact: c,
    depth,
    detached: detached.has(c.id),
    inCycle: cycleSet.has(c.id),
    children: (children.get(c.id) ?? []).sort(CONTACT_SORT).map((k) => build(k, depth + 1)),
  });

  return { roots: roots.sort(CONTACT_SORT).map((c) => build(c, 0)), cycleIds };
}

/** Depth-first order, for rendering as an indented list rather than a canvas. */
export function flattenOrgTree(nodes: OrgNode[]): OrgNode[] {
  return nodes.flatMap((n) => [n, ...flattenOrgTree(n.children)]);
}

/** Everybody under this person, at any depth. What a folded row stands in for. */
export function descendantCount(node: OrgNode): number {
  return node.children.reduce((n, k) => n + 1 + descendantCount(k), 0);
}

/**
 * The rows to draw when some people are folded away.
 *
 * A folded manager stays on screen -- they are the handle you unfold -- and
 * everyone beneath them goes, however deep. Flattening the whole company and
 * hiding rows afterwards would still pay for every row of a company with two
 * hundred people in it; this never walks the branch at all.
 */
export function visibleOrgNodes(nodes: OrgNode[], folded: ReadonlySet<string>): OrgNode[] {
  return nodes.flatMap((n) =>
    folded.has(n.contact.id) ? [n] : [n, ...visibleOrgNodes(n.children, folded)],
  );
}

/**
 * Would making `managerId` the manager of `contactId` create a loop? The same
 * question the database trigger answers — asked here so the picker never offers
 * a choice that is about to be rejected.
 */
export function wouldCycle(
  rows: HierarchyContact[],
  contactId: string,
  managerId: string | null | undefined,
): boolean {
  if (!managerId) return false;
  if (managerId === contactId) return true;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return chainReaches(
    (id) => byId.get(id)?.reports_to_contact_id ?? null,
    managerId,
    contactId,
    rows.length + 1,
  );
}

/**
 * Everyone at this company who may legally be named as this contact's manager.
 * Ordered most senior first — the opposite of a site card, because the answer
 * you are looking for in a manager picker is usually near the top of the chart.
 */
export function eligibleManagers(rows: HierarchyContact[], contactId: string): HierarchyContact[] {
  return rows
    .filter((r) => r.id !== contactId && !wouldCycle(rows, contactId, r.id))
    .sort(
      (a, b) =>
        positionRank(b.position_key) - positionRank(a.position_key) ||
        a.full_name.localeCompare(b.full_name),
    );
}

/**
 * The escalation path: immediate manager first, then theirs, up to the top.
 * This is the "they are not picking up" list.
 */
export function managerChain(
  rows: HierarchyContact[],
  contactId: string | null | undefined,
): HierarchyContact[] {
  if (!contactId) return [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: HierarchyContact[] = [];
  const seen = new Set<string>([contactId]);
  let cur = byId.get(contactId)?.reports_to_contact_id ?? null;
  while (cur && !seen.has(cur)) {
    const next = byId.get(cur);
    if (!next) break;
    out.push(next);
    seen.add(cur);
    cur = next.reports_to_contact_id;
  }
  return out;
}

/** Everyone holding the Billing position at this company. */
export function billingContacts(rows: HierarchyContact[]): HierarchyContact[] {
  return rows.filter((r) => r.position_key === BILLING_POSITION).sort(CONTACT_SORT);
}

/* ------------------------------------------------------------------ */
/* Who may know about which building                                   */
/* ------------------------------------------------------------------ */

/**
 * One person covering one building. Structural on purpose so the rules below
 * can be reasoned about — and tested — without a database row.
 */
export interface PropertyCover {
  property_id: string;
  contact_id: string;
  /** Their position AT THIS BUILDING. Null means use their company position. */
  position_key: string | null;
}

/** Their position at a building: the override if there is one, else company-wide. */
export function coverPosition(
  cover: PropertyCover,
  contact: HierarchyContact | undefined,
): string | null {
  return cover.position_key ?? contact?.position_key ?? null;
}

/** Everyone strictly beneath `contactId` in the reporting tree. */
export function subordinateIds(rows: HierarchyContact[], contactId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const r of rows) {
    const mgr = r.reports_to_contact_id;
    if (!mgr || mgr === r.id) continue;
    const list = children.get(mgr);
    if (list) list.push(r.id);
    else children.set(mgr, [r.id]);
  }
  const out = new Set<string>();
  // Iterative and seen-guarded: rows written before the guard trigger existed
  // can still contain a loop, and this must not be the thing that hangs.
  const queue = [...(children.get(contactId) ?? [])];
  while (queue.length) {
    const id = queue.pop()!;
    if (id === contactId || out.has(id)) continue;
    out.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}

export type PropertyScopeReason =
  /** Assigned to these buildings themselves. */
  | "assigned"
  /** Sees them only because the people under them run them. */
  | "through_reports"
  /** Accounts payable for the company, so every building. */
  | "company_billing"
  /** Nothing of their own; they cover what the person they report to runs. */
  | "through_manager"
  /** Runs nothing and nobody: they know about no building in particular. */
  | "none";

export interface PropertyScope {
  /** Every building this person may be told about. */
  propertyIds: string[];
  /** The subset they run themselves. */
  ownIds: string[];
  /** True when the answer is "the company", not a list. */
  companyWide: boolean;
  reason: PropertyScopeReason;
  /**
   * Buildings that are theirs only because of who they report to. A subset of
   * `propertyIds`, never of `ownIds`, so the panel can say where each one came
   * from rather than presenting borrowed cover as an assignment.
   */
  inheritedIds: string[];
}

/**
 * Which buildings a person at the customer's company may be told about.
 *
 * The client's rule, in their words: "this guy works specifically for this
 * building; when it comes to the next building he has no idea it exists.
 * However the person above him knows about these two buildings but not the
 * other two." So visibility is the reporting tree read downward — your own
 * buildings, plus every building run by anyone beneath you — and nothing else.
 * An Owner/CEO ends up seeing everything not by exception but because the
 * whole company reports up to them.
 *
 * The one branch: a company-level accounts-payable contact — Billing position,
 * not tied to any one building — covers the company, so they see every
 * building. A Billing contact who IS tied to a building bills for that
 * building only, which is the other half of what the client described.
 *
 * This decides what paperwork may be sent to whom. It is the internal answer
 * today and the gate a client portal would sit behind, so it is stated once,
 * here, and never re-derived at a call site.
 */
export function propertyScope(input: {
  people: HierarchyContact[];
  covers: PropertyCover[];
  allPropertyIds: string[];
  contactId: string;
}): PropertyScope {
  const { people, covers, allPropertyIds, contactId } = input;
  const me = people.find((p) => p.id === contactId);

  const own = new Set<string>();
  const assignedAnywhere = new Set<string>();
  for (const c of covers) {
    assignedAnywhere.add(c.contact_id);
    if (c.contact_id === contactId) own.add(c.property_id);
  }

  if (me?.position_key === BILLING_POSITION && !assignedAnywhere.has(contactId)) {
    const all = [...new Set(allPropertyIds)];
    return {
      propertyIds: all,
      ownIds: [],
      companyWide: true,
      reason: "company_billing",
      inheritedIds: [],
    };
  }

  const below = subordinateIds(people, contactId);
  const fromReports = new Set<string>();
  for (const c of covers) {
    if (below.has(c.contact_id)) fromReports.add(c.property_id);
  }

  /*
   * Mark, 2026-09-09: "when someone is reporting to someone they need to be
   * assigned the same buildings."
   *
   * A super put under a regional who runs one building was showing "No building
   * yet. Assign one below before sending them site paperwork" -- true, and
   * useless, because the building they work at is the one their manager runs
   * and somebody would have to type it in twice.
   *
   * So somebody with NO building of their own covers what the people above
   * them run. Once they are assigned a building themselves, that is the answer
   * and nothing is borrowed: a super who runs Maple Court does not thereby see
   * their regional's other forty sites. That condition is what keeps this from
   * contradicting the rule the rest of this function implements, which the
   * client stated as "when it comes to the next building he has no idea it
   * exists".
   *
   * It is computed, never written. Nothing here creates an assignment row, so
   * removing the reporting line removes the cover with it.
   */
  const fromManagers = new Set<string>();
  if (own.size === 0) {
    const above = new Set(managerChain(people, contactId).map((m) => m.id));
    for (const c of covers) {
      if (above.has(c.contact_id)) fromManagers.add(c.property_id);
    }
  }

  const inherited = new Set([...fromReports, ...fromManagers]);
  const all = [...new Set([...own, ...inherited])];
  return {
    propertyIds: all,
    ownIds: [...own],
    companyWide: false,
    inheritedIds: [...inherited],
    reason:
      own.size > 0
        ? "assigned"
        : fromReports.size > 0
          ? "through_reports"
          : fromManagers.size > 0
            ? "through_manager"
            : "none",
  };
}

/** May this person be told about this building at all? */
export function canSeeProperty(scope: PropertyScope, propertyId: string): boolean {
  return scope.companyWide || scope.propertyIds.includes(propertyId);
}

export type BillingLevel = "asset" | "company" | "none";

export interface BillingResolution {
  contacts: HierarchyContact[];
  /**
   * Where the answer came from. "asset" means this building bills its own and
   * the company's accounts-payable contact is NOT the person to ring.
   */
  level: BillingLevel;
}

/**
 * Who to ring about money for one building.
 *
 * The client: sometimes one accounts-payable contact covers the whole company,
 * and sometimes each building bills its own. So a building's own AP contact
 * wins outright when there is one, and the company's answers otherwise — never
 * both, because showing both is how an invoice question reaches the wrong desk.
 *
 * "Company AP" means a Billing contact tied to no building at all. Somebody
 * who does the billing for one building is that building's, not the company's,
 * and must never be offered as the fallback for a different building.
 *
 * This is not the invoice addressee. That is jobs.bill_to_account_id.
 */
export function resolveBilling(input: {
  people: HierarchyContact[];
  /** Every cover row in play — at minimum, all rows for every Billing contact. */
  covers: PropertyCover[];
  propertyId: string | null;
}): BillingResolution {
  const { people, covers, propertyId } = input;
  const byId = new Map(people.map((p) => [p.id, p]));

  if (propertyId) {
    const seen = new Set<string>();
    const here = covers
      .filter(
        (c) =>
          c.property_id === propertyId &&
          coverPosition(c, byId.get(c.contact_id)) === BILLING_POSITION,
      )
      .flatMap((c) => {
        const contact = byId.get(c.contact_id);
        if (!contact || seen.has(contact.id)) return [];
        seen.add(contact.id);
        return [contact];
      })
      .sort(CONTACT_SORT);
    if (here.length > 0) return { contacts: here, level: "asset" };
  }

  const tied = new Set(covers.map((c) => c.contact_id));
  const company = billingContacts(people).filter((c) => !tied.has(c.id));
  return company.length > 0
    ? { contacts: company, level: "company" }
    : { contacts: [], level: "none" };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const PEOPLE_FIELDS =
  "id, full_name, title, position_key, reports_to_contact_id, email, phone, is_primary";
const PEOPLE_FIELDS_LEGACY = "id, full_name, title, email, phone, is_primary";

/**
 * `available: false` means the migration has not been applied yet and the panel
 * must say so. Anything else throws.
 *
 * A failed read must never surface as an empty chart. "This building has no
 * manager" and "we could not read who manages this building" send a rep to
 * opposite actions at 2am, and only one of them is recoverable.
 */
export interface HierarchyRead {
  rows: HierarchyContact[];
  available: boolean;
}

export async function fetchCompanyPeople(accountId: string): Promise<HierarchyRead> {
  const { data, error } = await supabase
    .from("contacts")
    .select(PEOPLE_FIELDS)
    .eq("account_id", accountId)
    .order("full_name");
  if (!error) {
    return { rows: (data ?? []) as unknown as HierarchyContact[], available: true };
  }
  if (!isMissingSchema(error)) throw error;

  // Pre-migration: the people are real, the hierarchy is not there yet. Return
  // the contacts so the panel can list them flat and say why it is flat.
  const legacy = await supabase
    .from("contacts")
    .select(PEOPLE_FIELDS_LEGACY)
    .eq("account_id", accountId)
    .order("full_name");
  if (legacy.error) throw legacy.error;
  return {
    rows: (legacy.data ?? []).map((r) => ({
      ...(r as unknown as Omit<HierarchyContact, "position_key" | "reports_to_contact_id">),
      position_key: null,
      reports_to_contact_id: null,
    })),
    available: false,
  };
}

export interface AccountProperty {
  id: string;
  account_id: string;
  name: string | null;
  address: string;
  address_key: string;
  notes: string | null;
  active: boolean;
}

const PROPERTY_FIELDS = "id, account_id, name, address, address_key, notes, active";

export async function fetchAccountProperties(
  accountId: string,
): Promise<{ rows: AccountProperty[]; available: boolean }> {
  const { data, error } = await supabase
    .from("account_properties")
    .select(PROPERTY_FIELDS)
    .eq("account_id", accountId)
    .order("name")
    .order("address");
  if (error) {
    if (isMissingSchema(error)) return { rows: [], available: false };
    throw error;
  }
  return { rows: (data ?? []) as unknown as AccountProperty[], available: true };
}

/** The buildings these ids name, for a person's building chip (D2). */
export async function fetchPropertiesByIds(ids: string[]): Promise<AccountProperty[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("account_properties")
    .select(PROPERTY_FIELDS)
    .in("id", ids);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []) as unknown as AccountProperty[];
}

export interface PropertyAssignment extends PropertyCover {
  id: string;
  sort_order: number;
}

export async function fetchPropertyAssignments(
  propertyIds: string[],
): Promise<{ rows: PropertyAssignment[]; available: boolean }> {
  if (propertyIds.length === 0) return { rows: [], available: true };
  const { data, error } = await supabase
    .from("account_property_contacts")
    .select("id, property_id, contact_id, position_key, sort_order")
    .in("property_id", propertyIds);
  if (error) {
    if (isMissingSchema(error)) return { rows: [], available: false };
    throw error;
  }
  return { rows: (data ?? []) as unknown as PropertyAssignment[], available: true };
}

/**
 * Every building assignment these people hold, anywhere in their company.
 *
 * Asked from the other end than fetchPropertyAssignments: not "who covers this
 * building" but "is this person tied to a building at all", which is the
 * question that separates the company's accounts-payable contact from one
 * building's.
 */
export async function fetchContactCovers(
  contactIds: string[],
): Promise<{ rows: PropertyCover[]; available: boolean }> {
  if (contactIds.length === 0) return { rows: [], available: true };
  const { data, error } = await supabase
    .from("account_property_contacts")
    .select("property_id, contact_id, position_key")
    .in("contact_id", contactIds);
  if (error) {
    if (isMissingSchema(error)) return { rows: [], available: false };
    throw error;
  }
  return { rows: (data ?? []) as unknown as PropertyCover[], available: true };
}

/* ------------------------------------------------------------------ */
/* From a job, at 2am                                                  */
/* ------------------------------------------------------------------ */

export interface SiteContact {
  contact: HierarchyContact;
  /** Position for this building, which may differ from their company position. */
  positionKey: string | null;
  /**
   * True when they are here because of who they report to, not because anyone
   * assigned them. The card says so: a name nobody recorded against this
   * building should not look like one somebody did.
   */
  inherited: boolean;
}

export interface SiteEscalation {
  property: AccountProperty | null;
  /** Assigned to this building, closest to the door first. */
  onSite: SiteContact[];
  /** Up the reporting line from the first on-site person. */
  escalation: HierarchyContact[];
  /** Who to ring about a payment. Not the invoice addressee — see bill-to.ts. */
  billing: HierarchyContact[];
  /** Whether that answer is this building's own AP contact or the company's. */
  billingLevel: BillingLevel;
  /** False when the hierarchy migration has not been applied yet. */
  available: boolean;
}

/**
 * Everything the person standing in the water needs, from a job's own address
 * and account. Matching is on the folded address key, the same identity
 * property_notes has used since 20260818180528, so a building the office
 * already left a property note on is the building found here.
 */
export async function resolveSiteEscalation(input: {
  accountId: string | null | undefined;
  address: string | null | undefined;
}): Promise<SiteEscalation> {
  const empty: SiteEscalation = {
    property: null,
    onSite: [],
    escalation: [],
    billing: [],
    billingLevel: "none",
    available: true,
  };
  if (!input.accountId) return empty;

  const people = await fetchCompanyPeople(input.accountId);
  if (!people.available) return { ...empty, available: false };
  const byId = new Map(people.rows.map((r) => [r.id, r]));

  /* Every building the company's Billing people are tied to, so a contact who
     does the books for one building is never offered as the company's answer
     for another. Read once and reused for both branches below. */
  const billingCovers = await fetchContactCovers(billingContacts(people.rows).map((c) => c.id));
  const companyBilling = resolveBilling({
    people: people.rows,
    covers: billingCovers.rows,
    propertyId: null,
  });
  const withCompanyBilling = {
    ...empty,
    billing: companyBilling.contacts,
    billingLevel: companyBilling.level,
  };

  const key = addressKey(input.address);
  if (!key) return withCompanyBilling;

  const props = await supabase
    .from("account_properties")
    .select(PROPERTY_FIELDS)
    .eq("account_id", input.accountId)
    .eq("address_key", key)
    .maybeSingle();
  if (props.error) {
    if (isMissingSchema(props.error)) return { ...withCompanyBilling, available: false };
    throw props.error;
  }
  const property = (props.data as unknown as AccountProperty | null) ?? null;
  if (!property) return withCompanyBilling;

  const assigned = await fetchPropertyAssignments([property.id]);
  if (!assigned.available) {
    return { ...withCompanyBilling, property, available: false };
  }

  /* This building's own AP contact beats the company's, which is the whole
     point of billing attaching at either level. */
  const billingHere = resolveBilling({
    people: people.rows,
    covers: [...assigned.rows, ...billingCovers.rows],
    propertyId: property.id,
  });

  const explicit: SiteContact[] = assigned.rows.flatMap((a) => {
    const contact = byId.get(a.contact_id);
    // A contact we cannot read is not a contact we can call. Dropping it is
    // right; showing a blank row that looks callable is not.
    return contact
      ? [{ contact, positionKey: a.position_key ?? contact.position_key, inherited: false }]
      : [];
  });

  /*
   * The people who cover this building through the person who runs it.
   *
   * A super put under the regional who runs a building has no assignment row of
   * their own, and until now that meant the 2am card listed the regional and
   * not the super actually standing at the door. The account panel already
   * showed the super covering it; this is the same answer reaching the place it
   * was for.
   *
   * `propertyScope` is asked rather than re-derived, so the card and the panel
   * cannot drift: the same guard applies, and somebody who runs a building of
   * their own borrows nothing.
   */
  const allCovers = await fetchContactCovers(people.rows.map((r) => r.id));
  const named = new Set(explicit.map((s) => s.contact.id));
  const borrowed: SiteContact[] = allCovers.available
    ? people.rows.flatMap((person) => {
        if (named.has(person.id)) return [];
        const scope = propertyScope({
          people: people.rows,
          covers: allCovers.rows,
          allPropertyIds: [property.id],
          contactId: person.id,
        });
        return scope.inheritedIds.includes(property.id)
          ? [{ contact: person, positionKey: person.position_key, inherited: true }]
          : [];
      })
    : [];

  const onSite: SiteContact[] = [...explicit, ...borrowed].sort(
    (a, b) =>
      positionRank(a.positionKey) - positionRank(b.positionKey) ||
      // At the same distance from the door, the person somebody actually
      // recorded goes first.
      Number(a.inherited) - Number(b.inherited) ||
      a.contact.full_name.localeCompare(b.contact.full_name),
  );

  const first = onSite[0]?.contact.id ?? null;
  const escalation = managerChain(people.rows, first).filter(
    (m) => !onSite.some((s) => s.contact.id === m.id),
  );

  return {
    property,
    onSite,
    escalation,
    billing: billingHere.contacts,
    billingLevel: billingHere.level,
    available: true,
  };
}
