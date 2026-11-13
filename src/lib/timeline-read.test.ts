/**
 * The three things that can go wrong with a timeline read, in order of how
 * much they would cost:
 *
 *  1. sending the model something it should not have, or leaving out the thing
 *     that makes the read worth having;
 *  2. regenerating on every page view, which is the token bill Mark asked
 *     about twice;
 *  3. printing a confident observation citing a date nothing happened on.
 */
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "@/lib/account-timeline";
import {
  MAX_DIGEST_ENTRIES,
  MIN_REGENERATE_INTERVAL_MS,
  buildTimelineDigest,
  buildTimelineReadPrompt,
  isStale,
  needsRegeneration,
  observationKey,
  parseTimelineRead,
} from "@/lib/timeline-read";

const NOW = new Date("2026-09-09T12:00:00.000Z");

function entry(over: Partial<TimelineEntry> & { id: string; at: string }): TimelineEntry {
  return {
    kind: "note",
    title: "Note",
    subtitle: null,
    body: null,
    source: null,
    chips: [],
    ...over,
  } as TimelineEntry;
}

/** A small but realistic history: a question, a promise, a stated deadline. */
function history(): TimelineEntry[] {
  return [
    entry({
      id: "comm:a",
      kind: "call",
      at: "2026-07-29T17:13:12.000Z",
      title: "Inbound call",
      body: "Inbound: asked about response time for an overnight loss.",
      source: "Dialer",
      call: {
        direction: "inbound",
        durationSeconds: 240,
        outcome: "connected",
        recordingUrl: "https://rec.example.com/x.mp3",
      },
    }),
    entry({
      id: "note:b",
      at: "2026-06-11T17:13:11.000Z",
      title: "Note",
      body: "Budget cycle resets in Q1 — revisit onboarding then.",
    }),
    entry({
      id: "task:c",
      kind: "task",
      at: "2026-07-22T17:13:11.000Z",
      title: "Chase COI renewal",
      subtitle: "Dana Ruiz · due August 26, 2026",
      overdue: true,
      source: "Automation rule",
    }),
    entry({
      id: "touch:d",
      kind: "meeting",
      at: "2026-06-30T17:13:11.000Z",
      title: "In-person meeting",
      body: "On-site meeting — walked two buildings, discussed response times.",
      source: "Web App",
    }),
    entry({
      id: "email:e",
      kind: "email",
      at: "2026-08-03T17:13:12.000Z",
      title: "Vendor onboarding paperwork",
      email: {
        from: "rep@goldstar.example",
        to: ["office@ridgeave.example"],
        subject: "Vendor onboarding paperwork",
        preview: "Sending the packet over — we'll have the COI back to you by Friday.",
        hasAttachment: true,
        isPrivate: false,
      },
    }),
  ];
}

describe("buildTimelineDigest — what the model is shown", () => {
  it("carries the words a rep would have had to read the whole timeline for", () => {
    const d = buildTimelineDigest(history(), { now: NOW });
    const text = d.lines.join("\n");
    expect(d.entryCount).toBe(5);
    expect(text).toContain("Budget cycle resets in Q1");
    expect(text).toContain("asked about response time for an overnight loss");
    expect(text).toContain("we'll have the COI back to you by Friday");
    // The channel pattern only exists if addresses survive.
    expect(text).toContain("office@ridgeave.example");
    // Outcome and overdue state are facts about the entry, not counts.
    expect(text).toContain("outcome connected");
    expect(text).toContain("past its due date");
  });

  it("reads forwards and hands out short handles instead of record ids", () => {
    const d = buildTimelineDigest(history(), { now: NOW });
    const dates = d.lines.map((l) => l.split(" | ")[1]!);
    expect(dates).toEqual([...dates].sort());
    expect(d.lines[0]!.startsWith("E1 | 2026-06-11")).toBe(true);
    expect(d.refs.map((r) => r.ref)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    // No internal ids reach the model — it cannot echo one into a suggestion.
    expect(d.lines.join("\n")).not.toContain("comm:a");
    expect(d.refs.find((r) => r.ref === "E4")?.entryId).toBe("comm:a");
  });

  it("excludes photos, invoices, private mail, links and anything older than the window", () => {
    const entries = [
      ...history(),
      entry({
        id: "photo:x",
        kind: "photo",
        at: "2026-08-01T00:00:00.000Z",
        title: "9 photos uploaded",
      }),
      entry({
        id: "invoice:x",
        kind: "invoice",
        at: "2026-08-02T00:00:00.000Z",
        title: "Invoice INV-4410",
        subtitle: "paid · due September 1, 2026",
      }),
      entry({
        id: "email:private",
        kind: "email",
        at: "2026-08-04T00:00:00.000Z",
        title: "Private thread",
        email: {
          from: "a@b.c",
          to: ["d@e.f"],
          subject: "Private thread",
          preview: "internal only",
          hasAttachment: false,
          isPrivate: true,
        },
      }),
      entry({
        id: "note:ancient",
        at: "2024-01-01T00:00:00.000Z",
        title: "Note",
        body: "ancient history",
      }),
      entry({
        id: "note:link",
        at: "2026-08-05T00:00:00.000Z",
        body: "Signed copy at https://files.example.com/s/abc?token=secret",
      }),
    ];
    const text = buildTimelineDigest(entries, { now: NOW }).lines.join("\n");

    expect(text).not.toContain("photos uploaded");
    expect(text).not.toContain("INV-4410");
    expect(text).not.toContain("Private thread");
    expect(text).not.toContain("internal only");
    expect(text).not.toContain("ancient history");
    // A call recording is never offered at all, and a link pasted into a
    // note is stripped: both are credentialed access the model cannot use.
    expect(text).not.toContain("https://rec.example.com");
    expect(text).not.toContain("token=secret");
    expect(text).toContain("[link removed]");
  });

  it("keeps only the newest entries when a record is enormous", () => {
    const many = Array.from({ length: MAX_DIGEST_ENTRIES + 25 }, (_, i) =>
      entry({
        id: `note:${i}`,
        at: new Date(NOW.getTime() - i * 86_400_000).toISOString(),
        body: `entry ${i}`,
      }),
    );
    const d = buildTimelineDigest(many, { now: NOW });
    expect(d.entryCount).toBe(MAX_DIGEST_ENTRIES);
    expect(d.totalEntries).toBe(MAX_DIGEST_ENTRIES + 25);
    expect(d.lines.join("\n")).toContain("entry 0");
    expect(d.lines.join("\n")).not.toContain("entry 70");
  });

  it("names dismissed headlines in the prompt so they do not come straight back", () => {
    const d = buildTimelineDigest(history(), { now: NOW });
    const prompt = buildTimelineReadPrompt(d, {
      accountName: "Ridge Avenue Realty Partners",
      now: NOW,
      dismissedHeadlines: ["Their Q1 budget note has come and gone"],
    });
    expect(prompt).toContain("Today is 2026-09-09");
    expect(prompt).toContain("Ridge Avenue Realty Partners");
    expect(prompt).toContain("ALREADY DISMISSED BY THIS REP");
    expect(prompt).toContain("- Their Q1 budget note has come and gone");
  });
});

describe("needsRegeneration — the token bill", () => {
  const digest = buildTimelineDigest(history(), { now: NOW });
  const mark = {
    fingerprint: digest.fingerprint,
    latestEntryAt: digest.latestEntryAt,
    entryCount: digest.entryCount,
    generatedAt: "2026-09-01T00:00:00.000Z",
  };

  it("never regenerates while the timeline is unchanged, however many views", () => {
    for (let view = 0; view < 100; view++) {
      expect(needsRegeneration(mark, digest, { now: NOW })).toBe(false);
    }
    expect(isStale(mark, digest)).toBe(false);
  });

  it("regenerates once the timeline has actually advanced", () => {
    const moved = buildTimelineDigest(
      [
        ...history(),
        entry({ id: "note:new", at: "2026-09-08T09:00:00.000Z", body: "they called back" }),
      ],
      { now: NOW },
    );
    expect(moved.fingerprint).not.toBe(digest.fingerprint);
    expect(isStale(mark, moved)).toBe(true);
    expect(needsRegeneration(mark, moved, { now: NOW })).toBe(true);
  });

  it("notices an edit in place, not just a new row", () => {
    const edited = history();
    edited[1] = entry({
      id: "note:b",
      at: "2026-06-11T17:13:11.000Z",
      body: "Budget cycle resets in Q2 now.",
    });
    expect(buildTimelineDigest(edited, { now: NOW }).fingerprint).not.toBe(digest.fingerprint);
  });

  it("generates the first time, and holds off during the cooldown even when history moved", () => {
    expect(needsRegeneration(null, digest, { now: NOW })).toBe(true);

    const moved = buildTimelineDigest(
      [...history(), entry({ id: "note:new", at: "2026-09-09T11:00:00.000Z", body: "fresh" })],
      { now: NOW },
    );
    const justNow = { ...mark, generatedAt: new Date(NOW.getTime() - 60_000).toISOString() };
    expect(needsRegeneration(justNow, moved, { now: NOW })).toBe(false);

    const older = {
      ...mark,
      generatedAt: new Date(NOW.getTime() - MIN_REGENERATE_INTERVAL_MS - 1000).toISOString(),
    };
    expect(needsRegeneration(older, moved, { now: NOW })).toBe(true);
  });
});

describe("parseTimelineRead — a citation that cannot be checked is not shown", () => {
  const digest = buildTimelineDigest(history(), { now: NOW });
  const good = {
    headline: "Their stated Q1 budget reset has passed with no follow-up",
    detail: "The note says to revisit onboarding when the budget resets. Nothing since.",
    entry_ref: "E1",
    date: "2026-06-11",
    quote: "Budget cycle resets in Q1",
  };

  it("accepts an observation that points at a real line", () => {
    const out = parseTimelineRead({ observations: [good] }, digest);
    expect(out.rejected).toEqual([]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.date).toBe("2026-06-11");
    expect(out.items[0]!.sourceLabel).toBe("Note");
    expect(out.items[0]!.entryId).toBe("note:b");
    expect(out.items[0]!.key).toBe(observationKey("note:b", good.headline));
  });

  it("rejects a response citing a date that is not in the input", () => {
    const out = parseTimelineRead(
      {
        observations: [
          {
            headline: "They promised a decision at the March review",
            detail: "Chase it.",
            entry_ref: "E1",
            date: "2026-03-14",
            quote: "decision at the March review",
          },
        ],
      },
      digest,
    );
    expect(out.items).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toBe("cited a date not present in the timeline");
  });

  it("rejects a real date pinned to the wrong entry, and an invented handle", () => {
    const wrongEntry = parseTimelineRead({ observations: [{ ...good, entry_ref: "E5" }] }, digest);
    expect(wrongEntry.items).toEqual([]);
    expect(wrongEntry.rejected[0]!.reason).toBe("date does not match the cited entry");

    const noSuchRef = parseTimelineRead({ observations: [{ ...good, entry_ref: "E99" }] }, digest);
    expect(noSuchRef.items).toEqual([]);
    expect(noSuchRef.rejected[0]!.reason).toBe("cited an entry that was not supplied");
  });

  it("rejects a quote the cited entry never contained", () => {
    const out = parseTimelineRead(
      { observations: [{ ...good, quote: "we will match any competitor's price" }] },
      digest,
    );
    expect(out.items).toEqual([]);
    expect(out.rejected[0]!.reason).toBe("quote is not in the cited entry");
  });

  it("keeps a dismissed observation dismissed, even reworded", () => {
    const key = observationKey("note:b", good.headline);
    const same = parseTimelineRead({ observations: [good] }, digest, {
      dismissedKeys: new Set([key]),
    });
    expect(same.items).toEqual([]);
    expect(same.rejected[0]!.reason).toBe("dismissed by this user");

    // Punctuation and case changes must not mint a new key.
    const reworded = parseTimelineRead(
      {
        observations: [
          { ...good, headline: "THEIR STATED Q1 BUDGET RESET HAS PASSED, with no follow-up!" },
        ],
      },
      digest,
      { dismissedKeys: new Set([key]) },
    );
    expect(reworded.items).toEqual([]);
  });

  it("survives junk, and caps how much it will show", () => {
    expect(parseTimelineRead(null, digest).items).toEqual([]);
    expect(parseTimelineRead({}, digest).items).toEqual([]);
    expect(parseTimelineRead({ observations: "nope" }, digest).items).toEqual([]);
    expect(parseTimelineRead({ observations: [{ detail: "no headline" }] }, digest).items).toEqual(
      [],
    );
    expect(parseTimelineRead({ insufficient: true, observations: [] }, digest).insufficient).toBe(
      true,
    );

    const many = Array.from({ length: 9 }, (_, i) => ({
      ...good,
      headline: `Observation number ${i} about the budget note`,
    }));
    expect(parseTimelineRead({ observations: many }, digest).items.length).toBeLessThanOrEqual(3);
  });

  it("drops a second observation making the same point about the same entry", () => {
    const out = parseTimelineRead(
      { observations: [good, { ...good, detail: "Said differently." }] },
      digest,
    );
    expect(out.items).toHaveLength(1);
    expect(out.rejected[0]!.reason).toBe("duplicate of an earlier observation");
  });
});
