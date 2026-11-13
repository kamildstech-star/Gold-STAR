/**
 * Chase shift hours — scheduled window, overtime state and the thresholds an
 * admin controls. Shifts are stamped with their scheduled window when the
 * chaser clocks in (DB trigger); this module is the read/display side.
 */
import { supabase } from "@/integrations/supabase/client";

export type ChaseShiftSettings = {
  overtimeReminderMinutes: number;
  overtimeEscalateMinutes: number;
  autoCloseHours: number;
};

const DEFAULTS: ChaseShiftSettings = {
  overtimeReminderMinutes: 15,
  overtimeEscalateMinutes: 60,
  autoCloseHours: 16,
};

export async function fetchChaseShiftSettings(): Promise<ChaseShiftSettings> {
  const { data, error } = await supabase.rpc("chase_settings");
  if (error) return DEFAULTS;
  const s = (data ?? {}) as Record<string, unknown>;
  const num = (k: string, d: number) => {
    const v = Number(s[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    overtimeReminderMinutes: num("overtime_reminder_minutes", DEFAULTS.overtimeReminderMinutes),
    overtimeEscalateMinutes: num("overtime_escalate_minutes", DEFAULTS.overtimeEscalateMinutes),
    autoCloseHours: num("shift_auto_close_hours", DEFAULTS.autoCloseHours),
  };
}

/** "8:00 AM – 7:00 PM" for a pair of `time` columns. */
export function shiftHoursLabel(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  if (!start || !end) return null;
  return `${clockLabel(start)} – ${clockLabel(end)}`;
}

/** "11h" / "8h 30m" for a pair of `time` columns. */
export function shiftLengthLabel(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  if (!start || !end) return null;
  let mins = toMinutes(end) - toMinutes(start);
  if (mins <= 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "7:00 PM" for a timestamp. */
export function endTimeLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export type OvertimeState = {
  /** Past their scheduled end and still clocked in. */
  over: boolean;
  minutesOver: number;
  /** Past the manager-escalation threshold. */
  escalated: boolean;
};

export function overtimeState(
  scheduledEndAt: string | null | undefined,
  settings: ChaseShiftSettings,
  now: number = Date.now(),
): OvertimeState {
  if (!scheduledEndAt) return { over: false, minutesOver: 0, escalated: false };
  const diff = now - new Date(scheduledEndAt).getTime();
  const minutesOver = Math.floor(diff / 60_000);
  return {
    over: minutesOver > 0,
    minutesOver: Math.max(minutesOver, 0),
    escalated: minutesOver >= settings.overtimeEscalateMinutes,
  };
}

function toMinutes(t: string): number {
  const [h = "0", m = "0"] = t.split(":");
  return Number(h) * 60 + Number(m);
}

function clockLabel(t: string): string {
  const [h = "0", m = "0"] = t.split(":");
  const d = new Date();
  d.setHours(Number(h), Number(m), 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
