import type { JobLossType } from "./jobs";

/**
 * Loss type is the most important categorical dimension in the app.
 * Every surface that shows a loss type — badges, rows, pins, chart series —
 * pulls its color from here so the mapping stays consistent.
 */
export const LOSS_TEXT: Record<JobLossType, string> = {
  water: "text-loss-water",
  fire: "text-loss-fire",
  smoke: "text-loss-smoke",
  sewer: "text-loss-sewer",
  mold: "text-loss-mold",
  biohazard: "text-loss-biohazard",
  storm: "text-loss-storm",
  cleaning: "text-loss-cleaning",
};

export const LOSS_BG_SOFT: Record<JobLossType, string> = {
  water: "bg-loss-water/10 text-loss-water",
  fire: "bg-loss-fire/10 text-loss-fire",
  smoke: "bg-loss-smoke/10 text-loss-smoke",
  sewer: "bg-loss-sewer/10 text-loss-sewer",
  mold: "bg-loss-mold/10 text-loss-mold",
  biohazard: "bg-loss-biohazard/10 text-loss-biohazard",
  storm: "bg-loss-storm/10 text-loss-storm",
  cleaning: "bg-loss-cleaning/10 text-loss-cleaning",
};

export const LOSS_STRIPE: Record<JobLossType, string> = {
  water: "border-l-loss-water",
  fire: "border-l-loss-fire",
  smoke: "border-l-loss-smoke",
  sewer: "border-l-loss-sewer",
  mold: "border-l-loss-mold",
  biohazard: "border-l-loss-biohazard",
  storm: "border-l-loss-storm",
  cleaning: "border-l-loss-cleaning",
};

export function lossBadge(t: JobLossType | null | undefined): string {
  if (!t) return "bg-muted text-muted-foreground";
  return LOSS_BG_SOFT[t];
}
