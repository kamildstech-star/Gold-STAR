import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => ({
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  insert: vi.fn(),
  single: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => query },
}));
vi.mock("@/lib/graph.functions", () => ({ pushCalendarEvent: vi.fn(async () => ({})) }));
import { listEventAttendees, saveEvent } from "./calendar";

describe("calendar write safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
  });
  it("does not interpret a failed attendee fetch as an empty invite list", async () => {
    query.maybeSingle.mockResolvedValue({ data: null, error: new Error("Connection lost") });
    await expect(listEventAttendees("event")).rejects.toThrow("Connection lost");
  });
  it("distinguishes an inaccessible event from an event with no attendees", async () => {
    query.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(listEventAttendees("event")).rejects.toThrow("no longer accessible");
    query.maybeSingle.mockResolvedValueOnce({ data: { attendees: [] }, error: null });
    await expect(listEventAttendees("event")).resolves.toEqual([]);
  });
  it("rejects invalid event times before touching the database", async () => {
    await expect(
      saveEvent(
        {
          subject: "QA",
          event_type: "meeting",
          starts_at: "2026-09-07T12:00Z",
          ends_at: "2026-09-07T11:00Z",
          user_id: "qa",
        },
        "qa",
      ),
    ).rejects.toThrow("end must be after");
    expect(query.select).not.toHaveBeenCalled();
  });
  it("creates a local event with no provider, leaving identity to the database guard", async () => {
    // The column defaulted to 'outlook' and the guard refuses any provider on
    // a signed-in insert, so leaving it out meant every new event failed.
    query.insert.mockReturnValue(query);
    query.single.mockResolvedValue({ data: { id: "new" }, error: null });
    await saveEvent(
      {
        subject: "Inspection",
        event_type: "inspection",
        starts_at: "2026-09-07T11:00Z",
        ends_at: "2026-09-07T12:00Z",
        attendees: ["client@example.com"],
        user_id: "rep",
      },
      "rep",
    );
    const inserted = query.insert.mock.calls[0][0];
    expect(inserted).toHaveProperty("provider", null);
    expect(inserted.sync_state).toBe("pending_push");
    // Verification and the acting user are stamped by the trigger from the
    // session; the browser never sends them.
    expect(inserted).not.toHaveProperty("push_identity_verified");
    expect(inserted).not.toHaveProperty("push_actor_id");
    for (const key of ["external_id", "mailbox_id", "organizer_email"]) {
      expect(inserted).not.toHaveProperty(key);
    }
  });
});
