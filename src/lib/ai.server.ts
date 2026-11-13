/**
 * Server-only AI helpers. Everything here runs behind a server function.
 *
 * Two hard rules encoded in this file:
 *  1. The assistant never writes. It parses and summarises; a human confirms.
 *  2. Every number in a summary comes from a real query in `gatherFacts`.
 *     The model is given those facts and told it may not invent others.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import {
  chat,
  replyText,
  transcribeAudio,
  type AiProviderName,
  type AiTask,
} from "@/lib/ai-provider.server";
import type { AiFeature } from "@/lib/ai-billing.server";
import type { AssistantScope } from "@/lib/assistant-scope.server";

/*
 * Which service answers — the Lovable gateway (default), Anthropic, or any
 * OpenAI-compatible endpoint — is ai-provider.server.ts's business. These
 * helpers say WHAT they need (a task, a prompt, maybe a picture) and get text
 * back, so moving provider changes no caller.
 */

/** Speech-to-text for dictated notes. */
export async function transcribe(audio: Uint8Array, mime: string): Promise<string> {
  return transcribeAudio(audio, mime);
}

/**
 * Plain chat completion. `json` forces a JSON object response. `task` picks
 * the model on providers that have more than one (ai-provider.server.ts);
 * short structured reads pass "extraction". `target` pins one call to a
 * specific provider and model — the loss report uses it to reach its own,
 * stronger model (reportModelPlan) through the same client.
 */
export async function complete(
  system: string,
  user: string,
  json = false,
  task: AiTask = "general",
  target?: {
    provider?: AiProviderName;
    model?: string;
    effort?: string;
    signal?: AbortSignal;
    /** What the call is for, as the Falcon Console shows it (ai-billing.server.ts). */
    feature?: AiFeature;
  },
): Promise<string> {
  const reply = await chat({
    task,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    json,
    ...(target ?? {}),
  });
  return replyText(reply.content).trim();
}

export function safeJson<T>(raw: string): T | null {
  const cleaned = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

type DB = SupabaseClient<Database>;

/**
 * Accounts + contacts the caller can actually see, for name matching.
 *
 * Read with the caller's own client so RLS decides. For a sales rep, peers'
 * accounts are additionally dropped: RLS may expose the location's book, but a
 * rep's dictation roster is their own pipeline, not a colleague's.
 */
export async function candidateRecords(supabase: DB, scope: AssistantScope) {
  const [{ data: accounts }, { data: contacts }] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, name, stage, location_id, assigned_rep")
      .order("name")
      .limit(500),
    supabase.from("contacts").select("id, full_name, account_id").order("full_name").limit(1000),
  ]);

  const peerRestricted =
    scope.caps.peopleScope === "self" ||
    (scope.roles.includes("sales_rep") &&
      !scope.roles.some((r) =>
        ["owner", "admin", "dev", "regional", "location_manager", "sales_manager"].includes(r),
      ));

  let visibleAccounts = (accounts ?? []) as Array<{
    id: string;
    name: string;
    stage: string;
    location_id: string | null;
    assigned_rep?: string | null;
  }>;
  const redactions: string[] = [];
  if (peerRestricted) {
    const before = visibleAccounts.length;
    visibleAccounts = visibleAccounts.filter(
      (a) => a.assigned_rep === scope.effectiveUserId || a.assigned_rep == null,
    );
    if (visibleAccounts.length !== before) {
      redactions.push("peer_accounts_excluded_from_dictation_roster");
    }
  }
  const accountIdSet = new Set(visibleAccounts.map((a) => a.id));
  const visibleContacts = (
    (contacts ?? []) as Array<{
      id: string;
      full_name: string;
      account_id: string | null;
    }>
  ).filter((c) => !c.account_id || accountIdSet.has(c.account_id));

  return { accounts: visibleAccounts, contacts: visibleContacts, redactions };
}

export interface ActivityFacts {
  window_days: number;
  since: string;
  scope: string;
  touchpoints_total: number;
  touchpoints_by_type: Record<string, number>;
  meetings_held: number;
  accounts_advanced: Array<{ account: string; from: string | null; to: string }>;
  contact_attempts: number;
  contact_attempts_by_channel: Record<string, number>;
  jobs_created: number;
  /** Omitted entirely for roles without financial visibility. */
  jobs_won_value?: number;
  gift_sends: number;
  notes: string[];
  redactions: string[];
}

/**
 * Real queries only. Everything the model is later allowed to state comes
 * from this object; empty means empty, and we say so rather than guessing.
 */
export async function gatherFacts(
  supabase: DB,
  opts: { days: number; userId?: string | null; locationId?: string | null },
  scope: AssistantScope,
  allowed: Set<string> | null,
): Promise<ActivityFacts> {
  const redactions: string[] = [];

  // Person filter is decided here, not by the caller's request payload.
  let personFilter: string | null = opts.userId ?? null;
  if (scope.caps.peopleScope === "self") {
    if (personFilter && personFilter !== scope.effectiveUserId) {
      throw new Error("Your role only lets the assistant report on your own activity.");
    }
    personFilter = scope.effectiveUserId;
    redactions.push("person_scope_forced_to_self");
  } else if (personFilter && allowed && !allowed.has(personFilter)) {
    throw new Error("That person is outside the scope your role can ask the assistant about.");
  }

  const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString();

  let tp = supabase
    .from("touchpoints")
    .select("type, occurred_at, created_by, account_id")
    .gte("occurred_at", since);
  if (personFilter) tp = tp.eq("created_by", personFilter);
  else if (allowed) tp = tp.in("created_by", [...allowed]);

  let ca = supabase
    .from("contact_attempts")
    .select("channel, occurred_at, author_id")
    .gte("occurred_at", since);
  if (personFilter) ca = ca.eq("author_id", personFilter);
  else if (allowed) ca = ca.in("author_id", [...allowed]);

  let stages = supabase
    .from("account_stage_history")
    .select("from_stage, to_stage, changed_at, changed_by, account_id")
    .gte("changed_at", since);
  if (personFilter) stages = stages.eq("changed_by", personFilter);
  else if (allowed) stages = stages.in("changed_by", [...allowed]);

  let jobs = supabase
    .from("jobs")
    .select("id, created_at, location_id, created_by, billed_amount, collected_amount")
    .gte("created_at", since);
  if (opts.locationId) jobs = jobs.eq("location_id", opts.locationId);
  else if (scope.locationIds.length > 0 && scope.caps.peopleScope !== "all") {
    jobs = jobs.in("location_id", scope.locationIds);
  }
  // Job counts are people activity too: a self-scoped caller counts only the
  // jobs they created, never their location's whole book.
  if (personFilter) jobs = jobs.eq("created_by", personFilter);
  else if (allowed) jobs = jobs.in("created_by", [...allowed]);

  let gifts = supabase.from("gift_sends").select("id, sent_at, created_by").gte("sent_at", since);
  if (personFilter) gifts = gifts.eq("created_by", personFilter);
  else if (allowed) gifts = gifts.in("created_by", [...allowed]);

  const [tpRes, caRes, stRes, jobRes, giftRes] = await Promise.all([tp, ca, stages, jobs, gifts]);

  const byType: Record<string, number> = {};
  for (const row of tpRes.data ?? []) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
  }
  const byChannel: Record<string, number> = {};
  for (const row of caRes.data ?? []) {
    byChannel[row.channel] = (byChannel[row.channel] ?? 0) + 1;
  }

  const stageRows = stRes.data ?? [];
  const accountIds = Array.from(new Set(stageRows.map((s) => s.account_id).filter(Boolean)));
  let names = new Map<string, string>();
  if (accountIds.length > 0) {
    const { data } = await supabase.from("accounts").select("id, name").in("id", accountIds);
    names = new Map((data ?? []).map((a) => [a.id, a.name]));
  }

  const notes: string[] = [];
  for (const [label, res] of [
    ["touchpoints", tpRes],
    ["contact attempts", caRes],
    ["stage history", stRes],
    ["jobs", jobRes],
    ["gift sends", giftRes],
  ] as const) {
    if (res.error) notes.push(`${label} unavailable: ${res.error.message}`);
  }

  return {
    window_days: opts.days,
    since,
    scope: personFilter ? "single person" : opts.locationId ? "single location" : "whole company",
    touchpoints_total: (tpRes.data ?? []).length,
    touchpoints_by_type: byType,
    meetings_held: (byType["meeting_in_person"] ?? 0) + (byType["meeting_virtual"] ?? 0),
    accounts_advanced: stageRows.map((s) => ({
      account: names.get(s.account_id) ?? "(unnamed account)",
      from: s.from_stage,
      to: s.to_stage,
    })),
    contact_attempts: (caRes.data ?? []).length,
    contact_attempts_by_channel: byChannel,
    jobs_created: (jobRes.data ?? []).length,
    // Financial totals are computed only inside the caller's RLS scope, and
    // only for roles allowed to see money at all.
    ...(scope.caps.financials
      ? {
          jobs_won_value: (jobRes.data ?? []).reduce(
            (sum, j) => sum + Number(j.billed_amount ?? 0),
            0,
          ),
        }
      : {}),
    gift_sends: (giftRes.data ?? []).length,
    notes,
    redactions: scope.caps.financials
      ? redactions
      : [...redactions, "financial_totals_withheld_for_role"],
  };
}

/**
 * Reads a certificate or licence PDF/image and returns the fields a human then
 * checks. The model never saves anything — a misread expiry silently marking an
 * account compliant is the one failure that matters, so the rep confirms.
 */
export async function extractDocument(
  fileBase64: string,
  mime: string,
  fileName: string,
  hint: string,
): Promise<string> {
  const isImage = mime.startsWith("image/");
  const block = isImage
    ? { type: "image_url" as const, image_url: { url: `data:${mime};base64,${fileBase64}` } }
    : {
        type: "file" as const,
        file: { filename: fileName, file_data: `data:${mime};base64,${fileBase64}` },
      };

  // "document": a misread expiry marking a vendor compliant is the failure
  // that matters, so this stays on the stronger model.
  const reply = await chat({
    task: "document",
    feature: "compliance_doc",
    messages: [
      {
        role: "system",
        content: [
          "You read vendor compliance documents (ACORD certificates of insurance, IICRC and EPA RRP certificates, state contractor and mold licenses, W-9s, background checks).",
          "Return STRICT JSON only, no prose:",
          '{"kind":string|null,"carrier":string|null,"issuer":string|null,"policy_number":string|null,"effective_date":"YYYY-MM-DD"|null,"expiry_date":"YYYY-MM-DD"|null,"limit_occurrence":number|null,"limit_aggregate":number|null,"state_code":string|null,"insured_name":string|null,"coverages":[{"kind":string,"policy_number":string|null,"effective_date":"YYYY-MM-DD"|null,"expiry_date":"YYYY-MM-DD"|null,"limit_occurrence":number|null,"limit_aggregate":number|null}],"confidence":"high"|"medium"|"low","notes":string|null}',
          `kind and coverages[].kind MUST be one of: ${hint}.`,
          "Dates as ISO. Limits as plain numbers, no currency symbols or commas.",
          "On an ACORD COI list EVERY coverage line found in coverages. Use null when a field is genuinely absent — never guess.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract the compliance fields from this document." },
          block,
        ],
      },
    ],
    json: true,
  });
  return replyText(reply.content).trim();
}

/**
 * Reads a photographed business card and returns the model's raw reply.
 *
 * Same route as `extractDocument`: the chat model behind the gateway takes an
 * image part natively, so a card is one image message with a JSON-only
 * system prompt. Nothing is interpreted here — `parseCardModelOutput` in
 * business-card.ts decides what, if anything, the reply is worth, and the
 * server function that calls this never lets the reply near another prompt.
 *
 * `imageDataUrl` is a `data:image/…;base64,` URL already checked for mime
 * and size by the caller's schema; a 12MP frame never reaches this function
 * because the browser downscales first (`business-card-photo.ts`).
 */
export async function readBusinessCardImage(
  imageDataUrl: string,
  system: string,
  feature: AiFeature = "business_card",
): Promise<string> {
  const reply = await chat({
    task: "extraction",
    feature,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Read this business card." },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    json: true,
  });
  return replyText(reply.content).trim();
}

/**
 * Reads a photographed paper field work ticket and returns the model's raw
 * reply.
 *
 * Mark: "and its not reading the fields to enter in" — "everything was filled
 * in". Same gateway route as the business card and the compliance document,
 * with the PDF/image split `extractDocument` already uses, because a crew
 * photographs a sheet on a phone and the office sometimes scans a stack of
 * them to one PDF.
 *
 * `temperature: 0` is the one difference that matters. This is transcription
 * of somebody's crew size and machine counts; there is nothing here worth
 * being creative about, and a second read of the same sheet should say the
 * same thing. Nothing is interpreted here — `parseTicketModelOutput` in
 * field-ticket-extract.ts decides what, if anything, the reply is worth, and
 * a person confirms every value before it is saved.
 */
export async function readFieldTicketDocument(
  dataUrl: string,
  mime: string,
  fileName: string,
  system: string,
): Promise<string> {
  const block = mime.startsWith("image/")
    ? { type: "image_url" as const, image_url: { url: dataUrl } }
    : { type: "file" as const, file: { filename: fileName, file_data: dataUrl } };

  const reply = await chat({
    task: "document",
    feature: "field_ticket",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [{ type: "text", text: "Read this field work ticket." }, block],
      },
    ],
    json: true,
  });
  return replyText(reply.content).trim();
}
