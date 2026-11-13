import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import {
  SHIFT_STATUS_LABEL,
  SHIFT_STATUS_TONE,
  clockIn as captureClockIn,
  clockOut as captureClockOut,
  elapsedMinutes,
  fmtDay,
  fmtMinutes,
  fmtTime,
  getPositionOnce,
  migrateLegacyClockQueue,
  pendingShift,
  weekBounds,
  type ShiftStatus,
} from "@/lib/timeclock";
import { useSyncQueue } from "@/lib/sync-status";
import { AlertTriangle, CloudOff, Info, MapPin, Timer } from "lucide-react";

export const Route = createFileRoute("/_authenticated/timeclock/")({
  head: () => ({
    meta: [
      { title: "Time clock · Recovery Hub" },
      {
        name: "description",
        content:
          "Clock in and out with a single tap, and see every location event recorded against your own shifts.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: TimeclockCockpit,
});

type Shift = {
  id: string;
  location_id: string;
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lon: number | null;
  clock_out_at: string | null;
  clock_out_lat: number | null;
  clock_out_lon: number | null;
  total_minutes: number | null;
  status: ShiftStatus;
};

function TimeclockCockpit() {
  const app = useAppContext();
  const [openShift, setOpenShift] = useState<Shift | null>(null);
  const [week, setWeek] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  /*
   * A read that failed and a week with no shifts look identical on screen, and
   * one of them is a lie. Worse for the open shift: "Clocked out" on a failed
   * read invites a second clock-in against a shift that is already running.
   */
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  /*
   * Punches live in the app-wide sync queue now, so the count here and the
   * count in the header are the same number read from the same store. A
   * rejected punch is not "pending" — it is the one thing on this page a
   * person has to act on.
   */
  const sync = useSyncQueue();
  const queued = sync.items.filter((i) => i.kind === "clock_in" || i.kind === "clock_out");
  const held = queued.filter((i) => i.status !== "rejected");
  const refused = queued.filter((i) => i.status === "rejected");
  const [locationId, setLocationId] = useState(
    app.currentLocationId ?? app.visibleLocations[0]?.id ?? "",
  );

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    if (!app.viewerUserId) return;
    setLoading(true);
    const { start, end } = weekBounds();
    const [openRes, weekRes] = await Promise.all([
      supabase
        .from("shifts")
        .select("*")
        .eq("user_id", app.viewerUserId)
        .is("clock_out_at", null)
        .order("clock_in_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("shifts")
        .select("*")
        .eq("user_id", app.viewerUserId)
        .gte("clock_in_at", start.toISOString())
        .lt("clock_in_at", end.toISOString())
        .order("clock_in_at", { ascending: false }),
    ]);
    setFailed(!!openRes.error || !!weekRes.error);
    setOpenShift((openRes.data ?? null) as Shift | null);
    setWeek((weekRes.data ?? []) as Shift[]);
    setLoading(false);
  }, [app.viewerUserId]);

  useEffect(() => {
    load();
  }, [load]);

  // Punches the previous build left in localStorage, where nothing drains them.
  useEffect(() => {
    void migrateLegacyClockQueue().then((n) => {
      if (n) sync.refresh();
    });
    // Once per mount: it empties the old store, so it cannot run twice usefully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * The shift this device believes is open. The server's answer wins when
   * there is one; a punch still in the queue is the answer when there is not,
   * which is what lets a crew clock out of a shift they clocked into
   * underground. Marked pending everywhere it is shown — it is not a record
   * until it lands.
   */
  const localShift = pendingShift(sync.items);
  const activeShiftId = openShift?.id ?? (openShift ? null : (localShift?.shiftId ?? null));
  const activeSince = openShift?.clock_in_at ?? (openShift ? null : (localShift?.at ?? null));
  const onClock = !!activeShiftId;
  const pendingPunch = !openShift && !!localShift;

  const clockIn = async () => {
    if (!app.userId || !locationId) {
      toast.error("Pick a location first.");
      return;
    }
    setBusy(true);
    const pos = await getPositionOnce();
    try {
      const { queued: held } = await captureClockIn({
        userId: app.userId,
        locationId,
        at: new Date().toISOString(),
        lat: pos.lat,
        lon: pos.lon,
      });
      if (held) toast.warning("Held on this phone — it goes up when you have signal.");
      else toast.success("Clocked in");
    } catch (e) {
      // A refusal the server will repeat is shown now, not queued to fail
      // quietly in an hour — this one always means a shift is already open.
      toastDbError(e, { action: "Clocking in" });
    } finally {
      setBusy(false);
      sync.refresh();
      load();
    }
  };

  const clockOut = async () => {
    if (!activeShiftId) return;
    setBusy(true);
    const pos = await getPositionOnce();
    try {
      const { queued: held } = await captureClockOut({
        shiftId: activeShiftId,
        at: new Date().toISOString(),
        lat: pos.lat,
        lon: pos.lon,
      });
      if (held) toast.warning("Held on this phone — it goes up when you have signal.");
      else toast.success("Clocked out");
    } catch (e) {
      toastDbError(e, { action: "Clocking out" });
    } finally {
      setBusy(false);
      sync.refresh();
      load();
    }
  };

  const weekMinutes = week.reduce(
    (s, w) =>
      s + (w.total_minutes ?? (w.clock_out_at ? elapsedMinutes(w.clock_in_at, w.clock_out_at) : 0)),
    0,
  );
  const liveMinutes = activeSince ? elapsedMinutes(activeSince) : 0;
  void tick;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
      <PageHeader title="Time clock" className="-mx-4 px-4" />
      {/* The className above: PageHeader bleeds -mx-3 below md, sized for the
          shell's usual px-3 gutter. This page is px-4 at every width, so the
          sticky header stopped 4px short of each edge and showed the page. */}

      {/*
       * On a phone the strip goes below the clock. It stacks one tile per row
       * there, ~330px of tiles, which pushed Clock in / Clock out — the one
       * thing a crew member opens this page to tap — below the fold of an
       * iPhone, and fully out of sight once a sync alert showed. Everything
       * the tiles say is also on the clock card, the alerts and This week.
       */}
      <MetricStrip
        className="max-md:order-1"
        metrics={[
          {
            label: "Status",
            value: onClock ? "Clocked in" : "Clocked out",
            icon: Timer,
            tone: onClock ? "success" : "default",
            note: activeSince
              ? `since ${fmtTime(activeSince)}${pendingPunch ? " · not synced yet" : ""}`
              : undefined,
          },
          {
            label: "This week",
            value: fmtMinutes(weekMinutes),
            icon: MapPin,
            note: `${week.length} shift${week.length === 1 ? "" : "s"}`,
          },
          {
            label: "Pending sync",
            value: held.length,
            icon: CloudOff,
            tone: held.length ? "warning" : "default",
            note: refused.length ? `${refused.length} refused` : undefined,
          },
        ]}
      />

      {failed && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Your shifts could not be read</AlertTitle>
          <AlertDescription>
            Do not take the status below as fact — reload before clocking in or out, or you may open
            a second shift on top of one that is already running.
          </AlertDescription>
        </Alert>
      )}

      {held.length > 0 && (
        <Alert variant="warning">
          <CloudOff className="size-4" />
          <AlertTitle>
            {held.length} punch{held.length === 1 ? "" : "es"} waiting to sync
          </AlertTitle>
          <AlertDescription>
            Captured on this device at the time you tapped, and filed with that time — not with the
            time they upload. They go up automatically as soon as you're back online.
          </AlertDescription>
        </Alert>
      )}

      {/*
       * A refused punch is the one case where waiting does nothing: the server
       * has already given its answer and will give it again. It gets the
       * reason and a person to take it to, not a spinner.
       */}
      {refused.map((item) => (
        <Alert key={item.id} variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{item.label} could not be filed</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{item.lastError ?? "The server refused this punch."}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void sync.retryOne(item.id)}>
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void sync.discard(item.id)}>
                Discard
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ))}

      {/* Big, thumb-sized control — the whole point for field and crew */}
      <Card className={onClock ? "border-success/50" : ""}>
        <CardContent className="space-y-3 p-3">
          {onClock ? (
            <>
              <div className="text-center">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  On the clock since {fmtTime(activeSince)}
                  {pendingPunch && " · held on this phone"}
                </div>
                <div className="font-mono text-5xl font-semibold tabular-nums">
                  {fmtMinutes(liveMinutes)}
                </div>
              </div>
              <Button
                size="lg"
                variant="destructive"
                className="h-16 w-full text-lg"
                onClick={clockOut}
                disabled={busy || app.writesDisabled}
              >
                {busy ? "Recording…" : "Clock out"}
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">Location</span>
                <Select value={locationId} onValueChange={setLocationId}>
                  {/* 16px: under it iOS zooms the page in on focus and never back. */}
                  <SelectTrigger className="h-12 text-base">
                    <SelectValue placeholder="Pick your location" />
                  </SelectTrigger>
                  <SelectContent>
                    {app.visibleLocations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.code} · {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="lg"
                className="h-16 w-full text-lg"
                onClick={clockIn}
                disabled={busy || app.writesDisabled}
              >
                {busy ? "Recording…" : "Clock in"}
              </Button>
            </>
          )}
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <MapPin className="mt-0.5 size-3.5 shrink-0" />
            Your position is recorded once at clock-in and once at clock-out. Nothing is recorded in
            between, and everything recorded is shown to you below.
          </p>
        </CardContent>
      </Card>

      <Card className="max-md:order-2">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">This week</CardTitle>
          <span className="font-mono text-lg font-semibold tabular-nums">
            {fmtMinutes(weekMinutes)}
          </span>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : week.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No shifts recorded this week. Your first record is created the moment you clock in
              above.
            </p>
          ) : (
            week.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-sm border p-3 text-sm"
              >
                <div>
                  <div className="font-medium">{fmtDay(s.clock_in_at)}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtTime(s.clock_in_at)} → {fmtTime(s.clock_out_at)}
                    {s.clock_in_lat != null && " · position captured at clock-in"}
                    {s.clock_out_lat != null && " and clock-out"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className={SHIFT_STATUS_TONE[s.status]}>
                    {SHIFT_STATUS_LABEL[s.status]}
                  </Badge>
                  <span className="font-mono tabular-nums">
                    {fmtMinutes(
                      s.total_minutes ??
                        (s.clock_out_at
                          ? elapsedMinutes(s.clock_in_at, s.clock_out_at)
                          : elapsedMinutes(s.clock_in_at)),
                    )}
                  </span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground max-md:order-2">
        <Info className="mt-0.5 size-3.5 shrink-0" />A manager can approve or correct a shift, and
        every correction is written to an audit trail with who made it and why. Nothing here is
        silently editable.
      </p>
    </div>
  );
}
