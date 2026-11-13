import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface CredentialMetaDTO {
  provider: string;
  key_name: string;
  masked: string;
  is_public: boolean;
  updated_at: string;
  updated_by_name: string | null;
}

async function assertAdmin(context: {
  supabase: {
    rpc: (fn: "is_privileged", args: { _user_id: string }) => Promise<{ data: unknown }>;
  };
  userId: string;
}) {
  const { data } = await context.supabase.rpc("is_privileged", { _user_id: context.userId });
  if (!data) throw new Error("Forbidden");
}

/** Masked metadata only — a stored value is never returned to the browser. */
export const listIntegrationCredentials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CredentialMetaDTO[]> => {
    await assertAdmin(context as never);
    const { listCredentialMeta } = await import("@/lib/integration-credentials.server");
    const rows = await listCredentialMeta();
    const ids = [...new Set(rows.map((r) => r.updated_by).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data } = await context.supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", ids);
      for (const p of data ?? []) names.set(p.user_id, p.full_name ?? "");
    }
    return rows.map((r) => ({
      provider: r.provider,
      key_name: r.key_name,
      masked: r.masked,
      is_public: r.is_public,
      updated_at: r.updated_at,
      updated_by_name: r.updated_by ? (names.get(r.updated_by) ?? null) : null,
    }));
  });

export const saveIntegrationCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { provider: string; keyName: string; value: string; isPublic?: boolean }) => {
      const value = (input.value ?? "").trim();
      if (!input.provider || !input.keyName) throw new Error("Provider and key are required.");
      if (value.length < 4) throw new Error("That value looks too short to be a credential.");
      if (value.length > 8000) throw new Error("That value is too long.");
      return {
        provider: input.provider,
        keyName: input.keyName,
        value,
        isPublic: Boolean(input.isPublic),
      };
    },
  )
  .handler(async ({ data, context }): Promise<CredentialMetaDTO> => {
    await assertAdmin(context as never);
    const { saveCredential } = await import("@/lib/integration-credentials.server");
    const meta = await saveCredential({
      ...data,
      actorId: context.userId,
      actorEmail: (context.claims as { email?: string } | null)?.email ?? null,
    });
    return {
      provider: meta.provider,
      key_name: meta.key_name,
      masked: meta.masked,
      is_public: meta.is_public,
      updated_at: meta.updated_at,
      updated_by_name: null,
    };
  });

export const deleteIntegrationCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { provider: string; keyName: string }) => input)
  .handler(async ({ data, context }) => {
    await assertAdmin(context as never);
    const { removeCredential } = await import("@/lib/integration-credentials.server");
    await removeCredential({
      provider: data.provider,
      keyName: data.keyName,
      actorId: context.userId,
      actorEmail: (context.claims as { email?: string } | null)?.email ?? null,
    });
    return { ok: true };
  });

/** A real call against the provider. The result is what drives the card. */
export const testIntegrationConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { provider: string }) => input)
  .handler(
    async ({ data, context }): Promise<{ ok: boolean; message: string; tested_at: string }> => {
      await assertAdmin(context as never);
      const { runIntegrationTest } = await import("@/lib/integration-tests.server");
      const { recordTestResult } = await import("@/lib/integration-credentials.server");
      const result = await runIntegrationTest(data.provider);
      await recordTestResult({
        provider: data.provider,
        ok: result.ok,
        message: result.message,
        actorId: context.userId,
      });
      return { ...result, tested_at: new Date().toISOString() };
    },
  );
