// TODO(remove after cutover): temporary, for moving the app off Lovable to
// Vercel. Delete with the rest of the secret transfer (see the header of
// secret-transfer.ts).
/**
 * The two doors to the Owner's "Transfer secrets to new host" card. Both sit
 * behind requireSupabaseAuth (a live session, an active and approved
 * profile), and the handler then asks the database whether the caller is the
 * Owner before it touches anything — an admin who found these functions is
 * refused exactly like a stranger.
 *
 * The browser sends a mode and, for a real run, the confirmation word. It
 * cannot send a destination: the URL, team, project, environment and the
 * allowlist are constants in secret-transfer.ts. What comes back is names and
 * statuses only (see secret-transfer.server.ts for how values are kept out).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import type { SecretTransferCheck, SecretTransferRun } from "./secret-transfer";
import type { CallerContext, SecretTransferDeps } from "./secret-transfer.server";

async function serverDeps(): Promise<SecretTransferDeps> {
  const { RATE_LIMITS, consumeLimit } = await import("@/lib/rate-limit.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return {
    env: process.env,
    admin: supabaseAdmin as unknown as SecretTransferDeps["admin"],
    consumeLimit,
    rules: { check: RATE_LIMITS.secretTransferCheck, transfer: RATE_LIMITS.secretTransfer },
  };
}

export const checkSecretTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SecretTransferCheck> => {
    const { handleSecretTransfer } = await import("./secret-transfer.server");
    const result = await handleSecretTransfer(
      context as unknown as CallerContext,
      { mode: "check" },
      await serverDeps(),
    );
    return result as SecretTransferCheck;
  });

export const runSecretTransfer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { confirm: string }) =>
    z
      .object({ confirm: z.string().max(32) })
      .strict()
      .parse(data),
  )
  .handler(async ({ context, data }): Promise<SecretTransferRun> => {
    const { handleSecretTransfer } = await import("./secret-transfer.server");
    const result = await handleSecretTransfer(
      context as unknown as CallerContext,
      { mode: "transfer", confirm: data.confirm },
      await serverDeps(),
    );
    return result as SecretTransferRun;
  });
