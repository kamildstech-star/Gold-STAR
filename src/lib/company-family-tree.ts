import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { buildOrgTree, type HierarchyContact, type OrgNode } from "@/lib/company-hierarchy";

/**
 * A company's family: the parent company above it, its sister and child
 * companies, and the key people inside each one.
 *
 * David, 24 Sep, looking at the hierarchy card: "it's not going to show like a
 * tree, like an organizational chart, right? ... sometimes it could give
 * clarity." Preferred, not critical — so this is a second way of drawing what
 * is already stored (`accounts.parent_account_id` and the people's reporting
 * lines), never a second place to store it.
 *
 * Visibility is whatever RLS returns. A parent company the viewer may not read
 * simply is not fetched, and the tree roots at the highest company they can
 * see, flagged so the chart does not pretend that is the top.
 */

export interface FamilyCompany {
  id: string;
  name: string;
  parent_account_id: string | null;
  account_type: string | null;
  status: string | null;
}

export interface FamilyCompanyNode {
  company: FamilyCompany;
  depth: number;
  /** The top of each reporting line inside this company — its key people. */
  people: OrgNode[];
  /** Everyone at this company, at any depth under those key people. */
  peopleCount: number;
  children: FamilyCompanyNode[];
}

export interface FamilyTree {
  root: FamilyCompanyNode;
  /** The root has a parent the viewer cannot read. */
  hiddenAbove: boolean;
  /** Companies whose parent link loops. Drawn at the top level, never followed. */
  cycleIds: string[];
  /** The read stopped at MAX_COMPANIES; there are more branches than drawn. */
  truncated: boolean;
}

/** Ancestors to walk before giving up. Real portfolios are two or three deep. */
export const MAX_ANCESTOR_HOPS = 8;
/** Levels below the root, and companies in all, to read at most. */
export const MAX_DESCENDANT_DEPTH = 6;
export const MAX_COMPANIES = 200;

const COMPANY_SORT = (a: FamilyCompany, b: FamilyCompany) => a.name.localeCompare(b.name);

/**
 * Assemble the family from flat rows. Tolerant the same way `buildOrgTree` is:
 * a parent link that loops, or points at a company outside the set, never
 * stops the chart from drawing — the odd row becomes a branch of the root
 * rather than disappearing.
 */
export function buildFamilyTree(input: {
  companies: FamilyCompany[];
  people: (HierarchyContact & { account_id: string })[];
  rootId: string;
  hiddenAbove?: boolean;
  truncated?: boolean;
}): FamilyTree | null {
  const byId = new Map(input.companies.map((c) => [c.id, c]));
  const root = byId.get(input.rootId);
  if (!root) return null;

  const kids = new Map<string, FamilyCompany[]>();
  for (const c of input.companies) {
    if (c.id === root.id || !c.parent_account_id) continue;
    const list = kids.get(c.parent_account_id);
    if (list) list.push(c);
    else kids.set(c.parent_account_id, [c]);
  }

  const peopleBy = new Map<string, HierarchyContact[]>();
  for (const p of input.people) {
    const list = peopleBy.get(p.account_id);
    if (list) list.push(p);
    else peopleBy.set(p.account_id, [p]);
  }

  const placed = new Set<string>();
  const build = (c: FamilyCompany, depth: number): FamilyCompanyNode => {
    placed.add(c.id);
    const staff = peopleBy.get(c.id) ?? [];
    return {
      company: c,
      depth,
      people: buildOrgTree(staff).roots,
      peopleCount: staff.length,
      children: (kids.get(c.id) ?? [])
        .filter((k) => !placed.has(k.id))
        .sort(COMPANY_SORT)
        .map((k) => build(k, depth + 1)),
    };
  };
  const tree = build(root, 0);

  // Anything read but not reached from the root is in a loop (A -> B -> A) or
  // hangs off a company that is not in the set. Draw it, flagged, under the
  // root rather than dropping a company the viewer was allowed to see.
  const cycleIds: string[] = [];
  for (const c of [...input.companies].sort(COMPANY_SORT)) {
    if (placed.has(c.id)) continue;
    cycleIds.push(c.id);
    tree.children.push(build(c, 1));
  }

  return {
    root: tree,
    hiddenAbove: input.hiddenAbove ?? false,
    cycleIds,
    truncated: input.truncated ?? false,
  };
}

/** Every company in the family, depth first. */
export function familyCompanies(node: FamilyCompanyNode): FamilyCompanyNode[] {
  return [node, ...node.children.flatMap(familyCompanies)];
}

/** The ids from the root down to `targetId`, inclusive — what opens by default. */
export function pathTo(node: FamilyCompanyNode, targetId: string): string[] | null {
  if (node.company.id === targetId) return [node.company.id];
  for (const k of node.children) {
    const rest = pathTo(k, targetId);
    if (rest) return [node.company.id, ...rest];
  }
  return null;
}

/**
 * Would making `parentId` the parent of `accountId` loop? Asked before the
 * write so the picker refuses it in words, not with a chart that suddenly
 * draws a company under itself.
 */
export function wouldLoop(tree: FamilyTree, accountId: string, parentId: string): boolean {
  if (accountId === parentId) return true;
  const self = familyCompanies(tree.root).find((n) => n.company.id === accountId);
  if (!self) return false;
  return familyCompanies(self).some((n) => n.company.id === parentId);
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

const COMPANY_FIELDS = "id, name, parent_account_id, account_type, status";
// Name and position only. The chart is for seeing the shape of a customer; a
// phone number belongs on the account page, behind that page's own rules.
const PEOPLE_FIELDS =
  "id, account_id, full_name, title, position_key, reports_to_contact_id, is_primary";
const PEOPLE_FIELDS_LEGACY = "id, account_id, full_name, title, is_primary";

type PersonRow = HierarchyContact & { account_id: string };

async function readPeople(ids: string[]): Promise<PersonRow[]> {
  if (ids.length === 0) return [];
  const full = await supabase
    .from("contacts")
    .select(PEOPLE_FIELDS)
    .in("account_id", ids)
    .is("archived_at", null)
    .order("full_name");
  const shape = (rows: Record<string, unknown>[]): PersonRow[] =>
    rows.map((r) => ({
      ...(r as unknown as PersonRow),
      position_key: (r.position_key as string | null | undefined) ?? null,
      reports_to_contact_id: (r.reports_to_contact_id as string | null | undefined) ?? null,
      email: null,
      phone: null,
    }));
  if (!full.error) return shape((full.data ?? []) as unknown as Record<string, unknown>[]);
  if (!isMissingSchema(full.error)) throw full.error;
  const legacy = await supabase
    .from("contacts")
    .select(PEOPLE_FIELDS_LEGACY)
    .in("account_id", ids)
    .order("full_name");
  if (legacy.error) throw legacy.error;
  return shape((legacy.data ?? []) as unknown as Record<string, unknown>[]);
}

/**
 * Up to the top, then breadth-first down. Every read goes through the normal
 * client, so what comes back is exactly what this viewer's RLS allows.
 */
export async function fetchCompanyFamily(accountId: string): Promise<FamilyTree | null> {
  const companies = new Map<string, FamilyCompany>();

  const readOne = async (id: string) => {
    const { data, error } = await supabase
      .from("accounts")
      .select(COMPANY_FIELDS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as FamilyCompany | null;
  };

  const start = await readOne(accountId);
  if (!start) return null;
  companies.set(start.id, start);

  let root = start;
  let hiddenAbove = false;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && root.parent_account_id; hop++) {
    if (companies.has(root.parent_account_id)) break; // a loop: stop where we are
    const parent = await readOne(root.parent_account_id);
    if (!parent) {
      hiddenAbove = true;
      break;
    }
    companies.set(parent.id, parent);
    root = parent;
  }

  let frontier = [root.id];
  let truncated = false;
  for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && frontier.length > 0; depth++) {
    const { data, error } = await supabase
      .from("accounts")
      .select(COMPANY_FIELDS)
      .in("parent_account_id", frontier)
      .order("name")
      .limit(MAX_COMPANIES);
    if (error) throw error;
    const next: string[] = [];
    for (const c of (data ?? []) as FamilyCompany[]) {
      if (companies.has(c.id)) continue;
      if (companies.size >= MAX_COMPANIES) {
        truncated = true;
        break;
      }
      companies.set(c.id, c);
      next.push(c.id);
    }
    frontier = next;
  }

  const people = await readPeople([...companies.keys()]);
  return buildFamilyTree({
    companies: [...companies.values()],
    people,
    rootId: root.id,
    hiddenAbove,
    truncated,
  });
}

export async function setParentCompany(accountId: string, parentId: string | null): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update({ parent_account_id: parentId })
    .eq("id", accountId);
  if (error) throw error;
}
