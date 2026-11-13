import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { requireAssistantCapability } from "@/lib/assistant-capability.server";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BASE64_CHARS } from "@/lib/assistant-attachments";
import { prepareAttachments } from "@/lib/assistant-attachments.server";
import { assistantTurn } from "@/lib/assistant-chat.server";
import { logAssistantEvent, resolveAssistantScope } from "@/lib/assistant-scope.server";
import { executePlan, type PlanStep } from "@/lib/assistant-writes.server";

const attachmentSchema = z.object({
  name: z.string().min(1).max(200),
  mime: z.string().max(100),
  data_base64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
});

export type AssistantRequestContext = {
  entity: "account";
  id: string;
};

const requestContextSchema = z.object({
  entity: z.literal("account"),
  id: z.string().uuid(),
});

type DB = SupabaseClient<Database>;

async function verifiedPageContext(
  supabase: DB,
  requested: AssistantRequestContext | undefined,
  legacyPageContext: string | null | undefined,
) {
  if (!requested) return legacyPageContext ?? undefined;

  // This is deliberately queried through the caller's authenticated client.
  // A missing row and an RLS-hidden row receive the same response.
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", requested.id)
    .maybeSingle();
  if (error || !data) throw new Error("Account not found or unavailable.");

  return `the verified account record for "${data.name}" (account id ${data.id})`;
}

const askSchema = z
  .object({
    question: z.string().max(4000),
    conversationId: z.string().uuid().nullable().optional(),
    pageContext: z.string().max(500).nullable().optional(),
    context: requestContextSchema.optional(),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
  })
  // A turn has to carry something; a file on its own is a valid question.
  .refine((d) => d.question.trim().length > 0 || (d.attachments?.length ?? 0) > 0, {
    message: "Ask something, or attach a file.",
  });

export const askAssistant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => askSchema.parse(d))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    await requireAssistantCapability(supabase, context.userId);
    const pageContext = await verifiedPageContext(supabase, data.context, data.pageContext);
    const scope = await resolveAssistantScope(supabase, context.userId);

    // Files are validated and stored before anything else happens, so a
    // rejected or unstorable attachment surfaces as an error rather than as an
    // answer that quietly ignored it.
    let prepared: Awaited<ReturnType<typeof prepareAttachments>> = [];
    if (data.attachments?.length) {
      try {
        prepared = await prepareAttachments(supabase, context.userId, data.attachments);
      } catch (err) {
        await logAssistantEvent(scope, {
          feature: "assistant_attachment",
          question: data.question,
          retrieved: { files: data.attachments.map((a) => a.name) },
          outcome: "error",
          responsePreview: (err as Error).message,
        });
        throw err;
      }
    }

    // Conversation is per-user (RLS on assistant_conversations).
    let conversationId = data.conversationId ?? null;
    if (!conversationId) {
      const { data: conv, error } = await supabase
        .from("assistant_conversations")
        .insert({
          user_id: context.userId,
          title: (data.question.trim() || prepared[0]?.meta.name || "Attachment").slice(0, 80),
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      conversationId = conv.id;
    }

    const { data: prior } = await supabase
      .from("assistant_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at")
      .limit(24);

    const history = ((prior ?? []) as Array<{ role: string; content: string }>).map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    let turn;
    try {
      turn = await assistantTurn(
        supabase,
        scope,
        history,
        data.question,
        pageContext,
        prepared.flatMap((p) => p.parts),
      );
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "assistant_chat",
        question: data.question,
        outcome: "error",
        responsePreview: (err as Error).message,
      });
      throw err;
    }

    await supabase.from("assistant_messages").insert([
      {
        conversation_id: conversationId,
        user_id: context.userId,
        role: "user",
        content: data.question,
        meta: JSON.parse(JSON.stringify({ attachments: prepared.map((p) => p.meta) })),
      },
      {
        conversation_id: conversationId,
        user_id: context.userId,
        role: "assistant",
        content: turn.reply,
        meta: JSON.parse(
          JSON.stringify({
            plan: turn.plan,
            navigate: turn.navigate,
            tools: turn.toolsUsed,
          }),
        ),
      },
    ]);
    await supabase
      .from("assistant_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    await logAssistantEvent(scope, {
      feature: "assistant_chat",
      question: data.question,
      retrieved: {
        tools: turn.toolsUsed,
        attachments: prepared.map((p) => ({
          name: p.meta.name,
          mime: p.meta.mime,
          bytes: p.meta.size_bytes,
          path: p.meta.storage_path,
        })),
      },
      responsePreview: turn.reply,
      outcome: "ok",
    });

    return {
      conversationId,
      attachments: prepared.map((p) => p.meta),
      reply: turn.reply,
      plan: JSON.parse(JSON.stringify(turn.plan)) as Array<{
        op: string;
        entity?: string;
        summary: string;
        preview: Array<{ label: string; value: string }>;
      }>,
      navigate: turn.navigate,
      toolsUsed: turn.toolsUsed,
    };
  });

const stepSchema = z.object({
  op: z.enum(["create", "update", "archive", "tag", "draft_email"]),
  entity: z.string().optional(),
  id: z.string().nullable().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  children: z.array(z.record(z.string(), z.unknown())).optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string(),
  preview: z.array(z.object({ label: z.string(), value: z.string() })),
});

/**
 * Execute a plan the user has confirmed. Each step runs as the signed-in user,
 * so RLS decides what is allowed; failures report the real database reason.
 */
export const confirmAssistantAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ plan: z.array(stepSchema).min(1).max(12) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAssistantCapability(context.supabase, context.userId);
    const scope = await resolveAssistantScope(context.supabase, context.userId);
    const outcome = await executePlan(context.supabase, scope, data.plan as unknown as PlanStep[]);
    await logAssistantEvent(scope, {
      feature: "assistant_action",
      question: data.plan.map((s) => s.summary).join(" · "),
      retrieved: { steps: data.plan.map((s) => `${s.op}:${s.entity ?? "email"}`) },
      responsePreview: outcome.results.map((r) => r.message).join(" | "),
      outcome: outcome.ok ? "ok" : "error",
    });
    return outcome;
  });

export const listAssistantConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAssistantCapability(context.supabase, context.userId);
    const { data } = await context.supabase
      .from("assistant_conversations")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false })
      .limit(30);
    return data ?? [];
  });

export const getAssistantConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ conversationId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAssistantCapability(context.supabase, context.userId);
    const { data: rows } = await context.supabase
      .from("assistant_messages")
      .select("id, role, content, meta, created_at")
      .eq("conversation_id", data.conversationId)
      .order("created_at")
      .limit(200);
    return rows ?? [];
  });

export const deleteAssistantConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ conversationId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAssistantCapability(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("assistant_conversations")
      .delete()
      .eq("id", data.conversationId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
