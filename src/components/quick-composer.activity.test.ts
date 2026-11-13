import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/email.functions", () => ({ sendEmail: vi.fn() }));

import { NOTE_TYPE, activityMode, composerTarget } from "./quick-composer";

/**
 * Melly, 6 Nov, with Pipedrive on screen: log a meeting "on the 25th" and "it
 * comes up as a task on November 25th". The composer's one rule: a date later
 * than now schedules a task; now or earlier logs it on the timeline.
 */
const NOW = new Date("2026-11-09T15:00:00");
const at = (iso: string) => new Date(iso);

describe("activityMode", () => {
  it("schedules a call or meeting dated later than now", () => {
    expect(activityMode("meeting", at("2026-11-25T10:00:00"), NOW)).toBe("schedule");
    expect(activityMode("call", at("2026-11-09T16:00:00"), NOW)).toBe("schedule");
  });

  it("logs a call, meeting or email dated now or earlier", () => {
    expect(activityMode("call", at("2026-11-09T15:00:00"), NOW)).toBe("log");
    expect(activityMode("meeting", at("2026-11-02T12:00:00"), NOW)).toBe("log");
    expect(activityMode("email", at("2026-11-09T14:30:00"), NOW)).toBe("log");
    expect(activityMode("site_visit", at("2026-11-09T09:00:00"), NOW)).toBe("log");
  });

  it("allows a minute's slack so 'now' is not read as the future", () => {
    expect(activityMode("call", at("2026-11-09T15:00:45"), NOW)).toBe("log");
  });

  it("always schedules a task or a deadline, whatever the date", () => {
    expect(activityMode("task", at("2026-11-01T09:00:00"), NOW)).toBe("schedule");
    expect(activityMode("deadline", at("2026-11-09T09:00:00"), NOW)).toBe("schedule");
  });

  it("saves a note as a note, whatever the date", () => {
    expect(activityMode(NOTE_TYPE, at("2026-12-01T09:00:00"), NOW)).toBe("note");
  });
});

describe("composerTarget", () => {
  it("opens Activity with the type a caller asked for", () => {
    expect(composerTarget("call")).toEqual({ tab: "activity", type: "call" });
    expect(composerTarget("note")).toEqual({ tab: "activity", type: NOTE_TYPE });
    expect(composerTarget("meeting")).toEqual({ tab: "activity", type: "meeting" });
  });

  it("opens any other tab as itself", () => {
    expect(composerTarget("email")).toEqual({ tab: "email", type: null });
    expect(composerTarget("invoice")).toEqual({ tab: "invoice", type: null });
  });
});
