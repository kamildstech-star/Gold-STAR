/** Reject invalid ranges before converting dates or writing an event. */
export function validateEventTimes(start: string, end: string): string | null {
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "Enter a valid start and end time.";
  if (to <= from) return "The end must be after the start.";
  return null;
}
