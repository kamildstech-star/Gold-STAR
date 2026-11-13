/**
 * The order of the job page's tabs, and whether the strip has more to show.
 *
 * Fifteen tabs do not fit on a phone. In the office order the three a crew
 * opens all day — Drying log, Equipment and Field Form — were twelfth to
 * fourteenth, about 800px of swiping at 375px, and the people who use those
 * tabs most are exactly the people holding a phone in a wet building. The
 * phone-width audit (PR #278) put it plainly: "Put the field tabs first for
 * crew, or add a fade mask." This does both, because they fix different
 * things: the order puts a crew member's tabs under their thumb, the fade
 * tells everyone else that the strip goes on.
 *
 * The order follows the PRIMARY role, the same way the bilingual labels do
 * (`label-language.ts`): crew and legacy field technicians get the field
 * order, everyone else keeps the office order they already know. Field
 * chasers are not here for the same reason they are not bilingual by default
 * — they sell, and their job page is contacts, pictures and documents, not
 * the drying log. Someone who is both an admin and on a crew is looked at as
 * the admin.
 *
 * By role and not by screen width: a tab that moves when the phone is turned
 * sideways, or between the phone and the truck's tablet, is a tab nobody can
 * find by memory. No tab is hidden from anyone — this decides order only, and
 * what each tab shows is still each tab's own business.
 */
import type { AppRole } from "@/lib/roles";

/*
 * FE6, 28 Oct (Oct 26 call — layout only, for David to confirm): labor sits
 * beside the money. Timecard (the job's labor hours and rates) moved from
 * tenth to straight after Billing, where the job's client rates (the T&M
 * rate sheet, on the bill) and the job's categories on the bill already are,
 * so the office reads labor, rates and billing in one place. The crew's field
 * order below is unchanged.
 */
export const JOB_TABS = [
  "general",
  "contacts",
  "tasks",
  "pictures",
  "documents",
  // 10 Nov (David): "billing should be ... at least after documents".
  // Timecard stays straight after it (FE6).
  "billing",
  "timecard",
  "communications",
  "timeline",
  "schedule",
  "rooms",
  "drying",
  "equipment",
  "ticket",
  "portal",
] as const;
export type JobTab = (typeof JOB_TABS)[number];

export const JOB_TAB_LABEL: Record<JobTab, string> = {
  general: "General",
  contacts: "Contacts",
  tasks: "Tasks",
  billing: "Billing",
  pictures: "Pictures",
  documents: "Documents",
  communications: "Communications",
  timeline: "Timeline",
  schedule: "Schedule",
  timecard: "Timecard",
  rooms: "Rooms",
  drying: "Drying log",
  equipment: "Equipment",
  ticket: "Field Form",
  // David, 24 Sep: "a separate portal... only whatever is shared to them on a
  // job-by-job basis" — the sharing is chosen on this tab, per job.
  portal: "Customer portal",
};

/**
 * Tabs that sit behind "More" instead of on the strip (meeting 3 Nov: the top
 * bar was too cluttered — "move the timeline and time cards under the
 * dropdown"; their content overlaps Billing). Every tab is still one click
 * away, and the customer portal stays on the bar.
 */
// 5 Nov: with four tabs merged there is room, so Timecard and Timeline are
// back on the strip and "More" is gone ("take this in normal tabs list").
export const JOB_TABS_IN_MORE: readonly JobTab[] = [];

/**
 * Tabs folded into another tab (5 Nov: thirteen tabs to nine, so the strip
 * stops needing "More"; 6 Nov: Tasks and Equipment back out, eleven on the bar). Nothing went away — each one is a section of the
 * tab it joined, and its key still opens it: `?tab=tasks`, a History link,
 * an in-app "open Tasks" button all land on the new tab, scrolled to the
 * section. See `jobTabHome` and the job page's `section` param.
 */
export const JOB_TAB_MERGED_INTO: Readonly<Partial<Record<JobTab, JobTab>>> = {
  // 6 Nov evening (David, ops): "Pictures should be on the top bar — don't
  // hide or consolidate it under any other option." It is a tab again.
  communications: "contacts",
  // J3 (5 Nov, round 2): Timeline is a section of General, Timecard of Billing.
  timeline: "general",
  timecard: "billing",
  // 6 Nov: the customer portal's sharing choices sit under Contacts.
  portal: "contacts",
  /*
   * Tasks and Equipment are NOT here any more. David, 6 Nov call: "Equipment
   * should be up here on top" and "tasks could be up here — I want as much
   * as I could have accessible without having to multi-click". Both are
   * tabs on the strip again; Tasks keeps its place after Contacts and
   * Equipment sits before Field Form, where the crew reaches for it.
   */
};

/** The tab on the strip that shows `tab`: itself, or the tab it was merged into. */
export function jobTabHome(tab: JobTab): JobTab {
  return JOB_TAB_MERGED_INTO[tab] ?? tab;
}

/** A merged tab's key: a section on another tab, not a tab of its own. */
export function isJobSection(tab: JobTab): boolean {
  return JOB_TAB_MERGED_INTO[tab] != null;
}

/** The roles whose day on a job is the drying log, the gear and the field form. */
export const FIELD_TAB_ORDER_ROLES: readonly AppRole[] = ["crew", "field"];

/**
 * What a crew member reaches for, in the order they reach for it. General
 * stays first because it is where every job opens and where the notes are;
 * the next three are the daily readings, the gear on site and the ticket,
 * which together fit on a 375px screen beside General. Pictures and Rooms
 * follow because a reading or a placement usually starts from one. Whatever
 * is left keeps its office order behind them.
 */
const FIELD_FIRST: readonly JobTab[] = [
  "general",
  "drying",
  "equipment",
  "ticket",
  "pictures",
  "rooms",
  "timecard",
  "tasks",
  "schedule",
];

/** The tabs the strip shows, in office order: every tab not merged into another. */
export const JOB_BAR_TABS: readonly JobTab[] = JOB_TABS.filter((t) => !isJobSection(t));

export function jobTabOrder(primary: AppRole | null | undefined): readonly JobTab[] {
  if (!primary || !FIELD_TAB_ORDER_ROLES.includes(primary)) return JOB_BAR_TABS;
  const first = FIELD_FIRST.filter((t) => !isJobSection(t));
  return [...first, ...JOB_BAR_TABS.filter((t) => !first.includes(t))];
}

/**
 * Which edges of a horizontally scrolling strip have tabs hidden past them.
 *
 * A strip clipped at a tab boundary looks finished, so the fade is the only
 * hint that there is more. It shows only on an edge that really has more —
 * a fade over the last tab once you have reached it reads as a rendering
 * fault. `slack` absorbs the sub-pixel scrollLeft a zoomed or high-DPI phone
 * reports at the very end, which would otherwise leave the fade stuck on.
 */
export function stripFade(
  m: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  slack = 2,
): { start: boolean; end: boolean } {
  const overflow = m.scrollWidth - m.clientWidth;
  if (overflow <= slack) return { start: false, end: false };
  return {
    start: m.scrollLeft > slack,
    end: m.scrollLeft < overflow - slack,
  };
}
