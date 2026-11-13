import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useIntakeQuestions,
  type IntakeAnswerType,
  type IntakeQuestion,
} from "@/lib/intake-questions";

export const Route = createFileRoute("/_authenticated/admin/intake-questions")({
  head: () => ({
    meta: [
      { title: "Intake questions · Recovery Hub" },
      {
        name: "description",
        content:
          "Maintain the intake questionnaire asked on every incoming job — question text, answer type and order.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: IntakeQuestionsAdmin,
});

const TYPES: { value: IntakeAnswerType; label: string }[] = [
  { value: "reported_source", label: "How did this job arrive? (source list)" },
  { value: "yes_no", label: "Yes / no" },
  { value: "choice", label: "Choice list" },
  { value: "text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "date", label: "Date" },
];

function IntakeQuestionsAdmin() {
  const qc = useQueryClient();
  const questions = useIntakeQuestions({ includeInactive: true });
  const [newPrompt, setNewPrompt] = useState("");
  const [newType, setNewType] = useState<IntakeAnswerType>("yes_no");

  const refresh = () => qc.invalidateQueries({ queryKey: ["intake-questions"] });

  const patch = async (id: string, values: Record<string, unknown>) => {
    const { error } = await supabase
      .from("intake_questions")
      .update(values as never)
      .eq("id", id);
    if (error) return toast.error(error.message);
    refresh();
  };

  const add = async () => {
    const prompt = newPrompt.trim();
    if (!prompt) return;
    const max = Math.max(0, ...(questions.data ?? []).map((q) => q.sort_order));
    const { error } = await supabase
      .from("intake_questions")
      .insert({ prompt, answer_type: newType, sort_order: max + 10 } as never);
    if (error) return toast.error(error.message);
    setNewPrompt("");
    refresh();
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("intake_questions").delete().eq("id", id);
    if (error) return toast.error(error.message);
    refresh();
  };

  const move = async (q: IntakeQuestion, dir: -1 | 1) => {
    const list = questions.data ?? [];
    const i = list.findIndex((x) => x.id === q.id);
    const other = list[i + dir];
    if (!other) return;
    await Promise.all([
      supabase
        .from("intake_questions")
        .update({ sort_order: other.sort_order } as never)
        .eq("id", q.id),
      supabase
        .from("intake_questions")
        .update({ sort_order: q.sort_order } as never)
        .eq("id", other.id),
    ]);
    refresh();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Intake questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            These are the questions asked on the job intake form. The starter set is a placeholder —
            rename, reorder or switch off anything that isn't how the team actually takes a call.
          </p>
          <p className="text-xs text-muted-foreground">
            The public intake form (website and emailed links) always asks for the property address,
            name, phone and email — all required — then optional photos and notes. Switch a question
            onto the public form only if it should be asked there as well.
          </p>

          {(questions.data ?? []).map((q, i) => (
            <div key={q.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-start gap-2">
                <Input
                  defaultValue={q.prompt}
                  onBlur={(e) =>
                    e.target.value.trim() && e.target.value !== q.prompt
                      ? patch(q.id, { prompt: e.target.value.trim() })
                      : undefined
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={i === 0}
                  onClick={() => move(q, -1)}
                  aria-label="Move up"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={i === (questions.data ?? []).length - 1}
                  onClick={() => move(q, 1)}
                  aria-label="Move down"
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(q.id)}
                  aria-label="Delete question"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Select
                  value={q.answer_type}
                  onValueChange={(v) => patch(q.id, { answer_type: v })}
                >
                  <SelectTrigger className="w-72">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={q.active}
                    onCheckedChange={(v) => patch(q.id, { active: v })}
                    id={`active-${q.id}`}
                  />
                  <Label htmlFor={`active-${q.id}`} className="text-xs">
                    Active
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={q.ask_on_public_form}
                    onCheckedChange={(v) => patch(q.id, { ask_on_public_form: v })}
                    id={`public-${q.id}`}
                  />
                  <Label htmlFor={`public-${q.id}`} className="text-xs">
                    Also on public form
                  </Label>
                </div>
              </div>
              {q.answer_type === "choice" && (
                <Input
                  placeholder="Choices, comma separated"
                  defaultValue={q.choices.join(", ")}
                  onBlur={(e) =>
                    patch(q.id, {
                      choices: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              )}
              <Input
                placeholder="Help text (optional)"
                defaultValue={q.help_text ?? ""}
                onBlur={(e) => patch(q.id, { help_text: e.target.value.trim() || null })}
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Input
              className="w-80"
              placeholder="New question"
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
            />
            <Select value={newType} onValueChange={(v) => setNewType(v as IntakeAnswerType)}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={add}>
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
