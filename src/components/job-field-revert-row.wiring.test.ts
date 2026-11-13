import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source assertions for the job field Revert (no DOM testing library here).
 * Each check extracts its own fragment so a comment cannot satisfy it.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const ROW = read("src/components/job-field-revert-row.tsx");
const TIMELINE = read("src/components/record-timeline.tsx");

describe("the job field Revert", () => {
  it("is always on show, never hover-revealed", () => {
    const button = ROW.match(/\{canOffer && \(\s*<Button[\s\S]*?<\/Button>/);
    expect(button).not.toBeNull();
    expect(button![0]).not.toMatch(/row-actions|REVEAL_ON_HOVER|opacity-0|group-hover/);
  });

  it("previews before it reverts, and only a ready state enables the button", () => {
    const q = ROW.match(/const state = useQuery\(\{[\s\S]*?\}\);/);
    expect(q![0]).toContain("fetchFieldChangeState(edit.id)");
    const action = ROW.match(/<AlertDialogAction[\s\S]*?>/);
    expect(action![0]).toMatch(/disabled=\{!ready \|\| revert\.isPending\}/);
  });

  it("the Timeline swaps in grouped field edits only once the migration is there", () => {
    const merge = TIMELINE.match(/const items = useMemo\(\(\) => \{[\s\S]*?\}, \[/);
    expect(merge![0]).toContain("if (!fieldChanges.data?.available) return merged;");
    expect(merge![0]).toContain("withFieldEdits(merged, groupFieldChanges(");
    const q = TIMELINE.match(/const fieldChanges = useQuery\(\{[\s\S]*?\}\);/);
    expect(q![0]).toContain('enabled: type === "job"');
  });
});
