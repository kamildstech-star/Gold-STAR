/**
 * Proposals on a pipeline card.
 *
 * Mark: "Is there a way to make something in the pipeline a proposal?" A
 * proposal is a title, a contract template, priced lines and a status that
 * runs draft -> sent -> signed | declined | expired. Sending it for signature
 * reuses the Documents panel's own path (a `documents` row from the template,
 * a `document_send_packets` link, the /sign/$token page); the database moves
 * the card when it is sent and when it is signed (migration 20261012200000).
 *
 * The rules that decide anything live in the database — line totals are a
 * generated column, the total is recomputed from the lines, the lifecycle and
 * the stage move are triggers. The copies here (`lineTotal`,
 * `proposalTotals`, `canTransition`, `proposalStageMove`) exist so the dialog
 * can show the same answer before it asks, and the tests hold the two to the
 * same cases. If they ever disagree the database wins.
 *
 * Until the migration is applied and types.ts regenerated, the tables are read
 * untyped and a missing table reads as "not available yet", never as an error
 * on the page — the same arrangement as src/lib/tm-forms.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { renderTemplate, type MergeData } from "@/lib/document-templates";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { TONE } from "@/lib/tone";
const db = () => supabase as unknown as SupabaseClient;

/* ------------------------------------------------------------- lifecycle */

export const PROPOSAL_STATUSES = ["draft", "sent", "signed", "declined", "expired"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  signed: "Signed",
  declined: "Declined",
  expired: "Expired",
};

/** Badge classes, in the tones the packet states already use. */
export const PROPOSAL_STATUS_TONE: Record<ProposalStatus, string> = {
  draft: TONE.neutral,
  sent: TONE.warning,
  signed: TONE.success,
  declined: TONE.danger,
  expired: TONE.neutral,
};

/** Where each status may go next. The guard trigger enforces the same map. */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  draft: ["sent"],
  sent: ["signed", "declined", "expired"],
  signed: [],
  declined: [],
  expired: [],
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/** Only a draft is edited. Once it has gone out, a changed offer is a new proposal. */
export function isEditable(status: ProposalStatus): boolean {
  return status === "draft";
}

/* ------------------------------------------------------------------ money */

/** Half away from zero, the way numeric's round() goes. */
function roundHalfAway(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** Cents, the way numeric(…,2) stores a value. */
function cents(n: number): number {
  return Number.isFinite(n) ? roundHalfAway(n * 100) : 0;
}

function lineTotalCents(quantity: number, unitPrice: number): number {
  // Integer cents times integer cents is exact; one rounding, as round(q * p, 2).
  return roundHalfAway((cents(quantity) * cents(unitPrice)) / 100);
}

/**
 * quantity x unit price, exactly as the generated column computes it: both
 * stored to the cent first (numeric(12,2) and numeric(14,2)), then the product
 * rounded to the cent.
 */
export function lineTotal(quantity: number, unitPrice: number): number {
  return lineTotalCents(quantity, unitPrice) / 100;
}

export type ProposalLine = {
  description: string;
  quantity: number;
  unit_price: number;
};

/** Subtotal is the sum of the lines; total equals it until a tax or discount exists. */
export function proposalTotals(lines: readonly ProposalLine[]): {
  subtotal: number;
  total: number;
} {
  const sum = lines.reduce((acc, l) => acc + lineTotalCents(l.quantity, l.unit_price), 0);
  return { subtotal: sum / 100, total: sum / 100 };
}

export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** A line as the form holds it: what was typed, not yet numbers. */
export type ProposalLineDraft = {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
};

let lineSeq = 0;
export function blankLine(): ProposalLineDraft {
  lineSeq += 1;
  return { key: `line-${Date.now()}-${lineSeq}`, description: "", quantity: "1", unitPrice: "" };
}

function num(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  return cleaned === "" ? Number.NaN : Number(cleaned);
}

/**
 * The typed lines as numbers, or why not. A row left completely empty is
 * skipped rather than reported, so the spare row at the foot of the editor
 * never blocks a save.
 */
export function parseLineDrafts(drafts: readonly ProposalLineDraft[]): {
  lines: ProposalLine[];
  errors: string[];
} {
  const lines: ProposalLine[] = [];
  const errors: string[] = [];
  drafts.forEach((d, i) => {
    const description = d.description.trim();
    const blank = !description && !d.unitPrice.trim() && (!d.quantity.trim() || d.quantity === "1");
    if (blank) return;
    const quantity = num(d.quantity);
    const unitPrice = num(d.unitPrice);
    const n = i + 1;
    if (!description) errors.push(`Line ${n} needs a description.`);
    if (!Number.isFinite(quantity) || quantity <= 0)
      errors.push(`Line ${n}: the quantity must be more than zero.`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0)
      errors.push(`Line ${n}: the unit price must be zero or more.`);
    if (description && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitPrice))
      lines.push({ description, quantity, unit_price: Math.max(0, unitPrice) });
  });
  return { lines, errors };
}

/** What the form edits. Strings throughout — it is what was typed. */
export type ProposalDraft = {
  title: string;
  /** "" for no template: the pricing alone under the title. */
  templateId: string;
  notes: string;
  terms: string;
  lines: ProposalLineDraft[];
};

/** Why the draft cannot be saved yet, or null when it can. */
export function draftProblem(draft: ProposalDraft): string | null {
  if (!draft.title.trim()) return "Give the proposal a title.";
  const { lines, errors } = parseLineDrafts(draft.lines);
  if (errors.length) return errors[0]!;
  if (!lines.length) return "Add at least one priced line.";
  return null;
}

export function emptyDraft(title = ""): ProposalDraft {
  return { title, templateId: "", notes: "", terms: "", lines: [blankLine()] };
}

/* ------------------------------------------------- the card moving itself */

export type ProposalStage = {
  id: string;
  pipeline_id: string;
  key: string;
  name: string;
  sort_order: number;
  is_won: boolean;
  is_lost: boolean;
  is_active: boolean;
};

export const PROPOSAL_SENT_STAGE_KEY = "proposal_sent";

export type ProposalStageMove =
  { kind: "move"; stage: ProposalStage } | { kind: "stay"; reason: string };

/**
 * Where a status change takes the card — the dialog's preview of what
 * tg_account_proposal_advance will do. Sent goes to the pipeline's Proposal
 * sent stage; signed to its won stage (Active Client first), or the stage
 * after Proposal sent when there is no won stage; declined goes nowhere. And
 * never backwards: a card already at or past the target, won, or lost stays.
 */
export function proposalStageMove(
  stages: readonly ProposalStage[],
  currentStageId: string | null,
  event: "sent" | "signed" | "declined",
): ProposalStageMove {
  if (event === "declined")
    return { kind: "stay", reason: "Declined — the card stays where it is." };
  const cur = stages.find((s) => s.id === currentStageId);
  if (!cur) return { kind: "stay", reason: "Not moved: the account is not on a pipeline stage." };
  const own = stages.filter((s) => s.pipeline_id === cur.pipeline_id && s.is_active);

  let target: ProposalStage | undefined;
  if (event === "sent") {
    target = own.find((s) => s.key === PROPOSAL_SENT_STAGE_KEY);
    if (!target)
      return { kind: "stay", reason: "Not moved: this pipeline has no Proposal sent stage." };
  } else {
    target = own
      .filter((s) => s.is_won)
      .sort(
        (a, b) =>
          Number(b.key === "active_client") - Number(a.key === "active_client") ||
          a.sort_order - b.sort_order,
      )[0];
    if (!target) {
      const sent = own.find((s) => s.key === PROPOSAL_SENT_STAGE_KEY);
      target = sent
        ? own
            .filter((s) => !s.is_lost && s.sort_order > sent.sort_order)
            .sort((a, b) => a.sort_order - b.sort_order)[0]
        : undefined;
    }
    if (!target)
      return { kind: "stay", reason: "Not moved: this pipeline has no stage to win into." };
  }

  if (cur.id === target.id || cur.is_won || cur.is_lost || cur.sort_order >= target.sort_order) {
    return { kind: "stay", reason: `Not moved: already at ${cur.name}.` };
  }
  return { kind: "move", stage: target };
}

/** "moves this card to Proposal sent" / "leaves the card where it is — already at …". */
export function stageMoveClause(move: ProposalStageMove): string {
  if (move.kind === "move") return `moves this card to ${move.stage.name}`;
  const why = move.reason.replace(/^Not moved: /, "").replace(/\.$/, "");
  return `leaves the card where it is — ${why}`;
}

/** The one line the dialog prints under its send buttons: "Sending moves this card to …". */
export function stageMoveSentence(move: ProposalStageMove, verb: string): string {
  return `${verb} ${stageMoveClause(move)}.`;
}

/* ------------------------------------------------------- the document body */

const PROPOSAL_TABLE_TOKEN = /\{\{\s*proposal\.table\s*\}\}/;

/** The priced lines as plain text, for the PDF body (blank lines separate paragraphs). */
export function pricingTable(lines: readonly ProposalLine[]): string {
  const { total } = proposalTotals(lines);
  const rows = lines.map(
    (l) =>
      `${l.description} — ${l.quantity} x ${formatMoney(l.unit_price)} = ${formatMoney(lineTotal(l.quantity, l.unit_price))}`,
  );
  return [...rows, "", `Total: ${formatMoney(total)}`].join("\n");
}

export type ProposalForBody = {
  title: string;
  notes: string | null;
  terms: string | null;
};

/** The proposal's own merge keys, on top of the account and office ones. */
export function proposalMergeData(
  proposal: ProposalForBody,
  lines: readonly ProposalLine[],
  base: MergeData,
): MergeData {
  const { subtotal, total } = proposalTotals(lines);
  return {
    ...base,
    "proposal.title": proposal.title,
    "proposal.table": pricingTable(lines),
    "proposal.subtotal": formatMoney(subtotal),
    "proposal.total": formatMoney(total),
  };
}

/**
 * The text that goes on the document. The template's wording with every key
 * filled; the pricing where the template put {{proposal.table}}, or after the
 * wording when it did not; then the notes and terms. With no template, the
 * pricing alone under the title.
 */
export function renderProposalBody(
  templateBody: string | null,
  proposal: ProposalForBody,
  lines: readonly ProposalLine[],
  base: MergeData,
): string {
  const data = proposalMergeData(proposal, lines, base);
  const parts: string[] = [];
  if (templateBody && templateBody.trim()) {
    parts.push(renderTemplate(templateBody, data));
    if (!PROPOSAL_TABLE_TOKEN.test(templateBody)) parts.push(`Pricing\n\n${pricingTable(lines)}`);
  } else {
    parts.push(proposal.title, `Pricing\n\n${pricingTable(lines)}`);
  }
  if (proposal.notes?.trim()) parts.push(`Notes\n\n${proposal.notes.trim()}`);
  if (proposal.terms?.trim()) parts.push(`Terms\n\n${proposal.terms.trim()}`);
  return parts.join("\n\n");
}

/** Merge data for an account: its primary contact and its address. */
export function mergeDataForAccount(
  account: {
    name: string;
    address_line1?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
  },
  contact: { full_name?: string | null; email?: string | null; phone?: string | null } | null,
  companyName = "Gold Star Restoration",
): MergeData {
  const cityStateZip = [account.city, account.state, account.postal_code]
    .filter(Boolean)
    .join(", ");
  return {
    "account.name": account.name,
    "customer.name": contact?.full_name ?? account.name,
    "customer.email": contact?.email ?? null,
    "customer.phone": contact?.phone ?? null,
    "property.address": account.address_line1 ?? null,
    "property.city_state_zip": cityStateZip || null,
    "company.name": companyName,
    today: new Date().toLocaleDateString(DATE_LOCALE, US_DATE),
    Today: new Date().toLocaleDateString(DATE_LOCALE, US_DATE),
  };
}

/* ------------------------------------------------------------------- reads */

export type AccountProposal = {
  id: string;
  account_id: string;
  pipeline_id: string | null;
  title: string;
  template_id: string | null;
  template_version_id: string | null;
  status: ProposalStatus;
  subtotal: number;
  total: number;
  notes: string | null;
  terms: string | null;
  document_id: string | null;
  sent_at: string | null;
  sent_by: string | null;
  signed_at: string | null;
  declined_at: string | null;
  declined_reason: string | null;
  expired_at: string | null;
  stage_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StoredProposalLine = ProposalLine & {
  id: string;
  proposal_id: string;
  position: number;
  line_total: number;
};

const PROPOSAL_COLUMNS =
  "id,account_id,pipeline_id,title,template_id,template_version_id,status,subtotal,total,notes,terms,document_id,sent_at,sent_by,signed_at,declined_at,declined_reason,expired_at,stage_note,created_by,created_at,updated_at";

function toProposal(r: Record<string, unknown>): AccountProposal {
  return {
    ...(r as unknown as AccountProposal),
    subtotal: Number(r.subtotal ?? 0),
    total: Number(r.total ?? 0),
  };
}

/** `available: false` until the migration is applied — the page says so instead of erroring. */
export async function listAccountProposals(
  accountId: string,
  client: SupabaseClient = db(),
): Promise<{ available: boolean; rows: AccountProposal[] }> {
  const { data, error } = await client
    .from("account_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("account_id", accountId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) return { available: false, rows: [] };
    throw error;
  }
  return {
    available: true,
    rows: (data ?? []).map((r) => toProposal(r as Record<string, unknown>)),
  };
}

export async function fetchProposal(
  id: string,
  client: SupabaseClient = db(),
): Promise<{ proposal: AccountProposal; lines: StoredProposalLine[] } | null> {
  const [p, l] = await Promise.all([
    client.from("account_proposals").select(PROPOSAL_COLUMNS).eq("id", id).maybeSingle(),
    client
      .from("account_proposal_lines")
      .select("id,proposal_id,position,description,quantity,unit_price,line_total")
      .eq("proposal_id", id)
      .order("position"),
  ]);
  if (p.error) throw p.error;
  if (l.error) throw l.error;
  if (!p.data) return null;
  return {
    proposal: toProposal(p.data as Record<string, unknown>),
    lines: (l.data ?? []).map((r) => ({
      ...(r as unknown as StoredProposalLine),
      quantity: Number(r.quantity),
      unit_price: Number(r.unit_price),
      line_total: Number(r.line_total),
    })),
  };
}

/* ------------------------------------------------------------------ writes */

export type ProposalDraftInput = {
  id?: string | null;
  accountId: string;
  title: string;
  templateId: string | null;
  templateVersionId: string | null;
  notes: string | null;
  terms: string | null;
  lines: readonly ProposalLine[];
  userId: string | null;
};

/**
 * Writes a draft and its lines. The lines are replaced wholesale — a draft's
 * lines are a list the rep edits as one thing, and the database recomputes the
 * total from whatever lands.
 */
export async function saveProposalDraft(
  input: ProposalDraftInput,
  client: SupabaseClient = db(),
): Promise<string> {
  const fields = {
    title: input.title.trim(),
    template_id: input.templateId,
    template_version_id: input.templateVersionId,
    notes: input.notes?.trim() || null,
    terms: input.terms?.trim() || null,
  };
  let id = input.id ?? null;
  if (id) {
    const { error } = await client.from("account_proposals").update(fields).eq("id", id);
    if (error) throw error;
    const { error: delError } = await client
      .from("account_proposal_lines")
      .delete()
      .eq("proposal_id", id);
    if (delError) throw delError;
  } else {
    const { data, error } = await client
      .from("account_proposals")
      .insert({ ...fields, account_id: input.accountId, created_by: input.userId })
      .select("id")
      .single();
    if (error) throw error;
    id = (data as { id: string }).id;
  }
  if (input.lines.length) {
    const { error } = await client.from("account_proposal_lines").insert(
      input.lines.map((l, i) => ({
        proposal_id: id,
        position: i,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
      })),
    );
    if (error) throw error;
  }
  return id;
}

/**
 * Moves a proposal along. The guard trigger stamps the time and who; the
 * advance trigger moves the card and writes `stage_note`, which is read back
 * here so the caller can say what happened.
 */
export async function setProposalStatus(
  id: string,
  status: Exclude<ProposalStatus, "draft">,
  extra: { documentId?: string | null; declinedReason?: string | null } = {},
  client: SupabaseClient = db(),
): Promise<AccountProposal> {
  const patch: Record<string, unknown> = { status };
  if (extra.documentId) patch.document_id = extra.documentId;
  if (status === "declined") patch.declined_reason = extra.declinedReason?.trim() || null;
  const { error } = await client.from("account_proposals").update(patch).eq("id", id);
  if (error) throw error;
  const { data, error: readError } = await client
    .from("account_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("id", id)
    .single();
  if (readError) throw readError;
  return toProposal(data as Record<string, unknown>);
}

/** Drafts only; a sent proposal is a record and the policy refuses the rest. */
export async function deleteProposalDraft(
  id: string,
  client: SupabaseClient = db(),
): Promise<void> {
  const { error } = await client
    .from("account_proposals")
    .delete()
    .eq("id", id)
    .eq("status", "draft");
  if (error) throw error;
}
