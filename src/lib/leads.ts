import type { Database } from "@/integrations/supabase/types";

export type PipelineStage = Database["public"]["Enums"]["pipeline_stage"];
export type AppRole = Database["public"]["Enums"]["app_role"];
export type ContactChannel = Database["public"]["Enums"]["contact_channel"];

export const PIPELINE_STAGES: PipelineStage[] = [
  "new",
  "attempting_contact",
  "contacted",
  "appointment_set",
  "quoted",
  "won",
  "lost",
  "unqualified",
];

export const STAGE_LABEL: Record<PipelineStage, string> = {
  new: "New",
  attempting_contact: "Attempting contact",
  contacted: "Contacted",
  appointment_set: "Appointment set",
  quoted: "Quoted",
  won: "Won",
  lost: "Lost",
  unqualified: "Unqualified",
};

export const CONTACT_CHANNELS: ContactChannel[] = ["call", "sms", "email", "door", "other"];

export const CHANNEL_LABEL: Record<ContactChannel, string> = {
  call: "Call",
  sms: "SMS",
  email: "Email",
  door: "Door knock",
  other: "Other",
};

export const OUTCOMES = [
  "connected",
  "left_voicemail",
  "no_answer",
  "wrong_number",
  "not_interested",
  "callback_requested",
  "other",
] as const;

export const OUTCOME_LABEL: Record<(typeof OUTCOMES)[number], string> = {
  connected: "Connected",
  left_voicemail: "Left voicemail",
  no_answer: "No answer",
  wrong_number: "Wrong number",
  not_interested: "Not interested",
  callback_requested: "Callback requested",
  other: "Other",
};

export type Band = "today" | "week" | "cooling" | "cold" | "unknown";

export function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00Z").getTime();
  if (!Number.isFinite(d)) return null;
  const now = Date.now();
  return Math.max(0, Math.floor((now - d) / 86400000));
}

export function bandFor(days: number | null): Band {
  if (days == null) return "unknown";
  if (days <= 1) return "today";
  if (days <= 7) return "week";
  if (days <= 30) return "cooling";
  return "cold";
}

export const BAND_LABEL: Record<Band, string> = {
  today: "Today & yesterday",
  week: "This week (2–7 days)",
  cooling: "Cooling (8–30 days)",
  cold: "Cold (30+ days)",
  unknown: "Undated",
};

export const BAND_ORDER: Band[] = ["today", "week", "cooling", "cold", "unknown"];
