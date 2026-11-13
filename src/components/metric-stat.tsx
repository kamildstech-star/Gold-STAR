import * as React from "react";
import { Link } from "@tanstack/react-router";

import { FitText } from "@/components/ui/fit-text";
import { cn } from "@/lib/utils";

/**
 * The one metric tile.
 *
 * The app had four near-identical copies of this markup (dashboards.tsx,
 * dashboards-sales.tsx, dashboard-overview-cards.tsx and metric-strip.tsx),
 * which is how the numeral drifted between 26px and 28px and how two of them
 * lost their delta treatment. This is the single implementation.
 *
 * The rule the client stated, encoded once: the NUMBER is the element and the
 * label is its caption — big bold tabular numeral, small quiet label
 * underneath, never the reverse.
 */

export type MetricTone = "default" | "danger" | "warning" | "success" | "info";

const TONE: Record<MetricTone, string> = {
  default: "text-foreground",
  danger: "text-destructive",
  warning: "text-warning",
  success: "text-success",
  info: "text-chart-1",
};

export function MetricStat({
  value,
  label,
  delta,
  hint,
  icon,
  iconTint,
  tone = "default",
  size,
  compactOnPhone,
  href,
  onClick,
  className,
}: {
  value: React.ReactNode;
  label: string;
  /** Movement against the previous period. Caller formats the words. */
  delta?: { value: string; dir?: "up" | "down" } | null;
  /** Quiet context line, used when there is no delta. */
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  /** Colour for the icon and its wash. Defaults to the primary accent. */
  iconTint?: string;
  tone?: MetricTone;
  size?: "lg" | "md";
  /** Below `sm`: small padding, small numeral and icon above it, so four
   *  tiles fit one row on a 360px phone (5 Nov, T1). Wider screens unchanged. */
  compactOnPhone?: boolean;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  /**
   * Mark, from a screenshot of this strip with OUTSTANDING A/R cut to
   * "$394,…": "we need the words to be auto resizing so there are no ...
   * anywhere"
   *
   * The numeral used to `truncate`, with a guess in front of it (anything
   * past 8 glyphs dropped a rung to 24px) that missed "$394,821" — exactly
   * 8 — on a laptop-width tile. The guess is gone; FitText measures the real
   * box and shrinks the real text only as far as it has to, so "29" is still
   * 32px and a value that fits on a wide screen is not shrunk on a hunch.
   * `size` stays for a caller that wants the smaller rung on purpose.
   */
  const step = size ?? "lg";

  const body = (
    <>
      <div className="min-w-0 flex-1">
        {/* The numeral. ~2.5x its label, 800 weight, tabular so columns of
            tiles line up digit for digit. */}
        <FitText
          className={cn(
            "font-extrabold leading-[1.1] tracking-[-0.02em] tabular-nums",
            step === "lg"
              ? "text-[length:var(--text-metric)]"
              : "text-[length:var(--text-metric-sm)]",
            compactOnPhone && "max-sm:text-[15px]",
            TONE[tone],
          )}
        >
          {value}
        </FitText>
        {/* The caption, underneath and deliberately quiet. It wraps rather
            than truncates: "OUTSTANDING A/R" is 15 uppercase glyphs and was
            one narrow tile away from "OUTSTANDING A…". The same for the note
            line. Tiles in a strip are stretched to one height, so a wrapped
            caption costs nothing in alignment. */}
        <div
          className={cn(
            "kpi-label mt-1.5 break-words",
            compactOnPhone && "max-sm:mt-0.5 max-sm:text-[9px] max-sm:tracking-[0.02em]",
          )}
        >
          {label}
        </div>
        {delta ? (
          <span className="delta-chip mt-2" data-dir={delta.dir === "down" ? "down" : "up"}>
            {delta.dir === "down" ? "↓" : "↑"} {delta.value}
          </span>
        ) : hint ? (
          <div className="mt-1.5 break-words text-[length:var(--text-note)] text-muted-foreground">
            {hint}
          </div>
        ) : null}
      </div>
      {icon && (
        <span
          className={cn(
            "flex size-10 flex-none self-start items-center justify-center rounded-[var(--radius-control)]",
            compactOnPhone && "max-sm:size-6 max-sm:[&_svg]:size-3.5",
          )}
          style={
            iconTint
              ? {
                  backgroundColor: `color-mix(in oklab, ${iconTint} 12%, transparent)`,
                  color: iconTint,
                }
              : undefined
          }
        >
          {icon}
        </span>
      )}
    </>
  );

  /* The 3 Nov redesign: a tinted tile carries its colour as a 3px bar along
     its top edge (see `kpi-tile` in styles.css), the icon chip on the right. */
  const accent = iconTint ? ({ "--kpi-accent": iconTint } as React.CSSProperties) : undefined;

  const interactive = cn(
    "hover:border-[var(--primary)]/40 hover:shadow-[var(--card-shadow-hover)]",
    compactOnPhone && "max-sm:flex-col-reverse max-sm:gap-1 max-sm:p-2",
  );

  if (href) {
    return (
      <Link
        to={href}
        data-accent={iconTint ? "" : undefined}
        style={accent}
        className={cn("kpi-tile", interactive, className)}
      >
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-accent={iconTint ? "" : undefined}
        style={accent}
        className={cn("kpi-tile", interactive, className)}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      data-accent={iconTint ? "" : undefined}
      style={accent}
      className={cn(
        "kpi-tile",
        compactOnPhone && "max-sm:flex-col-reverse max-sm:gap-1 max-sm:p-2",
        className,
      )}
    >
      {body}
    </div>
  );
}

/** Grid wrapper for a row of MetricStats. */
export function MetricRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("metric-strip", className)}>{children}</div>;
}
