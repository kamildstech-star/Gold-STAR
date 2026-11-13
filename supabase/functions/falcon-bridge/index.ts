// falcon-bridge — the Falcon Console reads AI usage, cost and credits
// and makes audited credit/tier/pack changes through this one function.
// HMAC-signed, machine-to-machine (verify_jwt = false). All the behaviour is in
// ../_shared/falcon-bridge.ts (unit-tested); the SQL is migration
// 20261111000000_ai_billing.sql, section 7 (service role only).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleFalconBridge } from "../_shared/falcon-bridge.ts";

Deno.serve((req) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  return handleFalconBridge(req, {
    secret: Deno.env.get("FALCON_BRIDGE_SECRET") ?? "",
    nowSeconds: () => Math.floor(Date.now() / 1000),
    async claim(requestId, action, operator) {
      const { data, error } = await admin.rpc("falcon_bridge_claim", {
        p_request_id: requestId,
        p_action: action,
        p_operator: operator,
      });
      if (error) throw new Error(`falcon_bridge_claim: ${error.message}`);
      return data === true;
    },
    async rpc(fn, args) {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
  });
});
