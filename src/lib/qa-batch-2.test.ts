import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { tradeshowEventId, tradeshowToEvent } from "@/lib/calendar";
import { documentDisplayName, documentTypeLabel } from "@/lib/documents";

/**
 * The second batch of fixes from the live read-only QA of 2026-09-16
 * (qa-guards/live-report.md), findings 8 to 12.
 *
 * Most of these are UI wiring, which this repo tests by reading the source —
 * there is no DOM testing library here, and `src/components/qty-takes-a-sum.test.ts`
 * set the precedent. The genuinely logical parts are pulled out as pure
 * functions and exercised directly.
 */

/* ---------------------------------------------------------- 8. Documents */

describe("a document with nothing to show still shows itself", () => {
  it("names a document that arrived without one", () => {
    // The Documents list printed "10 documents" above nine legible rows and
    // one blank band. The tenth was real; it just had nothing to render.
    expect(documentDisplayName("")).toBe("Untitled document");
    expect(documentDisplayName("   ")).toBe("Untitled document");
    expect(documentDisplayName(null)).toBe("Untitled document");
    expect(documentDisplayName(undefined)).toBe("Untitled document");
  });

  it("leaves a real name alone", () => {
    expect(documentDisplayName("Champion_Health_Care_Locations.xlsx")).toBe(
      "Champion_Health_Care_Locations.xlsx",
    );
  });

  it("labels a document type this build has never heard of", () => {
    expect(documentTypeLabel("contract")).toBe("Contract");
    // A doc_type written by a newer migration indexed to undefined and left
    // the cell empty; the raw value is worse than a label and better than air.
    expect(documentTypeLabel("something_new")).toBe("something_new");
    expect(documentTypeLabel(null)).toBe("—");
  });

  it("renders the list through those fallbacks, so no row can come out blank", () => {
    const src = readFileSync("src/routes/_authenticated/documents.index.tsx", "utf8");
    expect(src).toContain("documentDisplayName(d.name)");
    expect(src).toContain("documentTypeLabel(d.doc_type)");
    // The raw reads are what produced the blank row.
    expect(src).not.toMatch(/>\{d\.name\}</);
    expect(src).not.toContain("DOCUMENT_TYPE_LABEL[d.doc_type]");
  });

  it("counts the documents it is about to draw", () => {
    // `shown` comes from `rows` and every row renders, so the stat tile and
    // the list agree once the blank row is legible again.
    const src = readFileSync("src/routes/_authenticated/documents.index.tsx", "utf8");
    expect(src).toContain("documentsInFolder(rows, folders, activeFolder)");
    expect(src).toMatch(/value: rows\.length\.toLocaleString\("en-US"\)/);
  });
});

describe("a missing thumbnail is a missing thumbnail, not a server fault", () => {
  it("answers 404 rather than 502 when the thumb object cannot be read", () => {
    const src = readFileSync("src/routes/api/documents.$id.file.ts", "utf8");
    const thumb = src.slice(src.indexOf('if (variant === "thumb")'));
    expect(thumb).toContain('fail(404, "This document has no thumbnail yet.")');
    // 403 stays itself: the object is genuinely refused, so re-making the
    // thumbnail would fail the same way and nobody should try.
    expect(thumb).toContain("upstream.status === 403");
  });

  it("stops the client reading a 5xx as 'you may not have this'", () => {
    /*
     * probeThumbnail mapped anything that was not 200/404 to "denied", and a
     * denial stops the generator running. So one 502 from storage left the
     * document without a thumbnail for good, on top of the console error.
     */
    const src = readFileSync("src/lib/document-thumbnails.ts", "utf8");
    const probe = src.slice(src.indexOf("async function probeThumbnail"));
    expect(probe).toContain('if (res.status >= 500) return "missing"');
    expect(probe).toContain('if (res.status === 404) return "missing"');
    expect(probe).toMatch(/catch \{[\s\S]{0,200}return "missing"/);
  });

  it("still lands every failure on the typed icon", () => {
    const src = readFileSync("src/components/document-viewer.tsx", "utf8");
    expect(src).toContain('onError={() => setState({ kind: "none" })}');
  });
});

/* ---------------------------------------------------------- 9. Calendar */

describe("a scheduled tradeshow is on the calendar", () => {
  const show = {
    id: "7185d970-4182-40ba-9efa-bf2960998018",
    name: "IICRC Restoration",
    city: "Brooklyn",
    state: "NY",
    starts_on: "2026-09-09",
    ends_on: "2026-09-12",
    location_id: "loc-1",
    notes: null,
  };

  it("becomes a tradeshow-typed, all-day event", () => {
    const ev = tradeshowToEvent(show);
    expect(ev.event_type).toBe("tradeshow");
    expect(ev.is_all_day).toBe(true);
    expect(ev.subject).toBe("IICRC Restoration");
    expect(ev.starts_at).toBe("2026-09-09T00:00:00.000Z");
  });

  it("covers every day it runs, the last one included", () => {
    // Half-open: a show ending on the 12th must still occupy the 12th, so the
    // event runs to the start of the 13th.
    expect(tradeshowToEvent(show).ends_at).toBe("2026-09-13T00:00:00.000Z");
  });

  it("occupies its single day when there is no end date", () => {
    const oneDay = tradeshowToEvent({ ...show, ends_on: null });
    expect(oneDay.starts_at).toBe("2026-09-09T00:00:00.000Z");
    expect(oneDay.ends_at).toBe("2026-09-10T00:00:00.000Z");
  });

  it("carries the office and the place, so the page filters still bite", () => {
    const ev = tradeshowToEvent(show);
    expect(ev.location_id).toBe("loc-1");
    expect(ev.location_text).toBe("Brooklyn, NY");
  });

  it("is marked as derived, and never looks like a stored row", () => {
    const ev = tradeshowToEvent(show);
    expect(ev.derived).toEqual({ kind: "tradeshow", id: show.id });
    expect(ev.id).toBe(tradeshowEventId(show.id));
    expect(ev.id).not.toBe(show.id);
  });

  it("falls back to a name rather than an empty chip", () => {
    expect(tradeshowToEvent({ ...show, name: "   " }).subject).toBe("Tradeshow");
  });

  it("is unioned into the calendar read, beside the recurring events", () => {
    const src = readFileSync("src/lib/calendar.ts", "utf8");
    expect(src).toContain("listTradeshowEvents(f)");
    expect(src).toMatch(/\.\.\.recurring,\s*\.\.\.tradeshows/);
    // Asking for only some types must not smuggle tradeshows back in.
    expect(src).toMatch(/if \(!f\.types\.includes\("tradeshow"\)\) return \[\]/);
  });

  it("never lets a derived event be dragged, deleted or edited as a row", () => {
    const src = readFileSync("src/routes/_authenticated/calendar.tsx", "utf8");
    expect(src).toContain("draggable={!ev.derived}");
    expect(src).toContain("if (ev && !ev.derived) move.mutate({ ev, day })");
    expect(src).toContain('derived?.kind === "tradeshow"');
    expect(src).not.toContain("onOpen={setEditing}");
  });
});

/* ------------------------------------------------- 10 & 12. Page labels */

describe("the page is called what the menu called it", () => {
  it("titles /projects 'Pictures', as the sidebar does", () => {
    const src = readFileSync("src/routes/_authenticated/projects.index.tsx", "utf8");
    expect(src).toContain('title="Pictures"');
    expect(src).toContain('{ title: "Pictures · Recovery Hub" },');
    expect(src).not.toContain('title="Projects"');
    expect(src).not.toContain("Projects · Recovery Hub");
  });

  it("sends you back to 'Pictures' from one project", () => {
    const src = readFileSync("src/routes/_authenticated/projects.$id.tsx", "utf8");
    expect(src).toContain('label="Pictures"');
  });

  it("keeps the route itself at /projects", () => {
    // Only the visible labels change; a bookmarked URL still resolves.
    const src = readFileSync("src/routes/_authenticated/projects.index.tsx", "utf8");
    expect(src).toContain('createFileRoute("/_authenticated/projects/")');
  });

  it("gives Intake forms the same gutter as every other page", () => {
    const src = readFileSync("src/routes/_authenticated/intake-inbox.tsx", "utf8");
    expect(src).toContain('<div className="page-shell space-y-3">');
  });
});

/* ------------------------------------------------------ 11. The 404 script */

describe("the service worker is not registered until it is known to be there", () => {
  const src = readFileSync("src/lib/register-sw.ts", "utf8");

  it("probes the script first", () => {
    /*
     * `register()` rejecting is not the problem: the browser logs "A bad HTTP
     * response code (404) was received when fetching the script" itself, and a
     * .catch() cannot unsay it.
     */
    expect(src).toContain("registerIfServed");
    expect(src).toMatch(/fetch\(SW_URL, \{ method: "GET", cache: "no-store" \}\)/);
    expect(src).toContain("if (!res.ok) return;");
  });

  it("declines a host that answers with the SPA's HTML instead", () => {
    expect(src).toMatch(/type\.includes\("html"\)/);
  });

  it("keeps every existing guard — dev, iframes and preview hosts", () => {
    expect(src).toContain("if (!import.meta.env.PROD) return true;");
    expect(src).toContain("window.self !== window.top");
    expect(src).toContain('h.startsWith("preview--")');
    expect(src).toContain('.get("sw") === "off"');
  });
});
