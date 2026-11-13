// Photo folders inside a project.
//
// The constraint that matters: capture speed. A photo taken from the shutter
// lands at the project root with no prompt. Filing is an afterwards activity,
// done by whoever is putting the claim package together.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type PhotoFolder = Database["public"]["Tables"]["photo_folders"]["Row"];

export type FolderNode = PhotoFolder & { children: FolderNode[]; depth: number };

export async function listFolders(projectId: string): Promise<PhotoFolder[]> {
  const { data, error } = await supabase
    .from("photo_folders")
    .select("*")
    .eq("project_id", projectId)
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export function buildTree(folders: PhotoFolder[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) byId.set(f.id, { ...f, children: [], depth: 0 });
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_folder_id ? byId.get(node.parent_folder_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const stamp = (nodes: FolderNode[], depth: number) => {
    for (const n of nodes) {
      n.depth = depth;
      stamp(n.children, depth + 1);
    }
  };
  stamp(roots, 0);
  return roots;
}

/** Depth-first flatten, used for pickers and the sidebar list. */
export function flattenTree(nodes: FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (list: FolderNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function breadcrumbFor(folders: PhotoFolder[], folderId: string | null): PhotoFolder[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: PhotoFolder[] = [];
  let cur = byId.get(folderId) ?? null;
  let guard = 0;
  while (cur && guard++ < 20) {
    trail.unshift(cur);
    cur = cur.parent_folder_id ? (byId.get(cur.parent_folder_id) ?? null) : null;
  }
  return trail;
}

/** Ids of a folder and everything beneath it — folder views are inclusive. */
export function descendantIds(folders: PhotoFolder[], folderId: string): string[] {
  const kids = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parent_folder_id) continue;
    kids.set(f.parent_folder_id, [...(kids.get(f.parent_folder_id) ?? []), f.id]);
  }
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const c of kids.get(id) ?? []) walk(c);
  };
  walk(folderId);
  return out;
}

/**
 * A folder named by where it sits — "Unit 100 · Kitchen" for a Kitchen inside
 * a Unit 100 folder. This is the same string the Rooms tab prints for that
 * room, so a photo's room label and the room list agree; and two units'
 * kitchens stop reading as one place, which the bare folder name made them.
 */
export function folderPathLabel(
  folders: Pick<PhotoFolder, "id" | "name" | "parent_folder_id">[],
  folderId: string,
): string | null {
  const trail = breadcrumbFor(folders as PhotoFolder[], folderId);
  if (!trail.length) return null;
  return trail.map((f) => f.name.trim()).join(" · ");
}

/**
 * The folders worth showing when only filed photos matter — the job's Pictures
 * tab, where a template-made tree is mostly empty and the empty rows bury the
 * two rooms that have pictures in them.
 *
 * A folder is kept when it holds a photo, and so is every folder above it:
 * dropping a parent because it is empty itself would strand the child that is
 * not, and an unreachable folder is a lost photo. `pinned` keeps a folder on
 * its own account — the job's room folders, which are the places the crew is
 * about to file into and are not template clutter even while empty.
 */
export function foldersWithPhotos(
  folders: PhotoFolder[],
  counts: Record<string, number>,
  pinned: (f: PhotoFolder) => boolean = () => false,
): PhotoFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const keep = new Set<string>();
  for (const f of folders) {
    if (!counts[f.id] && !pinned(f)) continue;
    let cur: PhotoFolder | undefined = f;
    let guard = 0;
    while (cur && !keep.has(cur.id) && guard++ < 20) {
      keep.add(cur.id);
      cur = cur.parent_folder_id ? byId.get(cur.parent_folder_id) : undefined;
    }
  }
  return folders.filter((f) => keep.has(f.id));
}

export async function createFolder(input: {
  projectId: string;
  name: string;
  parentFolderId: string | null;
  userId: string | null;
  sortOrder?: number;
}): Promise<PhotoFolder> {
  const { data, error } = await supabase
    .from("photo_folders")
    .insert({
      project_id: input.projectId,
      name: input.name.trim(),
      parent_folder_id: input.parentFolderId,
      created_by: input.userId,
      sort_order: input.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("photo_folders").update({ name: name.trim() }).eq("id", id);
  if (error) throw error;
}

/**
 * Deleting a folder never deletes photos — they fall back to the project root.
 * Losing a photo is losing claim evidence.
 */
export async function deleteFolder(id: string): Promise<void> {
  const { error: photoErr } = await supabase
    .from("photos")
    .update({ folder_id: null })
    .eq("folder_id", id);
  if (photoErr) throw photoErr;
  const { error: childErr } = await supabase
    .from("photo_folders")
    .update({ parent_folder_id: null })
    .eq("parent_folder_id", id);
  if (childErr) throw childErr;
  const { error } = await supabase.from("photo_folders").delete().eq("id", id);
  if (error) throw error;
}

export async function movePhotos(photoIds: string[], folderId: string | null): Promise<void> {
  if (!photoIds.length) return;
  const { error } = await supabase
    .from("photos")
    .update({ folder_id: folderId })
    .in("id", photoIds);
  if (error) throw error;
}

// --- Folder templates -------------------------------------------------------
//
// A template is data, not code: a declarative tree plus the questions it needs
// answered. Every answer resolves to a list of strings and a `forEach` node
// expands into one folder per entry, so "Unit -> Floor -> Room" falls out of
// the same walker that applies a fixed tree. Nothing here is per-template
// logic, which is what makes moving these into an admin-managed table a change
// of source rather than a rewrite.
//
// Templates are never applied automatically. Offices differ on how they file a
// claim package, and a new album full of empty folders nobody asked for is
// worse than no folders at all.

export type TemplateNode = {
  /** Literal folder name. Ignored when `forEach` is set. */
  name?: string;
  /** Parameter key whose answers become this node's siblings. */
  forEach?: string;
  /** Written in front of each generated name, e.g. "Unit " + "101". */
  prefix?: string;
  children?: TemplateNode[];
};

export type TemplateParam = {
  key: string;
  label: string;
  /**
   * list  — designators, accepting both "100, 101" and the range "100-104"
   * count — a number, expanded to 1..n
   * names — free text, split on commas
   */
  kind: "list" | "count" | "names";
  placeholder: string;
  help?: string;
  required?: boolean;
  default?: string;
};

export type FolderTemplate = {
  id: string;
  name: string;
  description: string;
  params?: TemplateParam[];
  tree: TemplateNode[];
};

/** A `forEach`-free tree, ready to be written to the database. */
export type PlannedFolder = { name: string; children: PlannedFolder[] };

export type ExpandedTemplate = {
  nodes: PlannedFolder[];
  total: number;
  /** Top-level branches left out to stay under the cap. */
  omitted: number;
};

/**
 * A multifamily building can ask for thousands of folders from three short
 * answers. The cap keeps one typo from burying an album.
 */
export const TEMPLATE_FOLDER_CAP = 200;

/** Bound on a single answer, so a fat-fingered range never reaches the tree. */
const MAX_VALUES_PER_PARAM = 500;

export const FOLDER_TEMPLATES: FolderTemplate[] = [
  {
    id: "restoration-claim",
    name: "Restoration claim package",
    description: "Pre-mitigation through reconstruction — the standard claim narrative.",
    tree: [
      {
        name: "Pre-mitigation",
        children: [{ name: "Overview" }, { name: "Damage detail" }, { name: "Moisture readings" }],
      },
      {
        name: "Mitigation",
        children: [
          { name: "Demolition" },
          { name: "Equipment placement" },
          { name: "Daily readings" },
        ],
      },
      { name: "Reconstruction", children: [{ name: "In progress" }, { name: "Completed" }] },
      { name: "Contents" },
      { name: "Cause of loss" },
    ],
  },
  {
    id: "multifamily-building",
    name: "Multifamily building",
    description: "One branch per unit, optionally split by floor and by room.",
    params: [
      {
        key: "units",
        label: "Units",
        kind: "list",
        placeholder: "100, 101, 200-204",
        help: "Commas between units, a dash for a range. Letters carry: A1-A4.",
        required: true,
      },
      {
        key: "floors",
        label: "Floors per unit",
        kind: "count",
        placeholder: "2",
        help: "Leave blank for single-storey units.",
      },
      {
        key: "rooms",
        label: "Rooms per unit",
        kind: "names",
        placeholder: "Kitchen, Bathroom, Bedroom",
        help: "Leave blank to file by unit only.",
      },
    ],
    tree: [
      {
        forEach: "units",
        prefix: "Unit ",
        children: [{ forEach: "floors", prefix: "Floor ", children: [{ forEach: "rooms" }] }],
      },
    ],
  },
  {
    id: "by-room",
    name: "By room (single family)",
    description: "One folder per affected room.",
    params: [
      {
        key: "rooms",
        label: "Rooms",
        kind: "names",
        placeholder: "Kitchen, Bathroom",
        default: "Kitchen, Living room, Bathroom, Bedroom, Basement",
        required: true,
      },
    ],
    tree: [{ forEach: "rooms" }],
  },
  {
    id: "before-during-after",
    name: "Before / during / after",
    description: "Three folders, the order an adjuster reads a file in.",
    tree: [{ name: "Before" }, { name: "During" }, { name: "After" }],
  },
];

const RANGE = /^([A-Za-z]*)(\d+)\s*-\s*([A-Za-z]*)(\d+)$/;

/** "100-104" and "A1-A4" are inclusive ranges; anything else stays literal. */
function expandRange(token: string): string[] {
  const m = RANGE.exec(token);
  if (!m) return [token];
  const [, headA, startDigits, headB, endDigits] = m;
  // "A1-B4" spans two stacks and has no single meaning — leave it as typed.
  if (headA.toLowerCase() !== headB.toLowerCase()) return [token];
  let lo = Number(startDigits);
  let hi = Number(endDigits);
  if (lo > hi) [lo, hi] = [hi, lo];
  hi = Math.min(hi, lo + MAX_VALUES_PER_PARAM - 1);
  // "01-12" is a padded stack, "1-12" is not.
  const width = startDigits.startsWith("0") ? startDigits.length : 0;
  const out: string[] = [];
  for (let n = lo; n <= hi; n++) out.push(headA + String(n).padStart(width, "0"));
  return out;
}

/** Folder names collide case-insensitively, so answers dedupe the same way. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function parseTemplateValues(param: TemplateParam, raw: string): string[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (param.kind === "count") {
    const n = Math.floor(Number(text));
    if (!Number.isFinite(n) || n < 1) return [];
    return Array.from({ length: Math.min(n, MAX_VALUES_PER_PARAM) }, (_, i) => String(i + 1));
  }
  const tokens = text
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (param.kind === "names") return dedupe(tokens).slice(0, MAX_VALUES_PER_PARAM);
  const out: string[] = [];
  for (const token of tokens) {
    out.push(...expandRange(token));
    if (out.length >= MAX_VALUES_PER_PARAM) break;
  }
  return dedupe(out).slice(0, MAX_VALUES_PER_PARAM);
}

function resolveNodes(nodes: TemplateNode[], values: Record<string, string[]>): PlannedFolder[] {
  const out: PlannedFolder[] = [];
  for (const node of nodes) {
    const children = node.children ? resolveNodes(node.children, values) : [];
    if (node.forEach) {
      const list = values[node.forEach] ?? [];
      // An unanswered level disappears and its children move up a rung, so
      // leaving "floors" blank gives Unit -> Room instead of an empty tier.
      if (!list.length) {
        out.push(...children);
        continue;
      }
      for (const v of list) out.push({ name: (node.prefix ?? "") + v, children });
      continue;
    }
    if (node.name) out.push({ name: node.name, children });
  }
  return out;
}

function countFolders(nodes: PlannedFolder[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countFolders(node.children);
  return n;
}

/**
 * Pure, so the dialog can price a template before anyone commits to it.
 * `omitted` is reported rather than swallowed — a silently short tree reads as
 * a filing mistake later, when nobody remembers the cap.
 */
export function expandTemplate(
  template: FolderTemplate,
  answers: Record<string, string>,
): ExpandedTemplate {
  const values: Record<string, string[]> = {};
  for (const p of template.params ?? [])
    values[p.key] = parseTemplateValues(p, answers[p.key] ?? "");

  const branches = resolveNodes(template.tree, values);
  const nodes: PlannedFolder[] = [];
  let total = 0;
  for (const branch of branches) {
    // Whole branches are dropped, never half a unit.
    const size = countFolders([branch]);
    if (total + size > TEMPLATE_FOLDER_CAP) break;
    nodes.push(branch);
    total += size;
  }
  return { nodes, total, omitted: branches.length - nodes.length };
}

/**
 * Opt-in only, run by an admin from the folder rail. Names are matched within
 * their own parent at every depth, so applying a template into an album that
 * is already half filed merges into it instead of duplicating it.
 */
export async function applyFolderTemplate(
  projectId: string,
  nodes: PlannedFolder[],
  userId: string | null,
): Promise<number> {
  const existing = await listFolders(projectId);
  const key = (parentId: string | null, name: string) =>
    `${parentId ?? "root"}:${name.trim().toLowerCase()}`;
  const byKey = new Map(existing.map((f) => [key(f.parent_folder_id, f.name), f.id]));
  const siblings = new Map<string, number>();
  for (const f of existing) {
    const k = f.parent_folder_id ?? "root";
    siblings.set(k, (siblings.get(k) ?? 0) + 1);
  }

  let created = 0;
  const walk = async (list: PlannedFolder[], parentId: string | null) => {
    for (const node of list) {
      const name = node.name.trim();
      if (!name) continue;
      let id = byKey.get(key(parentId, name));
      if (!id) {
        const sk = parentId ?? "root";
        const order = siblings.get(sk) ?? 0;
        siblings.set(sk, order + 1);
        const row = await createFolder({
          projectId,
          name,
          parentFolderId: parentId,
          userId,
          sortOrder: order,
        });
        id = row.id;
        byKey.set(key(parentId, name), id);
        created++;
      }
      if (node.children.length) await walk(node.children, id);
    }
  };
  await walk(nodes, null);
  return created;
}
