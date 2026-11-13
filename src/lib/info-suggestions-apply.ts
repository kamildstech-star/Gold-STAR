/**
 * Apply for the suggested-fields review: the accepted values go through the
 * job's ordinary write paths and nowhere else.
 *
 *   - job columns  -> updateJobFieldsQueued, the path the job's inline fields
 *     and Edit all forms use (offline queue, field permissions in RLS, and the
 *     `log_job_field_changes` trigger that puts the change on the timeline);
 *   - answers      -> saveJobIntakeAnswers, stamped source 'recipient';
 *   - phone/email  -> insertJobContactMethods, the Customer card's own insert.
 *
 * One call writes a whole Apply all as one job patch, so the timeline shows
 * one edit rather than one per field.
 */
import { toast } from "sonner";

import { saveJobIntakeAnswers } from "@/lib/intake-questions";
import { insertJobContactMethods } from "@/lib/job-contact-methods";
import { updateJobFieldsQueued } from "@/lib/job-update";
import { answerPatch, jobPatchValue, type SuggestionRow } from "@/lib/info-suggestions";

export type ApplyItem = { row: SuggestionRow; value: string };

export async function applySuggestionItems(input: {
  jobId: string;
  items: ApplyItem[];
  userId: string | null;
  /** A carrier the reviewer matched to a CRM account, used only if the job has none. */
  carrierAccountId?: string | null;
  jobHasCarrierAccount?: boolean;
}): Promise<{ job: boolean; answers: boolean; contacts: boolean }> {
  const patch: Record<string, unknown> = {};
  const answers: Record<
    string,
    {
      question_id: string;
      answer_text: string | null;
      answer_bool: boolean | null;
      answer_date: string | null;
    }
  > = {};
  const methods: { kind: "phone" | "email"; value: string }[] = [];

  for (const { row, value } of input.items) {
    const t = row.target;
    if (t.type === "job") {
      patch[t.column] = jobPatchValue(t, value);
      if (
        t.column === "insurance_carrier" &&
        input.carrierAccountId &&
        !input.jobHasCarrierAccount
      ) {
        patch["insurance_carrier_account_id"] = input.carrierAccountId;
      }
    } else if (t.type === "answer") {
      answers[t.questionId] = { question_id: t.questionId, ...answerPatch(t.answerType, value) };
    } else if (t.type === "contact") {
      methods.push({ kind: t.kind, value: value.trim() });
    }
  }

  if (Object.keys(patch).length) {
    const res = await updateJobFieldsQueued(input.jobId, patch, "Recipient details");
    // updateJobFieldsQueued has already said why; a lost write is not "applied".
    if (!res.ok) throw new Error("The job could not be saved.");
    if (res.queued) toast.warning("Held on this device — it saves when you have signal.");
  }
  if (Object.keys(answers).length) {
    await saveJobIntakeAnswers(input.jobId, answers, input.userId, { source: "recipient" });
  }
  if (methods.length) await insertJobContactMethods(input.jobId, methods);

  return {
    job: Object.keys(patch).length > 0,
    answers: Object.keys(answers).length > 0,
    contacts: methods.length > 0,
  };
}
