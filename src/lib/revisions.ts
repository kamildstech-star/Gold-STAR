import type { Json } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";

/**
 * Versioning for estimates and invoices.
 *
 * A revision is a full snapshot of the document — header, scopes and lines —
 * kept against a version number. The top revision stays editable and tracks the
 * live record. The moment a version is sent, downloaded or printed for a
 * recipient it is **frozen**: the database refuses any further change to that
 * snapshot, and the stored PDF is the exact file the recipient holds. The next
 * edit opens v2, so a correction never rewrites history.
 */

export type RevKind = "estimate" | "invoice";

export interface RevisionLine {
  id: string;
  scope_id: string | null;
  position: number;
  code: string | null;
  name: string;
  description: string | null;
  uom: string;
  quantity: number;
  unit_price: number;
  taxable: boolean;
  is_discount: boolean;
  subtotal: number | null;
}

export interface RevisionSnapshot {
  header: Record<string, Json | undefined>;
  scopes: { id: string; name: string; room_name: string | null; position: number }[];
  lines: RevisionLine[];
  subtotal: number;
  tax: number;
  total: number;
}

export interface Revision {
  id: string;
  kind: RevKind;
  record_id: string;
  location_id: string | null;
  version: number;
  total: number;
  snapshot: RevisionSnapshot;
  change_summary: string | null;
  frozen: boolean;
  frozen_at: string | null;
  document_id: string | null;
  created_by: string | null;
  created_at: string;
  sends?: RevisionSend[];
}

export interface RevisionSend {
  id: string;
  revision_id: string;
  recipient: string | null;
  channel: string;
  note: string | null;
  sent_by: string | null;
  sent_at: string;
}

const CFG = {
  estimate: {
    table: "estimates",
    scopes: "estimate_scopes",
    lines: "estimate_lines",
    fk: "estimate_id",
    header:
      "id, seq, status, title, estimate_date, job_id, job_number, customer_name, account_id, address, locality, region, postal_code, office_name, tax_rate, notes, subtotal, tax, total, location_id, current_version",
  },
  invoice: {
    table: "invoices",
    scopes: "invoice_scopes",
    lines: "invoice_lines",
    fk: "invoice_id",
    header:
      "id, invoice_number, status, title, issue_date, due_date, job_id, job_number, customer_name, account_id, carrier, claim_number, address, locality, region, postal_code, office_name, tax_rate, notes, subtotal, tax, total, billed_amount, line_itemized, location_id, current_version, estimate_id, source_estimate_version",
  },
} as const;

/** `GS-INV-2026-00001 v2` — the label the office quotes back to an adjuster. */
export function versionLabel(version: number) {
  return `v${version}`;
}

async function buildSnapshot(kind: RevKind, id: string) {
  const scopeFields = "id, name, room_name, position";
  const lineFields =
    "id, scope_id, position, code, name, description, uom, quantity, unit_price, taxable, is_discount, subtotal";
  const [header, scopes, lines] =
    kind === "estimate"
      ? await Promise.all([
          supabase.from("estimates").select(CFG.estimate.header).eq("id", id).single(),
          supabase
            .from("estimate_scopes")
            .select(scopeFields)
            .eq("estimate_id", id)
            .order("position"),
          supabase
            .from("estimate_lines")
            .select(lineFields)
            .eq("estimate_id", id)
            .order("position"),
        ])
      : await Promise.all([
          supabase.from("invoices").select(CFG.invoice.header).eq("id", id).single(),
          supabase
            .from("invoice_scopes")
            .select(scopeFields)
            .eq("invoice_id", id)
            .order("position"),
          supabase.from("invoice_lines").select(lineFields).eq("invoice_id", id).order("position"),
        ]);
  if (header.error) throw header.error;
  if (scopes.error) throw scopes.error;
  if (lines.error) throw lines.error;

  const h = header.data;
  const total = Number(
    kind === "invoice"
      ? (("billed_amount" in h ? h.billed_amount : null) ?? h.total ?? 0)
      : (h.total ?? 0),
  );
  const snapshot: RevisionSnapshot = {
    header: h,
    scopes: scopes.data ?? [],
    lines: lines.data ?? [],
    subtotal: Number(h.subtotal ?? 0),
    tax: Number(h.tax ?? 0),
    total,
  };
  return { snapshot, total, locationId: h.location_id as string | null };
}

export async function listRevisions(kind: RevKind, recordId: string): Promise<Revision[]> {
  const { data, error } = await supabase
    .from("record_revisions")
    .select("*, sends:record_revision_sends(*)")
    .eq("kind", kind)
    .eq("record_id", recordId)
    .order("version", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as Revision[];
}

/**
 * Brings the working version in line with the record as it stands now. If the
 * newest version has already gone out, this opens the next one instead of
 * touching the frozen snapshot — that is the whole point of the feature.
 */
export async function syncDraftRevision(kind: RevKind, recordId: string): Promise<Revision | null> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;
  if (!userId) return null;

  const { snapshot, total, locationId } = await buildSnapshot(kind, recordId);

  const { data: top, error: topErr } = await supabase
    .from("record_revisions")
    .select("*")
    .eq("kind", kind)
    .eq("record_id", recordId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (topErr) throw topErr;

  if (top && !top.frozen) {
    const { data, error } = await supabase
      .from("record_revisions")
      .update({
        snapshot: { ...snapshot, lines: snapshot.lines.map((line) => ({ ...line })) },
        total,
        location_id: locationId,
      })
      .eq("id", top.id)
      .select("*")
      .single();
    if (error) throw error;
    return data as unknown as Revision;
  }

  const version = (top?.version ?? 0) + 1;
  const summary = top
    ? summariseDiff(diffRevisions(top.snapshot as unknown as RevisionSnapshot, snapshot))
    : null;
  const { data, error } = await supabase
    .from("record_revisions")
    .insert({
      kind,
      record_id: recordId,
      location_id: locationId,
      version,
      total,
      snapshot: { ...snapshot, lines: snapshot.lines.map((line) => ({ ...line })) },
      change_summary: summary,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw error;

  await supabase.from(CFG[kind].table).update({ current_version: version }).eq("id", recordId);
  return data as unknown as Revision;
}

/**
 * Freezes the working version because it just went to someone, and records who
 * received which version. `documentId` is the stored PDF — the frozen file.
 */
export async function freezeAndLogSend(
  kind: RevKind,
  recordId: string,
  opts: { documentId?: string | null; recipient?: string | null; channel: string; note?: string },
) {
  const rev = await syncDraftRevision(kind, recordId);
  if (!rev) return null;
  const { data: auth } = await supabase.auth.getUser();

  if (!rev.frozen) {
    const { error } = await supabase
      .from("record_revisions")
      .update({ frozen: true, document_id: opts.documentId ?? rev.document_id ?? null })
      .eq("id", rev.id);
    if (error) throw error;
  } else if (opts.documentId && !rev.document_id) {
    await supabase
      .from("record_revisions")
      .update({ document_id: opts.documentId })
      .eq("id", rev.id);
  }

  await supabase.from("record_revision_sends").insert({
    revision_id: rev.id,
    recipient: opts.recipient ?? null,
    channel: opts.channel,
    note: opts.note ?? null,
    sent_by: auth.user?.id ?? null,
  });
  return rev;
}

/* ------------------------------------------------------------------ diffing */

export interface LineDiff {
  kind: "added" | "removed" | "changed";
  name: string;
  before?: RevisionLine;
  after?: RevisionLine;
  fields?: string[];
  delta: number;
}

export interface RevisionDiff {
  lines: LineDiff[];
  totalBefore: number;
  totalAfter: number;
  delta: number;
}

const lineKey = (l: RevisionLine) => l.id || `${l.code ?? ""}|${l.name}`;
const NUM = (v: unknown) => Number(v ?? 0);

/** Line-level diff so "why did the amount change?" has a precise answer. */
export function diffRevisions(
  before: RevisionSnapshot | null,
  after: RevisionSnapshot,
): RevisionDiff {
  const beforeLines = before?.lines ?? [];
  const prev = new Map(beforeLines.map((l) => [lineKey(l), l]));
  const diffs: LineDiff[] = [];

  for (const l of after.lines) {
    const p = prev.get(lineKey(l));
    if (!p) {
      diffs.push({ kind: "added", name: l.name, after: l, delta: NUM(l.subtotal) });
      continue;
    }
    prev.delete(lineKey(l));
    const fields: string[] = [];
    if (NUM(p.quantity) !== NUM(l.quantity)) fields.push("quantity");
    if (NUM(p.unit_price) !== NUM(l.unit_price)) fields.push("rate");
    if ((p.name ?? "") !== (l.name ?? "")) fields.push("name");
    if ((p.description ?? "") !== (l.description ?? "")) fields.push("description");
    if (!!p.taxable !== !!l.taxable) fields.push("taxable");
    if (fields.length) {
      diffs.push({
        kind: "changed",
        name: l.name,
        before: p,
        after: l,
        fields,
        delta: NUM(l.subtotal) - NUM(p.subtotal),
      });
    }
  }
  for (const p of prev.values()) {
    diffs.push({ kind: "removed", name: p.name, before: p, delta: -NUM(p.subtotal) });
  }

  const totalBefore = NUM(before?.total);
  const totalAfter = NUM(after.total);
  return { lines: diffs, totalBefore, totalAfter, delta: totalAfter - totalBefore };
}

export function summariseDiff(d: RevisionDiff) {
  const added = d.lines.filter((l) => l.kind === "added").length;
  const removed = d.lines.filter((l) => l.kind === "removed").length;
  const changed = d.lines.filter((l) => l.kind === "changed").length;
  const parts: string[] = [];
  if (added) parts.push(`${added} line${added > 1 ? "s" : ""} added`);
  if (removed) parts.push(`${removed} line${removed > 1 ? "s" : ""} removed`);
  if (changed) parts.push(`${changed} line${changed > 1 ? "s" : ""} changed`);
  if (d.delta) parts.push(`total ${d.delta > 0 ? "+" : "−"}$${Math.abs(d.delta).toFixed(2)}`);
  return parts.join(" · ") || "No line changes";
}
