/**
 * Chase writes, offline first.
 *
 * Rule for the field: nothing blocks on the network. Every one of these
 * captures the work locally, confirms to the chaser immediately, and lets the
 * sync queue land it when service returns. The queue item id doubles as the
 * server-side idempotency key (`apply_offline_op`), so a retry after a dropped
 * response can never create a second lead, outcome, arrival or note.
 */
import { supabase } from "@/integrations/supabase/client";
import { drain, enqueue, newId, type QueuedKind } from "@/lib/offline-queue";

export type QueuedWrite = { queued: boolean; result: unknown };

function offline(): boolean {
  return typeof navigator !== "undefined" && !navigator.onLine;
}

/**
 * Try once, fall back to the queue. Never throws for a transport problem —
 * the only thing the caller has to know is whether it went now or later.
 */
async function writeOrQueue(
  kind: QueuedKind,
  payload: Record<string, unknown>,
  label: string,
): Promise<QueuedWrite> {
  const id = newId();
  const createdAt = new Date().toISOString();

  if (offline()) {
    await enqueue({ id, kind, payload, label });
    return { queued: true, result: null };
  }

  try {
    const { data, error } = await supabase.rpc("apply_offline_op", {
      _key: id,
      _kind: kind,
      _payload: payload as never,
      _client_created_at: createdAt,
    });
    if (error) throw new Error(error.message);
    const res = data as { duplicate?: boolean; result?: unknown } | null;
    return { queued: false, result: res?.result ?? null };
  } catch {
    // A flaky connection is treated as offline rather than losing the work.
    await enqueue({ id, kind, payload, label });
    void drain();
    return { queued: true, result: null };
  }
}

export function queueOutcome(input: {
  incidentId: string;
  reasonId: string;
  subReasonId?: string | null;
  subLabel?: string | null;
  note?: string | null;
  worthAnotherTry?: boolean;
  revisitAfter?: string | null;
  label?: string;
}) {
  return writeOrQueue(
    "outcome",
    {
      incidentId: input.incidentId,
      reasonId: input.reasonId,
      subReasonId: input.subReasonId ?? null,
      subLabel: input.subLabel ?? null,
      note: input.note ?? null,
      worthAnotherTry: input.worthAnotherTry ?? false,
      revisitAfter: input.revisitAfter ?? null,
    },
    input.label ?? "Lead outcome",
  );
}

export function queueDecline(incidentId: string, reason: string | null, label?: string) {
  return writeOrQueue("decline", { incidentId, reason }, label ?? "Decline");
}

export function queueArrival(input: {
  incidentId: string;
  action: "sign_up" | "photo" | "outcome" | "exposure" | "manual";
  lat?: number | null;
  lon?: number | null;
  accuracyM?: number | null;
  label?: string;
}) {
  return writeOrQueue(
    "arrival",
    {
      incidentId: input.incidentId,
      action: input.action,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      accuracyM: input.accuracyM ?? null,
    },
    input.label ?? "Arrival",
  );
}

export function queueIncidentNote(incidentId: string, body: string, label?: string) {
  return writeOrQueue("incident_note", { incidentId, body }, label ?? "Lead note");
}
