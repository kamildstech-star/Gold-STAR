/**
 * What the card is allowed to say.
 *
 * The point of the rebuild is that a rep can tell the read apart from the row
 * count, and can check any read line against the timeline below it. So: the
 * two halves are labelled differently, every observation prints its date and
 * quote, and a model outage produces a sentence saying so — never a blank card
 * and never a suggestion with no source.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineReadResult } from "@/lib/timeline-read.functions";

const state = vi.hoisted(() => ({
  read: null as TimelineReadResult | null,
  /** The cache lookup is still in flight — i.e. this is a page load. */
  readLoading: false,
  focus: [] as Array<{
    key: string;
    severity: "danger" | "warn" | "info";
    title: string;
    detail: string;
    action: string;
  }>,
}));

vi.mock("@/components/app-context", () => ({
  useWritesDisabled: () => ({ disabled: false, reason: null }),
  // The card's heading goes through the language setting; English here.
  useAppContext: () => ({ userId: null, primary: "admin" }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const isRead = queryKey[0] === "account-timeline-read";
    const loading = isRead && state.readLoading;
    return {
      // react-query hands you no data at all while the first fetch is open.
      data: loading ? undefined : isRead ? state.read : state.focus,
      isLoading: loading,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("@/lib/timeline-read.functions", () => ({
  accountTimelineRead: {},
  dismissTimelineObservation: {},
}));
vi.mock("@/lib/account-focus", () => ({
  FOCUS_ACTION_LABEL: { view_tasks: "See tasks" },
  dismissFocus: vi.fn(),
  fetchAccountFocus: vi.fn(),
  restoreFocus: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { ProspectSuggestionCard } from "./account-prospect/prospect-suggestion-card";
import { TimelineReadPanel } from "./timeline-read-panel";

function result(over: Partial<TimelineReadResult> = {}): TimelineReadResult {
  return {
    status: "ok",
    items: [],
    stale: false,
    readThrough: null,
    generatedAt: null,
    entryCount: 12,
    message: null,
    ...over,
  };
}

const OBSERVATION = {
  key: "timeline_read:abc",
  headline: "They asked about overnight response time and never got an answer",
  detail: "The inbound call raised it; nothing since mentions response times.",
  date: "2026-07-29",
  sourceLabel: "Call",
  quote: "asked about response time for an overnight loss",
  entryId: "comm:a",
};

beforeEach(() => {
  state.read = null;
  state.readLoading = false;
  state.focus = [];
});

describe("the timeline read panel", () => {
  it("prints the date and the words each observation came from", () => {
    state.read = result({ items: [OBSERVATION], readThrough: "2026-08-03T17:13:12.000Z" });
    const html = renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "account" }));
    expect(html).toContain("What the AI read");
    expect(html).toContain("never got an answer");
    // The receipt: a rep can find this exact line in the Timeline card below.
    expect(html).toContain("07/29/2026");
    expect(html).toContain("asked about response time for an overnight loss");
    expect(html).toContain('aria-label="Dismiss observation"');
  });

  it("says the read is unavailable rather than inventing one", () => {
    state.read = result({
      status: "unavailable",
      message: "The timeline read is unavailable right now. The checks below are still up to date.",
    });
    const html = renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "account" }));
    expect(html).toContain("unavailable right now");
    expect(html).not.toContain('aria-label="Dismiss observation"');
  });

  it("says so when there is too little history, and when nothing stood out", () => {
    state.read = result({ status: "insufficient", entryCount: 2, message: null });
    expect(renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "a" }))).toContain(
      "too little history",
    );

    state.read = result({ items: [] });
    expect(renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "a" }))).toContain(
      "nothing stood out",
    );
  });

  /**
   * The QC failure this file did not catch: the code was right — a page view
   * cannot reach the model — but the section announced "Looking for an existing
   * read…" while the cache lookup was open, which is indistinguishable to a rep
   * from the work we said would not happen. A page load must be silent.
   */
  it("says nothing at all while the load-time cache lookup is open", () => {
    state.readLoading = true;
    const onLoad = renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "a" }));

    // No progress of any kind: no message, no spinner, no skeleton. The
    // trailing ellipsis is how every one of these announcements is written.
    expect(onLoad).not.toContain("…");
    expect(onLoad).not.toMatch(/looking|loading|fetching|checking|searching|please wait/i);
    expect(onLoad).not.toContain("animate-spin");
    expect(onLoad).not.toContain("animate-pulse");
    expect(onLoad).not.toContain("aria-busy");
    expect(onLoad).not.toContain('role="status"');
    expect(onLoad).not.toContain('role="progressbar"');

    // What it shows instead is the invitation, exactly as an un-read account
    // looks once the lookup has come back empty — byte for byte, so a future
    // "just a small placeholder" cannot creep back in.
    state.readLoading = false;
    state.read = result({ status: "none" });
    expect(onLoad).toBe(renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "a" })));
    expect(onLoad).toContain("Read the history");
  });

  it("offers a read on demand instead of buying one on every page view", () => {
    state.read = result({ status: "none" });
    const fresh = renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "a" }));
    expect(fresh).toContain("has not been read yet");
    expect(fresh).toContain("Read the history");

    state.read = result({ items: [OBSERVATION], stale: true });
    const moved = renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "a" }));
    expect(moved).toContain("Re-read");
    expect(moved).toContain("The timeline has moved since this read.");
  });

  it("still offers Re-read on a current stored read", () => {
    // A stored, up-to-date read used to render no action at all, which left a
    // rep unable to refresh it or to discover what the button does.
    state.read = result({ items: [OBSERVATION], stale: false });
    const current = renderToStaticMarkup(createElement(TimelineReadPanel, { accountId: "a" }));
    expect(current).toContain("Re-read");
    expect(current).not.toContain("The timeline has moved since this read.");
  });
});

describe("the card as a whole", () => {
  it("stops calling a row count an AI suggestion", () => {
    state.read = result({ items: [OBSERVATION] });
    state.focus = [
      {
        key: "overdue_tasks",
        severity: "danger",
        title: "Overdue tasks on this account",
        detail: "5 task(s) past their due date",
        action: "view_tasks",
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ProspectSuggestionCard, { accountId: "account", onAction: vi.fn() }),
    );
    // The next step leads, labelled as a record check; the read follows under
    // its own honest label. Neither is passed off as the other.
    expect(html).toContain("Next step");
    expect(html.indexOf("On the record")).toBeLessThan(html.indexOf("What the AI read"));
    // The mechanical signals survive, next to the read, presented as checks.
    expect(html).toContain("Overdue tasks on this account");
    expect(html).toContain("See tasks");
    expect(html).not.toContain("AI Suggestion");
  });
});
