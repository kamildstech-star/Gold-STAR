import { cn } from "@/lib/utils";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Clock,
  FileSignature,
  Flame,
  MapPin,
  Navigation as NavIcon,
  PenLine,
  Plus,
  Power,
  Radio,
  Camera,
  CloudSun,
  Phone,
  Timer,
  Truck,
  Upload,
  Users,
  Volume2,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { actionErrorMessage, toastDbError } from "@/lib/db-errors";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { ensureJobAlbum } from "@/lib/job-photos";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { HideableSection } from "@/lib/hidden-sections";
import { claimIncident, fetchMyDispatchScope, inDispatchScope, raceMessage } from "@/lib/territory";
import { SyncBanner, ConnectionChip } from "@/components/offline/sync-banner";
import { prefetchForIncident } from "@/lib/chase-prefetch";
import {
  endTimeLabel,
  fetchChaseShiftSettings,
  overtimeState,
  shiftHoursLabel,
} from "@/lib/chase-shift";
import { releaseClaim } from "@/lib/assignment-rules";
import { useServerFn } from "@tanstack/react-start";

import { WorkAuthorizationDialog } from "@/components/work-authorization-dialog";
import { lookupIncidentProperty } from "@/lib/property-lookup.functions";
import { listCockpitFeedCalls, type CockpitFeedCall } from "@/lib/fire-feed/cockpit-feed.functions";
import { SKIP_REASON_LABEL, type SkipReason } from "@/lib/fire-feed/decide";
import {
  FireFeedCallDialog,
  type FireFeedCallView,
} from "@/components/fire-feed/fire-feed-call-dialog";
import { lookupIncidentPublicRecord } from "@/lib/incident-public-record.functions";
import { ContactUnlockRows, PublicRecordBasics } from "@/components/chase/public-record-basics";
import {
  arrivalStampLine,
  clearArrival,
  markArrivedManually,
  stampArrivalFromAction,
  tryProximityArrival,
} from "@/lib/arrival";
import { CockpitMap } from "@/components/chase/cockpit-map";
import { useDevicePermissions } from "@/lib/device-permissions";
import {
  PermissionPrimingScreen,
  PermissionDeniedBanner,
} from "@/components/chase/device-permissions";

import { ExposureSheet } from "@/components/chase/exposure-sheet";
import {
  ExposureGroupPanel,
  ExposureOriginLeadChip,
} from "@/components/chase/exposure-group-panel";
import { OutcomeSheet } from "@/components/chase/outcome-sheet";
import { DeclineSheet } from "@/components/chase/decline-sheet";
import { AttemptHistory } from "@/components/chase/attempt-history";
import { IncidentSources } from "@/components/chase/incident-sources";
import { commissionLabel, fetchMyChaseJobs } from "@/lib/chase-board";
import {
  dispatchDetailLine,
  fireTypeLine,
  formatDuration,
  getCurrentPosition,
  incidentSeverity,
  INCIDENT_TYPE_LABEL,
  mapsDeepLink,
  OUTCOME_LABEL,
  timeSince,
  type Incident,
  INCIDENT_STATUS_LABEL,
} from "@/lib/incidents";
import { EXTERNAL_LINK_REL } from "@/lib/maps-links";
import { drainQueue, enqueuePhoto, extFromMime, newPhotoId, readExif } from "@/lib/photos";
import { FitText } from "@/components/ui/fit-text";
import { countBy, useCompetitorSightings } from "@/lib/competitor-activity";
import { ViewMapLink } from "@/components/chase/competitor-activity-snapshot";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/chase/")({
  head: () => ({
    meta: [
      { title: "Chase cockpit · Recovery Hub" },
      {
        name: "description",
        content:
          "Live fire-chase board — alerts in your zones, still-open leads, active chases and today's signed jobs.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ChaseCockpit,
});

type Shift = {
  id: string;
  user_id: string;
  location_id: string;
  started_at: string;
  ended_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  scheduled_minutes: number | null;
  overtime_escalated_at: string | null;
};

const BOARD_WINDOW_MS = 24 * 3_600_000;

/* ------------------------------------------------------------------ */
/*  Data hooks                                                         */
/* ------------------------------------------------------------------ */

function useOpenShift(userId: string | null) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["chase", "shift", userId],
    queryFn: async (): Promise<Shift | null> => {
      const { data, error } = await supabase
        .from("chaser_shifts")
        .select("*")
        .eq("user_id", userId!)
        .is("ended_at", null)
        .maybeSingle();
      if (error) throw error;
      return (data as Shift | null) ?? null;
    },
  });
}

/** The chaser's own market and zones. Nobody picks a location by hand. */
function useDispatchScope(userId: string | null) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["chase", "scope", userId],
    queryFn: () => fetchMyDispatchScope(userId!),
    staleTime: 300_000,
  });
}

/** Market name + the zones they actually hold, for the banner. */
function useTerritoryLabel(userId: string | null) {
  return useQuery({
    enabled: !!userId,
    staleTime: 300_000,
    queryKey: ["chase", "territory-label", userId],
    queryFn: async (): Promise<{
      label: string | null;
      shiftStart: string | null;
      shiftEnd: string | null;
    }> => {
      const { data: t, error } = await supabase
        .from("chaser_territories")
        .select(
          "market_id, dispatch_whole_market, dispatch_zone_ids, shift_start_time, shift_end_time",
        )
        .eq("user_id", userId!)
        .maybeSingle();
      if (error) throw error;
      if (!t) return { label: null, shiftStart: null, shiftEnd: null };

      const { data: market } = await supabase
        .from("markets")
        .select("name, shift_start_time, shift_end_time")
        .eq("id", t.market_id)
        .maybeSingle();

      let label = market?.name ?? "Market";
      if (t.dispatch_whole_market) {
        label += " · whole market";
      } else if ((t.dispatch_zone_ids ?? []).length > 0) {
        const { data: zones } = await supabase
          .from("zones")
          .select("name")
          .in("id", t.dispatch_zone_ids);
        const names = (zones ?? []).map((z) => z.name);
        label += names.length ? ` · ${names.slice(0, 3).join(", ")}` : "";
        if (names.length > 3) label += ` +${names.length - 3}`;
      } else {
        label += " · no zones assigned";
      }

      return {
        label,
        shiftStart: t.shift_start_time ?? market?.shift_start_time ?? null,
        shiftEnd: t.shift_end_time ?? market?.shift_end_time ?? null,
      };
    },
  });
}

/** Everything live in the last 24 hours. The cockpit is the working board. */
function useBoard(userId: string | null) {
  const qc = useQueryClient();

  const q = useQuery({
    enabled: !!userId,
    queryKey: ["chase", "board", userId],
    queryFn: async (): Promise<Incident[]> => {
      const since = new Date(Date.now() - BOARD_WINDOW_MS).toISOString();
      const { data, error } = await supabase
        .from("incidents")
        .select("*")
        .in("status", ["new", "dispatched", "accepted", "on_scene"])
        .neq("lifecycle", "dead")
        .gte("reported_at", since)
        .order("reported_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data as Incident[]) ?? [];
    },
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel(`chase-board:${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "incidents" }, () =>
        qc.invalidateQueries({ queryKey: ["chase", "board"] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [userId, qc]);

  return q;
}

/** Accepting or declining clears this chaser's board only. */
function useMyPassed(userId: string | null) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["chase", "my-dispatches", userId],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from("incident_dispatches")
        .select("incident_id,response")
        .eq("user_id", userId!)
        .in("response", ["declined", "declined_race", "no_action"]);
      if (error) throw error;
      return (data ?? []).map((d) => d.incident_id);
    },
    refetchInterval: 60_000,
  });
}

function useSignedToday(userId: string | null) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["chase", "signed-today", userId],
    queryFn: async () => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const [{ data, error }, jobs] = await Promise.all([
        supabase
          .from("incidents")
          .select("id, address, job_id, outcome_at")
          .eq("accepted_by", userId!)
          .eq("outcome", "contract_signed")
          .gte("outcome_at", start.toISOString())
          .order("outcome_at", { ascending: false }),
        fetchMyChaseJobs().catch(() => []),
      ]);
      if (error) throw error;
      const byJob = new Map(jobs.map((j) => [j.job_id, j]));
      return (data ?? []).map((i) => ({
        ...i,
        job: i.job_id ? (byJob.get(i.job_id) ?? null) : null,
      }));
    },
    refetchInterval: 120_000,
  });
}

function useMyActivity(userId: string | null) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["chase", "activity", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("incident_events")
        .select("id, event_type, occurred_at, incidents(address)")
        .eq("actor_id", userId!)
        .order("occurred_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        event_type: string;
        occurred_at: string;
        incidents: { address: string | null } | null;
      }[];
    },
    refetchInterval: 120_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

function ChaseCockpit() {
  const app = useAppContext();
  const { disabled: writesDisabled, reason: writesReason } = useWritesDisabled();
  const qc = useQueryClient();
  const [confirmOff, setConfirmOff] = useState(false);
  const [dutyBusy, setDutyBusy] = useState(false);
  const [, setDutyTick] = useState(0);

  // Every "my …" read on this screen is the viewed person's under View As
  // (viewerUserId); the writes further down keep app.userId.
  const shiftQ = useOpenShift(app.viewerUserId);
  const shift = shiftQ.data ?? null;

  const scopeQ = useDispatchScope(app.viewerUserId);
  const territoryQ = useTerritoryLabel(app.viewerUserId);
  const shiftSettingsQ = useQuery({
    queryKey: ["chase", "shift-settings"],
    queryFn: fetchChaseShiftSettings,
    staleTime: 300_000,
  });
  const boardQ = useBoard(app.viewerUserId);
  const passedQ = useMyPassed(app.viewerUserId);
  const signedQ = useSignedToday(app.viewerUserId);

  /* Device permissions — explainer first, never a cold browser prompt. */
  const perms = useDevicePermissions(app.userId);
  const [explainerOpen, setExplainerOpen] = useState(false);
  useEffect(() => {
    if (!perms.loading && !perms.primed) setExplainerOpen(true);
  }, [perms.loading, perms.primed]);

  const activityQ = useMyActivity(app.viewerUserId);

  useEffect(() => {
    if (!shift) return;
    const t = setInterval(() => setDutyTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [shift?.id]);

  const shiftSettings = shiftSettingsQ.data ?? null;
  const overtime = overtimeState(
    shift?.scheduled_end_at,
    shiftSettings ?? {
      overtimeReminderMinutes: 15,
      overtimeEscalateMinutes: 60,
      autoCloseHours: 16,
    },
  );

  /**
   * Overtime nags on a repeat, not once — the server also writes an in-app
   * notification on the same cadence, this is the in-page prompt.
   */
  const lastNagRef = useRef(0);
  useEffect(() => {
    if (!shift || !overtime.over || !shiftSettings) return;
    const everyMs = Math.max(shiftSettings.overtimeReminderMinutes, 1) * 60_000;
    const nag = () => {
      if (Date.now() - lastNagRef.current < everyMs) return;
      lastNagRef.current = Date.now();
      toast.warning(
        `Shift ended at ${endTimeLabel(shift.scheduled_end_at) ?? "your scheduled time"} — clock out?`,
        { description: "You are still on the clock.", duration: 12_000 },
      );
    };
    nag();
    const t = setInterval(nag, 60_000);
    return () => clearInterval(t);
  }, [shift?.id, overtime.over, shiftSettings?.overtimeReminderMinutes]);

  const refreshBoard = () => {
    qc.invalidateQueries({ queryKey: ["chase", "board"] });
    qc.invalidateQueries({ queryKey: ["chase", "my-dispatches"] });
    qc.invalidateQueries({ queryKey: ["chase", "signed-today"] });
    qc.invalidateQueries({ queryKey: ["chase", "activity"] });
  };

  const rows = boardQ.data ?? [];
  const scope = scopeQ.data ?? null;
  const passed = useMemo(() => new Set(passedQ.data ?? []), [passedQ.data]);

  /** Their active chases — accepted, still awaiting an outcome. */
  const myChases = useMemo(
    () => rows.filter((i) => i.accepted_by === app.viewerUserId && !i.outcome),
    [rows, app.viewerUserId],
  );

  const unclaimed = useMemo(
    () => rows.filter((i) => !i.accepted_by && !passed.has(i.id)),
    [rows, passed],
  );

  /**
   * In my zones → alert. Elsewhere in my market → still open. Alerts are
   * auto-ranked: worst fire first, then freshest.
   */
  const myAlerts = useMemo(() => {
    const rank = { high: 0, med: 1, low: 2 } as const;
    const list = scope ? unclaimed.filter((i) => inDispatchScope(scope, i)) : unclaimed;
    return [...list].sort(
      (a, b) =>
        rank[incidentSeverity(a)] - rank[incidentSeverity(b)] ||
        new Date(b.reported_at).getTime() - new Date(a.reported_at).getTime(),
    );
  }, [unclaimed, scope]);

  const stillOpen = useMemo(
    () =>
      scope
        ? unclaimed.filter(
            (i) => !inDispatchScope(scope, i) && (!i.market_id || i.market_id === scope.marketId),
          )
        : [],
    [unclaimed, scope],
  );

  /** Everything worth plotting: my alerts, my active chases, then the market. */
  const mapIncidents = useMemo(
    () => [...myChases, ...myAlerts, ...stillOpen],
    [myChases, myAlerts, stillOpen],
  );

  /** Map selection. Defaults to the top-ranked alert so the map is never idle. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const focus = useMemo(
    () => mapIncidents.find((i) => i.id === focusId) ?? myAlerts[0] ?? null,
    [mapIncidents, focusId, myAlerts],
  );

  /**
   * The chaser's own position, so the plot can draw the run to the incident.
   *
   * Read when the cockpit opens and again when the chaser comes back to it —
   * NOT on a timer. It used to poll every two minutes with
   * `enableHighAccuracy`, for as long as the screen was open, which is the
   * battery-hungriest thing a phone can be asked to do and bought nothing: a
   * chaser sitting in a truck does not move, and one who IS moving reads their
   * position again the moment they look at the screen.
   *
   * Every chaser action already stamps its own fix through
   * `getCurrentPosition()`, and that helper reuses a fix up to 30 seconds old,
   * so the events supervisors rely on are unaffected. Melly wanted location
   * captured with the work, not a GPS loop running behind it.
   */
  const [myPos, setMyPos] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void getCurrentPosition().then((p) => {
        if (p && !cancelled) setMyPos({ lat: p.lat, lon: p.lon });
      });
    read();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const goOnDuty = async () => {
    const locId = app.currentLocationId || app.visibleLocations[0]?.id;
    if (!app.userId || !locId) return;
    setDutyBusy(true);
    const pos = await getCurrentPosition();
    const { error } = await supabase.from("chaser_shifts").insert({
      user_id: app.userId,
      location_id: locId,
      started_lat: pos?.lat ?? null,
      started_lon: pos?.lon ?? null,
    });
    setDutyBusy(false);
    if (error) {
      toastDbError(error, { action: "Going on duty" });
      return;
    }
    toast.success("On duty");
    qc.invalidateQueries({ queryKey: ["chase", "shift"] });
  };

  const goOffDuty = async (opts?: { flagIncidentId?: string }) => {
    if (!shift) return;
    setDutyBusy(true);
    const pos = await getCurrentPosition();
    const nowIso = new Date().toISOString();

    if (opts?.flagIncidentId) {
      await supabase.from("incident_events").insert({
        incident_id: opts.flagIncidentId,
        event_type: "escalated",
        actor_id: app.userId,
        lat: pos?.lat ?? null,
        lon: pos?.lon ?? null,
        payload: { reason: "chaser_went_off_duty", needs_dispatcher: true },
      });
    }

    const { error } = await supabase
      .from("chaser_shifts")
      .update({ ended_at: nowIso, ended_lat: pos?.lat ?? null, ended_lon: pos?.lon ?? null })
      .eq("id", shift.id);
    setDutyBusy(false);
    if (error) {
      toastDbError(error, { action: "Going off duty" });
      return;
    }
    setConfirmOff(false);
    toast(
      opts?.flagIncidentId
        ? "Off duty — chase flagged for the dispatcher"
        : "Off duty — alerts stopped",
    );
    qc.invalidateQueries({ queryKey: ["chase"] });
  };

  const requestOffDuty = () => {
    if (myChases.length > 0) setConfirmOff(true);
    else void goOffDuty();
  };

  /* ------------------- Guard rails ------------------- */

  if (app.loading) return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;

  if (app.visibleLocations.length === 0) {
    return (
      <div className="p-3">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No location access</AlertTitle>
          <AlertDescription>
            You aren't a member of any location, so no chase alerts can reach you. Ask an admin to
            add you to a location under Admin → Users.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const shiftHours =
    shiftHoursLabel(territoryQ.data?.shiftStart, territoryQ.data?.shiftEnd) ??
    (shift?.scheduled_start_at && shift?.scheduled_end_at
      ? `${endTimeLabel(shift.scheduled_start_at)} – ${endTimeLabel(shift.scheduled_end_at)}`
      : null);

  const shiftDuration = shift
    ? formatDuration(Date.now() - new Date(shift.started_at).getTime())
    : null;

  const fires = rows.filter((i) => i.incident_type === "fire");
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const firesToday = fires.filter((i) => new Date(i.reported_at) >= startToday).length;
  const firesYesterday = fires.length - firesToday;
  const enRoute = myChases.filter((i) => !i.arrived_at).length;
  const accepted = rows.filter((i) => i.accepted_by === app.viewerUserId).length;
  const signedCount = (signedQ.data ?? []).length;
  const conversion = accepted ? Math.round((signedCount / accepted) * 100) : 0;
  const responses = rows
    .filter((i) => i.accepted_at && i.arrived_at)
    .map((i) => new Date(i.arrived_at!).getTime() - new Date(i.accepted_at!).getTime());
  const avgResponse = responses.length
    ? Math.round(responses.reduce((a, b) => a + b, 0) / responses.length / 60000)
    : null;
  const newestId = myAlerts[0]?.id ?? mapIncidents[0]?.id ?? null;
  const lockCls = cn(
    "transition-[filter,opacity] duration-700",
    !shift && "pointer-events-none select-none blur-[10px] saturate-[0.35] opacity-70",
  );

  /**
   * Focus mode. One chase = one screen: while a chase is live, it owns the
   * page and everything else shrinks to a strip.
   */
  const activeChase = myChases[0] ?? null;
  const focusMode = !!shift && !!activeChase;

  const releaseChase = async () => {
    if (!activeChase) return;
    try {
      // The database decides what "released" means — other responders may still
      // be on it, in which case the fire does not go back on the board.
      const res = await releaseClaim(activeChase.id, "chase_cancelled_by_chaser");
      toast(
        res.reopened
          ? "Chase released — back on the board"
          : `Released — ${res.remaining} chaser${res.remaining === 1 ? "" : "s"} still on it`,
      );
    } catch (e) {
      toastDbError(e, { action: "Releasing the chase" });
      return;
    }
    refreshBoard();
  };

  if (focusMode && activeChase) {
    return (
      <div className="chase-cockpit relative w-full space-y-3 bg-[var(--surface)] p-3 pb-28 text-[var(--foreground)] md:pb-3">
        {/* ---------- Slim strip: everything the cockpit normally shows ---------- */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[8px] border border-[color-mix(in_oklab,var(--success)_40%,transparent)] bg-[color-mix(in_oklab,var(--success)_14%,var(--card))] px-4 py-2.5 text-[12px]">
          <span className="flex items-center gap-2">
            <span
              className="size-2.5 animate-pulse rounded-full"
              style={{ background: "var(--success)" }}
            />
            <span
              className="text-[13px] font-extrabold uppercase tracking-[0.08em]"
              style={{ color: "var(--success)" }}
            >
              On a chase
            </span>
          </span>
          <span className="text-[var(--muted-foreground)]">
            Open alerts{" "}
            <span className="font-semibold text-[var(--foreground)]">{myAlerts.length}</span>
          </span>
          <span className="text-[var(--muted-foreground)]">
            Signed today{" "}
            <span className="font-semibold text-[var(--foreground)]">{signedCount}</span>
          </span>
          {shiftDuration && (
            <span className="text-[var(--muted-foreground)]">
              On shift{" "}
              <span className="font-mono font-semibold tabular-nums text-[var(--foreground)]">
                {shiftDuration}
              </span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden sm:block">
              <WeatherChip pos={myPos} />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={writesDisabled}
              onClick={() => void releaseChase()}
            >
              Cancel chase
            </Button>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-3">
            {/* ---------- Hero: the chase itself ---------- */}
            <AcceptedIncidentCard
              incident={activeChase}
              writesDisabled={writesDisabled}
              onChange={refreshBoard}
              onOpenSibling={setFocusId}
            />

            {/* ---------- Map, locked to the route to this incident ---------- */}
            <div className="relative overflow-hidden rounded-[8px] border border-[var(--border)] bg-card">
              <CockpitMap
                incidents={[activeChase]}
                selectedId={activeChase.id}
                onSelect={() => {}}
                me={myPos}
                newestId={activeChase.id}
                className="h-[300px] md:h-[420px]"
              />
              <NextStopCard incident={activeChase} me={myPos} />
            </div>
          </div>

          {/* ---------- Scanner stays, compact ---------- */}
          <aside className="min-w-0">
            <ScannerFeedCard
              incidents={[...myAlerts, ...stillOpen]}
              selectedId={null}
              live
              compact
              readOnly
              onSelect={() => {}}
            />
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="chase-cockpit relative w-full space-y-3 bg-[var(--surface)] p-3 pb-28 text-[var(--foreground)] md:pb-3">
      <PermissionPrimingScreen
        open={explainerOpen}
        onContinue={async () => {
          await perms.prime();
          setExplainerOpen(false);
        }}
        onSkip={() => {
          setExplainerOpen(false);
          void perms.dismissExplainer();
        }}
      />
      <PermissionDeniedBanner
        location={perms.location}
        notifications={perms.notifications}
        degraded={perms.degraded}
        platform={perms.platform}
        onRetry={async () => {
          await perms.prime();
        }}
      />
      <SyncBanner />

      {/* ---------- Chasing banner ---------- */}

      {shift && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-3 rounded-[8px] border px-4 py-2.5",
            overtime.over
              ? "border-[color-mix(in_oklab,var(--warning)_55%,transparent)] bg-[color-mix(in_oklab,var(--warning)_16%,var(--card))]"
              : "border-[color-mix(in_oklab,var(--success)_40%,transparent)] bg-[color-mix(in_oklab,var(--success)_14%,var(--card))]",
          )}
        >
          <span className="flex items-center gap-2">
            <span
              className="size-2.5 animate-pulse rounded-full"
              style={{ background: overtime.over ? "var(--warning)" : "var(--success)" }}
            />
            <span
              className="text-[13px] font-extrabold uppercase tracking-[0.08em]"
              style={{ color: overtime.over ? "var(--warning)" : "var(--success)" }}
            >
              {overtime.over ? "Shift ended — clock out?" : "You are chasing"}
            </span>
          </span>
          <span className="text-[12px] text-[var(--muted-foreground)]">
            Territory{" "}
            <span className="font-semibold text-[var(--foreground)]">
              {territoryQ.data?.label ??
                (scope
                  ? scope.wholeMarket
                    ? "Whole market"
                    : `${scope.zoneIds.size} zones`
                  : "Not assigned")}
            </span>
          </span>
          {shiftHours && (
            <span className="text-[12px] text-[var(--muted-foreground)]">
              Hours <span className="font-semibold text-[var(--foreground)]">{shiftHours}</span>
            </span>
          )}
          {overtime.over && (
            <span className="text-[12px] font-semibold" style={{ color: "var(--warning)" }}>
              {`Shift ended at ${endTimeLabel(shift.scheduled_end_at) ?? "—"} · ${formatDuration(
                overtime.minutesOver * 60_000,
              )} over`}
              {overtime.escalated || shift.overtime_escalated_at ? " · manager alerted" : ""}
            </span>
          )}
          <ConnectionChip />
          {shiftDuration && (
            <span className="text-[12px] text-[var(--muted-foreground)]">
              On shift{" "}
              <span className="font-mono font-semibold tabular-nums text-[var(--foreground)]">
                {shiftDuration}
              </span>
            </span>
          )}

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden sm:block">
              <WeatherChip pos={myPos} />
            </div>
            <button
              type="button"
              disabled={dutyBusy || writesDisabled}
              onClick={requestOffDuty}
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--destructive)] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-white transition hover:opacity-90 disabled:opacity-60"
            >
              <Power className="size-3.5" />
              Clock out
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {/* ---------- KPI row ---------- */}
        <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", lockCls)} aria-hidden={!shift}>
          <KpiCard
            icon={<Flame className="size-5" style={{ color: "var(--destructive)" }} />}
            tint="#FDECEB"
            label="Fires Today"
            value={firesToday}
            sub={`${firesToday - firesYesterday >= 0 ? "+" : ""}${firesToday - firesYesterday} vs yesterday`}
            subColor="var(--destructive)"
          />
          <KpiCard
            icon={<Truck className="size-5" style={{ color: "#FA6702" }} />}
            tint="#FEF0E4"
            label="En Route"
            value={enRoute}
            sub={`${enRoute} Active Route${enRoute === 1 ? "" : "s"}`}
            subColor="#FA6702"
          />
          <KpiCard
            icon={<Users className="size-5" style={{ color: "var(--success)" }} />}
            tint="color-mix(in oklab, var(--success) 14%, var(--card))"
            label="Qualified Leads"
            value={accepted}
            sub={`${conversion}% Conversion`}
            subColor="var(--success)"
          />
          <KpiCard
            icon={<Timer className="size-5" style={{ color: "var(--primary)" }} />}
            tint="#E6EFFE"
            label="Avg Response"
            value={avgResponse == null ? "—" : `${avgResponse}m`}
            sub={avgResponse == null ? "No arrivals logged" : "Accept → on scene"}
            subColor="var(--primary)"
          />
        </div>

        {!scopeQ.isLoading && !scope && (
          <div className={lockCls} aria-hidden={!shift}>
            <Alert variant="warning">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>No chase territory assigned</AlertTitle>
              <AlertDescription>
                Until an admin assigns your market and zones under Admin → Territory, you're seeing
                everything you have access to rather than your own slice.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* ---------- Map + right rail ---------- */}
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_352px]">
          <div className="relative min-w-0">
            <div className={cn("min-w-0 space-y-3", lockCls)} aria-hidden={!shift}>
              <div className="relative overflow-hidden rounded-[8px] border border-[var(--border)] bg-card">
                <CockpitMap
                  incidents={mapIncidents}
                  selectedId={focus?.id ?? null}
                  onSelect={setFocusId}
                  me={myPos}
                  newestId={newestId}
                  className="h-[300px] md:h-[470px]"
                />
                {focus && <NextStopCard incident={focus} me={myPos} />}
              </div>

              {myChases.length > 0 && (
                <Section title="Your active chase">
                  {myChases.map((i) => (
                    <AcceptedIncidentCard
                      key={i.id}
                      incident={i}
                      writesDisabled={writesDisabled}
                      onChange={refreshBoard}
                      onOpenSibling={setFocusId}
                    />
                  ))}
                </Section>
              )}

              {focus && !focus.accepted_by && (
                <Section title="Selected incident">
                  <AlertCard
                    key={focus.id}
                    incident={focus}
                    writesDisabled={writesDisabled}
                    onChange={refreshBoard}
                  />
                </Section>
              )}

              {/* ---------- Bottom row of four ---------- */}
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <CompetitorActivityCard />
                <ContactStatusCard incident={focus} writesDisabled={writesDisabled} />
                <QuickNotesCard incident={focus} writesDisabled={writesDisabled} />
                <PhotoUploadCard incident={focus} />
              </div>
            </div>
            {!shift && (
              <ChaseLockOverlay
                busy={dutyBusy || writesDisabled}
                onClockIn={() => void goOnDuty()}
              />
            )}
          </div>

          {/* ---------- Right rail — scanner feed stays live while clocked out ---------- */}
          <aside className="flex min-w-0 flex-col xl:sticky xl:top-3 xl:h-[calc(100vh-6.5rem)]">
            <ScannerFeedCard
              incidents={[...myAlerts, ...stillOpen]}
              selectedId={focus?.id ?? null}
              live
              fill
              readOnly={!shift}
              onSelect={setFocusId}
            />
          </aside>
        </div>

        {/* ---------- Status bar ---------- */}
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[8px] border border-[var(--border)] bg-card px-4 py-3 text-[12px]",
            lockCls,
          )}
          aria-hidden={!shift}
        >
          <span className="flex items-center gap-2 font-semibold">
            <span
              className="size-2.5 rounded-full"
              style={{ background: shift ? "var(--success)" : "var(--muted-foreground)" }}
            />
            Scanner {shift ? "connected" : "idle"}
          </span>
          <span className="text-[var(--muted-foreground)]">
            GPS accuracy{" "}
            <span className="font-semibold text-[var(--foreground)]">
              {myPos ? "live" : "unavailable"}
            </span>
          </span>
          <span className="text-[var(--muted-foreground)]">
            Drive mode <span className="font-semibold text-[var(--foreground)]">Chaser</span>
          </span>
          <span className="text-[var(--muted-foreground)]">
            Territory{" "}
            <span className="font-semibold text-[var(--foreground)]">
              {territoryQ.data?.label ??
                (scope
                  ? scope.wholeMarket
                    ? "Whole market"
                    : `${scope.zoneIds.size} zones`
                  : "Not assigned")}
            </span>
          </span>
          {shiftDuration && (
            <span className="text-[var(--muted-foreground)]">
              On duty{" "}
              <span className="font-mono font-semibold tabular-nums text-[var(--foreground)]">
                {shiftDuration}
              </span>
            </span>
          )}
          <button
            type="button"
            disabled={dutyBusy || writesDisabled}
            onClick={() => (shift ? requestOffDuty() : void goOnDuty())}
            className={
              "ml-auto inline-flex items-center gap-2 rounded-[6px] border px-4 py-2 text-[12px] font-bold uppercase tracking-[0.06em] disabled:opacity-60 " +
              (shift
                ? "border-[var(--primary)] text-[var(--primary)] hover:bg-[#E6EFFE] dark:hover:bg-accent"
                : "border-transparent bg-[#c2410c] text-white hover:bg-[#9a3412]")
            }
          >
            <Power className="size-4" />
            {shift ? "End route" : "Go on duty"}
          </button>
        </div>
      </div>

      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Go off duty?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You have an active chase at {myChases[0]?.address ?? "an unknown address"}. Log an
            outcome first, or go off duty and leave it flagged for the dispatcher.
          </p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setConfirmOff(false)}>
              Keep chasing
            </Button>
            <Button
              variant="outline"
              disabled={dutyBusy}
              onClick={() => void goOffDuty({ flagIncidentId: myChases[0]?.id })}
            >
              Flag for dispatcher &amp; go off duty
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Locked cockpit gate — clicking the logo clocks the chaser in.
 *  Fixed to the viewport upper third so it never gets pushed below the fold.
 */
function ChaseLockOverlay({ busy, onClockIn }: { busy: boolean; onClockIn: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-30 flex items-start justify-center p-6 pt-[28vh] sm:pt-[30vh]">
      <div className="pointer-events-auto flex flex-col items-center gap-4 text-center">
        <button
          type="button"
          disabled={busy}
          onClick={onClockIn}
          aria-label="Clock in and start chasing"
          className="group rounded-2xl p-4 outline-none transition-transform duration-500 hover:scale-[1.06] focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-60"
        >
          <img
            src="/gold-star-logo.png"
            alt="Gold Star Restoration"
            className="h-24 w-auto grayscale transition-[filter,transform] duration-700 ease-out group-hover:grayscale-0 group-hover:drop-shadow-[0_10px_30px_rgba(0,0,0,0.18)] group-active:scale-95 md:h-32"
          />
        </button>
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--foreground)]">
            {busy ? "Clocking in…" : "Tap the star to start chasing"}
          </div>
          <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
            The cockpit unlocks once you are clocked in.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Layout helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Cockpit panel. Every one carries the per-user eye toggle: hiding is personal
 * and reversible from the "Hidden (n)" control in the page header.
 */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <HideableSection sectionKey={slugKey(title)} label={title}>
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {title}
          </div>
          {action}
        </div>
        {children}
      </section>
    </HideableSection>
  );
}

/** Stable key from a panel title, so saved hides survive copy edits poorly but reads well. */
function slugKey(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="px-3 py-2.5 text-[13px] text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}

/** On/off duty toggle chip — the primary duty control. */
function DutyChip({ on, busy, onClick }: { on: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      aria-pressed={on}
      title={on ? "Tap to go off duty" : "Tap to go on duty"}
      className={
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-semibold uppercase tracking-wide transition disabled:opacity-60 " +
        (on
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
          : "border-border bg-muted text-muted-foreground hover:bg-muted/70")
      }
    >
      <span
        className={
          "grid size-2.5 shrink-0 place-items-center rounded-full " +
          (on
            ? "bg-emerald-500 shadow-[0_0_8px_theme(colors.emerald.400)]"
            : "bg-muted-foreground/50")
        }
      />
      {on ? "On duty" : "Off duty"}
      <Power className="size-3.5 opacity-70" />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Cards                                                              */
/* ------------------------------------------------------------------ */

/**
 * Alert card. Dispatch facts only — code, building type, units. Property and
 * owner detail loads after the claim, never on the board.
 */
/** Colour-coded severity, derived from the dispatch facts. Display only. */
function SeverityBadge({ incident }: { incident: Incident }) {
  const sev = incidentSeverity(incident);
  return <span className={`sev-badge sev-${sev}`}>{sev}</span>;
}

function AlertCard({
  incident,
  writesDisabled,
  onChange,
}: {
  incident: Incident;
  writesDisabled: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);

  const accept = async () => {
    setBusy(true);
    // Maps opens on the tap itself — nothing awaits in front of it, so no
    // popup blocker and no dialog stands between the chaser and the road.
    if (incident.address || (incident.lat && incident.lon)) {
      window.open(
        mapsDeepLink(incident.address ?? "", incident.lat, incident.lon),
        "_blank",
        "noopener,noreferrer",
      );
    }
    const pos = await getCurrentPosition();
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) {
      setBusy(false);
      return;
    }
    let result;
    try {
      result = await claimIncident(incident.id);
    } catch (e) {
      toast.error(actionErrorMessage(e, "Could not accept"));
      setBusy(false);
      return;
    }
    if (!result.claimed) {
      toast(raceMessage(result));
      setBusy(false);
      onChange();
      return;
    }
    // Signal now, doorstep later: pull property, contract and map to the device.
    void prefetchForIncident(incident.id);
    await supabase.from("incident_events").insert({
      incident_id: incident.id,
      event_type: "accepted",
      actor_id: uid,
      lat: pos?.lat ?? null,
      lon: pos?.lon ?? null,
    });
    setBusy(false);
    onChange();
  };

  const detail = dispatchDetailLine(incident);

  return (
    <>
      <Card className="border-2 border-[var(--brand-red)]/60">
        <CardContent className="space-y-3 py-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-[var(--brand-red)]">
                <Flame className="size-3.5" /> {fireTypeLine(incident)} ·{" "}
                {timeSince(incident.reported_at)}
              </div>
              <div className="mt-1 text-lg font-semibold leading-tight">
                {incident.address ?? "Unknown address"}
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {[incident.locality, incident.postal_code].filter(Boolean).join(" · ") || "—"}
              </div>
              {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
              <IncidentSources incident={incident} />
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <SeverityBadge incident={incident} />
              <Badge variant="outline" className="uppercase">
                {INCIDENT_TYPE_LABEL[incident.incident_type]}
              </Badge>
            </div>
          </div>

          {/* What already failed here — never knock the same door blind. */}
          <AttemptHistory incidentId={incident.id} />

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button
              variant="outline"
              size="lg"
              className="h-14"
              disabled={busy || writesDisabled}
              onClick={() => setDeclineOpen(true)}
            >
              Decline
            </Button>
            <Button
              size="lg"
              className="h-14 bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700"
              disabled={busy || writesDisabled}
              onClick={accept}
            >
              <NavIcon className="mr-2 size-4" />
              Claim &amp; go
            </Button>
          </div>
        </CardContent>
      </Card>

      <DeclineSheet
        open={declineOpen}
        onOpenChange={setDeclineOpen}
        incidentId={incident.id}
        onDeclined={() => {
          setDeclineOpen(false);
          onChange();
        }}
      />
    </>
  );
}

/** Read-only row for leads outside this chaser's zones. Dispatch facts only. */
function LeadRow({ incident }: { incident: Incident }) {
  const detail = dispatchDetailLine(incident);
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{incident.address ?? "—"}</div>
        <div className="truncate text-xs text-muted-foreground">
          {fireTypeLine(incident)}
          {detail ? ` · ${detail}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SeverityBadge incident={incident} />
        <span className="text-xs text-muted-foreground">{timeSince(incident.reported_at)}</span>
      </div>
    </div>
  );
}

/** Big-number stat tile for the command rail. */
function StatTile({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint?: string;
  tone: "danger" | "warning" | "info" | "success";
}) {
  return (
    <div className={`cmd-stat cmd-stat-${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="cmd-stat-icon">{icon}</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="cmd-stat-value font-mono tabular-nums">{value}</div>
      {hint && <div className="truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Dispatch intelligence for the selected pin, sitting under the plot. */
function IntelligenceStrip({ incident }: { incident: Incident | null }) {
  if (!incident) {
    return (
      <div className="border-t px-3 py-3 text-[13px] text-muted-foreground">
        Select an incident to see its dispatch intelligence.
      </div>
    );
  }
  const cells: { k: string; v: string }[] = [
    { k: "Type", v: INCIDENT_TYPE_LABEL[incident.incident_type] ?? "—" },
    { k: "Alarm", v: incident.alarm_level ?? "—" },
    { k: "Structure", v: incident.building_type ?? "—" },
    {
      k: "Units",
      v: incident.units_dispatched != null ? String(incident.units_dispatched) : "—",
    },
  ];
  return (
    <div className="border-t">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          <div className="truncate text-[17px] font-bold leading-tight">
            {incident.address ?? "Unknown address"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[incident.locality, incident.postal_code].filter(Boolean).join(" · ") || "—"} ·{" "}
            {fireTypeLine(incident)}
          </div>
        </div>
        <SeverityBadge incident={incident} />
      </div>
      <div className="mt-2 grid grid-cols-2 divide-x divide-y border-t sm:grid-cols-4 sm:divide-y-0">
        {cells.map((c) => (
          <div key={c.k} className="px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              {c.k}
            </div>
            <div className="truncate text-sm font-semibold">{c.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ranked scanner-feed row. Rank is the auto-ranking, not a manual queue. */
function RankedRow({
  rank,
  incident,
  active,
  onSelect,
}: {
  rank: number;
  incident: Incident;
  active: boolean;
  onSelect: () => void;
}) {
  const detail = dispatchDetailLine(incident);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        "flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-accent/50 " +
        (active ? "cmd-row-active" : "")
      }
    >
      <span className="cmd-rank font-mono tabular-nums">{rank}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <SeverityBadge incident={incident} />
          <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
            {timeSince(incident.reported_at)}
          </span>
        </span>
        <span className="mt-1 block truncate text-sm font-semibold">
          {incident.address ?? "Unknown address"}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {fireTypeLine(incident)}
          {detail ? ` · ${detail}` : ""}
        </span>
      </span>
    </button>
  );
}

function AcceptedIncidentCard({
  incident,
  writesDisabled,
  onChange,
  onOpenSibling,
}: {
  incident: Incident;
  writesDisabled: boolean;
  onChange: () => void;
  onOpenSibling?: (id: string) => void;
}) {
  const app = useAppContext();
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [exposureOpen, setExposureOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const contractNavigate = useNavigate();
  const arrived = !!incident.arrived_at;

  /**
   * The full agreement needs a job to hang off. A signature at the scene is
   * what creates the job, so if the incident has none yet we create it here and
   * carry the incident's property details across.
   */
  const openContract = async () => {
    let jobId = incident.job_id;
    if (!jobId) {
      const id = crypto.randomUUID();
      const { error } = await supabase.from("jobs").insert({
        id,
        location_id: incident.location_id,
        account_id: incident.account_id,
        address: incident.address,
        status: "new",
        created_by: app.userId,
      } as never);
      if (error) {
        toast.error("Could not open the contract — the job could not be created.");
        return;
      }
      await supabase.from("incidents").update({ job_id: id }).eq("id", incident.id);
      jobId = id;
      onChange();
    }
    void contractNavigate({ to: "/contract/$jobId", params: { jobId } });
  };
  const [, setTick] = useState(0);
  useEffect(() => {
    if (arrived) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [arrived]);
  const acceptedMs = incident.accepted_at ? new Date(incident.accepted_at).getTime() : null;
  const arrivedMs = incident.arrived_at ? new Date(incident.arrived_at).getTime() : null;
  const tta = acceptedMs ? (arrivedMs ?? Date.now()) - acceptedMs : 0;

  /**
   * Derived arrival. When the app comes back to the foreground — phone out of
   * the pocket, back from the front door — we check where the device is and
   * stamp it if it's at the address. The chaser is told, not asked.
   */
  useEffect(() => {
    if (arrived || writesDisabled) return;
    let cancelled = false;
    const attempt = () => {
      if (document.visibilityState !== "visible") return;
      void tryProximityArrival(incident.id).then((ok) => {
        if (ok && !cancelled) onChange();
      });
    };
    attempt();
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("focus", attempt);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("focus", attempt);
    };
  }, [incident.id, arrived, writesDisabled, onChange]);

  const logArrival = async () => {
    const pos = await getCurrentPosition();
    try {
      await markArrivedManually(incident.id, { lat: pos?.lat ?? null, lon: pos?.lon ?? null });
    } catch (error) {
      toastDbError(error, { action: "Logging arrival" });
      return;
    }
    const { data: userRes } = await supabase.auth.getUser();
    await supabase.from("incident_events").insert({
      incident_id: incident.id,
      event_type: "arrived",
      actor_id: userRes.user?.id ?? null,
      lat: pos?.lat ?? null,
      lon: pos?.lon ?? null,
      payload: { time_to_arrival_ms: tta, method: "manual" },
    });
    toast.success("Arrival logged");
    onChange();
  };

  const undoArrival = async () => {
    try {
      await clearArrival(incident.id);
      onChange();
    } catch (error) {
      toastDbError(error, { action: "Changing the arrival time" });
    }
  };

  /**
   * Any on-scene action stamps arrival first, then does what was asked. The
   * stamp never blocks the action — the work matters more than the metric.
   */
  const onSceneAction = (
    action: "sign_up" | "photo" | "outcome" | "exposure",
    open: () => void,
  ) => {
    open();
    if (arrived || writesDisabled) return;
    void stampArrivalFromAction(incident.id, action).then((ok) => {
      if (ok) onChange();
    });
  };

  const detail = dispatchDetailLine(incident);
  const derived = arrived && incident.arrival_method && incident.arrival_method !== "manual";
  const locationId = incident.location_id ?? app.currentLocationId ?? app.visibleLocations[0]?.id;

  return (
    <>
      <Card className="border-2 border-brand">
        <CardContent className="space-y-3 py-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest text-brand">
                {arrived ? "On scene" : "Accepted · en route"}
              </div>
              <div className="mt-1 text-lg font-semibold leading-tight">
                {incident.address ?? "Unknown address"}
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                {[incident.locality, incident.postal_code].filter(Boolean).join(" · ") || "—"}
              </div>
              <div className="mt-1">
                <ExposureOriginLeadChip incident={incident} onOpen={onOpenSibling} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {fireTypeLine(incident)}
                {detail ? ` · ${detail}` : ""}
              </div>
              <IncidentSources incident={incident} />
            </div>
            <Badge variant="outline" className="shrink-0 uppercase">
              {INCIDENT_TYPE_LABEL[incident.incident_type]}
            </Badge>
          </div>

          <AttemptHistory incidentId={incident.id} />

          {/* Owner data is a paid lookup, so it happens once, here, after accept. */}
          <PropertyPanel incidentId={incident.id} />

          {derived ? (
            // Passive: it already happened, and can be corrected without a prompt.
            <div className="flex items-center justify-between gap-2 rounded-sm bg-muted/50 px-3 py-2 text-xs">
              <span>{arrivalStampLine(incident.arrived_at!, incident.arrival_method)}</span>
              <button
                type="button"
                className="shrink-0 underline text-muted-foreground"
                onClick={() => void undoArrival()}
              >
                change?
              </button>
            </div>
          ) : arrived ? (
            <div className="rounded-sm bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              Arrived {timeSince(incident.arrived_at)}
            </div>
          ) : null}

          {!arrived && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="lg"
                className="h-14 bg-[#2f6bff] text-white hover:bg-[#2f6bff]/90"
                asChild
              >
                <a
                  href={mapsDeepLink(incident.address ?? "", incident.lat, incident.lon)}
                  target="_blank"
                  rel={EXTERNAL_LINK_REL}
                >
                  <NavIcon className="mr-2 size-5" />
                  Open in Maps
                </a>
              </Button>
              <Button
                size="lg"
                className="h-14 bg-amber-500 font-semibold text-foreground hover:bg-amber-600"
                disabled={writesDisabled}
                onClick={logArrival}
              >
                <MapPin className="mr-2 size-5" />
                I've arrived
              </Button>
            </div>
          )}

          {/*
            These can only be done on scene, so doing any of them is the
            arrival stamp. No extra tap is ever asked for.
          */}
          <div className="space-y-2">
            <Button
              size="lg"
              className="h-14 w-full text-base"
              disabled={writesDisabled || !locationId}
              onClick={() => onSceneAction("sign_up", () => setSignOpen(true))}
            >
              <PenLine className="mr-2 size-5" />
              Sign the owner
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-12 w-full"
              disabled={writesDisabled || !locationId}
              onClick={() => onSceneAction("sign_up", () => void openContract())}
            >
              <FileSignature className="mr-2 size-4" />
              Full contract
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="lg"
                className="h-12"
                disabled={writesDisabled}
                onClick={() => onSceneAction("exposure", () => setExposureOpen(true))}
              >
                <Plus className="mr-1.5 size-4" />
                Sign a neighbor
              </Button>
              <Button
                variant="outline"
                size="lg"
                className="h-12"
                disabled={writesDisabled}
                onClick={() => onSceneAction("outcome", () => setOutcomeOpen(true))}
              >
                Log outcome
              </Button>
            </div>
          </div>

          {/* The fire and its neighbours: siblings, never a cascade. */}
          <ExposureGroupPanel incident={incident} onOpen={onOpenSibling} />
        </CardContent>
      </Card>

      <WorkAuthorizationDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        target={{
          incidentId: incident.id,
          accountId: incident.account_id,
          jobId: incident.job_id,
          locationId: locationId ?? "",
          address: incident.address ?? "",
          lossType: INCIDENT_TYPE_LABEL[incident.incident_type],
        }}
        onSigned={onChange}
      />

      <ExposureSheet
        open={exposureOpen}
        onOpenChange={setExposureOpen}
        incident={incident}
        onCreated={onChange}
      />

      <OutcomeSheet
        open={outcomeOpen}
        onOpenChange={setOutcomeOpen}
        incident={incident}
        onSaved={() => {
          setOutcomeOpen(false);
          onChange();
        }}
      />
    </>
  );
}

/** Owner and property facts, looked up once per accepted alert. */
function PropertyPanel({ incidentId }: { incidentId: string }) {
  const lookup = useServerFn(lookupIncidentProperty);
  const q = useQuery({
    queryKey: ["chase", "property", incidentId],
    queryFn: () => lookup({ data: { incidentId } }),
    staleTime: Infinity,
    retry: false,
  });

  if (q.isLoading) {
    return <div className="px-1 text-[12px] text-muted-foreground">Looking up the property…</div>;
  }
  if (!q.data || q.data.status !== "ok") {
    return (
      <div className="px-1 text-[12px] text-muted-foreground">
        {q.data?.status === "unavailable" ? q.data.reason : "Property data unavailable."}
      </div>
    );
  }

  const p = q.data;
  const facts = [
    p.owner_occupied == null ? null : p.owner_occupied ? "Owner-occupied" : "Rental",
    p.unit_count ? `${p.unit_count} units` : null,
    p.year_built ? `Built ${p.year_built}` : null,
    p.last_sale_date ? `Last sale ${p.last_sale_date}` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-0.5 rounded-sm border px-3 py-2 text-[13px]">
      <div className="font-semibold">{p.owner_name ?? "Owner unknown"}</div>
      {p.owner_phone && (
        <a href={`tel:${p.owner_phone}`} className="block text-primary">
          {p.owner_phone}
        </a>
      )}
      {facts.length > 0 && (
        <div className="text-[12px] text-muted-foreground">{facts.join(" · ")}</div>
      )}
    </div>
  );
}

export { OUTCOME_LABEL };

/* ------------------------------------------------------------------ */
/*  Cockpit chrome — header, KPI, map overlay, rail and bottom cards   */
/* ------------------------------------------------------------------ */

const CARD = "rounded-[8px] border border-[var(--border)] bg-card";
const CARD_HEAD =
  "flex items-center justify-between gap-2 border-b border-[var(--border)] px-3.5 py-2.5 text-[12px] font-extrabold uppercase tracking-[0.08em] text-[var(--foreground)]";

function miles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Live conditions at the chaser's position — open-meteo, no key needed. */
function WeatherChip({ pos }: { pos: { lat: number; lon: number } | null }) {
  const q = useQuery({
    enabled: !!pos,
    queryKey: ["chase", "weather", pos?.lat?.toFixed(2), pos?.lon?.toFixed(2)],
    staleTime: 900_000,
    queryFn: async () => {
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${pos!.lat}&longitude=${pos!.lon}&current=temperature_2m,cloud_cover&temperature_unit=fahrenheit`,
      );
      if (!r.ok) throw new Error("weather");
      const j = (await r.json()) as { current?: { temperature_2m: number; cloud_cover: number } };
      return j.current ?? null;
    },
    retry: false,
  });
  const c = q.data;
  return (
    <div className="flex items-center gap-2">
      <CloudSun className="size-5 text-[var(--muted-foreground)]" />
      <div className="leading-tight">
        <div className="text-[14px] font-bold text-[var(--foreground)]">
          {c ? `${Math.round(c.temperature_2m)} °F` : "—"}
        </div>
        <div className="text-[11px] text-[var(--muted-foreground)]">
          {c == null
            ? "Weather unavailable"
            : c.cloud_cover > 70
              ? "Cloudy"
              : c.cloud_cover > 30
                ? "Partly cloudy"
                : "Clear"}
        </div>
      </div>
    </div>
  );
}

function ClockChip() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2">
      <Clock className="size-5 text-[var(--muted-foreground)]" />
      <div className="leading-tight">
        <div className="text-[12px] text-[var(--muted-foreground)]">
          {now.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </div>
        <div className="text-[15px] font-bold text-[var(--foreground)]">
          {now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
    </div>
  );
}

/** On-duty status control, styled as the mockup's duty dropdown. */
function DutyDropdown({
  on,
  busy,
  name,
  onToggle,
}: {
  on: boolean;
  busy: boolean;
  name: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onToggle}
      title={on ? "Tap to go off duty" : "Tap to go on duty"}
      className="flex min-w-[190px] items-center gap-3 rounded-[6px] border border-[var(--border)] px-3 py-2 text-left transition hover:bg-[var(--surface)] disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em]">
          <span
            className="size-2 rounded-full"
            style={{ background: on ? "var(--success)" : "var(--muted-foreground)" }}
          />
          <span style={{ color: on ? "var(--success)" : "var(--muted-foreground)" }}>
            {on ? "On duty" : "Off duty"}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[14px] font-semibold text-[var(--foreground)]">
          {name}
        </span>
      </span>
      <Power className="size-4 shrink-0 text-[var(--muted-foreground)]" />
    </button>
  );
}

function KpiCard({
  icon,
  tint,
  label,
  value,
  sub,
  subColor,
}: {
  icon: React.ReactNode;
  tint: string;
  label: string;
  value: number | string;
  sub: string;
  subColor: string;
}) {
  return (
    <div className={CARD + " flex items-center gap-3 px-4 py-3.5"}>
      <span
        className="grid size-[46px] shrink-0 place-items-center rounded-[10px]"
        style={{ background: tint }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
          {label}
        </div>
        <FitText className="text-[30px] font-extrabold leading-[1.1] text-[var(--foreground)] tabular-nums">
          {value}
        </FitText>
        <div className="truncate text-[12px] font-semibold" style={{ color: subColor }}>
          {sub}
        </div>
      </div>
    </div>
  );
}

/** Floating next-stop card over the map. */
function NextStopCard({
  incident,
  me,
}: {
  incident: Incident;
  me: { lat: number; lon: number } | null;
}) {
  const dist =
    me && incident.lat != null && incident.lon != null
      ? miles(me, { lat: incident.lat, lon: incident.lon })
      : null;
  const eta = dist == null ? null : Math.max(1, Math.round((dist / 24) * 60));
  return (
    <div className="absolute right-3 top-3 w-[218px] rounded-[8px] border border-[var(--border)] bg-card p-3 shadow-[0_6px_18px_rgba(11,34,69,0.12)]">
      <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
        Next stop
      </div>
      <div className="mt-1 text-[15px] font-bold leading-tight text-[var(--foreground)]">
        {incident.address ?? "Unknown address"}
      </div>
      <div className="text-[12px] text-[var(--muted-foreground)]">
        {[incident.locality, incident.postal_code].filter(Boolean).join(", ") || "—"}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
            Eta
          </div>
          <div className="text-[19px] font-extrabold text-[var(--destructive)]">
            {eta == null ? "—" : `${eta} min`}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
            Distance
          </div>
          <div className="text-[19px] font-extrabold text-[var(--foreground)]">
            {dist == null ? "—" : `${dist.toFixed(1)} mi`}
          </div>
        </div>
      </div>
      <a
        href={mapsDeepLink(incident.address ?? "", incident.lat, incident.lon)}
        target="_blank"
        rel="noreferrer"
        className="mt-3 block rounded-[6px] bg-[var(--primary)] py-2 text-center text-[12px] font-bold uppercase tracking-[0.06em] !text-[var(--primary-foreground)] no-underline hover:bg-[var(--primary)]/90"
      >
        View details
      </a>
    </div>
  );
}

const SEV_CHIP: Record<string, { bg: string; fg: string; label: string }> = {
  high: {
    bg: "color-mix(in oklab, var(--destructive) 14%, var(--card))",
    fg: "var(--destructive)",
    label: "High",
  },
  med: { bg: "#FEEEDF", fg: "#D96A06", label: "Medium" },
  low: { bg: "#FDF6D9", fg: "#A87C08", label: "Low" },
};

function SevChip({ incident }: { incident: Incident }) {
  const s = SEV_CHIP[incidentSeverity(incident)] ?? SEV_CHIP["low"]!;
  return (
    <span
      className="rounded-[4px] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.08em]"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

/**
 * Scanner feed. Until live scanner audio is wired, the incident feed is the
 * transmission log — same shape, real rows.
 */
function ScannerFeedCard({
  incidents,
  selectedId,
  live,
  readOnly = false,
  compact = false,
  fill = false,
  onSelect,
}: {
  incidents: Incident[];
  selectedId: string | null;
  live: boolean;
  readOnly?: boolean;
  compact?: boolean;
  /** Stretch to the height of the rail; the list scrolls inside the card. */
  fill?: boolean;
  onSelect: (id: string) => void;
}) {
  const [channel, setChannel] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);

  /*
   * 4 Nov: the Fire Feed's calls (Settings › Sales › Fire feed) in the same
   * scanner — every dispatch line it read in the last day, with what it did
   * with it. A call that became a lead is already here as its incident, so
   * it is not listed twice.
   */
  const [openCall, setOpenCall] = useState<CockpitFeedCall | null>(null);
  const callView: FireFeedCallView | null = openCall
    ? {
        title: openCall.title,
        source: openCall.source,
        at: openCall.at,
        url: openCall.url,
        decision: openCall.decision,
        reason: openCall.reason,
        extraction: openCall.extraction,
      }
    : null;
  const fetchCalls = useServerFn(listCockpitFeedCalls);
  const callsQ = useQuery({
    queryKey: ["chase", "fire-feed-calls"],
    queryFn: () => fetchCalls(),
    refetchInterval: 60_000,
    retry: false,
  });

  type ScanRow =
    | { kind: "incident"; at: number; incident: Incident }
    | { kind: "call"; at: number; call: CockpitFeedCall };
  const rows = useMemo((): ScanRow[] => {
    const shown = new Set(incidents.map((i) => i.id));
    const inc: ScanRow[] =
      channel === "fire_feed"
        ? []
        : (channel === "all"
            ? incidents
            : incidents.filter((i) => i.incident_type === channel)
          ).map((i) => ({ kind: "incident", at: new Date(i.reported_at).getTime(), incident: i }));
    const calls: ScanRow[] =
      channel === "all" || channel === "fire_feed"
        ? (callsQ.data?.calls ?? [])
            .filter((c) => !(c.incidentId && shown.has(c.incidentId)))
            .map((c) => ({ kind: "call", at: new Date(c.at).getTime(), call: c }))
        : [];
    return [...inc, ...calls].sort((a, b) => b.at - a.at);
  }, [incidents, channel, callsQ.data]);

  useEffect(() => {
    if (autoScroll) listRef.current?.scrollTo({ top: 0 });
  }, [rows.length, autoScroll]);

  return (
    <div className={cn(CARD, "overflow-hidden", fill && "flex min-h-0 flex-1 flex-col")}>
      <div className={cn(CARD_HEAD, fill && "shrink-0")}>
        <span className="flex items-center gap-2">
          <Radio className="size-4 text-[var(--destructive)]" />
          Scanner feed
        </span>
        <span
          className="flex items-center gap-1.5 text-[10px] font-extrabold"
          style={{ color: live ? "var(--destructive)" : "var(--muted-foreground)" }}
        >
          <span
            className="size-2 rounded-full"
            style={{ background: live ? "var(--destructive)" : "var(--muted-foreground)" }}
          />
          LIVE
        </span>
      </div>
      <div
        className={cn(
          "flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-2",
          fill && "shrink-0",
          compact && "hidden",
        )}
      >
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="h-8 rounded-[6px] border border-[var(--border)] bg-card px-2 text-[12px] text-[var(--foreground)]"
        >
          <option value="all">All channels</option>
          <option value="fire">Fire</option>
          <option value="smoke">Smoke</option>
          <option value="water">Water</option>
          <option value="storm">Storm</option>
          <option value="fire_feed">Fire Feed calls</option>
        </select>
        <Volume2 className="size-4 text-[var(--muted-foreground)]" />
        <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">Auto scroll</span>
        <button
          type="button"
          onClick={() => setAutoScroll((v) => !v)}
          aria-pressed={autoScroll}
          className="relative h-5 w-9 rounded-full transition"
          style={{ background: autoScroll ? "var(--primary)" : "var(--border)" }}
        >
          <span
            className="absolute top-0.5 size-4 rounded-full bg-card transition-all"
            style={{ left: autoScroll ? 18 : 2 }}
          />
        </button>
      </div>
      <div
        ref={listRef}
        className={cn(
          fill ? "min-h-[320px] flex-1" : compact ? "max-h-[260px]" : "max-h-[430px]",
          "divide-y divide-[var(--border)] overflow-auto",
        )}
      >
        {rows.length === 0 ? (
          <div className="px-3.5 py-6 text-center text-[12px] text-[var(--muted-foreground)]">
            No transmissions in the last 24 hours.
          </div>
        ) : (
          rows.slice(0, compact ? 8 : fill ? 100 : 25).map((row) => {
            if (row.kind === "call")
              return (
                <FeedCallRow key={`call:${row.call.id}`} call={row.call} onOpen={setOpenCall} />
              );
            const i = row.incident;
            return (
              <div
                key={i.id}
                className={"px-3.5 py-2.5 " + (selectedId === i.id ? "bg-[var(--surface)]" : "")}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-bold text-[var(--destructive)] tabular-nums">
                    {new Date(i.reported_at).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    })}
                  </span>
                  <span className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-[var(--primary)]">
                    {i.status === "new" ? "Dispatch" : INCIDENT_STATUS_LABEL[i.status]}
                  </span>
                  <span className="ml-auto">
                    <SevChip incident={i} />
                  </span>
                </div>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-bold text-[var(--foreground)]">
                      {fireTypeLine(i)}
                    </div>
                    <div className="truncate text-[12px] text-[var(--muted-foreground)]">
                      {i.address ?? "—"}
                    </div>
                    <div className="truncate text-[12px] text-[var(--muted-foreground)]">
                      {dispatchDetailLine(i) || "—"}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={readOnly}
                    title={readOnly ? "Clock in to create a lead" : undefined}
                    onClick={() => onSelect(i.id)}
                    className="shrink-0 rounded-[5px] border border-[var(--primary)] px-2 py-1 text-[11px] font-semibold text-[var(--primary)] hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                  >
                    Create lead
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {rows.length > (compact ? 8 : 25) && (
        <div className="border-t border-[var(--border)] px-3.5 py-2 text-[11px] text-[var(--muted-foreground)]">
          Showing latest {compact ? 8 : 25} of {rows.length} transmissions
        </div>
      )}
      <FireFeedCallDialog call={callView} onOpenChange={(o) => !o && setOpenCall(null)} />
    </div>
  );
}

/** One Fire Feed call in the scanner: when, where from, the line, and what became of it. */
function FeedCallRow({
  call,
  onOpen,
}: {
  call: CockpitFeedCall;
  onOpen: (call: CockpitFeedCall) => void;
}) {
  const outcome =
    call.decision === "lead"
      ? { text: "Lead", tone: "text-success" }
      : call.decision === "merged"
        ? { text: "Merged into an alert", tone: "text-info" }
        : {
            text: SKIP_REASON_LABEL[call.reason as SkipReason] ?? "Skipped",
            tone: "text-muted-foreground",
          };
  return (
    <div className="px-3.5 py-2.5" data-fire-feed-call>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-bold tabular-nums text-muted-foreground">
          {new Date(call.at).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          })}
        </span>
        <span className="truncate text-[10px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
          {call.source}
        </span>
      </div>
      <div className="mt-1 truncate text-[13px] font-semibold text-foreground" title={call.title}>
        {/* The details in a pop-up, not the source page in a new tab (4 Nov). */}
        <button
          type="button"
          onClick={() => onOpen(call)}
          className="max-w-full truncate text-left hover:underline"
        >
          {call.title}
        </button>
      </div>
      <div className={cn("text-[11.5px] font-medium", outcome.tone)}>{outcome.text}</div>
    </div>
  );
}

/** Recent fire leads — the HPD/vacate follow-up channel, not live chases. */
function RecentFireLeadsCard() {
  const q = useQuery({
    queryKey: ["chase", "recent-fire-leads"],
    staleTime: 120_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fire_leads")
        .select("id, address, locality, postal_code, incident_date, value_amount, status, title")
        .is("archived_at", null)
        .order("source_first_seen_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data ?? [];
    },
  });
  const rows = q.data ?? [];
  return (
    <div className={CARD + " overflow-hidden"}>
      <div className={CARD_HEAD}>
        <span className="flex items-center gap-2">
          <Flame className="size-4 text-[#FA6702]" />
          Recent fire leads
        </span>
        <span className="text-[11px] font-semibold text-[var(--muted-foreground)]">Last 5</span>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {rows.length === 0 ? (
          <div className="px-3.5 py-5 text-[12px] text-[var(--muted-foreground)]">
            No fire leads yet.
          </div>
        ) : (
          rows.map((l) => (
            <div key={l.id} className="flex items-start justify-between gap-2 px-3.5 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-bold text-[var(--foreground)]">
                  {l.address ?? "—"}
                </div>
                <div className="truncate text-[12px] text-[var(--muted-foreground)]">
                  {[l.locality, l.postal_code].filter(Boolean).join(", ") || "—"}
                </div>
                <div className="truncate text-[12px] text-[var(--muted-foreground)]">
                  {l.title ?? "Fire vacate"}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[11px] text-[var(--muted-foreground)]">
                  {l.incident_date
                    ? new Date(l.incident_date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })
                    : "—"}
                </div>
                <span
                  className="mt-1 inline-block rounded-[4px] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.06em]"
                  style={
                    l.status === "open"
                      ? {
                          background: "color-mix(in oklab, var(--success) 14%, var(--card))",
                          color: "var(--success)",
                        }
                      : { background: "#FDF6D9", color: "#A87C08" }
                  }
                >
                  {String(l.status ?? "pending")}
                </span>
                <div className="mt-1 text-[12px] font-bold text-[var(--foreground)]">
                  {l.value_amount ? `$${Number(l.value_amount).toLocaleString("en-US")}` : "--"}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Who beat us to the door, from logged outcomes. */
function CompetitorActivityCard() {
  // Same query as the Performance page's competitor snapshot.
  const q = useCompetitorSightings({ kind: "rolling", hours: 24 }, null);
  const rows = countBy(q.data ?? [], "competitor")
    .slice(0, 6)
    .map((r) => [r.label, r.count] as const);
  return (
    <div className={CARD + " overflow-hidden"}>
      <div className={CARD_HEAD}>
        <span className="flex items-center gap-2">
          <Radio className="size-4 text-[var(--muted-foreground)]" />
          Competitor activity
        </span>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {rows.length === 0 ? (
          <div className="px-3.5 py-4 text-[12px] text-[var(--muted-foreground)]">
            No competitor sightings logged in the last 24 hours.
          </div>
        ) : (
          rows.map(([name, n]) => (
            <div key={name} className="flex items-center justify-between gap-2 px-3.5 py-2">
              <span className="truncate text-[12px] text-[var(--foreground)]">{name}</span>
              <span
                className="shrink-0 text-[12px] font-bold"
                style={{ color: n > 0 ? "var(--destructive)" : "var(--muted-foreground)" }}
              >
                {n} {n === 1 ? "fire" : "fires"}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center justify-between border-t border-[var(--border)] px-3.5 py-2 text-[11px] text-[var(--muted-foreground)]">
        Last 24 hours
        <ViewMapLink />
      </div>
    </div>
  );
}

/**
 * Homeowner and contact status for the selected incident.
 *
 * The owner-of-record basics are free public record, so they show before
 * claim to anyone who can see the incident (lookupIncidentPublicRecord).
 * Phone and email are the paid quick skip and unlock on claim
 * (lookupIncidentProperty, claimer only) — that path is unchanged.
 */
function ContactStatusCard({
  incident,
  writesDisabled,
}: {
  incident: Incident | null;
  writesDisabled: boolean;
}) {
  const lookup = useServerFn(lookupIncidentProperty);
  const lookupPublic = useServerFn(lookupIncidentPublicRecord);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    enabled: !!incident && !!incident.accepted_by,
    queryKey: ["chase", "property", incident?.id],
    queryFn: () => lookup({ data: { incidentId: incident!.id } }),
    staleTime: Infinity,
    retry: false,
  });
  const pub = useQuery({
    enabled: !!incident,
    queryKey: ["chase", "public-record", incident?.id],
    queryFn: () => lookupPublic({ data: { incidentId: incident!.id } }),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const p = q.data && q.data.status === "ok" ? q.data : null;
  const claimed = !!incident?.accepted_by;
  const record = pub.data?.status === "ok" ? pub.data.record : null;

  const occupancy =
    p?.owner_occupied == null ? "Unknown" : p.owner_occupied ? "Owner-occupied" : "Tenant-occupied";

  return (
    <div className={CARD + " overflow-hidden"}>
      <div className={CARD_HEAD}>Homeowner / contact status · reference only</div>
      <div className="px-3.5 py-2.5">
        <p className="mb-2 text-[11px] leading-snug text-[var(--muted-foreground)]">
          Owner of record is often an LLC; the person on site is often a tenant. Verify at the door.
        </p>
        <div
          className="mb-2 inline-flex rounded-[4px] px-2 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em]"
          style={{
            background: "color-mix(in oklab, var(--primary) 12%, var(--card))",
            color: "var(--primary)",
          }}
        >
          {occupancy}
        </div>
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-bold text-[var(--foreground)]">
            {incident?.address ?? "No incident selected"}
          </span>
          {incident && (
            <span
              className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.06em]"
              style={{
                background: "color-mix(in oklab, var(--destructive) 14%, var(--card))",
                color: "var(--destructive)",
              }}
            >
              {claimed ? "Claimed" : "New dispatch"}
            </span>
          )}
        </div>
        {incident && (
          <dl className="mt-2 space-y-1">
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <dt className="text-[var(--muted-foreground)]">Type</dt>
              <dd className="truncate font-semibold text-[var(--foreground)]">
                {incident.building_type ?? record?.property_class_label ?? "Unknown"}
              </dd>
            </div>
          </dl>
        )}
        {incident && (
          <div className="mt-1">
            <PublicRecordBasics loading={pub.isLoading} failed={pub.isError} result={pub.data} />
          </div>
        )}
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          {p?.owner_name && (
            <div className="mb-1 flex items-center justify-between gap-2 text-[12px]">
              <span className="text-[var(--muted-foreground)]">Owner (quick skip)</span>
              <span className="truncate font-semibold text-[var(--foreground)]">
                {p.owner_name}
              </span>
            </div>
          )}
          <ContactUnlockRows claimed={claimed} email={p?.owner_email} phone={p?.owner_phone} />
        </div>
        {p && (
          <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
            Source: {p.provider}
            {p.looked_up_at
              ? ` · pulled ${new Date(p.looked_up_at).toLocaleDateString(DATE_LOCALE, US_DATE)}`
              : ""}
          </p>
        )}
        <button
          type="button"
          disabled={!incident || !claimed || writesDisabled || busy || q.isFetching}
          onClick={() => {
            setBusy(true);
            void q.refetch().finally(() => setBusy(false));
          }}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[6px] border border-[var(--primary)] py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-[var(--primary)] hover:bg-[var(--accent)] disabled:opacity-50"
        >
          <Phone className="size-4" />
          Run quick skip
        </button>
        {!claimed && (
          <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
            Owner basics are public record. Phone and email unlock once you claim the incident.
          </p>
        )}
      </div>
    </div>
  );
}

/** Quick note against the selected incident. */
function QuickNotesCard({
  incident,
  writesDisabled,
}: {
  incident: Incident | null;
  writesDisabled: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!incident || !text.trim()) return;
    setBusy(true);
    const { data: userRes } = await supabase.auth.getUser();
    const { error } = await supabase.from("incident_notes").insert({
      incident_id: incident.id,
      author_id: userRes.user?.id ?? null,
      body: text.trim(),
    });
    setBusy(false);
    if (error) {
      toastDbError(error, { action: "Saving the note" });
      return;
    }
    setText("");
    toast.success("Note saved");
  };
  return (
    <div className={CARD + " overflow-hidden"}>
      <div className={CARD_HEAD}>
        <span className="flex items-center gap-2">
          <PenLine className="size-4 text-[var(--muted-foreground)]" />
          Quick notes
        </span>
      </div>
      <div className="p-3.5">
        <textarea
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add notes about this dispatch…"
          className="h-[110px] w-full resize-none rounded-[6px] border border-[var(--border)] px-3 py-2 text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[11px] text-[var(--muted-foreground)]">{text.length} / 500</span>
          <button
            type="button"
            disabled={!incident || !text.trim() || busy || writesDisabled}
            onClick={() => void save()}
            className="rounded-[6px] bg-[#c2410c] px-4 py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-white hover:bg-[#9a3412] disabled:opacity-50"
          >
            Save note
          </button>
        </div>
      </div>
    </div>
  );
}

/** Drag-and-drop photo capture for the selected incident's job. */
function PhotoUploadCard({ incident }: { incident: Incident | null }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const app = useAppContext();
  // Scene photos must land in the same album the job's Pictures tab reads, so
  // the album is created on demand rather than making the chaser go find it.
  const projectQ = useQuery({
    enabled: !!incident?.job_id,
    queryKey: ["chase", "photo-project", incident?.job_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("id,job_number,address,job_name,customer_name,account_id,location_id,loss_type_id")
        .eq("id", incident!.job_id!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return await ensureJobAlbum(data, app.userId);
    },
  });
  const projectId = projectQ.data ?? null;

  const accept = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!projectId) {
      toast("Sign the job first — photos file against the job record.");
      return;
    }
    for (const file of Array.from(files)) {
      const exif = await readExif(file).catch(() => null);
      await enqueuePhoto({
        id: newPhotoId(),
        projectId,
        blob: file,
        ext: extFromMime(file.type),
        mime: file.type || "image/jpeg",
        capturedAt: exif?.capturedAt ?? null,
        exifLat: exif?.lat ?? null,
        exifLon: exif?.lon ?? null,
        exifRaw: exif?.raw ?? {},
        width: 0,
        height: 0,
      });
    }
    toast.success(`${files.length} photo${files.length === 1 ? "" : "s"} queued`);
    void drainQueue(projectId);
  };

  return (
    <div className={CARD + " overflow-hidden"}>
      <div className={CARD_HEAD}>
        <span className="flex items-center gap-2">
          <Camera className="size-4 text-[var(--muted-foreground)]" />
          Photo upload
        </span>
      </div>
      <div className="p-3.5">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void accept(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={
            "grid h-[110px] cursor-pointer place-items-center rounded-[8px] border-2 border-dashed px-3 text-center transition " +
            (over
              ? "border-[var(--primary)] bg-[var(--accent)]"
              : "border-[#D7DEE9] bg-[#FBFCFE] dark:border-border dark:bg-muted/40")
          }
        >
          <div>
            <Upload className="mx-auto size-6 text-[var(--muted-foreground)]" />
            <div className="mt-1 text-[12px] font-semibold text-[var(--foreground)]">
              Drag &amp; drop photos here
            </div>
            <div className="text-[11px] text-[var(--muted-foreground)]">or click to browse</div>
            <div className="text-[11px] text-[var(--muted-foreground)]">JPG, PNG up to 10MB</div>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => void accept(e.target.files)}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-[6px] border border-[var(--primary)] py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-[var(--primary)] hover:bg-[var(--accent)]"
        >
          <Camera className="size-4" />
          Take photo
        </button>
        {!projectId && (
          <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
            Photos file against the job record once the job is signed.
          </p>
        )}
      </div>
    </div>
  );
}
