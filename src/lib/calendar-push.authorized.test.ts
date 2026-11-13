import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The push worker lets the database decide (calendar_push_authorized_event)
 * and pushes only what it authorises, through the mailbox it names. One test
 * per way an event can arrive at the queue, plus the refusals.
 *
 * The fake below answers the RPC with whatever a test sets, and serves
 * `graph_mailboxes` with the filters the code sends, so the app-side second
 * opinion (`resolveMailboxForEvent`) is exercised for real.
 */
type Mailbox = {
  id: string;
  upn: string;
  user_id: string | null;
  location_id: string | null;
  enabled: boolean;
  sync_calendar: boolean;
};
const state = vi.hoisted(() => ({
  mailboxes: [] as Mailbox[],
  rpc: { data: null as unknown, error: null as { code: string; message: string } | null },
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: unknown) => {
      state.rpcCalls.push({ fn, args });
      return state.rpc;
    },
    from: (table: string) => {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let patch: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          if (patch) state.updates.push({ id: v, patch });
          else filters.push((r) => r[k] === v);
          return patch ? Promise.resolve({ error: null }) : q;
        },
        is: (k: string, v: unknown) => {
          filters.push((r) => r[k] === v);
          return q;
        },
        order: () => q,
        limit: () => q,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return q;
        },
        maybeSingle: async () => {
          const rows = table === "graph_mailboxes" ? state.mailboxes : [];
          const hit = rows.find((r) => filters.every((f) => f(r as never)));
          return { data: hit ?? null, error: null };
        },
      };
      return q;
    },
  },
}));
import { pushCalendarRow } from "./calendar-push.server";
import * as graph from "./graph.server";

const mailbox = (over: Partial<Mailbox>): Mailbox => ({
  id: "m",
  upn: "m@example.com",
  user_id: null,
  location_id: null,
  enabled: true,
  sync_calendar: true,
  ...over,
});
const event = (over: Record<string, unknown> = {}) =>
  ({
    id: "event",
    provider: null,
    external_id: null,
    mailbox_id: null,
    organizer_email: null,
    user_id: "rep-a",
    location_id: "office",
    sync_direction: "outbound",
    sync_state: "pending_push",
    subject: "Inspection",
    starts_at: "2099-01-01T10:00:00Z",
    ends_at: "2099-01-01T11:00:00Z",
    attendees: [{ email: "client@example.com" }],
    is_cancelled: false,
    is_demo: false,
    ...over,
  }) as never;
const synced = (over: Record<string, unknown> = {}) =>
  event({
    provider: "outlook",
    external_id: "AAMk-1",
    mailbox_id: "own",
    organizer_email: "own@example.com",
    sync_direction: "two_way",
    ...over,
  });

const authorise = (row: Record<string, unknown>, box: { id: string; upn: string }) => {
  state.rpc = { data: { row, mailbox: box }, error: null };
};
const refuse = (message: string, code = "42501") => {
  state.rpc = { data: null, error: { code, message } };
};

let calls: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  // Authorization, not token routing (graph-auth.server.test.ts covers that):
  // run in application mode so a cleared push reaches Graph.
  vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
  vi.restoreAllMocks();
  state.updates = [];
  state.rpcCalls = [];
  state.rpc = { data: null, error: null };
  state.mailboxes = [
    mailbox({ id: "own", upn: "own@example.com", user_id: "rep-a" }),
    mailbox({ id: "colleague", upn: "colleague@example.com", user_id: "rep-b" }),
    mailbox({ id: "shared", upn: "office@example.com", location_id: "office" }),
  ];
  calls = [
    vi.spyOn(graph, "createCalendarEvent").mockResolvedValue({ id: "new-id" } as never),
    vi.spyOn(graph, "updateCalendarEvent").mockResolvedValue(undefined as never),
    vi.spyOn(graph, "cancelCalendarEvent").mockResolvedValue(undefined as never),
    vi.spyOn(graph, "deleteCalendarEvent").mockResolvedValue(undefined as never),
  ];
});
const graphUntouched = () => {
  for (const c of calls) expect(c).not.toHaveBeenCalled();
};
const lastPatch = () => state.updates.at(-1)?.patch ?? {};

describe("rows that never reach Outlook settle without asking the database", () => {
  it.each([
    ["a local-only event", event({ sync_direction: "local" })],
    ["demo data", synced({ is_demo: true })],
    ["a draft with no attendees", event({ attendees: [] })],
    ["a draft canceled before it was pushed", event({ is_cancelled: true })],
  ])("%s", async (_label, row) => {
    const out = await pushCalendarRow(row);
    expect(out).toMatchObject({ ok: true, action: "skip" });
    expect(state.rpcCalls).toHaveLength(0);
    expect(lastPatch().sync_state).toBe("clean");
    graphUntouched();
  });
});

describe("origin: synced from Outlook", () => {
  it("pushes an edit through the mailbox the database names, using its fresh row", async () => {
    // The queue's copy is older than what the database authorised.
    authorise(
      { ...(synced({ subject: "Moved inspection" }) as object) },
      {
        id: "own",
        upn: "own@example.com",
      },
    );
    const out = await pushCalendarRow(synced({ subject: "Inspection" }));
    expect(state.rpcCalls).toEqual([
      { fn: "calendar_push_authorized_event", args: { _event_id: "event" } },
    ]);
    expect(out).toMatchObject({ ok: true, action: "update" });
    expect(graph.updateCalendarEvent).toHaveBeenCalledWith(
      "own@example.com",
      "AAMk-1",
      expect.objectContaining({ subject: "Moved inspection" }),
      { kind: "application" },
    );
  });

  it("reports, and does not send, an event whose identity was never verified", async () => {
    refuse("Calendar push is not verified: its Outlook identity was never confirmed by a sync");
    const out = await pushCalendarRow(synced());
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    expect(out.reason).toContain("never confirmed by a sync");
    expect(lastPatch().sync_state).toBe("pending_push");
    expect(lastPatch().sync_error).toContain("never confirmed by a sync");
    graphUntouched();
  });

  it("reports a colleague editing an event in someone else's personal mailbox", async () => {
    refuse("Calendar editor cannot act as this mailbox");
    const out = await pushCalendarRow(synced({ mailbox_id: "colleague" }));
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    expect(lastPatch().sync_error).toContain("cannot act as this mailbox");
    graphUntouched();
  });

  it("never treats 'no mailbox' as a quiet skip once the event is in Outlook", async () => {
    refuse("No connected mailbox for this event", "P0002");
    const out = await pushCalendarRow(synced());
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    graphUntouched();
  });

  it("gives up after the usual attempts and shows up as stuck", async () => {
    refuse("The mailbox this event belongs to is disabled or has calendar sync off");
    const out = await pushCalendarRow(synced({ sync_attempts: 4 }));
    expect(out).toMatchObject({ ok: false, stuck: true });
    expect(lastPatch().sync_state).toBe("error");
  });
});

describe("origin: created in the CRM calendar", () => {
  it("creates it in the creator's own mailbox and marks the new identity verified", async () => {
    authorise({ ...(event() as object) }, { id: "own", upn: "own@example.com" });
    const out = await pushCalendarRow(event());
    expect(out).toMatchObject({ ok: true, action: "create" });
    expect(graph.createCalendarEvent).toHaveBeenCalledWith("own@example.com", expect.anything(), {
      kind: "application",
    });
    expect(lastPatch()).toMatchObject({
      sync_state: "pushed",
      provider: "outlook",
      external_id: "new-id",
      mailbox_id: "own",
      push_identity_verified: true,
    });
  });

  it("creates it in a shared office mailbox when the person has none", async () => {
    state.mailboxes = state.mailboxes.filter((m) => m.id !== "own");
    authorise({ ...(event() as object) }, { id: "shared", upn: "office@example.com" });
    const out = await pushCalendarRow(event());
    expect(out).toMatchObject({ ok: true, action: "create" });
    expect(graph.createCalendarEvent).toHaveBeenCalledWith(
      "office@example.com",
      expect.anything(),
      { kind: "application" },
    );
  });

  it("stays a Recovery Hub entry when nobody has a connected mailbox for it", async () => {
    refuse("No connected mailbox for this event", "P0002");
    const out = await pushCalendarRow(event());
    expect(out).toMatchObject({ ok: true, action: "skip" });
    expect(out.reason).toContain("stays in Recovery Hub");
    expect(lastPatch().sync_state).toBe("clean");
    graphUntouched();
  });

  it("reports one created for a colleague by someone who may not send as them", async () => {
    refuse("Calendar editor cannot act as this mailbox");
    const out = await pushCalendarRow(event({ user_id: "rep-b" }));
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    graphUntouched();
  });
});

describe("defense in depth", () => {
  it("refuses when the database and the app rule name different mailboxes", async () => {
    // A function loosened later to hand out a colleague's mailbox.
    authorise({ ...(event() as object) }, { id: "colleague", upn: "colleague@example.com" });
    const out = await pushCalendarRow(event());
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    expect(out.reason).toContain("disagree");
    graphUntouched();
  });

  it("refuses when the database answers without a mailbox", async () => {
    state.rpc = { data: { row: {} }, error: null };
    const out = await pushCalendarRow(synced());
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    graphUntouched();
  });

  it("fails closed on a transport error rather than pushing", async () => {
    refuse("fetch failed", "");
    const out = await pushCalendarRow(event());
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    graphUntouched();
  });
});
