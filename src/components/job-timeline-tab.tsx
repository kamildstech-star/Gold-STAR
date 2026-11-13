import { RecordTimeline } from "@/components/record-timeline";

/**
 * Everything that happened on the job — field edits, status changes, crew,
 * photos, documents and sends, estimates/invoices/versions, payments, time,
 * equipment, supplies, questionnaire answers, work orders and translations,
 * tasks, calls, email, notes, and anything done by the Assistant or an
 * automation. Server-side feed, permission-gated at the database.
 */
export function JobTimelineTab({ jobId }: { jobId: string }) {
  return <RecordTimeline type="job" id={jobId} />;
}
