/**
 * Falcon Console bridge — the only way the Falcon Console
 * (central AI billing console) reaches this app's AI usage and credits.
 *
 * Machine-to-machine: the console's `client-call` function signs every request
 * with a shared secret (FALCON_BRIDGE_SECRET here), so the gateway does not
 * verify a JWT. A request is accepted only when:
 *   - the secret is configured (fails CLOSED when unset),
 *   - x-falcon-timestamp is within MAX_SKEW_SECONDS of now,
 *   - x-falcon-signature = hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`)),
 *   - the body names an allowed action and a fresh request_id (replays refused),
 *   - writes name a falconmarketing.com operator and stay within the signed limit.
 *
 * Every action maps to one service-role-only SQL function (migrations
 * 20261111000000_ai_billing.sql, section 7). Nothing here touches Stripe or cards.
 */
import { timingSafeEqual } from "./timing-safe-equal.ts";

export const FALCON_BRIDGE_VERSION = "gsr-1";
export const MAX_SKEW_SECONDS = 300;
const FALCON_EMAIL = /^[a-z0-9._%+-]+@falconmarketing\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type FalconAction =
  | "health"
  | "overview"
  | "usage_month"
  | "money"
  | "ledger"
  | "settings"
  | "adjust_credits"
  | "set_tiers"
  | "set_packs";

const WRITES: ReadonlySet<FalconAction> = new Set(["adjust_credits", "set_tiers", "set_packs"]);
const ACTIONS: ReadonlySet<string> = new Set<FalconAction>([
  "health",
  "overview",
  "usage_month",
  "money",
  "ledger",
  "settings",
  "adjust_credits",
  "set_tiers",
  "set_packs",
]);

export interface FalconBridgeDeps {
  secret: string;
  nowSeconds: () => number;
  /** true the first time a request id is seen. */
  claim: (requestId: string, action: string, operator: string | null) => Promise<boolean>;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

class BadRequest extends Error {}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new BadRequest(`${what} must be a number`);
  return v;
}

/** Turns an action + params into the SQL call, validating as it goes. */
export function planCall(
  action: FalconAction,
  params: Record<string, unknown>,
  operator: string | null,
  limits: { max_credits?: number | null },
): { fn: string; args: Record<string, unknown> } {
  switch (action) {
    case "health":
    case "overview":
      return { fn: "falcon_overview", args: {} };
    case "usage_month":
    case "money": {
      const month = params.month ?? null;
      if (month !== null && (typeof month !== "string" || !MONTH.test(month)))
        throw new BadRequest("month must be YYYY-MM");
      const fn = action === "money" ? "falcon_money_month" : "falcon_usage_month";
      return { fn, args: { p_month: month ? `${month}-01` : null } };
    }
    case "ledger": {
      const before = params.before_id ?? null;
      const limit = params.limit ?? 50;
      const kind = params.kind ?? null;
      if (before !== null && (!Number.isInteger(before) || (before as number) < 1))
        throw new BadRequest("before_id must be a positive integer");
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200)
        throw new BadRequest("limit must be 1–200");
      if (kind !== null && !["topup", "usage", "adjustment"].includes(kind as string))
        throw new BadRequest("unknown kind");
      return { fn: "falcon_ledger", args: { p_before_id: before, p_limit: limit, p_kind: kind } };
    }
    case "settings":
      return { fn: "falcon_settings", args: {} };
    case "adjust_credits": {
      const credits = num(params.credits, "credits");
      if (credits === 0) throw new BadRequest("credits must not be zero");
      const max = limits.max_credits;
      if (max !== null && max !== undefined && Math.abs(credits) > max) {
        throw new BadRequest(`adjustments are limited to ${max} credits for this operator`);
      }
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (reason.length < 3 || reason.length > 300)
        throw new BadRequest("a reason of 3 to 300 characters is required");
      return {
        fn: "falcon_credits_adjust",
        args: { p_credits: credits, p_reason: reason, p_operator: operator },
      };
    }
    case "set_tiers":
      if (!Array.isArray(params.tiers)) throw new BadRequest("tiers must be a list");
      return { fn: "falcon_set_tiers", args: { p_tiers: params.tiers, p_operator: operator } };
    case "set_packs":
      if (!Array.isArray(params.packs)) throw new BadRequest("packs must be a list");
      return { fn: "falcon_set_packs", args: { p_packs: params.packs, p_operator: operator } };
  }
}

export async function handleFalconBridge(req: Request, deps: FalconBridgeDeps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!deps.secret) {
    console.error("[falcon-bridge] FALCON_BRIDGE_SECRET is not configured; refusing every request");
    return json(401, { error: "unauthorized" });
  }

  const timestamp = req.headers.get("x-falcon-timestamp") ?? "";
  const signature = (req.headers.get("x-falcon-signature") ?? "").toLowerCase();
  const raw = await req.text();
  const ts = Number(timestamp);
  if (!/^\d{9,11}$/.test(timestamp) || Math.abs(deps.nowSeconds() - ts) > MAX_SKEW_SECONDS) {
    return json(401, { error: "unauthorized" });
  }
  const expected = await hmacHex(deps.secret, `${timestamp}.${raw}`);
  if (!signature || !timingSafeEqual(signature, expected)) {
    console.warn("[falcon-bridge] bad signature");
    return json(401, { error: "unauthorized" });
  }

  let body: {
    request_id?: unknown;
    action?: unknown;
    params?: unknown;
    operator_email?: unknown;
    limits?: { max_credits?: unknown };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const requestId = typeof body.request_id === "string" ? body.request_id : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!UUID.test(requestId)) return json(400, { error: "request_id must be a UUID" });
  if (!ACTIONS.has(action)) return json(400, { error: "unknown action" });
  const params = (
    body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {}
  ) as Record<string, unknown>;
  const operator =
    typeof body.operator_email === "string" ? body.operator_email.trim().toLowerCase() : null;
  const maxCredits = body.limits?.max_credits;
  if (
    maxCredits !== undefined &&
    maxCredits !== null &&
    (typeof maxCredits !== "number" || !(maxCredits >= 0))
  ) {
    return json(400, { error: "limits.max_credits must be a non-negative number" });
  }
  if (WRITES.has(action as FalconAction) && (!operator || !FALCON_EMAIL.test(operator))) {
    return json(400, { error: "writes need a falconmarketing.com operator_email" });
  }

  let plan: { fn: string; args: Record<string, unknown> };
  try {
    plan = planCall(action as FalconAction, params, operator, {
      max_credits: maxCredits as number | null | undefined,
    });
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message });
    throw e;
  }

  if (!(await deps.claim(requestId, action, operator)))
    return json(409, { error: "request already used" });

  try {
    const data = await deps.rpc(plan.fn, plan.args);
    if (action === "health")
      return json(200, { ok: true, version: FALCON_BRIDGE_VERSION, overview: data });
    return json(200, { ok: true, data });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(422, { error: message.slice(0, 300) });
  }
}
