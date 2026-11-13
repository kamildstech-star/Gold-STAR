import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  KIND_SUBTITLE_LABEL,
  dueLabel,
  dueLongLabel,
  dueWhen,
  isOverdue,
  needsAccountButton,
  quickViewFields,
  type NeedsYouItem,
} from "@/lib/needs-you-today";

/**
 * Mark, on the "Needs you today" cards: "each of these you should be able to
 * click on these and see a mini view of the details of that as a pop up"
 *
 * The picker is the part with judgement in it — which rows exist, and which
 * ones the card already said — so it is a pure function and tested as one. The
 * wiring underneath (which click opens the popup, which clicks must not) is
 * read out of the source, the way src/lib/job-calculations.columns.test.ts and
 * src/components/qty-takes-a-sum.test.ts do it; there is no DOM testing
 * library in this repo.
 */

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const TASK: NeedsYouItem = {
  item_key: "task:t1",
  kind: "task",
  title: "Send seasonal guidance email",
  account_id: "acct-1",
  account_name: "North Shore Property Mgmt",
  subtitle: "Overdue",
  due_at: minutesFromNow(-41 * 1440),
  entity_id: "t1",
  action: "complete_task",
};

describe("how late the thing is", () => {
  it("counts down on the card in the tightest unit that fits", () => {
    expect(dueLabel(minutesFromNow(-41 * 1440))).toBe("41d overdue");
    expect(dueLabel(minutesFromNow(-90))).toBe("2h overdue");
    expect(dueLabel(minutesFromNow(-5))).toBe("5m overdue");
    expect(dueLabel(minutesFromNow(30))).toBe("in 30m");
    expect(dueLabel(null)).toBe("No date");
  });

  it("spells the same distance out for the popup", () => {
    expect(dueLongLabel(minutesFromNow(-41 * 1440))).toBe("41 days overdue");
    expect(dueLongLabel(minutesFromNow(-3 * 1440))).toBe("3 days overdue");
    expect(dueLongLabel(minutesFromNow(30))).toBe("in 30 minutes");
    expect(dueLongLabel(null)).toBe("No date");
  });

  it("says one day, not one days", () => {
    expect(dueLongLabel(minutesFromNow(-2 * 1440))).toBe("2 days overdue");
    expect(dueLongLabel(minutesFromNow(-60))).toBe("1 hour overdue");
  });

  it("has no date to print when there is no date", () => {
    expect(dueWhen(null)).toBeNull();
    expect(isOverdue(null)).toBe(false);
    expect(isOverdue(minutesFromNow(-1))).toBe(true);
    expect(isOverdue(minutesFromNow(60))).toBe(false);
  });

  it("prints the date itself, because a day count does not name a Tuesday", () => {
    const when = dueWhen("2026-09-01T17:00:00.000Z");
    // American English: month name first, then the day, then a 12-hour clock.
    // The separator between date and time moves between ICU versions, so this
    // pins the two ends and not the join.
    expect(when).toMatch(/^[A-Z][a-z]+ \d{1,2}, 2026\b/);
    expect(when).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)$/);
  });
});

describe("which rows the quick view shows", () => {
  it("opens on the list row alone, before the lookup lands", () => {
    const labels = quickViewFields(TASK, null).map((f) => f.label);
    expect(labels).toEqual(["Type", "Due"]);
  });

  it("never invents a row for something it does not have", () => {
    const labels = quickViewFields(TASK, {
      statusLabel: "Open",
      priorityLabel: null,
      assigneeName: "",
      stageName: "   ",
      createdAt: null,
      notes: null,
    }).map((f) => f.label);
    expect(labels).toEqual(["Type", "Due", "Status"]);
  });

  it("fills in as the rest of the record arrives", () => {
    const fields = quickViewFields(TASK, {
      statusLabel: "Open",
      priorityLabel: "High",
      assigneeName: "Dana Reyes",
      stageName: "Active Outreach",
      createdAt: "2026-07-14T09:00:00.000Z",
      notes: "They asked for the fall version, not the spring one.",
    });
    expect(fields.map((f) => f.label)).toEqual([
      "Type",
      "Due",
      "Status",
      "Priority",
      "Assigned to",
      "Stage",
      "Created",
      "Notes",
    ]);
    expect(fields.find((f) => f.label === "Type")?.value).toBe("Task");
    expect(fields.find((f) => f.label === "Created")?.value).toContain("2026");
    expect(fields.find((f) => f.label === "Notes")?.multiline).toBe(true);
  });

  it("drops a task's subtitle, which only ever restates the due date", () => {
    // The RPC writes 'Overdue' or 'Due today' there; the Due row already said so.
    const values = quickViewFields(TASK, null).map((f) => f.value);
    expect(values).not.toContain("Overdue");
    expect(values.some((v) => /overdue/i.test(v))).toBe(true);
  });

  it("keeps every other kind's subtitle, and names what it is", () => {
    const cadence: NeedsYouItem = {
      ...TASK,
      item_key: "cadence:a1",
      kind: "cadence",
      title: "Touch overdue",
      subtitle: "Last touch 12 Mar 2026",
      entity_id: "acct-1",
      action: "log_touch",
    };
    const row = quickViewFields(cadence, null).find((f) => f.value === "Last touch 12 Mar 2026");
    expect(row?.label).toBe(KIND_SUBTITLE_LABEL.cadence);
    expect(row?.label).toBe("Last touch");
  });

  it("leaves the account out of the rows — it is a link, not a value", () => {
    const values = quickViewFields(TASK, { assigneeName: "Dana Reyes" }).map((f) => f.value);
    expect(values).not.toContain("North Shore Property Mgmt");
  });
});

describe("the way through to the account", () => {
  it("offers its own button when the action button does something else", () => {
    expect(needsAccountButton(TASK)).toBe(true);
    expect(needsAccountButton({ ...TASK, kind: "cadence", action: "log_touch" })).toBe(true);
  });

  it("does not offer the same trip twice", () => {
    expect(needsAccountButton({ ...TASK, kind: "rot", action: "open_account" })).toBe(false);
    expect(needsAccountButton({ ...TASK, kind: "annual", action: "book_meeting" })).toBe(false);
  });

  it("has nowhere to send anyone when the item has no account", () => {
    expect(needsAccountButton({ ...TASK, account_id: null })).toBe(false);
  });
});

/* -- the wiring, read out of the card ------------------------------------ */

/*
 * Normalised to LF first. Git checks this repo out with CRLF on Windows, so a
 * pattern that ends at a line break matches in one worktree and not in
 * another -- which is exactly how this test passed where it was written and
 * failed on main. A source-level test asserts on code, not on which machine
 * checked the code out.
 */
const source = readFileSync("src/components/needs-you-today.tsx", "utf8").replace(/\r\n/g, "\n");

/**
 * The card with its comments taken out. The comments in that file quote Mark
 * and explain the stopPropagation calls, so leaving them in would let an
 * explanation satisfy an assertion about the code.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function fragment(re: RegExp, what: string): string {
  const match = code.match(re);
  if (!match) throw new Error(`${what} was not found in needs-you-today.tsx`);
  return match[0];
}

/** The card element itself: the div carrying role="button" and its attributes. */
const cardElement = () => fragment(/<div\s+key=\{it\.item_key\}[\s\S]*?>\n/, "the card element");

/** The account link on the card, which must keep navigating. */
const accountLinkOnCard = () =>
  fragment(
    /<Link\s+to="\/accounts\/\$id"\s+params=\{\{ id: it\.account_id \}\}[\s\S]*?<\/Link>/,
    "the account link on the card",
  );

/** The Complete button, rendered once and used by both the card and the popup. */
const completeButton = () =>
  fragment(/\{item\.action === "complete_task"[\s\S]*?\n {6}\)\}/, "the Complete button");

describe("the card opens the popup without eating the clicks that already worked", () => {
  it("takes a click and takes a keyboard, and says so to a screen reader", () => {
    const card = cardElement();
    expect(card).toContain('role="button"');
    expect(card).toContain("tabIndex={0}");
    expect(card).toContain('aria-haspopup="dialog"');
    expect(card).toContain("onClick={() => setPreview(it)}");
    expect(card).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
    // Space scrolls the page unless the card claims it.
    expect(card).toContain("e.preventDefault()");
    // Enter pressed on the account link inside must not also open the popup.
    expect(card).toContain("if (e.target !== e.currentTarget) return;");
  });

  it("reads as clickable before it is clicked", () => {
    const card = cardElement();
    expect(card).toContain("cursor-pointer");
    expect(card).toContain("hover:bg-hover");
  });

  it("still navigates from the account link", () => {
    const link = accountLinkOnCard();
    expect(link).toContain('to="/accounts/$id"');
    expect(link).toContain("onClick={(e) => e.stopPropagation()}");
  });

  it("Complete asks how it was done (11 Nov), and does not open the popup doing it", () => {
    const button = completeButton();
    expect(button).toContain("e.stopPropagation();");
    expect(button).toContain("setCompleting(item);");
    expect(code).toContain('htmlFor="task-completion-note"');
    expect(code).toContain("{ item: completing, note: completionNote }");
  });

  it("completes through the one mutation, from the card and from the popup alike", () => {
    // `actionsFor` is rendered twice. A second completing mutation, or a second
    // call site, would be a second thing to keep in step with the first.
    expect(code.match(/const completeTask = useMutation\(/g) ?? []).toHaveLength(1);
    expect(code.match(/completeTask\.mutate\(/g) ?? []).toHaveLength(1);
    expect(code).toContain("{actionsFor(it)}");
    expect(code).toContain("{actionsFor(preview, () => setPreview(null))}");
  });

  it("closes the popup once the thing it was about is done", () => {
    expect(completeButton()).toContain("afterComplete.current = onDone;");
    expect(code).toContain("afterComplete.current?.();");
  });

  it("does not fetch the rest of the record until a card has been opened", () => {
    const detail = fragment(
      /const detailQuery = useQuery\(\{[\s\S]*?\n {2}\}\);/,
      "the detail query",
    );
    expect(detail).toContain('queryKey: ["needs-you-detail", preview?.item_key]');
    expect(detail).toContain("enabled: !!preview");
  });
});
