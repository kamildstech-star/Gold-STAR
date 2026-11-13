import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), upsert: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b = { middleware: () => b, inputValidator: () => b, handler: (fn: unknown) => fn };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./graph.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph.server")>()),
  createCalendarEvent: vi.fn(async () => ({ id: "graph-event" })),
  graphConfigured: vi.fn(() => true),
  getMessage: vi.fn(),
}));
import { createGraphMeeting } from "./graph.functions";
import { ingestEvents, processNotification } from "./graph-sync.server";
import * as graph from "./graph.server";
beforeEach(() => {
  vi.clearAllMocks();
  // Schema compatibility, not token routing: run it in application mode.
  vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
  mocks.from.mockImplementation((table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      not: () => q,
      range: async () => ({
        data: [{ id: "contact", account_id: null, email: "client@example.com" }],
      }),
      maybeSingle: async () => ({
        data: {
          id: "mailbox",
          upn: "own@example.com",
          user_id: "caller",
          location_id: null,
          enabled: true,
        },
      }),
      single: async () => ({ data: { id: "event", touchpoint_id: null }, error: null }),
      upsert: mocks.upsert,
    };
    if (table === "calendar_events") mocks.upsert.mockReturnValue(q);
    return q;
  });
});
// These two used to assert the opposite: the integrity columns were not live,
// so writing them would have broken ingest. They are live now, and the push
// worker asks calendar_push_authorized_event, which refuses unverified rows.
it("creates a meeting marked verified, acting as the session user", async () => {
  await (createGraphMeeting as unknown as (arg: unknown) => Promise<unknown>)({
    data: {
      fromUpn: "own@example.com",
      subject: "Test",
      startIso: "2099-01-01T10:00:00Z",
      endIso: "2099-01-01T11:00:00Z",
      attendees: ["client@example.com"],
      // Client input never names the actor.
      push_actor_id: "someone-else",
    },
    context: { userId: "caller", supabase: {} },
  });
  expect(mocks.upsert).toHaveBeenCalledTimes(1);
  expect(mocks.upsert.mock.calls[0][0].push_identity_verified).toBe(true);
  expect(mocks.upsert.mock.calls[0][0].push_actor_id).toBe("caller");
  expect(mocks.upsert.mock.calls[0][0].external_id).toBe("graph-event");
});
it("ingests Graph events marked verified, leaving who may push to the next editor", async () => {
  await ingestEvents({ id: "mailbox", upn: "own@example.com", user_id: "caller" } as never, [
    {
      id: "graph-event",
      attendees: [{ emailAddress: { address: "client@example.com" } }],
      start: { dateTime: "2099-01-01T10:00:00" },
      end: { dateTime: "2099-01-01T11:00:00" },
    },
  ]);
  expect(mocks.upsert).toHaveBeenCalledTimes(1);
  expect(mocks.upsert.mock.calls[0][0].push_identity_verified).toBe(true);
  expect(mocks.upsert.mock.calls[0][0].mailbox_id).toBe("mailbox");
  expect(mocks.upsert.mock.calls[0][0]).not.toHaveProperty("push_actor_id");
  expect(mocks.upsert.mock.calls[0][0].external_id).toBe("graph-event");
});
it.each([
  { sync_mail: false, messages_subscription_expires_at: "2099-01-01" },
  { sync_mail: true, messages_subscription_expires_at: "2000-01-01" },
  { sync_mail: true, messages_subscription_expires_at: null },
])("retains disabled/expired notification rejection %j", async (flags) => {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: { enabled: true, ...flags } }),
  };
  mocks.from.mockReturnValue(q);
  await processNotification({
    subscriptionId: "sub",
    resourceId: "message",
    resource: "users/a/messages/message",
  });
  expect(graph.getMessage).not.toHaveBeenCalled();
});
