import type { Database } from "@/integrations/supabase/types";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type NotificationType = Database["public"]["Enums"]["notification_type"];
export type NotificationPriority = Database["public"]["Enums"]["notification_priority"];
export type NotificationDelivery = Database["public"]["Enums"]["notification_delivery"];
export type Notification = Database["public"]["Tables"]["notifications"]["Row"];
export type NotificationPreference =
  Database["public"]["Tables"]["notification_preferences"]["Row"];

export type NotificationGroup =
  "Leads and incidents" | "Estimates" | "Invoices" | "Follow-ups" | "Jobs" | "Chat" | "System";

export const NOTIFICATION_TYPES: {
  type: NotificationType;
  label: string;
  group: NotificationGroup;
}[] = [
  { type: "lead_new", label: "New lead in my location", group: "Leads and incidents" },
  { type: "incident_new", label: "New incident alert", group: "Leads and incidents" },
  {
    type: "incident_unaccepted",
    label: "Incident unaccepted past escalation window",
    group: "Leads and incidents",
  },
  { type: "estimate_sent", label: "Estimate sent", group: "Estimates" },
  { type: "estimate_viewed", label: "Estimate viewed", group: "Estimates" },
  { type: "estimate_approved", label: "Estimate approved", group: "Estimates" },
  { type: "estimate_rejected", label: "Estimate rejected", group: "Estimates" },
  { type: "estimate_expiring", label: "Estimate expiring", group: "Estimates" },
  { type: "invoice_sent", label: "Invoice sent", group: "Invoices" },
  { type: "invoice_viewed", label: "Invoice viewed", group: "Invoices" },
  { type: "invoice_partial_payment", label: "Invoice partially paid", group: "Invoices" },
  { type: "invoice_paid", label: "Invoice paid", group: "Invoices" },
  { type: "invoice_overdue_30", label: "Invoice overdue 30 days", group: "Invoices" },
  { type: "invoice_overdue_60", label: "Invoice overdue 60 days", group: "Invoices" },
  { type: "invoice_overdue_90", label: "Invoice overdue 90 days", group: "Invoices" },
  {
    type: "invoice_carrier_shortfall",
    label: "Carrier approved below billed amount",
    group: "Invoices",
  },
  { type: "task_due_today", label: "Task due today", group: "Follow-ups" },
  { type: "task_overdue", label: "Task overdue", group: "Follow-ups" },
  { type: "task_completed", label: "Assigned task completed", group: "Follow-ups" },
  {
    type: "account_touch_overdue",
    label: "Account overdue on quarterly touch",
    group: "Follow-ups",
  },
  { type: "account_meeting_due", label: "Annual in-person meeting due", group: "Follow-ups" },
  {
    type: "vendor_doc_expiring",
    label: "Vendor document expiring in 30 days",
    group: "Follow-ups",
  },
  {
    // Added by 20260928123000; the generated enum types catch up on the next
    // Lovable regeneration, hence the cast.
    type: "vehicle_due" as NotificationType,
    label: "Vehicle inspection, registration, insurance or service due",
    group: "Follow-ups",
  },
  { type: "job_assigned", label: "Job assigned to me", group: "Jobs" },
  {
    // Added by 20261014090000; the generated enum types catch up on the next
    // Lovable regeneration, hence the cast.
    type: "email_reply_received" as NotificationType,
    label: "Customer replied to a job email",
    group: "Jobs",
  },
  { type: "job_status_changed", label: "Job status changed", group: "Jobs" },
  {
    type: "job_complete_equipment_out",
    label: "Job complete with equipment still assigned",
    group: "Jobs",
  },
  { type: "chat_message", label: "New message", group: "Chat" },
  { type: "chat_mention", label: "@mention", group: "Chat" },
  { type: "sync_failed", label: "Sync failed", group: "System" },
  { type: "export_alert", label: "Large data export (500+ records)", group: "System" },
  { type: "integration_disconnected", label: "Integration disconnected", group: "System" },
];

export const NOTIFICATION_LABEL = Object.fromEntries(
  NOTIFICATION_TYPES.map((t) => [t.type, t.label]),
) as Record<NotificationType, string>;

export const NOTIFICATION_GROUPS: NotificationGroup[] = [
  "Leads and incidents",
  "Estimates",
  "Invoices",
  "Follow-ups",
  "Jobs",
  "Chat",
  "System",
];

/** Defaults when a user has never touched their preferences. */
export const DEFAULT_PREFERENCE = {
  in_app: true,
  email: false,
  delivery: "immediate" as NotificationDelivery,
  quiet_hours_start: null as number | null,
  quiet_hours_end: null as number | null,
};

export function groupByDay(items: Notification[]) {
  const groups = new Map<string, Notification[]>();
  for (const n of items) {
    const d = new Date(n.created_at);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    const key = same(d, today)
      ? "Today"
      : same(d, yesterday)
        ? "Yesterday"
        : d.toLocaleDateString(DATE_LOCALE, US_DATE);
    const list = groups.get(key) ?? [];
    list.push(n);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

/** Route to open when a notification is clicked. */
export function notificationHref(n: Notification) {
  if (n.href) return n.href;
  switch (n.entity_type) {
    case "job":
      return `/jobs/${n.entity_id}`;
    case "account":
      return `/accounts/${n.entity_id}`;
    case "lead":
      return "/pipeline";
    case "incident":
      return "/chase";
    case "invoice":
      return "/billing";
    case "task":
      return "/tasks";
    case "conversation":
      return `/chat/${n.entity_id}`;
    default:
      return null;
  }
}

export function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
