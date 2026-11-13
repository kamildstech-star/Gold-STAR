import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Heart, Mic, Square, Sparkles, Pencil, History } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useWritesDisabled, useAppContext } from "@/components/app-context";
import { VoiceRecorder } from "@/lib/voice";
import { transcribeNote } from "@/lib/ai.functions";
import {
  parseRelationshipNote,
  type ParsedRelationshipFact,
} from "@/lib/relationship-notes.functions";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
type Category = { key: string; label: string };
type Fact = { category_key: string; value: string; source: string };
type Dump = { id: string; body: string; source: string; created_at: string };

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((ab) => {
    const buf = new Uint8Array(ab);
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  });
}

/**
 * The AI dump box. A rep types or dictates whatever they know about the
 * person; the system parses it into managed categories, keeps the original
 * text forever, and lets the rep correct every parsed value before it saves.
 */
export function ContactRelationshipNotes({
  contactId,
  contactName,
  birthdayMonth,
  birthdayDay,
  onSaved,
}: {
  contactId: string;
  contactName: string;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const { userId } = useAppContext();
  const { disabled, reason } = useWritesDisabled();
  const transcribe = useServerFn(transcribeNote);
  const parse = useServerFn(parseRelationshipNote);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [recorder, setRecorder] = useState<VoiceRecorder | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [bday, setBday] = useState<{ m: string; d: string }>({ m: "", d: "" });
  const [saving, setSaving] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const catsQ = useQuery({
    queryKey: ["relationship-categories"],
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await supabase
        .from("option_list_values")
        .select("key, label, option_lists!inner(key)")
        .eq("option_lists.key", "relationship_note_category")
        .eq("active", true)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []).map((r) => ({ key: r.key as string, label: r.label as string }));
    },
  });

  const factsQ = useQuery({
    queryKey: ["relationship-facts", contactId],
    queryFn: async (): Promise<Fact[]> => {
      const { data, error } = await supabase
        .from("contact_relationship_facts")
        .select("category_key, value, source")
        .eq("contact_id", contactId);
      if (error) throw error;
      return (data ?? []) as Fact[];
    },
  });

  const dumpsQ = useQuery({
    queryKey: ["relationship-dumps", contactId],
    queryFn: async (): Promise<Dump[]> => {
      const { data, error } = await supabase
        .from("contact_note_dumps")
        .select("id, body, source, created_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Dump[];
    },
  });

  const cats = catsQ.data ?? [];
  const facts = factsQ.data ?? [];
  const dumps = dumpsQ.data ?? [];
  const labelFor = (key: string) => cats.find((c) => c.key === key)?.label ?? key;

  const runParse = async (body: string) => {
    setBusy("Reading the note…");
    try {
      const res = await parse({
        data: {
          text: body,
          existing: facts.map((f) => ({ category_key: f.category_key, value: f.value })),
        },
      });
      const next: Record<string, string> = {};
      for (const f of facts) next[f.category_key] = f.value;
      for (const f of res.facts as ParsedRelationshipFact[]) next[f.category_key] = f.value;
      setDraft(next);
      setBday({
        m: String(res.birthday_month ?? birthdayMonth ?? ""),
        d: String(res.birthday_day ?? birthdayDay ?? ""),
      });
      if (res.read_only) {
        toast.info("Preview only", {
          description: "Saving is disabled while viewing as another role.",
        });
      }
    } catch (e) {
      toast.error("Could not read the note", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  const startRec = async () => {
    try {
      const rec = new VoiceRecorder();
      await rec.start();
      setRecorder(rec);
    } catch {
      toast.error("Microphone unavailable", { description: "Type the note instead." });
    }
  };

  const stopRec = async () => {
    if (!recorder) return;
    setBusy("Transcribing…");
    try {
      const out = await recorder.stop();
      setRecorder(null);
      if (!out) return;
      const audio_base64 = await blobToBase64(out.blob);
      const { transcript } = await transcribe({ data: { audio_base64, mime: out.mime } });
      if (!transcript) {
        toast.error("Nothing was transcribed");
        return;
      }
      setText((t) => (t ? `${t}\n${transcript}` : transcript));
    } catch (e) {
      toast.error("Transcription failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const { data: dump, error: dumpErr } = await supabase
        .from("contact_note_dumps")
        .insert({ contact_id: contactId, body: text.trim(), created_by: userId })
        .select("id")
        .single();
      if (dumpErr) throw dumpErr;

      const rows = Object.entries(draft)
        .filter(([, v]) => v.trim())
        .map(([category_key, value]) => ({
          contact_id: contactId,
          category_key,
          value: value.trim(),
          source: "rep",
          dump_id: dump.id,
          created_by: userId,
        }));
      if (rows.length) {
        const { error } = await supabase
          .from("contact_relationship_facts")
          .upsert(rows, { onConflict: "contact_id,category_key" });
        if (error) throw error;
      }

      const m = Number(bday.m);
      const d = Number(bday.d);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        const { error } = await supabase
          .from("contacts")
          .update({ birthday_month: m, birthday_day: d })
          .eq("id", contactId);
        if (error) throw error;
      }

      qc.invalidateQueries({ queryKey: ["relationship-facts", contactId] });
      qc.invalidateQueries({ queryKey: ["relationship-dumps", contactId] });
      setOpen(false);
      setText("");
      setDraft(null);
      onSaved();
      toast.success("Relationship notes saved");
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-sm border border-dashed p-2 text-xs">
      <div className="flex items-center gap-2">
        <Heart className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Relationship</span>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              setDraft(null);
              setText("");
            }
          }}
        >
          <DialogTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px]"
              disabled={disabled}
              title={reason ?? undefined}
            >
              <Sparkles className="mr-1 size-3" />
              Add notes
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Relationship notes · {contactName}</DialogTitle>
              <DialogDescription>
                Type or dictate whatever you know. The system sorts it into categories — everything
                it reads is a suggestion you can correct, and your original words are kept.
              </DialogDescription>
            </DialogHeader>

            <Textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Birthday June 8. Big cigar guy — Padron 1964s. Golfs Saturdays at Winged Foot. Wife Diane. Best to catch him late afternoon, hates mornings."
            />

            <div className="flex flex-wrap items-center gap-2">
              {recorder ? (
                <Button size="sm" variant="destructive" onClick={stopRec}>
                  <Square className="mr-1 size-3.5" /> Stop
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={startRec} disabled={!!busy}>
                  <Mic className="mr-1 size-3.5" /> Dictate
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => runParse(text.trim())}
                disabled={!!busy || text.trim().length < 3}
              >
                <Sparkles className="mr-1 size-3.5" /> Sort into categories
              </Button>
              {busy && <span className="text-[11px] text-muted-foreground">{busy}</span>}
            </div>

            {draft && (
              <div className="space-y-2 rounded-sm border p-2.5">
                <div className="text-[11px] text-muted-foreground">
                  Check each value before saving — parsing is a suggestion, not authority.
                </div>
                {cats.map((c) => (
                  <div key={c.key} className="grid grid-cols-[110px_1fr] items-center gap-2">
                    <Label className="text-[11px]">{c.label}</Label>
                    <Input
                      className="h-8 text-xs"
                      value={draft[c.key] ?? ""}
                      onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}
                    />
                  </div>
                ))}
                <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <Label className="text-[11px]">Birthday (M/D)</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      className="h-8 w-16 text-xs"
                      value={bday.m}
                      onChange={(e) => setBday({ ...bday, m: e.target.value })}
                      placeholder="6"
                    />
                    <span className="text-muted-foreground">/</span>
                    <Input
                      className="h-8 w-16 text-xs"
                      value={bday.d}
                      onChange={(e) => setBday({ ...bday, d: e.target.value })}
                      placeholder="8"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      used by gift campaigns
                    </span>
                  </div>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={!draft || saving || disabled}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-1.5 space-y-1">
        {facts.length === 0 && (
          <div className="text-[11px] text-muted-foreground">
            Nothing recorded yet. Dump what you know and the system will sort it.
          </div>
        )}
        {facts.map((f) => (
          <div key={f.category_key} className="grid grid-cols-[110px_1fr] gap-2 text-[11px]">
            <span className="text-muted-foreground">{labelFor(f.category_key)}</span>
            <span className="flex items-start gap-1">
              {f.value}
              {f.source === "ai" && <Pencil className="mt-0.5 size-2.5 text-muted-foreground" />}
            </span>
          </div>
        ))}
      </div>

      {dumps.length > 0 && (
        <div className="mt-2 border-t pt-1.5">
          <button
            type="button"
            onClick={() => setShowRaw((s) => !s)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <History className="size-3" />
            {showRaw ? "Hide" : `Original notes (${dumps.length})`}
          </button>
          {showRaw && (
            <div className="mt-1 space-y-1">
              {dumps.map((d) => (
                <div key={d.id} className="rounded-sm bg-muted/50 p-1.5 text-[11px]">
                  <div className="text-muted-foreground">
                    {new Date(d.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                  </div>
                  <div className="whitespace-pre-wrap">{d.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
