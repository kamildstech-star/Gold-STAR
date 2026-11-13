import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it } from "vitest";

import { _resetRecordViewMemory, recallRecordView, rememberRecordView } from "./record-view-memory";

/**
 * David, 22 Sep: "if I go here now, and now I go back to it... it still jumps
 * out of that screen. It has to save where you're at."
 */

function fakeStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

beforeEach(() => _resetRecordViewMemory());

describe("remembering where somebody was on a record", () => {
  it("knows nothing about a record never visited", () => {
    expect(recallRecordView("job:1", fakeStore())).toEqual({});
  });

  it("keeps the tab and the scroll, merged, per record", () => {
    const store = fakeStore();
    rememberRecordView("job:1", { tab: "billing" }, store);
    rememberRecordView("job:1", { scrollTop: 840 }, store);
    rememberRecordView("job:2", { tab: "tasks" }, store);
    expect(recallRecordView("job:1", store)).toEqual({ tab: "billing", scrollTop: 840 });
    expect(recallRecordView("job:2", store)).toEqual({ tab: "tasks" });
  });

  it("survives a reload through session storage", () => {
    const store = fakeStore();
    rememberRecordView("job:1", { tab: "documents", scrollTop: 300 }, store);
    _resetRecordViewMemory();
    expect(recallRecordView("job:1", store)).toEqual({ tab: "documents", scrollTop: 300 });
  });

  it("ignores junk in storage rather than restoring it", () => {
    const store = fakeStore();
    store.data.set("record-view:job:1", "{not json");
    expect(recallRecordView("job:1", store)).toEqual({});
    store.data.set("record-view:job:2", JSON.stringify({ tab: 7, scrollTop: "far" }));
    expect(recallRecordView("job:2", store)).toEqual({});
  });

  it("still works when the browser refuses storage", () => {
    const refusing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    rememberRecordView("job:1", { tab: "billing" }, refusing);
    expect(recallRecordView("job:1", refusing)).toEqual({ tab: "billing" });
  });
});

const PAGE = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8").replace(/\r\n/g, "\n");
const LIB = readFileSync("src/lib/record-view-memory.ts", "utf8").replace(/\r\n/g, "\n");

describe("the job record", () => {
  it("opens on General unless the URL names a tab — David, 20 Oct", () => {
    expect(PAGE).toContain('const tab: JobTab = search.tab ?? "general";');
    expect(PAGE).not.toMatch(/recallRecordView|rememberRecordView|useRecordScrollMemory/);
  });

  it("keeps the open tab on the URL, so a reload stays on it (FE4)", () => {
    const setTab = PAGE.match(/const setTab = useCallback\([\s\S]*?\n {2}\);/)![0];
    // 5 Nov: a merged tab's name opens the tab it joined, at its inner tab.
    // Round 2: Equipment is a section of General, so General keeps a section too.
    expect(setTab).toMatch(/home === "general"\s*\?\s*isJobSection\(asked\)/);
    expect(setTab).toContain("{ tab: home, section: asked }");
    expect(setTab).toContain("replace: true");
  });

  it("takes a record link's params off the URL but keeps the tab", () => {
    // The inner tab (section) is state too, so it stays.
    expect(PAGE).toMatch(
      /search: search\.tab\s*\?\s*\{ tab: search\.tab, \.\.\.\(search\.section \? \{ section: search\.section \} : \{\}\) \}/,
    );
  });
});

describe("the scroll memory itself", () => {
  it("keeps the scroll position in the shell's scrollport", () => {
    expect(LIB).toContain('anchor.current?.closest("main")');
  });

  it("does not save the next page's scroll as this record's", () => {
    const onScroll = LIB.match(/const onScroll = \(\) => \{[\s\S]*?\n {4}\};/);
    expect(onScroll![0]).toContain("if (!anchor.current?.isConnected) return;");
  });

  it("refreshes in place after a save instead of going back to Loading…", () => {
    const reload = PAGE.match(/const reload = async \(\) => \{[\s\S]*?\n {2}\};/)![0];
    expect(reload).toContain("if (shownJobId.current !== id) setLoading(true);");
    expect(reload).not.toMatch(/^\s*setLoading\(true\);/m);
    expect(reload).toContain("shownJobId.current = id;");
  });
});
