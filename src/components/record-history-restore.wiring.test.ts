import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source assertions for the Timeline's Restore (no DOM testing library in
 * this repo). Each check extracts the fragment it is about, so a comment in
 * the file can neither satisfy nor break it.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ROW = read("src/components/record-history-restore.tsx");
const TIMELINE = read("src/components/record-timeline.tsx");
const LIB = read("src/lib/record-history.ts");

describe("the Restore button", () => {
  it("is always on show — not the hover-reveal row-actions — so a phone has it", () => {
    const button = ROW.match(/\{canOffer && \(\s*<Button[\s\S]*?<\/Button>/);
    expect(button).not.toBeNull();
    expect(button![0]).not.toMatch(/row-actions|REVEAL_ON_HOVER|opacity-0|group-hover/);
    expect(button![0]).toMatch(/restoreVerb\(entry\.op\)/);
  });

  it("is offered on deletes and edits that have not been restored, never on a restore", () => {
    const offer = ROW.match(/const canOffer = [^;]+;/);
    expect(offer![0]).toContain('entry.op !== "restore"');
    expect(offer![0]).toContain("!entry.restoredBy");
  });

  it("asks the database what would happen before offering the confirm", () => {
    const query = ROW.match(/const preview = useQuery\(\{[\s\S]*?\}\);/);
    expect(query![0]).toContain("fetchHistoryPreview(entry.id)");
    expect(query![0]).toMatch(/staleTime: 0/);
    const action = ROW.match(/<AlertDialogAction[\s\S]*?>/);
    expect(action![0]).toMatch(/disabled=\{!ready \|\| restore\.isPending\}/);
  });

  it("shows the database's refusal in words, not toastDbError's flattening", () => {
    const onError = ROW.match(/onError: \(err\) => \{[\s\S]*?\},/);
    expect(onError![0]).toContain("restoreErrorMessage(err)");
    expect(onError![0]).not.toContain("toastDbError");
  });
});

describe("the job Timeline reads the history", () => {
  it("only for a job, merged with the activity feed", () => {
    const q = TIMELINE.match(/const history = useQuery\(\{[\s\S]*?\}\);/);
    expect(q![0]).toContain("fetchJobHistory(id)");
    expect(q![0]).toContain('enabled: type === "job"');
    expect(TIMELINE).toMatch(/mergeTimeline\(q\.data \?\? \[\], buildHistoryItems\(/);
  });

  it("renders history entries with their Restore row", () => {
    const render = TIMELINE.match(/it\.kind === "history" \? \(\s*<HistoryTimelineRow[^>]*>/);
    expect(render).not.toBeNull();
  });

  it("never selects * from record_history", () => {
    const select = LIB.match(/\.from\("record_history"\)\s*\.select\(([^)]*)\)/);
    expect(select![1]).toBe("HISTORY_COLUMNS");
  });
});
