import { Calculator, CircleCheck, Clock, ReceiptText, type LucideIcon } from "lucide-react";

import { MetricStat } from "@/components/metric-stat";
import { fmtMoney } from "@/lib/jobs";
import type { JobMoney } from "@/lib/job-money";
import { cn } from "@/lib/utils";

type Tone = "info" | "warning" | "success" | "danger";

/* Theme tokens, not hexes: every palette and dark mode already tunes these.
   Blue is chart-1 (the water blue), not `info` — Gold Star's info is its navy. */
const TINT: Record<Tone, string> = {
  info: "var(--chart-1)",
  warning: "var(--warning)",
  success: "var(--success)",
  danger: "var(--destructive)",
};

interface Stat {
  key: string;
  label: string;
  value: number;
  tone: Tone;
  icon: LucideIcon;
}

/**
 * The job's money as coloured stat cards, above the tabs' content on every tab
 * (3 Nov redesign). The same figures the Amounts card used to list — derived
 * by `useJobMoney`, so this and Billing agree — gated the same way: cost
 * viewers see all four, sellers (T11) see billed and paid, anyone else none.
 */
export function JobMoneyStrip({
  money,
  isLoading,
  isError,
  showMoney,
  showBilling,
  onOpenBilling,
}: {
  money: JobMoney | undefined;
  isLoading: boolean;
  isError: boolean;
  showMoney: boolean;
  showBilling: boolean;
  onOpenBilling: () => void;
}) {
  const m = money;
  const stats: Stat[] = showMoney
    ? [
        {
          key: "estimated",
          label: "Estimated",
          value: m?.estimated ?? 0,
          tone: "info",
          icon: Calculator,
        },
        {
          key: "billed",
          label: "Billed",
          value: m?.billed ?? 0,
          tone: "warning",
          icon: ReceiptText,
        },
        {
          key: "collected",
          label: "Collected",
          value: m?.collected ?? 0,
          tone: "success",
          icon: CircleCheck,
        },
        {
          key: "outstanding",
          label: "Outstanding",
          value: m?.outstanding ?? 0,
          tone: "danger",
          icon: Clock,
        },
      ]
    : showBilling
      ? [
          {
            key: "billed",
            label: "Billed",
            value: m?.billed ?? 0,
            tone: "warning",
            icon: ReceiptText,
          },
          {
            key: "paid",
            label: "Paid",
            value: m?.collected ?? 0,
            tone: "success",
            icon: CircleCheck,
          },
        ]
      : [];
  if (stats.length === 0) return null;

  return (
    <section aria-label="Job amounts" className="space-y-1.5" data-job-money-strip>
      <div
        className={cn(
          "grid gap-2 sm:gap-3",
          stats.length === 4
            ? "grid-cols-4 max-sm:gap-1.5 sm:grid-cols-2 lg:grid-cols-4"
            : "grid-cols-2",
        )}
      >
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <MetricStat
              key={s.key}
              size="md"
              compactOnPhone
              label={s.label}
              value={isError ? "—" : isLoading ? "…" : fmtMoney(s.value)}
              tone={isError ? "default" : s.tone}
              icon={<Icon className="size-5" />}
              iconTint={TINT[s.tone]}
              onClick={onOpenBilling}
            />
          );
        })}
      </div>
      {isError ? (
        <p className="text-[12px] text-destructive">
          Could not read this job&rsquo;s billing. These are not zeros — they are unknown.
        </p>
      ) : null}
    </section>
  );
}
