import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone, PhoneOff, PlugZap, Timer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { CALL_OUTCOMES, dialerConnected, fmtDurationShort, logCall } from "@/lib/calls";
import { toastDbError } from "@/lib/db-errors";
import { cn } from "@/lib/utils";

/**
 * Click-to-dial, app-wide.
 *
 * Any phone number anywhere in the app is a <PhoneLink>. Pressing it opens this
 * one screen with the record already in context, times the call, and logs the
 * notes and outcome as a touchpoint on the way out — the rep never navigates to
 * a "log a call" form.
 *
 * No dialer provider is connected yet, so the screen says so plainly and hands
 * the number to the device instead of pretending to place the call. When a
 * provider is wired up, only `placeCall` below changes.
 */

export type CallTarget = {
  phone: string | null;
  accountId?: string | null;
  accountName?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  jobId?: string | null;
  direction?: "inbound" | "outbound";
  /** Called after the call is logged — refresh the caller's list. */
  onLogged?: () => void;
};

type DialerCtx = { startCall: (t: CallTarget) => void };

const Ctx = React.createContext<DialerCtx | null>(null);

export function useDialer(): DialerCtx {
  return React.useContext(Ctx) ?? { startCall: () => {} };
}

export function DialerProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = React.useState<CallTarget | null>(null);
  const startCall = React.useCallback((t: CallTarget) => setTarget(t), []);
  const value = React.useMemo(() => ({ startCall }), [startCall]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CallScreenDialog target={target} onClose={() => setTarget(null)} />
    </Ctx.Provider>
  );
}

export function useDialerConnected() {
  return useQuery({
    queryKey: ["dialer-connected"],
    staleTime: 5 * 60_000,
    queryFn: dialerConnected,
  });
}

function CallScreenDialog({ target, onClose }: { target: CallTarget | null; onClose: () => void }) {
  const app = useAppContext();
  const { disabled, reason } = useWritesDisabled();
  const qc = useQueryClient();
  const connectedQuery = useDialerConnected();
  const providerReady = connectedQuery.data === true;

  const [startedAt, setStartedAt] = React.useState<number | null>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const [outcome, setOutcome] = React.useState<string>("connected");
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  React.useEffect(() => {
    if (!target) {
      stopTimer();
      setStartedAt(null);
      setElapsed(0);
      setNotes("");
      setOutcome("connected");
    }
    return stopTimer;
  }, [target]);

  if (!target) return null;

  const begin = () => {
    const t0 = Date.now();
    setStartedAt(t0);
    timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    // Without a provider the handset places the call; we still time and log it.
    if (target.phone) window.location.href = `tel:${target.phone.replace(/[^\d+]/g, "")}`;
  };

  const save = async () => {
    if (!app.userId) return;
    stopTimer();
    setSaving(true);
    try {
      await logCall({
        userId: app.userId,
        accountId: target.accountId ?? null,
        contactId: target.contactId ?? null,
        jobId: target.jobId ?? null,
        phone: target.phone,
        direction: target.direction ?? "outbound",
        outcome,
        durationSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
        notes,
        selfReported: !providerReady,
      });
      toast.success(
        outcome === "connected"
          ? `Call logged — ${fmtDurationShort(elapsed)}`
          : "Call logged — no answer, does not count toward cadence",
      );
      qc.invalidateQueries({ queryKey: ["calls"] });
      qc.invalidateQueries({ queryKey: ["call-queue"] });
      target.onLogged?.();
      onClose();
    } catch (e) {
      toastDbError(e, { action: "log this call" });
    } finally {
      setSaving(false);
    }
  };

  const who = target.contactName ?? target.accountName ?? target.phone ?? "Call";

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {who}
            {startedAt && (
              <Badge variant="secondary" className="gap-1">
                <Timer className="size-3" />
                {fmtDurationShort(elapsed)}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-[13px] text-muted-foreground">
            {target.accountName && <div>{target.accountName}</div>}
            <div className="font-medium text-foreground">{target.phone ?? "No number on file"}</div>
          </div>

          {!providerReady && (
            <Alert variant="info">
              <PlugZap className="size-4" />
              <AlertDescription className="text-[12px]">
                Dialer not connected — the call opens on your phone and is logged here as
                self-reported. Connect a provider in Admin → Integrations to place and record calls
                in-app.
              </AlertDescription>
            </Alert>
          )}

          {!startedAt ? (
            <Button className="h-11 w-full" onClick={begin} disabled={!target.phone}>
              <Phone className="mr-2 size-4" />
              {providerReady ? "Place call" : "Start call"}
            </Button>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Outcome</Label>
                <Select value={outcome} onValueChange={setOutcome}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CALL_OUTCOMES.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Textarea
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What was said, what happens next…"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={!startedAt || saving || disabled}
            title={reason ?? undefined}
          >
            <PhoneOff className="mr-2 size-4" />
            End &amp; log
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A phone number that dials. Use this anywhere a number is shown. */
export function PhoneLink({
  phone,
  className,
  label,
  ...target
}: CallTarget & { className?: string; label?: string }) {
  const { startCall } = useDialer();
  if (!phone) return <span className="text-muted-foreground">—</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        startCall({ phone, ...target });
      }}
      className={cn(
        "inline-flex items-center gap-1 text-left underline-offset-2 hover:underline",
        className,
      )}
      title="Click to dial"
    >
      <Phone className="size-3 shrink-0 opacity-70" aria-hidden />
      {label ?? phone}
    </button>
  );
}
