import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_ROUTES } from "@/lib/security/public-surface";

/**
 * Every API route, called with NO credential at all, refuses by itself.
 *
 * The secrets each route checks are configured (so the refusal is about the
 * caller, not a missing server setting), and the database client is replaced
 * with one that fails the test if touched: a route that reached the database
 * before rejecting would be caught here, not by an attacker.
 */
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));
const touched = vi.hoisted(() => ({ db: false }));
vi.mock("@/integrations/supabase/client.server", () => {
  const trap = new Proxy(
    {},
    {
      get() {
        touched.db = true;
        throw new Error("the database was reached without a credential");
      },
    },
  );
  return { supabaseAdmin: trap };
});
vi.mock("@/lib/rate-limit.server", () => ({
  throttleWebhook: async () => null,
  guardByIp: async () => null,
  guardByKey: async () => null,
}));

const SECRETS = [
  "CRON_SECRET",
  "OUTLOOK_WEBHOOK_CLIENT_STATE",
  "RESEND_WEBHOOK_SECRET",
  "AUTO_CAPTURE_WEBHOOK_SECRET",
  "CALLRAIL_WEBHOOK_SECRET",
  "EQUIPMENT_TRACKER_WEBHOOK_SECRET",
  "INCIDENT_WEBHOOK_SECRET",
  "RAVEN_WEBHOOK_SECRET",
];

beforeEach(() => {
  touched.db = false;
  for (const s of SECRETS) vi.stubEnv(s, "configured-test-secret-value-0123456789");
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
});
afterEach(() => vi.unstubAllEnvs());

type Handler = (input: { request: Request; params: Record<string, string> }) => Promise<Response>;

/** Link-token and user routes take path params; these are valid-shaped but unknown. */
const PARAMS: Record<string, Record<string, string>> = {
  "src/routes/api/share.$token.photo.$id.ts": {
    token: "not-a-real-token",
    id: "01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  },
  "src/routes/api/review.$token.ts": { token: "not-a-uuid" },
  "src/routes/api/documents.$id.file.ts": { id: "00000000-0000-4000-8000-000000000001" },
};

describe("API routes refuse a caller with no credential", () => {
  for (const [file, entry] of Object.entries(API_ROUTES)) {
    it(`${file} (${entry.credential})`, async () => {
      const mod = (await import(/* @vite-ignore */ `/${file}`)) as {
        Route: { server: { handlers: Record<string, Handler> } };
      };
      const handlers = mod.Route.server.handlers;
      expect(Object.keys(handlers).length).toBeGreaterThan(0);
      for (const [method, handler] of Object.entries(handlers)) {
        // Graph's subscription handshake is public by design: it echoes the
        // validationToken it is sent, and nothing else. Its notifications
        // (POST without the token) are tested like every other route.
        if (entry.credential === "graph-client-state" && method === "GET") continue;
        const request = new Request(`https://hub.test/${file}`, {
          method,
          headers: { "content-type": "application/json" },
          body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify({ value: [{}] }),
        });
        let status: number;
        try {
          status = (await handler({ request, params: PARAMS[file] ?? {} })).status;
        } catch {
          status = 401; // a thrown refusal is still a refusal
        }
        expect(status, `${method} ${file}`).toBeGreaterThanOrEqual(400);
        expect(touched.db, `${method} ${file} reached the database`).toBe(false);
      }
    });
  }
});
