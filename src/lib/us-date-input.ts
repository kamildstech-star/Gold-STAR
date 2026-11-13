/**
 * The text a date field shows and accepts: always MM/DD/YYYY, whatever the
 * computer's region is set to. A native `<input type="date">` draws its own
 * box in the operating system's order, so on a machine set to English (UK)
 * the T&M bill's From/To read day-first (FE5, 28 Oct). The value underneath
 * stays ISO (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` for date + time) — what the
 * database stores and every caller already reads off `e.target.value`.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A real calendar day? (02/30 is not.) */
function validDay(y: number, m: number, d: number): boolean {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

/** `2026-10-28` → `10/28/2026`. Anything else → "". */
export function isoToUS(iso: string | null | undefined): string {
  const m = ISO_DATE.exec((iso ?? "").slice(0, 10));
  if (!m) return "";
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * `10/28/2026` → `2026-10-28`. Also takes `10-28-2026`, `10.28.2026`,
 * single-digit month/day (`1/5/2026`) and a two-digit year (`1/5/26` →
 * 2026). Returns null for anything that is not a whole, real date.
 */
export function usToIso(text: string): string | null {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\s*$/.exec(text);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3]!.length === 2) year += 2000;
  if (!validDay(year, month, day)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * What the box shows while somebody types digits: the slashes go in by
 * themselves (`10282026` → `10/28/2026`). Typed separators are kept, so
 * `1/5/2026` is not forced into `15/20/26`.
 */
export function maskUSDate(typed: string): string {
  if (/[/.-]/.test(typed)) return typed.replace(/[^\d/.-]/g, "").slice(0, 10);
  const d = typed.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** Split `YYYY-MM-DDTHH:mm` into its date and `HH:mm` time. */
export function splitIsoDateTime(v: string | null | undefined): { date: string; time: string } {
  const m = ISO_DATE_TIME.exec(v ?? "");
  if (m) return { date: m[1]!, time: m[2]! };
  const d = ISO_DATE.exec((v ?? "").slice(0, 10));
  return { date: d ? d[0] : "", time: "" };
}

/** `YYYY-MM-DD` + `HH:mm` → `YYYY-MM-DDTHH:mm`, or "" until both are there. */
export function joinIsoDateTime(date: string, time: string): string {
  return date && /^\d{2}:\d{2}/.test(time) ? `${date}T${time.slice(0, 5)}` : "";
}

/** A local Date for an ISO day (noon, so no time zone moves it a day). */
export function isoToLocalDate(iso: string): Date | undefined {
  const m = ISO_DATE.exec(iso.slice(0, 10));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : undefined;
}

/** A local Date → `YYYY-MM-DD` in the viewer's own calendar. */
export function localDateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
