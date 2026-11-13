import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * What a "Needs you today" card knows, and what its quick view prints.
 *
 * Mark: "each of these you should be able to click on these and see a mini
 * view of the details of that as a pop up"
 *
 * The strip is deliberately one line per thing, so the card can only ever show
 * a title, a countdown and an account name. That is enough to scan and not
 * enough to decide with, which is why the card used to be a dead rectangle
 * with two live bits on it. The quick view is the rest of the record, and the
 * field picking lives here rather than in the JSX so it can be tested without
 * a DOM.
 *
 * The rule for the picker is that a row only exists if there is something in
 * it. An empty "Notes —" line reads as "somebody checked and there is nothing
 * to know", which is a different and worse claim than staying quiet.
 */

export type NeedsYouKind = "meeting" | "task" | "cadence" | "annual" | "rot" | "approval";

/** One row of `needs_you_today(_user_id, _all)`. */
export type NeedsYouItem = {
  item_key: string;
  kind: NeedsYouKind;
  title: string;
  account_id: string | null;
  account_name: string;
  subtitle: string | null;
  due_at: string | null;
  entity_id: string | null;
  action: string;
};

export const KIND_LABEL: Record<NeedsYouKind, string> = {
  meeting: "Meeting",
  task: "Task",
  cadence: "Cadence touch",
  annual: "Annual meeting",
  rot: "Rotting deal",
  approval: "Lead approval",
};

/**
 * The RPC packs a different fact into `subtitle` for every kind, so the quick
 * view names it rather than printing it under a shrug of a heading.
 */
export const KIND_SUBTITLE_LABEL: Record<NeedsYouKind, string> = {
  meeting: "When and who",
  task: "Timing",
  cadence: "Last touch",
  annual: "Window",
  rot: "Time in stage",
  approval: "Approval",
};

export function isOverdue(due: string | null): boolean {
  return due ? new Date(due).getTime() < Date.now() : false;
}

function distance(due: string) {
  const diffMin = Math.round((new Date(due).getTime() - Date.now()) / 60000);
  const abs = Math.abs(diffMin);
  if (abs < 60) return { late: diffMin < 0, n: abs, unit: "minute" };
  if (abs < 60 * 48) return { late: diffMin < 0, n: Math.round(abs / 60), unit: "hour" };
  return { late: diffMin < 0, n: Math.round(abs / 1440), unit: "day" };
}

/** The countdown on the card itself: "41d overdue", "in 3h". */
export function dueLabel(due: string | null): string {
  if (!due) return "No date";
  const { late, n, unit } = distance(due);
  const short = `${n}${unit[0]}`;
  return late ? `${short} overdue` : `in ${short}`;
}

/** The same countdown with room to breathe: "41 days overdue". */
export function dueLongLabel(due: string | null): string {
  if (!due) return "No date";
  const { late, n, unit } = distance(due);
  if (n === 0) return "Due now";
  const spelled = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return late ? `${spelled} overdue` : `in ${spelled}`;
}

/** The date itself, because "41 days overdue" does not tell you which Tuesday. */
export function dueWhen(due: string | null): string | null {
  if (!due) return null;
  return new Date(due).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);
}

/**
 * Everything the quick view found that the list row did not already carry.
 * Every field is optional: the popup opens on whatever is in hand and fills in
 * as the lookup lands, so clicking a card is never a wait.
 */
export type NeedsYouDetail = {
  statusLabel?: string | null;
  priorityLabel?: string | null;
  assigneeName?: string | null;
  stageName?: string | null;
  createdAt?: string | null;
  notes?: string | null;
};

/** The actions whose button is already a link to the account record. */
export const ACTIONS_THAT_OPEN_THE_ACCOUNT = ["open_meeting", "book_meeting", "open_account"];

/**
 * Whether the quick view needs its own "Open account" button. Items whose
 * action button already goes there would otherwise offer the same trip twice
 * under two different words.
 */
export function needsAccountButton(item: NeedsYouItem): boolean {
  return !!item.account_id && !ACTIONS_THAT_OPEN_THE_ACCOUNT.includes(item.action);
}

export type QuickViewField = {
  label: string;
  value: string;
  /** Notes are a body of text, not a value — the popup gives them a whole row. */
  multiline?: boolean;
};

/**
 * The rows of the quick view, in reading order. The account is not among them:
 * it is a link through to the record and the popup renders it as one.
 */
export function quickViewFields(
  item: NeedsYouItem,
  detail: NeedsYouDetail | null,
): QuickViewField[] {
  const fields: QuickViewField[] = [{ label: "Type", value: KIND_LABEL[item.kind] }];

  const when = dueWhen(item.due_at);
  if (when) fields.push({ label: "Due", value: `${when} · ${dueLongLabel(item.due_at)}` });

  /*
   * For a task the RPC writes "Overdue" or "Due today" into `subtitle`, which
   * is the Due row again in fewer words. Every other kind puts a fact there
   * that exists nowhere else on the card, so only the task drops it.
   */
  if (item.subtitle && item.kind !== "task") {
    fields.push({ label: KIND_SUBTITLE_LABEL[item.kind], value: item.subtitle });
  }

  const add = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) fields.push({ label, value: value.trim() });
  };

  add("Status", detail?.statusLabel);
  add("Priority", detail?.priorityLabel);
  add("Assigned to", detail?.assigneeName);
  add("Stage", detail?.stageName);
  add("Created", dateOnly(detail?.createdAt));

  if (detail?.notes && detail.notes.trim()) {
    fields.push({ label: "Notes", value: detail.notes.trim(), multiline: true });
  }

  return fields;
}
