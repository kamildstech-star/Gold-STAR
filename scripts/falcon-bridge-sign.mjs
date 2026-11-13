#!/usr/bin/env node
// Call a project's falcon-bridge exactly the way the Falcon Console does, so a
// developer can test their bridge without console access.
//
//   BRIDGE_URL=https://<ref>.supabase.co/functions/v1/falcon-bridge \
//   BRIDGE_SECRET=<the shared secret> \
//   node sign-bridge-request.mjs <action> ['<params JSON>'] [operator_email] [max_credits|null]
//
// Examples:
//   node sign-bridge-request.mjs health
//   node sign-bridge-request.mjs usage_month '{"month":"2026-11"}'
//   node sign-bridge-request.mjs ledger '{"limit":20,"kind":"usage"}'
//   node sign-bridge-request.mjs adjust_credits '{"credits":100,"reason":"bridge test"}' test@falconmarketing.com 1000
//
// Use writes (adjust_credits, set_tiers, set_packs) on STAGING only. Every
// production write must go through the console so it is audit-logged there.
// Never commit the secret or paste it into chat; pass it through the environment.
//
// Node 18+ (global fetch and crypto). No dependencies.
import { createHmac, randomUUID } from "node:crypto";

const [
  ,
  ,
  action,
  paramsJson = "{}",
  operator = "test@falconmarketing.com",
  maxCreditsArg = "null",
] = process.argv;
const url = process.env.BRIDGE_URL;
const secret = process.env.BRIDGE_SECRET;
if (!action || !url || !secret) {
  console.error(
    "usage: BRIDGE_URL=… BRIDGE_SECRET=… node sign-bridge-request.mjs <action> [params JSON] [operator_email] [max_credits|null]",
  );
  process.exit(2);
}

const maxCredits = maxCreditsArg === "null" ? null : Number(maxCreditsArg);
// Same field order and serialisation as the console. The signature covers the raw body.
const body = JSON.stringify({
  request_id: randomUUID(),
  action,
  params: JSON.parse(paramsJson),
  operator_email: operator,
  limits: { max_credits: maxCredits },
});
const ts = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-falcon-timestamp": ts,
    "x-falcon-signature": signature,
  },
  body,
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
process.exit(res.ok ? 0 : 1);
