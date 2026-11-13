/** Local recurring events. Occurrences keep wall-clock time in their named zone. */
export type RecurrenceRule = {
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  timeZone: string;
  count?: number;
  until?: string;
};
export type RecurringEvent = {
  id: string;
  starts_at: string | null;
  ends_at: string | null;
  is_cancelled: boolean;
  recurrence?: RecurrenceRule | null;
  recurrence_master_id?: string | null;
  recurrence_index?: number | null;
};
export type Occurrence<T> = T & {
  recurrence_master_id: string;
  recurrence_index: number;
  recurrence: RecurrenceRule;
  series_starts_at: string;
  series_ends_at: string;
};

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(date: Date, zone: string): Wall {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const read = (name: string) => Number(parts.find((p) => p.type === name)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}
const wallNumber = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
const dateKey = (w: Wall) =>
  `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;

/** Earliest instant for a repeated wall time; nonexistent DST times are omitted. */
function wallInstant(w: Wall, zone: string): number | null {
  const utc = wallNumber(w);
  const candidates = new Set<number>();
  // Offsets on either side capture both sides of a DST transition.
  for (const delta of [-2, -1, 0, 1, 2]) {
    const probe = utc + delta * 86_400_000;
    const offset = wallNumber(wallParts(new Date(probe), zone)) - probe;
    const candidate = utc - offset;
    if (wallNumber(wallParts(new Date(candidate), zone)) === utc) candidates.add(candidate);
  }
  return candidates.size ? Math.min(...candidates) : null;
}

export function validateRecurrence(rule: RecurrenceRule, startsAt: string): string | null {
  const start = new Date(startsAt);
  if (!Number.isFinite(start.getTime())) return "Choose a valid series start.";
  if (!["daily", "weekly", "monthly"].includes(rule.frequency)) return "Choose a repeat frequency.";
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 52)
    return "Repeat interval must be between 1 and 52.";
  try {
    wallParts(start, rule.timeZone);
  } catch {
    return "Choose a valid IANA timezone.";
  }
  if ((rule.count == null) === (rule.until == null))
    return "Choose an end date or occurrence count.";
  if (rule.count != null && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 366))
    return "Choose between 1 and 366 occurrences.";
  if (rule.until != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.until)) return "Choose a valid end date.";
    const until = new Date(`${rule.until}T00:00:00Z`);
    if (!Number.isFinite(until.getTime()) || until.toISOString().slice(0, 10) !== rule.until)
      return "Choose a valid end date.";
    const startDate = dateKey(wallParts(start, rule.timeZone));
    if (rule.until < startDate) return "Series end must be on or after its start date.";
    if (until.getTime() - new Date(`${startDate}T00:00:00Z`).getTime() > 5 * 366 * 86_400_000)
      return "End the series within five years.";
  }
  return null;
}

export function expandRecurringEvent<T extends RecurringEvent>(
  master: T,
  exceptions: T[],
  from: Date,
  to: Date,
): Occurrence<T>[] {
  const rule = master.recurrence;
  if (!rule || !master.starts_at || !master.ends_at || master.is_cancelled) return [];
  const error = validateRecurrence(rule, master.starts_at);
  if (error) throw new Error(error);
  const start = new Date(master.starts_at);
  const duration = new Date(master.ends_at).getTime() - start.getTime();
  if (!(duration > 0)) return [];
  const base = wallParts(start, rule.timeZone);
  const overrides = new Map(
    exceptions
      .filter((e) => e.recurrence_master_id === master.id)
      .map((e) => [e.recurrence_index, e]),
  );
  const result: Occurrence<T>[] = [];
  let index = 0;
  for (let step = 0; step < 10_000 && index < (rule.count ?? Infinity); step++) {
    const calendar = new Date(Date.UTC(base.year, base.month - 1, base.day));
    if (rule.frequency === "monthly") {
      calendar.setUTCDate(1);
      calendar.setUTCMonth(calendar.getUTCMonth() + step * rule.interval);
      const month = calendar.getUTCMonth();
      calendar.setUTCDate(base.day);
      if (calendar.getUTCMonth() !== month) continue;
    } else
      calendar.setUTCDate(
        calendar.getUTCDate() + step * rule.interval * (rule.frequency === "weekly" ? 7 : 1),
      );
    const wall = {
      ...base,
      year: calendar.getUTCFullYear(),
      month: calendar.getUTCMonth() + 1,
      day: calendar.getUTCDate(),
    };
    if (rule.until && dateKey(wall) > rule.until) break;
    const instant = step === 0 ? start.getTime() : wallInstant(wall, rule.timeZone);
    if (instant === null) continue;
    const override = overrides.get(index);
    const occurrence = {
      ...master,
      ...override,
      id: override?.id ?? `${master.id}:${index}`,
      recurrence: rule,
      recurrence_master_id: master.id,
      recurrence_index: index,
      series_starts_at: master.starts_at,
      series_ends_at: master.ends_at,
      starts_at: override?.starts_at ?? new Date(instant).toISOString(),
      ends_at: override?.ends_at ?? new Date(instant + duration).toISOString(),
    } as Occurrence<T>;
    index++;
    const occurrenceTime = new Date(occurrence.starts_at!).getTime();
    if (
      !occurrence.is_cancelled &&
      occurrenceTime >= from.getTime() &&
      occurrenceTime < to.getTime()
    )
      result.push(occurrence);
    // End-date rules have a finite horizon. Count rules must still inspect
    // later indexes because an exception can be moved into this range.
  }
  return result.sort((a, b) => Date.parse(a.starts_at!) - Date.parse(b.starts_at!));
}
