import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { HeartPulse } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CLIENT_HEALTH_DEFAULTS,
  CLIENT_HEALTH_MAX_DAYS,
  CLIENT_HEALTH_MIN_DAYS,
  HEALTH_META,
  describeClientHealthThresholds,
  normalizeClientHealthSettings,
  saveClientHealthSettings,
  useClientHealthSettings,
  useInvalidateClientHealth,
} from "@/lib/client-health";

export const Route = createFileRoute("/_authenticated/admin/client-health")({
  head: () => ({
    meta: [
      { title: "Client health · Admin · Recovery Hub" },
      {
        name: "description",
        content:
          "Set when an active client counts as Watch or At Risk — days since the last touchpoint.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ClientHealthAdmin,
});

/**
 * The thresholds behind "At Risk". One record in app_settings; every surface
 * that judges a client — the Active Clients board, the account header, the
 * nightly sweep, the automation engine — reads it, so changing a number here
 * changes the answer everywhere at once, without a deploy.
 */
function ClientHealthAdmin() {
  const app = useAppContext();
  const { settings, isLoading } = useClientHealthSettings();
  const invalidate = useInvalidateClientHealth();

  const [watch, setWatch] = React.useState(String(settings.watch_after_days));
  const [atRisk, setAtRisk] = React.useState(String(settings.at_risk_after_days));
  React.useEffect(() => {
    setWatch(String(settings.watch_after_days));
    setAtRisk(String(settings.at_risk_after_days));
  }, [settings.watch_after_days, settings.at_risk_after_days]);

  const draft = normalizeClientHealthSettings({
    watch_after_days: Number(watch),
    at_risk_after_days: Number(atRisk),
  });
  const dirty =
    draft.watch_after_days !== settings.watch_after_days ||
    draft.at_risk_after_days !== settings.at_risk_after_days;
  const watchClamped = Number(watch) > draft.at_risk_after_days;

  const save = useMutation({
    mutationFn: () => saveClientHealthSettings(draft, app.userId),
    onSuccess: (saved) => {
      invalidate();
      toast.success("Client health thresholds saved", {
        description: describeClientHealthThresholds(saved),
      });
    },
    onError: (e) => toastDbError(e, { action: "save the client health thresholds" }),
  });

  const disabled = isLoading || save.isPending || app.writesDisabled;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-card p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-start gap-3">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-xl"
            style={{ background: HEALTH_META.at_risk.soft, color: HEALTH_META.at_risk.color }}
          >
            <HeartPulse className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">When is an active client at risk?</div>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Health is judged from interaction metrics — today, the days since the last touchpoint
              that counts toward cadence (an answered call, a reply, a meeting, a gift or seasonal
              send). Unanswered outbound attempts do not move the clock. A rep can still mark a
              client Ghosted by hand; a hand-set stage can only make health worse, never hide
              silence.
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ThresholdField
            id="watch-days"
            label="Watch after"
            hint="Worth a look. Also the quarterly-touch cadence the nightly sweep creates tasks from."
            value={watch}
            onChange={setWatch}
            disabled={disabled}
            color={HEALTH_META.monitoring.color}
          />
          <ThresholdField
            id="at-risk-days"
            label="At Risk after"
            hint="The nightly sweep raises an urgent task for the account owner at this point."
            value={atRisk}
            onChange={setAtRisk}
            disabled={disabled}
            color={HEALTH_META.at_risk.color}
          />
        </div>

        {watchClamped ? (
          <p className="mt-2 text-[12px] text-warning">
            Watch cannot sit above At Risk — it will be saved as {draft.at_risk_after_days} days.
            Set the two equal to skip the Watch band entirely.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
          <div className="text-[12.5px]">
            <span className="text-muted-foreground">Reads as: </span>
            <span className="font-medium">{describeClientHealthThresholds(draft)}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setWatch(String(CLIENT_HEALTH_DEFAULTS.watch_after_days));
                setAtRisk(String(CLIENT_HEALTH_DEFAULTS.at_risk_after_days));
              }}
            >
              Reset to defaults
            </Button>
            <Button size="sm" disabled={disabled || !dirty} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-card p-4 text-[12.5px] shadow-[var(--shadow-card)]">
        <div className="text-[13px] font-semibold">Where these numbers are used</div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Active Clients — the Health band on every card, row and column, with the reason.</li>
          <li>The account header — "At Risk · No touch in 134 days".</li>
          <li>
            The nightly cadence sweep — a quarterly-touch task at the Watch threshold, an urgent
            at-risk task at the At Risk threshold.
          </li>
          <li>
            Automations — a "No activity on an account for N days" rule with no day count of its own
            follows the At Risk threshold.
          </li>
        </ul>
        <p className="mt-3 text-muted-foreground">
          Bands:{" "}
          {(["healthy", "monitoring", "at_risk", "critical"] as const)
            .map((k) => HEALTH_META[k].label)
            .join(" · ")}
          . Critical is Ghosted, confirmed by a rep — it clears on the next answered touch.
        </p>
      </div>
    </div>
  );
}

function ThresholdField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
  color,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] p-3">
      <Label htmlFor={id} className="flex items-center gap-2 text-[13px] font-semibold">
        <span aria-hidden className="size-2.5 rounded-full" style={{ background: color }} />
        {label}
      </Label>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={CLIENT_HEALTH_MIN_DAYS}
          max={CLIENT_HEALTH_MAX_DAYS}
          className="h-11 w-28 text-[15px] font-semibold tabular-nums"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="text-[13px] text-muted-foreground">days without a touchpoint</span>
      </div>
      <p className="mt-2 text-[11.5px] text-muted-foreground">{hint}</p>
    </div>
  );
}
