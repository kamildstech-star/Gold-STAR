import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Calendar push must never retarget an event to a mailbox other than its own.
 * It used to fall back to the organiser's address, the person's mailbox and
 * then any mailbox in the office whenever the event's own mailbox was off.
 *
 * The fake `graph_mailboxes` table below applies the filters the code asks
 * for, so a test passes only when the right filters are actually sent.
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
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    // The database refuses a disabled mailbox too (20261007140000); the app
    // rule below is the second opinion and is tested on its own.
    rpc: async () => ({
      data: null,
      error: {
        code: "42501",
        message: "The mailbox this event belongs to is disabled or has calendar sync off",
      },
    }),
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
import { pushCalendarRow, resolveMailboxForEvent } from "./calendar-push.server";
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
    sync_direction: "two_way",
    sync_state: "pending_push",
    subject: "Inspection",
    starts_at: "2099-01-01T10:00:00Z",
    ends_at: "2099-01-01T11:00:00Z",
    attendees: ["client@example.com"],
    is_cancelled: false,
    is_demo: false,
    ...over,
  }) as never;

beforeEach(() => {
  vi.restoreAllMocks();
  state.updates = [];
  state.mailboxes = [
    mailbox({ id: "own", upn: "own@example.com", user_id: "rep-a", enabled: false }),
    mailbox({
      id: "colleague",
      upn: "colleague@example.com",
      user_id: "rep-b",
      location_id: "office",
    }),
    mailbox({ id: "shared", upn: "office@example.com", location_id: "office" }),
    mailbox({ id: "boss", upn: "boss@example.com", user_id: "boss" }),
  ];
});

describe("resolveMailboxForEvent", () => {
  it("does not fall back when the event's own mailbox is disabled", async () => {
    expect(
      await resolveMailboxForEvent(
        event({ mailbox_id: "own", organizer_email: "boss@example.com", external_id: "x" }),
      ),
    ).toBeNull();
  });
  it("does not fall back when the event's own mailbox has calendar sync off", async () => {
    state.mailboxes[0] = { ...state.mailboxes[0], enabled: true, sync_calendar: false };
    expect(await resolveMailboxForEvent(event({ mailbox_id: "own" }))).toBeNull();
  });
  it("uses the event's own mailbox when it is on", async () => {
    state.mailboxes[0] = { ...state.mailboxes[0], enabled: true };
    expect(await resolveMailboxForEvent(event({ mailbox_id: "own" }))).toEqual({
      id: "own",
      upn: "own@example.com",
    });
  });
  it("refuses an Outlook event that has lost its mailbox, whatever the organiser says", async () => {
    expect(
      await resolveMailboxForEvent(
        event({ provider: "outlook", external_id: "x", organizer_email: "boss@example.com" }),
      ),
    ).toBeNull();
  });
  it("never picks a colleague's personal mailbox for a new event, only a shared one", async () => {
    expect(await resolveMailboxForEvent(event())).toEqual({
      id: "shared",
      upn: "office@example.com",
    });
    state.mailboxes = state.mailboxes.filter((m) => m.id !== "shared");
    expect(await resolveMailboxForEvent(event())).toBeNull();
  });
  it("prefers the person's own mailbox for a new event", async () => {
    state.mailboxes[0] = { ...state.mailboxes[0], enabled: true };
    expect(await resolveMailboxForEvent(event())).toEqual({ id: "own", upn: "own@example.com" });
  });
});

describe("pushCalendarRow", () => {
  it("sends nothing to Outlook and keeps the row's mailbox when its own is disabled", async () => {
    const calls = [
      vi.spyOn(graph, "createCalendarEvent"),
      vi.spyOn(graph, "updateCalendarEvent"),
      vi.spyOn(graph, "cancelCalendarEvent"),
      vi.spyOn(graph, "deleteCalendarEvent"),
    ];
    const out = await pushCalendarRow(
      event({ mailbox_id: "own", provider: "outlook", external_id: "x" }),
    );
    expect(out).toMatchObject({ ok: false, action: "blocked" });
    for (const c of calls) expect(c).not.toHaveBeenCalled();
    // The only write is the retry bookkeeping; nothing re-homes the event.
    for (const u of state.updates) expect(u.patch).not.toHaveProperty("mailbox_id");
    expect(state.updates.some((u) => u.patch.sync_state === "pending_push")).toBe(true);
  });
});
