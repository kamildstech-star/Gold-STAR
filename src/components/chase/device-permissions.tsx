import { useState } from "react";
import { AlertTriangle, Bell, CheckCircle2, MapPin, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { REENABLE_STEPS, type Platform, type PermState } from "@/lib/device-permissions";

/** First-run explainer. Shown before any browser dialog can fire. */
export function PermissionPrimingScreen({
  open,
  onContinue,
  onSkip,
}: {
  open: boolean;
  onContinue: () => Promise<void> | void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onSkip()}>
      <DialogContent className="max-w-[560px] gap-0 p-0">
        <div className="space-y-4 p-6">
          <div>
            <DialogTitle className="text-[19px] font-bold leading-tight">
              Before you start chasing
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13px] text-[var(--muted-foreground)]">
              Your phone will ask for two permissions on the next screen. Here's exactly what each
              one is used for.
            </DialogDescription>
          </div>

          <div className="space-y-3">
            <ReasonRow
              icon={<MapPin className="size-4" />}
              title="Location"
              points={[
                "Stamps your arrival on scene automatically — no typing.",
                "Shows distance and ETA to each incident.",
                "Routes you to the address.",
              ]}
            />
            <ReasonRow
              icon={<Bell className="size-4" />}
              title="Notifications"
              points={["Alerts you the moment a new fire lands in your territory."]}
            />
          </div>

          <div className="rounded-[8px] border border-[color-mix(in_oklab,var(--warning)_55%,transparent)] bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] p-3">
            <div className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.06em] text-[var(--warning)]">
              <AlertTriangle className="size-4" /> Do not pick “Allow Once”
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="rounded-[8px] border border-[color-mix(in_oklab,var(--success)_45%,transparent)] bg-[color-mix(in_oklab,var(--success)_12%,var(--card))] p-2.5">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--success)]">
                  <CheckCircle2 className="size-4" /> Choose this
                </div>
                <p className="mt-1 text-[13px] font-medium">
                  “Allow while using the app” or “Always”
                </p>
              </div>
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--muted)]/40 p-2.5 opacity-80">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--muted-foreground)]">
                  <X className="size-4" /> Avoid
                </div>
                <p className="mt-1 text-[13px] font-medium line-through decoration-[var(--destructive)]">
                  “Allow Once”
                </p>
              </div>
            </div>
            <p className="mt-2 text-[12px] text-[var(--muted-foreground)]">
              “Allow Once” expires when you close the tab, so the browser asks again every single
              shift.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button
              size="lg"
              className="h-12 flex-1 text-[15px] font-semibold"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onContinue();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Waiting for your answer…" : "Continue"}
            </Button>
            <Button variant="ghost" size="lg" className="h-12" onClick={onSkip} disabled={busy}>
              Not now
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReasonRow({
  icon,
  title,
  points,
}: {
  icon: React.ReactNode;
  title: string;
  points: string[];
}) {
  return (
    <div className="flex gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--card)] p-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--muted)] text-[var(--foreground)]">
        {icon}
      </span>
      <div>
        <div className="text-[14px] font-semibold">{title}</div>
        <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--muted-foreground)]">
          {points.map((p) => (
            <li key={p}>• {p}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Persistent inline banner when something is denied. We never re-prompt on
 * launch — the only path back to a system dialog is the button in here.
 */
export function PermissionDeniedBanner({
  location,
  notifications,
  degraded,
  platform,
  onRetry,
}: {
  location: PermState;
  notifications: PermState;
  degraded: string[];
  platform: Platform;
  onRetry: () => Promise<void> | void;
}) {
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const guide = REENABLE_STEPS[platform];

  /*
   * NOTIFICATIONS only. A chaser who gets no alerts cannot do the job, so that
   * stays flagged loudly.
   *
   * Denied LOCATION no longer raises this banner on its own. Melly, 17 Sep:
   * "I don't want them to know that they're being tracked... they don't need
   * to toggle on location every time." A warning telling a chaser their
   * location is blocked, with steps to switch it back on, is the app asking
   * again by other means — and their work is unaffected either way, because
   * events record with null coordinates. The gap is shown to supervisors in
   * the dispatch log instead, which is where somebody can act on it.
   *
   * `location` is still read: when notifications are ALSO denied the heading
   * names both, because the person is in settings anyway.
   */
  if (notifications !== "denied") return null;

  return (
    <div className="rounded-[8px] border border-[color-mix(in_oklab,var(--warning)_55%,transparent)] bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] p-3">
      <div className="flex flex-wrap items-start gap-3">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div className="min-w-[220px] flex-1">
          <div className="text-[13px] font-extrabold uppercase tracking-[0.06em] text-[var(--warning)]">
            {location === "denied" && notifications === "denied"
              ? "Location and notifications blocked"
              : location === "denied"
                ? "Location blocked"
                : "Notifications blocked"}
          </div>
          <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--muted-foreground)]">
            {degraded.map((d) => (
              <li key={d}>• {d}</li>
            ))}
          </ul>
          <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
            Your browser won't let the app ask again until you re-enable it in settings.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowSteps((s) => !s)}>
            {showSteps ? "Hide steps" : "How to re-enable"}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRetry();
              } finally {
                setBusy(false);
              }
            }}
          >
            Try again
          </Button>
        </div>
      </div>

      {showSteps && (
        <div className="mt-3 rounded-[8px] border border-[var(--border)] bg-[var(--card)] p-3">
          <div className="text-[13px] font-semibold">{guide.title}</div>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] text-[var(--muted-foreground)]">
            {guide.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {guide.deepLink ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                window.location.href = guide.deepLink!;
              }}
            >
              Open device settings
            </Button>
          ) : (
            <p className="mt-2 text-[12px] text-[var(--muted-foreground)]">
              {platform === "ios-safari"
                ? "iOS Safari has no link into Settings — the steps above have to be done by hand."
                : "Your browser doesn't expose a settings link, so follow the steps above."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
