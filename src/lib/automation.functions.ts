// Automation engine — the callable wrapper. All evaluation logic lives in
// automation-engine.server.ts so the manual run, the 15-minute cron hook and
// the event-driven database triggers all execute the exact same code path.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const runAutomations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { ruleId?: string | null } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase: userClient, userId } = context;
    const { data: allowed } = await userClient.rpc("is_sales_lead", { _user_id: userId });
    if (!allowed) throw new Error("Only the Sales Head, an owner or an admin can run automations.");

    const { runAutomationEngine } = await import("./automation-engine.server");
    return runAutomationEngine({ ruleId: data.ruleId ?? null, triggeredBy: userId });
  });
