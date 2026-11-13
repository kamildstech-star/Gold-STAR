import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatIntakeAnswer,
  useIntakeQuestions,
  useJobIntakeAnswers,
  saveJobIntakeAnswers,
  type IntakeAnswerDraft,
  type IntakeQuestion,
} from "@/lib/intake-questions";

export function useReportedSources() {
  const [sources, setSources] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("reported_sources")
        .select("id, label")
        .eq("active", true)
        .order("sort_order");
      setSources((data ?? []) as { id: string; label: string }[]);
    })();
  }, []);
  return sources;
}

type Props = {
  questions: IntakeQuestion[];
  answers: IntakeAnswerDraft;
  onChange: (answers: IntakeAnswerDraft) => void;
  /** The first question is the arrival source; it still writes jobs.reported_source_id. */
  sources: { id: string; label: string }[];
  sourceId: string;
  onSourceChange: (v: string) => void;
  sourceDetail: string;
  onSourceDetailChange: (v: string) => void;
  disabled?: boolean;
};

/**
 * The questionnaire is admin-defined, so nothing here is hardcoded except the
 * arrival-source question, which maps onto the existing reported_source field
 * so the source reporting keeps working.
 */
export function IntakeQuestionnaire({
  questions,
  answers,
  onChange,
  sources,
  sourceId,
  onSourceChange,
  sourceDetail,
  onSourceDetailChange,
  disabled,
}: Props) {
  const set = (id: string, patch: Partial<IntakeAnswerDraft[string]>) =>
    onChange({
      ...answers,
      [id]: {
        ...{ answer_text: null, answer_bool: null, answer_date: null },
        ...answers[id],
        ...patch,
        question_id: id,
      },
    });

  if (!questions.length) {
    return (
      <p className="text-xs text-muted-foreground">
        No intake questions are set up yet. Add them in Admin → Intake questions.
      </p>
    );
  }

  return (
    /*
     * Two columns once there is room. Most intake answers are a Yes/No pair,
     * so a single column left the right half of a wide card empty and pushed
     * the later questions below the fold while someone is on the phone.
     */
    <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
      {questions.map((q) => {
        const a = answers[q.id];
        /* Anything with a text box of its own needs the full width. */
        const wide = q.answer_type === "reported_source" || q.answer_type === "long_text";
        return (
          <div key={q.id} className={`grid gap-1.5 ${wide ? "lg:col-span-2" : ""}`}>
            <Label className="text-sm font-medium">{q.prompt}</Label>
            {q.help_text && <p className="text-xs text-muted-foreground">{q.help_text}</p>}

            {q.answer_type === "reported_source" && (
              <div className="space-y-2">
                <Select value={sourceId} onValueChange={onSourceChange} disabled={disabled}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a source" />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Detail (optional)"
                  value={sourceDetail}
                  onChange={(e) => onSourceDetailChange(e.target.value)}
                  disabled={disabled}
                />
              </div>
            )}

            {q.answer_type === "yes_no" && (
              <div className="flex gap-2">
                {[
                  { label: "Yes", value: true },
                  { label: "No", value: false },
                ].map((opt) => (
                  <Button
                    key={opt.label}
                    type="button"
                    size="sm"
                    variant={a?.answer_bool === opt.value ? "default" : "outline"}
                    disabled={disabled}
                    onClick={() =>
                      set(q.id, { answer_bool: a?.answer_bool === opt.value ? null : opt.value })
                    }
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            )}

            {q.answer_type === "choice" && (
              <div className="flex flex-wrap gap-1.5">
                {q.choices.map((c) => (
                  <Button
                    key={c}
                    type="button"
                    size="sm"
                    variant={a?.answer_text === c ? "default" : "outline"}
                    disabled={disabled}
                    className="h-8 rounded-full px-3 text-xs"
                    onClick={() => set(q.id, { answer_text: a?.answer_text === c ? null : c })}
                  >
                    {c}
                  </Button>
                ))}
              </div>
            )}

            {q.answer_type === "date" && (
              <Input
                type="date"
                value={a?.answer_date ?? ""}
                onChange={(e) => set(q.id, { answer_date: e.target.value })}
                disabled={disabled}
              />
            )}

            {q.answer_type === "text" && (
              <Input
                value={a?.answer_text ?? ""}
                onChange={(e) => set(q.id, { answer_text: e.target.value })}
                disabled={disabled}
              />
            )}

            {q.answer_type === "long_text" && (
              <Textarea
                rows={3}
                value={a?.answer_text ?? ""}
                onChange={(e) => set(q.id, { answer_text: e.target.value })}
                disabled={disabled}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The questionnaire on the job record. Reads as a summary, and opens for
 * editing - intake rarely gets every answer on the first call.
 */
export function JobQuestionnaireView({
  jobId,
  reportedSourceLabel,
  userId,
  disabled,
}: {
  jobId: string;
  reportedSourceLabel?: string | null;
  userId?: string | null;
  disabled?: boolean;
}) {
  const questions = useIntakeQuestions();
  const answers = useJobIntakeAnswers(jobId);
  /*
   * These used to be answerable only while creating the job, so anything the
   * caller did not know at 2am stayed a dash for the life of the job — and
   * every job created before a question existed could never answer it.
   */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<IntakeAnswerDraft>({});
  const [saving, setSaving] = useState(false);
  const list = questions.data ?? [];

  const startEdit = () => {
    setDraft(
      Object.fromEntries(
        Object.entries(answers.data ?? {}).map(([id, a]) => [
          id,
          {
            question_id: id,
            answer_text: a?.answer_text ?? null,
            answer_bool: a?.answer_bool ?? null,
            answer_date: a?.answer_date ?? null,
          },
        ]),
      ) as IntakeAnswerDraft,
    );
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveJobIntakeAnswers(jobId, draft, userId ?? null);
      await answers.refetch();
      setEditing(false);
    } catch (e) {
      toastDbError(e, { action: "Saving intake answers" });
    } finally {
      setSaving(false);
    }
  };

  if (!list.length) return null;

  if (editing) {
    return (
      <div className="space-y-3">
        {/*
         * The source question writes to jobs.reported_source_id, not to
         * job_intake_answers, so it is not editable here — it stays on the
         * job record where the rest of the job fields live.
         */}
        <IntakeQuestionnaire
          questions={list.filter((q) => q.answer_type !== "reported_source")}
          answers={draft}
          onChange={setDraft}
          sources={[]}
          sourceId=""
          onSourceChange={() => {}}
          sourceDetail=""
          onSourceDetailChange={() => {}}
          disabled={saving}
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save answers"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1 text-sm">
      {list.map((q) => {
        const value =
          q.answer_type === "reported_source"
            ? (reportedSourceLabel ?? null)
            : formatIntakeAnswer(q, answers.data?.[q.id]);
        return (
          <div
            key={q.id}
            className="grid grid-cols-[minmax(5rem,1fr)_auto] items-start gap-3 py-0.5"
          >
            <span className="text-muted-foreground">{q.prompt}</span>
            <span className="text-right font-medium">{value ?? "—"}</span>
          </div>
        );
      })}
      {!disabled && (
        <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs" onClick={startEdit}>
          <Pencil className="mr-1 size-3" /> Answer questions
        </Button>
      )}
    </div>
  );
}
