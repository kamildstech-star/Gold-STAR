import * as React from "react";

import { MetricRow, MetricStat, type MetricTone } from "@/components/metric-stat";
import { cn } from "@/lib/utils";

export type Metric = {
  label: string;
  value: React.ReactNode;
  /** Optional secondary note rendered under the value, in grey. A node so a tile can carry two short lines. */
  note?: React.ReactNode;
  tone?: MetricTone;
  /** Leading icon, rendered in a tinted chip on the accent rotation. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Delta chip, e.g. { value: "+12 vs last 7 days", dir: "up" }. */
  delta?: { value: string; dir?: "up" | "down" };
  href?: string;
  onClick?: () => void;
};

const TONE_TINT: Partial<Record<MetricTone, string>> = {
  danger: "var(--destructive)",
  warning: "var(--kpi-4)",
  success: "var(--kpi-2)",
};

/**
 * KPI row. A thin adapter over the one MetricStat primitive — it exists only
 * to keep the ~31 existing `MetricStrip metrics={...}` call sites working
 * while the numeral, label, spacing and delta treatment live in one place.
 */
export function MetricStrip({ metrics, className }: { metrics: Metric[]; className?: string }) {
  return (
    <MetricRow className={className}>
      {metrics.map((m, i) => {
        const Icon = m.icon;
        const tone = m.tone ?? "default";
        return (
          <MetricStat
            key={m.label}
            value={m.value}
            label={m.label}
            tone={tone}
            delta={m.delta}
            hint={m.note}
            href={m.href}
            onClick={m.onClick}
            icon={Icon ? <Icon className={cn("size-5")} /> : undefined}
            iconTint={TONE_TINT[tone] ?? `var(--kpi-${(i % 4) + 1})`}
          />
        );
      })}
    </MetricRow>
  );
}
