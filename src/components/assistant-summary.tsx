/**
 * Manager read-out. Every figure shown comes from `gatherFacts` running the
 * caller's own RLS-scoped queries; the model only turns those numbers into
 * prose and is instructed it may not invent any others.
 */
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { activitySummary, assistantScopePeople } from "@/lib/ai.functions";

/** Mirrors ActivityFacts from the server module (never imported client-side). */
interface ActivityFacts {
  window_days: number;
  since: string;
  scope: string;
  touchpoints_total: number;
  touchpoints_by_type: Record<string, number>;
  meetings_held: number;
  accounts_advanced: Array<{ account: string; from: string | null; to: string }>;
  contact_attempts: number;
  contact_attempts_by_channel: Record<string, number>;
  jobs_created: number;
  jobs_won_value?: number;
  redactions?: string[];
  gift_sends: number;
  notes: string[];
}

interface Person {
  user_id: string;
  full_name: string | null;
  email: string | null;
}

export function AssistantSummary() {
  const { visibleLocations } = useAppContext();
  const ask = useServerFn(activitySummary);

  const [people, setPeople] = useState<Person[]>([]);
  const [days, setDays] = useState("7");
  const [who, setWho] = useState("__all");
  const [where, setWhere] = useState("__all");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<{
    summary: string;
    facts: ActivityFacts;
  } | null>(null);

  // The list of people you may ask about is decided on the server from your
  // effective role, not filtered in the browser.
  const loadPeople = useServerFn(assistantScopePeople);
  useEffect(() => {
    void (async () => {
      try {
        const res = await loadPeople({ data: {} });
        setPeople(res.people as Person[]);
      } catch {
        setPeople([]);
      }
    })();
  }, [loadPeople]);

  const run = async () => {
    setLoading(true);
    try {
      const res = await ask({
        data: {
          days: Number(days),
          user_id: who === "__all" ? null : who,
          location_id: where === "__all" ? null : where,
          question: question.trim() || undefined,
        },
      });
      setAnswer(res);
    } catch (e) {
      toast.error("Could not build the summary", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Ask about activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Person</Label>
              <Select value={who} onValueChange={setWho}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">Everyone</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name ?? p.email ?? p.user_id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Location</Label>
              <Select value={where} onValueChange={setWhere}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All locations</SelectItem>
                  {visibleLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.code} · {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Window</Label>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="14">Last 14 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                  <SelectItem value="90">Last 90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Question (optional)</Label>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What did Chris do this week?"
            />
          </div>
          <Button onClick={run} disabled={loading}>
            {loading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Reading the data…
              </span>
            ) : (
              "Summarize"
            )}
          </Button>
        </CardContent>
      </Card>

      {answer ? (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Read-out</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.summary}</p>
              <p className="text-xs text-muted-foreground">
                Advisory only — generated from the recorded rows below. Nothing here changes any
                record.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">The rows behind the summary</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Fact label="Touchpoints" value={answer.facts.touchpoints_total} />
                <Fact label="Meetings held" value={answer.facts.meetings_held} />
                <Fact label="Lead contact attempts" value={answer.facts.contact_attempts} />
                <Fact label="Accounts advanced" value={answer.facts.accounts_advanced.length} />
                <Fact label="Jobs created" value={answer.facts.jobs_created} />
                <Fact label="Gift sends" value={answer.facts.gift_sends} />
                {typeof answer.facts.jobs_won_value === "number" ? (
                  <Fact
                    label="Billed on those jobs"
                    value={`$${answer.facts.jobs_won_value.toLocaleString("en-US")}`}
                  />
                ) : (
                  <Fact label="Billed on those jobs" value="Not available to your role" />
                )}
              </dl>
              {answer.facts.notes.length > 0 ? (
                <p className="pt-2 text-xs text-destructive">{answer.facts.notes.join(" ·")}</p>
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
