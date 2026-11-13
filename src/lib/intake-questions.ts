import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "./schema-fallback";

export type IntakeAnswerType =
  "text" | "long_text" | "yes_no" | "choice" | "date" | "reported_source";

export type IntakeQuestion = {
  id: string;
  prompt: string;
  help_text: string | null;
  answer_type: IntakeAnswerType;
  choices: string[];
  sort_order: number;
  active: boolean;
  /** Asked on the public intake form too. Off by default — the form is four fields, photos and notes. */
  ask_on_public_form: boolean;
};

export type IntakeAnswer = {
  question_id: string;
  answer_text: string | null;
  answer_bool: boolean | null;
  answer_date: string | null;
};

/** Answers held in form state before the job exists. */
export type IntakeAnswerDraft = Record<string, IntakeAnswer>;

const normalize = (rows: unknown[]): IntakeQuestion[] =>
  (rows as Record<string, unknown>[]).map((r) => ({
    id: r["id"] as string,
    prompt: r["prompt"] as string,
    help_text: (r["help_text"] as string | null) ?? null,
    answer_type: r["answer_type"] as IntakeAnswerType,
    choices: Array.isArray(r["choices"]) ? (r["choices"] as string[]) : [],
    sort_order: (r["sort_order"] as number) ?? 0,
    active: Boolean(r["active"]),
    ask_on_public_form: r["ask_on_public_form"] === true,
  }));

export async function fetchIntakeQuestions(opts?: { includeInactive?: boolean }) {
  const run = (withPublicFlag: boolean) => {
    let q = supabase
      .from("intake_questions")
      .select(
        `id, prompt, help_text, answer_type, choices, sort_order, active${
          withPublicFlag ? ", ask_on_public_form" : ""
        }`,
      )
      .order("sort_order")
      .order("created_at");
    if (!opts?.includeInactive) q = q.eq("active", true);
    return q;
  };
  // ask_on_public_form ships in a migration that is written but not applied.
  let res = await run(true);
  if (res.error && isMissingSchema(res.error)) res = await run(false);
  if (res.error) throw res.error;
  return normalize(res.data ?? []);
}

export function useIntakeQuestions(opts?: { includeInactive?: boolean }) {
  const includeInactive = opts?.includeInactive ?? false;
  return useQuery({
    queryKey: ["intake-questions", includeInactive],
    queryFn: () => fetchIntakeQuestions({ includeInactive }),
    staleTime: 60_000,
  });
}

export function useJobIntakeAnswers(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ["job-intake-answers", jobId],
    enabled: Boolean(jobId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_intake_answers")
        .select("question_id, answer_text, answer_bool, answer_date")
        .eq("job_id", jobId!);
      if (error) throw error;
      const map: IntakeAnswerDraft = {};
      for (const row of (data ?? []) as IntakeAnswer[]) map[row.question_id] = row;
      return map;
    },
  });
}

const isEmpty = (a: IntakeAnswer) =>
  (a.answer_text == null || a.answer_text.trim() === "") && a.answer_bool == null && !a.answer_date;

/** Upserts the filled answers for a job and clears the ones that were emptied. */
export async function saveJobIntakeAnswers(
  jobId: string,
  answers: IntakeAnswerDraft,
  userId?: string | null,
  /**
   * Who gave the answer. 'recipient' when staff accepted it from the customer
   * (the suggested-fields review); left to the column default ('staff') for a
   * typed answer.
   */
  opts?: { source?: "recipient" | "staff" },
) {
  const entries = Object.entries(answers);
  const filled = entries.filter(([, a]) => !isEmpty(a));
  const cleared = entries.filter(([, a]) => isEmpty(a)).map(([id]) => id);

  if (filled.length) {
    const { error } = await supabase.from("job_intake_answers").upsert(
      filled.map(([question_id, a]) => ({
        job_id: jobId,
        question_id,
        answer_text: a.answer_text?.trim() || null,
        answer_bool: a.answer_bool ?? null,
        answer_date: a.answer_date || null,
        answered_by: userId ?? null,
        ...(opts?.source ? { source: opts.source } : {}),
      })) as never,
      { onConflict: "job_id,question_id" },
    );
    if (error) throw error;
  }
  if (cleared.length) {
    const { error } = await supabase
      .from("job_intake_answers")
      .delete()
      .eq("job_id", jobId)
      .in("question_id", cleared);
    if (error) throw error;
  }
}

export function formatIntakeAnswer(q: IntakeQuestion, a: IntakeAnswer | undefined) {
  if (!a) return null;
  if (q.answer_type === "yes_no")
    return a.answer_bool == null ? null : a.answer_bool ? "Yes" : "No";
  if (q.answer_type === "date") return a.answer_date ?? null;
  return a.answer_text?.trim() || null;
}
