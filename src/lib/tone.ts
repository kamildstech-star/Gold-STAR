/**
 * The app's one set of status colours (4 Nov: "book one color for all in the
 * project and always use that color in that situation").
 *
 * Every status pill — invoices, estimates, jobs, documents, equipment,
 * timesheets, credentials — picks its colour by MEANING from this list, so
 * "done" is the same green and "waiting on someone" the same amber on every
 * screen. Theme tokens only: each palette and dark mode tunes them, and the
 * words are the token's own ink, which every palette sets for AA on its tint.
 *
 * - neutral  not started / no longer live: draft, missing, cancelled, void
 * - info     out and visible: sent, viewed, new, in transit
 * - brand    ours, moving: scheduled, on a job, submitted, ordered, invoiced
 * - warning  waiting on someone: pending, partial, in progress, expiring
 * - success  done well: paid, approved, signed, complete, connected
 * - danger   needs action: declined, disputed, expired, lost, error
 */
export type Tone = "neutral" | "info" | "brand" | "warning" | "success" | "danger";

export const TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted text-foreground/80",
  info: "border-info/25 bg-info/10 text-info",
  brand: "border-link/25 bg-link/10 text-link",
  warning: "border-warning/30 bg-warning/12 text-warning",
  success: "border-success/25 bg-success/12 text-success",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
};
