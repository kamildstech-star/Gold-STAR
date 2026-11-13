import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ mailbox: vi.fn(), body: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b = { middleware: () => b, inputValidator: () => b, handler: (fn: unknown) => fn };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: mocks.mailbox };
      return q;
    },
  },
}));
vi.mock("@/lib/graph.server", () => ({
  getMessageBody: mocks.body,
  APP_AUTH: { kind: "application" },
}));
import { graphMessageBody } from "./graph.functions";
beforeEach(() => {
  vi.clearAllMocks();
  // The authorization under test is the app's own (assertCanSendAs); token
  // routing for delegated mode is graph-auth.server.test.ts.
  vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
  mocks.body.mockResolvedValue({ content: "mail" });
});
async function read(userId: string) {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({
      data: { external_id: "forged-message", mailbox_id: "victim-mailbox" },
    }),
  };
  return (graphMessageBody as unknown as (input: unknown) => Promise<unknown>)({
    data: { communicationId: "owned-row" },
    context: {
      userId,
      supabase: { from: () => q, rpc: async () => ({ data: false }) },
    },
  });
}
it("blocks a caller-owned communication pointing at another user's mailbox", async () => {
  mocks.mailbox.mockResolvedValue({
    data: { upn: "victim@example.com", user_id: "victim", location_id: null, enabled: true },
  });
  await expect(read("attacker")).rejects.toThrow("cannot send as");
  expect(mocks.body).not.toHaveBeenCalled();
});
it("allows the mailbox owner to fetch its body", async () => {
  mocks.mailbox.mockResolvedValue({
    data: { upn: "victim@example.com", user_id: "victim", location_id: null, enabled: true },
  });
  await expect(read("victim")).resolves.toEqual({ content: "mail" });
});
