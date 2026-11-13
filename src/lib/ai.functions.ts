/**
 * Assistant server functions.
 *
 * Advisory only: nothing in this file writes business data. Dictation is
 * transcribed and parsed into a *proposal* the rep confirms in the UI, and
 * summaries are generated from facts fetched with the caller's own RLS.
 * The single write here is a translation row, which the user explicitly asks
 * for and can correct.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAssistantCapability } from "@/lib/assistant-capability.server";

const transcribeInput = z.object({
  audio_base64: z.string().min(1),
  mime: z.string().min(1).max(100),
});

export const transcribeNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transcribeInput.parse(d))
  .handler(async ({ data, context }) => {
    await requireAssistantCapability(context.supabase, context.userId);
    const { transcribe } = await import("./ai.server");
    const { resolveAssistantScope, logAssistantEvent } = await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);
    const bytes = Uint8Array.from(atob(data.audio_base64), (c) => c.charCodeAt(0));
    const text = await transcribe(bytes, data.mime);
    await logAssistantEvent(scope, {
      feature: "dictation_transcribe",
      retrieved: { audio_bytes: bytes.length },
      responsePreview: text,
      model: "openai/gpt-4o-mini-transcribe",
    });
    return { transcript: text };
  });

export interface DictationProposal {
  transcript: string;
  /** True while View As is active: parse and preview only, never save. */
  read_only?: boolean;
  account_id: string | null;
  account_name: string | null;
  account_confidence: "high" | "low" | "none";
  contact_id: string | null;
  contact_name: string | null;
  suggested_stage: string | null;
  touchpoint_type: string | null;
  occurred_note: string;
  next_action: string | null;
  follow_up_date: string | null;
  competitor: string | null;
  unmatched: string[];
}

const parseInput = z.object({ transcript: z.string().trim().min(3).max(8000) });

export const parseDictation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => parseInput.parse(d))
  .handler(async ({ data, context }): Promise<DictationProposal> => {
    await requireAssistantCapability(context.supabase, context.userId);
    const { candidateRecords, complete, safeJson } = await import("./ai.server");
    const { resolveAssistantScope, logAssistantEvent, untrusted, UNTRUSTED_PREAMBLE } =
      await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);
    const { accounts, contacts, redactions } = await candidateRecords(context.supabase, scope);

    const roster = accounts
      .slice(0, 300)
      .map((a) => `${a.id}|${a.name}|${a.stage}`)
      .join("\n");
    const people = contacts
      .slice(0, 400)
      .map((c) => `${c.id}|${c.full_name}|${c.account_id}`)
      .join("\n");

    const system = [
      "You extract CRM fields from a salesperson's dictated meeting note for a restoration company.",
      "Return ONLY JSON with keys: account_id, account_name, account_confidence, contact_id, contact_name, suggested_stage, touchpoint_type, occurred_note, next_action, follow_up_date, competitor, unmatched.",
      "account_id/contact_id MUST be an id copied verbatim from the supplied rosters, or null. Never invent ids.",
      "account_confidence is 'high' only when the spoken company name closely matches a roster row; otherwise 'low' (fuzzy) or 'none'.",
      "suggested_stage must be one of: target, researching, attempting_contact, meeting_booked, meeting_held, vendor_onboarding, active, nurture, dormant, lost — or null.",
      "touchpoint_type must be one of: call, email, meeting_in_person, meeting_virtual, gift, seasonal_send, other — or null.",
      "follow_up_date is an ISO date (YYYY-MM-DD) resolved against today, or null.",
      "occurred_note is a tidy written version of what the rep said, in their words, no invented detail.",
      "unmatched lists anything spoken that you could not tie to a record (e.g. an unknown company or person name).",
      "",
      UNTRUSTED_PREAMBLE,
    ].join("\n");

    const user = [
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
      "",
      "ACCOUNT ROSTER (id|name|stage):",
      untrusted(roster || "(no accounts visible to this user)"),
      "",
      "CONTACT ROSTER (id|name|account_id):",
      untrusted(people || "(none)"),
      "",
      "DICTATED NOTE:",
      untrusted(data.transcript),
    ].join("\n");

    // A short structured read: the cheap extraction model where there is one.
    const raw = await complete(system, user, true, "extraction", { feature: "dictation" });
    const parsed = safeJson<Partial<DictationProposal>>(raw);
    if (!parsed) {
      throw new Error("Could not read the assistant's response. Try again.");
    }

    // Never trust ids that aren't in the roster we supplied.
    const accountIds = new Set(accounts.map((a) => a.id));
    const contactIds = new Set(contacts.map((c) => c.id));
    const accountId =
      parsed.account_id && accountIds.has(parsed.account_id) ? parsed.account_id : null;
    const contactId =
      parsed.contact_id && contactIds.has(parsed.contact_id) ? parsed.contact_id : null;

    await logAssistantEvent(scope, {
      feature: "dictation_parse",
      question: data.transcript,
      retrieved: {
        accounts_in_roster: accounts.length,
        contacts_in_roster: contacts.length,
        matched_account_id: accountId,
        matched_contact_id: contactId,
      },
      redactions,
      model: "google/gemini-3.6-flash",
    });

    return {
      transcript: data.transcript,
      /** Writes are disabled while View As is active; the UI must not save. */
      read_only: scope.impersonating,
      account_id: accountId,
      account_name: accounts.find((a) => a.id === accountId)?.name ?? parsed.account_name ?? null,
      account_confidence: accountId
        ? ((parsed.account_confidence as DictationProposal["account_confidence"]) ?? "low")
        : "none",
      contact_id: contactId,
      contact_name:
        contacts.find((c) => c.id === contactId)?.full_name ?? parsed.contact_name ?? null,
      suggested_stage: parsed.suggested_stage ?? null,
      touchpoint_type: parsed.touchpoint_type ?? null,
      occurred_note: parsed.occurred_note ?? data.transcript,
      next_action: parsed.next_action ?? null,
      follow_up_date: parsed.follow_up_date ?? null,
      competitor: parsed.competitor ?? null,
      unmatched: Array.isArray(parsed.unmatched) ? parsed.unmatched : [],
    };
  });

/** Who the signed-in user may ask the assistant about, resolved server-side. */
export const assistantScopePeople = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(() => ({}))
  .handler(async ({ context }) => {
    await requireAssistantCapability(context.supabase, context.userId);
    const { resolveAssistantScope, assistantPeople } = await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);
    const people = await assistantPeople(context.supabase, scope);
    return { people, people_scope: scope.caps.peopleScope };
  });

const summaryInput = z.object({
  days: z.number().int().min(1).max(365).default(7),
  user_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  question: z.string().trim().max(500).optional(),
});

export const activitySummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => summaryInput.parse(d))
  .handler(async ({ data, context }) => {
    await requireAssistantCapability(context.supabase, context.userId);
    const { gatherFacts, complete } = await import("./ai.server");
    const {
      resolveAssistantScope,
      allowedPeople,
      logAssistantEvent,
      untrusted,
      UNTRUSTED_PREAMBLE,
    } = await import("./assistant-scope.server");

    const scope = await resolveAssistantScope(context.supabase, context.userId);
    const allowed = await allowedPeople(context.supabase, scope);

    let facts;
    try {
      facts = await gatherFacts(
        context.supabase,
        {
          days: data.days,
          userId: data.user_id ?? null,
          locationId: data.location_id ?? null,
        },
        scope,
        allowed,
      );
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "activity_summary",
        question: data.question ?? null,
        scopeSummary: { requested_user_id: data.user_id ?? null },
        outcome: "denied",
        responsePreview: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const everythingZero =
      facts.touchpoints_total === 0 &&
      facts.contact_attempts === 0 &&
      facts.jobs_created === 0 &&
      facts.accounts_advanced.length === 0 &&
      facts.gift_sends === 0;

    if (everythingZero) {
      await logAssistantEvent(scope, {
        feature: "activity_summary",
        question: data.question ?? null,
        scopeSummary: {
          requested_user_id: data.user_id ?? null,
          window_days: data.days,
        },
        retrieved: { rows: 0 },
        redactions: facts.redactions,
      });
      return {
        facts,
        summary:
          `No activity recorded in the last ${facts.window_days} days for this ${facts.scope}. ` +
          `That is what the data says — it may mean nothing was logged rather than nothing happened.`,
      };
    }

    const system = [
      "You are an operations analyst summarizing recorded CRM activity for a restoration company's leadership.",
      "You may ONLY state figures present in the FACTS JSON. Never estimate, extrapolate, or invent a number, name, or event.",
      "If the question asks for something not in FACTS, say plainly that the system does not record it.",
      "Advisory only: you may point out what looks thin, but never state that an action was taken or should be taken automatically.",
      "The FACTS were computed inside the asker's own permission scope. If a figure is absent, it is withheld by policy or genuinely unrecorded — say it is not available to them, and never estimate it.",
      "Write 4-8 short sentences of plain prose. No preamble, no markdown headings.",
      "",
      UNTRUSTED_PREAMBLE,
    ].join("\n");

    const user = [
      data.question ? `QUESTION: ${data.question}` : "QUESTION: What happened?",
      "",
      "FACTS:",
      untrusted(facts),
    ].join("\n");

    const summary = await complete(system, user, false, "general", {
      feature: "activity_summary",
    });

    await logAssistantEvent(scope, {
      feature: "activity_summary",
      question: data.question ?? null,
      scopeSummary: {
        requested_user_id: data.user_id ?? null,
        requested_location_id: data.location_id ?? null,
        window_days: data.days,
      },
      retrieved: {
        touchpoints: facts.touchpoints_total,
        contact_attempts: facts.contact_attempts,
        jobs_created: facts.jobs_created,
        accounts_advanced: facts.accounts_advanced.length,
        gift_sends: facts.gift_sends,
      },
      redactions: facts.redactions,
      responsePreview: summary,
      model: "google/gemini-3.6-flash",
    });

    return { facts, summary };
  });

import { sourceHash } from "./source-hash";

const translateInput = z.object({
  entity_type: z.enum(["job", "job_note", "quote", "message"]),
  entity_id: z.string().uuid(),
  field: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(20000),
  lang: z.string().trim().min(2).max(5).default("es"),
});

/**
 * Translate-on-save. The result is persisted so the crew view renders from
 * the database and never waits on (or needs) an API call in the field.
 */
export const translateAndStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => translateInput.parse(d))
  .handler(async ({ data, context }) => {
    const { complete } = await import("./ai.server");
    const { resolveAssistantScope, logAssistantEvent, untrusted, UNTRUSTED_PREAMBLE } =
      await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);
    if (!scope.caps.canWrite) {
      throw new Error("Writes are disabled while View As is active.");
    }

    const existing = await context.supabase
      .from("translations")
      .select("id, source_text, text, source")
      .eq("entity_type", data.entity_type)
      .eq("entity_id", data.entity_id)
      .eq("field", data.field)
      .eq("lang", data.lang)
      .maybeSingle();

    // A human correction wins until the English source actually changes.
    if (
      existing.data &&
      existing.data.source === "human" &&
      existing.data.source_text === data.text
    ) {
      return { text: existing.data.text, source: "human" as const };
    }

    const system =
      data.lang === "es"
        ? [
            "Translate restoration-industry work orders from English into clear Latin American Spanish for field crews.",
            "Keep it concrete and instructional. Preserve numbers, room names, measurements and equipment counts exactly.",
            "Do not add, remove, or soften any instruction. Return only the translation.",
          ].join(" ")
        : `Translate the text into ${data.lang}. Return only the translation.`;

    /*
     * 3 Nov meeting: "translation does not translate everything — API errors."
     * Off Lovable the default provider (the Lovable gateway) refuses every
     * call, and the crew saw the gateway's raw error. Say what to set instead.
     */
    const { aiConfigured, aiKeyName, aiProvider } = await import("./ai-provider.server");
    const setUp =
      "Translation needs an AI provider on the server: set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY (or AI_PROVIDER=openai_compatible with AI_BASE_URL and AI_API_KEY).";
    if (!aiConfigured()) {
      throw new Error(`Translation is not set up — ${aiKeyName()} is missing. ${setUp}`);
    }
    let translated: string;
    try {
      translated = await complete(
        `${system}\n\n${UNTRUSTED_PREAMBLE}`,
        untrusted(data.text),
        false,
        "general",
        { feature: "translation" },
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(
        aiProvider() === "lovable"
          ? `The translation service refused the request (${why.slice(0, 160)}). The Lovable AI gateway only works on Lovable. ${setUp}`
          : `The translation service did not answer (${why.slice(0, 200)}). Try again in a minute.`,
      );
    }
    if (!translated.trim()) throw new Error("The translation came back empty. Try again.");

    await logAssistantEvent(scope, {
      feature: "translate",
      scopeSummary: {
        entity_type: data.entity_type,
        entity_id: data.entity_id,
        field: data.field,
        lang: data.lang,
      },
      model: (await import("./ai-provider.server")).aiModel("general") ?? aiProvider(),
    });

    const { error } = await context.supabase.from("translations").upsert(
      {
        entity_type: data.entity_type,
        entity_id: data.entity_id,
        field: data.field,
        lang: data.lang,
        source_text: data.text,
        source_hash: sourceHash(data.text),
        text: translated,
        source: "machine",
        created_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "entity_type,entity_id,field,lang" },
    );
    if (error) throw new Error(error.message);

    return { text: translated, source: "machine" as const };
  });

const briefInput = z.object({ account_id: z.string().uuid() });

/**
 * Pre-call brief.
 *
 * Every fact is fetched with the caller's own client, so RLS decides what the
 * model can see — the brief can never surface a row the rep could not open
 * themselves. It summarises; it does not draft anything outbound.
 */
export const preCallBrief = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => briefInput.parse(d))
  .handler(async ({ data, context }) => {
    const { complete } = await import("./ai.server");
    const { resolveAssistantScope, logAssistantEvent, untrusted, UNTRUSTED_PREAMBLE } =
      await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);
    const sb = context.supabase;

    const [account, contacts, touches, notes, tasks, focus] = await Promise.all([
      sb
        .from("accounts")
        .select(
          "id,name,account_type,status,stage,stage_changed_at,last_in_person_at,annual_meeting_due_on,notes",
        )
        .eq("id", data.account_id)
        .maybeSingle(),
      sb
        .from("contacts")
        .select(
          "full_name,title,decision_role,personal_preferences,relationship_notes,best_time_to_reach",
        )
        .eq("account_id", data.account_id)
        .is("archived_at", null)
        .limit(20),
      sb
        .from("touchpoints")
        .select("type,occurred_at,notes")
        .eq("account_id", data.account_id)
        .order("occurred_at", { ascending: false })
        .limit(15),
      sb
        .from("account_notes")
        .select("body,created_at")
        .eq("account_id", data.account_id)
        .order("created_at", { ascending: false })
        .limit(10),
      sb
        .from("tasks")
        .select("title,due_date,status")
        .eq("account_id", data.account_id)
        .in("status", ["open", "in_progress"])
        .limit(15),
      sb.rpc("account_focus", { _account_id: data.account_id }),
    ]);

    if (!account.data) throw new Error("That account is not visible to you.");

    const system = [
      "You write a short pre-call brief for a restoration-company salesperson.",
      "Use ONLY the supplied facts. If something is not in the facts, say it is not on record — never guess.",
      "Never mention or invent dollar amounts, margins or labor rates.",
      "Never write an email, text or any message intended to be sent to the client. Refuse if asked.",
      "Format: 3-6 short bullets, then one line beginning 'Watch out:' if there is a risk (gift policy, ghosting, overdue commitment).",
      "",
      UNTRUSTED_PREAMBLE,
    ].join("\n");

    const user = [
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
      "ACCOUNT:",
      untrusted(account.data),
      "CONTACTS:",
      untrusted(contacts.data ?? []),
      "RECENT TOUCHES:",
      untrusted(touches.data ?? []),
      "RECENT NOTES:",
      untrusted(notes.data ?? []),
      "OPEN TASKS:",
      untrusted(tasks.data ?? []),
      "COMPUTED SIGNALS:",
      untrusted(focus.data ?? []),
    ].join("\n");

    const text = await complete(system, user, false, "general", { feature: "pre_call_brief" });

    await logAssistantEvent(scope, {
      feature: "pre_call_brief",
      scopeSummary: { account_id: data.account_id },
      retrieved: {
        contacts: contacts.data?.length ?? 0,
        touchpoints: touches.data?.length ?? 0,
        tasks: tasks.data?.length ?? 0,
      },
      responsePreview: text,
      model: "google/gemini-3.6-flash",
    });

    return { text };
  });

const extractInput = z.object({
  file_base64: z.string().min(1),
  mime: z.string().min(1).max(100),
  file_name: z.string().min(1).max(200),
  kinds: z.array(z.string().min(1).max(60)).min(1).max(60),
});

export interface ExtractedCoverage {
  kind: string;
  policy_number: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  limit_occurrence: number | null;
  limit_aggregate: number | null;
}

export interface ExtractedCredential {
  kind: string | null;
  carrier: string | null;
  issuer: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  limit_occurrence: number | null;
  limit_aggregate: number | null;
  state_code: string | null;
  insured_name: string | null;
  coverages: ExtractedCoverage[];
  confidence: "high" | "medium" | "low";
  notes: string | null;
}

/**
 * Reads a certificate and proposes the fields. Advisory only: the rep sees and
 * edits every value before anything is written.
 */
export const extractCredentialDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => extractInput.parse(d))
  .handler(async ({ data, context }) => {
    const { extractDocument, safeJson } = await import("./ai.server");
    const { resolveAssistantScope, logAssistantEvent } = await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);

    const raw = await extractDocument(
      data.file_base64,
      data.mime,
      data.file_name,
      data.kinds.join(", "),
    );
    const parsed = safeJson<ExtractedCredential>(raw);
    if (!parsed) throw new Error("Could not read that document. Enter the details by hand.");

    const allowed = new Set(data.kinds);
    const clean: ExtractedCredential = {
      kind: parsed.kind && allowed.has(parsed.kind) ? parsed.kind : null,
      carrier: parsed.carrier ?? null,
      issuer: parsed.issuer ?? null,
      policy_number: parsed.policy_number ?? null,
      effective_date: parsed.effective_date ?? null,
      expiry_date: parsed.expiry_date ?? null,
      limit_occurrence: parsed.limit_occurrence ?? null,
      limit_aggregate: parsed.limit_aggregate ?? null,
      state_code: parsed.state_code ?? null,
      insured_name: parsed.insured_name ?? null,
      coverages: (parsed.coverages ?? []).filter((c) => c && allowed.has(c.kind)),
      confidence: parsed.confidence ?? "low",
      notes: parsed.notes ?? null,
    };

    await logAssistantEvent(scope, {
      feature: "credential_extract",
      retrieved: { file_bytes: data.file_base64.length, coverages: clean.coverages.length },
      responsePreview: raw.slice(0, 500),
      model: "google/gemini-3.6-flash",
    });

    return clean;
  });
