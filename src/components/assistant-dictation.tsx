/**
 * Voice capture → transcript → parsed proposal → human confirmation.
 *
 * The proposal is never written automatically. Every field is editable and
 * the rep presses Save; a misheard company name must not be able to move an
 * account on its own.
 */
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Mic, Square, Wand2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { parseDictation, transcribeNote } from "@/lib/ai.functions";
import type { DictationProposal } from "@/lib/ai.functions";
import { toastDbError } from "@/lib/db-errors";
import { VoiceRecorder } from "@/lib/voice";

const TOUCHPOINT_TYPES = [
  "call",
  "email",
  "meeting_in_person",
  "meeting_virtual",
  "gift",
  "seasonal_send",
  "other",
] as const;

const STAGES = [
  "target",
  "researching",
  "attempting_contact",
  "meeting_booked",
  "meeting_held",
  "vendor_onboarding",
  "active",
  "nurture",
  "dormant",
  "lost",
] as const;

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function AssistantDictation() {
  const { userId } = useAppContext();
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const transcribe = useServerFn(transcribeNote);
  const parse = useServerFn(parseDictation);

  const [recorder, setRecorder] = useState<VoiceRecorder | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [proposal, setProposal] = useState<DictationProposal | null>(null);
  const [saving, setSaving] = useState(false);

  const start = async () => {
    try {
      const rec = new VoiceRecorder();
      await rec.start();
      setRecorder(rec);
    } catch {
      toast.error("Microphone unavailable", {
        description: "Grant microphone access, or type the note instead.",
      });
    }
  };

  const stop = async () => {
    if (!recorder) return;
    setBusy("Transcribing…");
    try {
      const out = await recorder.stop();
      setRecorder(null);
      if (!out) return;
      const audio_base64 = await blobToBase64(out.blob);
      const { transcript: text } = await transcribe({
        data: { audio_base64, mime: out.mime },
      });
      if (!text) {
        toast.error("Nothing was transcribed", {
          description: "Try again somewhere quieter, or type the note.",
        });
        return;
      }
      setTranscript(text);
      await runParse(text);
    } catch (e) {
      toast.error("Transcription failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  const runParse = async (text: string) => {
    setBusy("Reading the note…");
    try {
      const p = await parse({ data: { transcript: text } });
      setProposal(p);
    } catch (e) {
      toast.error("Could not parse the note", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  const confirmAndSave = async () => {
    if (!proposal || !userId) return;
    if (!proposal.account_id) {
      toast.error("Pick an account first", {
        description:
          "The assistant could not match a company it can see. Open the account and log from there.",
      });
      return;
    }
    setSaving(true);
    try {
      const { error: tpErr } = await supabase.from("touchpoints").insert({
        account_id: proposal.account_id,
        contact_id: proposal.contact_id,
        type: (proposal.touchpoint_type ?? "other") as (typeof TOUCHPOINT_TYPES)[number],
        occurred_at: new Date().toISOString(),
        notes: [
          proposal.occurred_note,
          proposal.competitor ? `Incumbent: ${proposal.competitor}` : null,
          proposal.next_action ? `Next: ${proposal.next_action}` : null,
          proposal.follow_up_date ? `Follow up: ${proposal.follow_up_date}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        created_by: userId,
      });
      if (tpErr) {
        toastDbError(tpErr, { action: "log the touchpoint" });
        return;
      }

      if (proposal.suggested_stage) {
        const { error: stageErr } = await supabase
          .from("accounts")
          .update({
            stage: proposal.suggested_stage as (typeof STAGES)[number],
            stage_changed_at: new Date().toISOString(),
          })
          .eq("id", proposal.account_id);
        if (stageErr) {
          toastDbError(stageErr, { action: "advance the account stage" });
          return;
        }
      }

      toast.success("Logged", {
        description: proposal.suggested_stage
          ? `Touchpoint saved and stage set to ${proposal.suggested_stage.replace(/_/g, "")}.`
          : "Touchpoint saved.",
      });
      setProposal(null);
      setTranscript("");
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof DictationProposal>(key: K, value: DictationProposal[K]) =>
    setProposal((p) => (p ? { ...p, [key]: value } : p));

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Dictate a note</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {recorder ? (
              <Button onClick={stop} variant="destructive" className="gap-2">
                <Square className="size-4" /> Stop and transcribe
              </Button>
            ) : (
              <Button onClick={start} disabled={Boolean(busy)} className="gap-2">
                <Mic className="size-4" /> Record
              </Button>
            )}
            {busy ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {busy}
              </span>
            ) : null}
          </div>
          <Textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={4}
            placeholder="…or type what happened: “just met with David at Sterling Property Management, they manage 40 buildings in Queens, current vendor is Servpro, following up in two weeks.”"
          />
          <Button
            variant="secondary"
            className="gap-2"
            disabled={transcript.trim().length < 3 || Boolean(busy)}
            onClick={() => runParse(transcript.trim())}
          >
            <Wand2 className="size-4" /> Read this note
          </Button>
        </CardContent>
      </Card>

      {proposal ? (
        <Card className="border-primary/40">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">Confirm before saving</CardTitle>
              <Badge variant={proposal.account_confidence === "high" ? "secondary" : "outline"}>
                {proposal.account_confidence === "high"
                  ? "Confident match"
                  : proposal.account_confidence === "low"
                    ? "Uncertain match — check it"
                    : "No account matched"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">Account</Label>
                <div className="rounded-sm border bg-muted/40 px-3 py-2 text-sm">
                  {proposal.account_name ?? "— not matched —"}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Contact</Label>
                <div className="rounded-sm border bg-muted/40 px-3 py-2 text-sm">
                  {proposal.contact_name ?? "— not matched —"}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Touchpoint type</Label>
                <Select
                  value={proposal.touchpoint_type ?? "other"}
                  onValueChange={(v) => update("touchpoint_type", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOUCHPOINT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.replace(/_/g, "")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Advance stage to</Label>
                <Select
                  value={proposal.suggested_stage ?? "__none"}
                  onValueChange={(v) => update("suggested_stage", v === "__none" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Leave unchanged</SelectItem>
                    {STAGES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.replace(/_/g, "")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Next action</Label>
                <Input
                  value={proposal.next_action ?? ""}
                  onChange={(e) => update("next_action", e.target.value || null)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Follow-up date</Label>
                <Input
                  type="date"
                  value={proposal.follow_up_date ?? ""}
                  onChange={(e) => update("follow_up_date", e.target.value || null)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Note</Label>
              <Textarea
                rows={4}
                value={proposal.occurred_note}
                onChange={(e) => update("occurred_note", e.target.value)}
              />
            </div>
            {proposal.unmatched.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Not matched to any record: {proposal.unmatched.join(",")}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button onClick={confirmAndSave} disabled={saving || writesDisabled}>
                {saving ? "Saving…" : "Confirm and save"}
              </Button>
              <Button variant="ghost" onClick={() => setProposal(null)}>
                Discard
              </Button>
              {writesDisabled ? (
                <span className="text-xs text-[hsl(var(--impersonation))]">
                  {reason ?? "Writes disabled"}
                </span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
