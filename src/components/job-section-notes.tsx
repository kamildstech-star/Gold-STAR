import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { personLabel } from "@/lib/chat";
import { jobSectionLabel } from "@/lib/job-sections";
import { undoableDelete, type Undoable } from "@/lib/undoable-delete";

export type JobSectionNote = {
  id: string;
  body: string;
  created_at: string;
  author_id: string | null;
  profiles?: { full_name: string | null } | null;
};

export async function fetchJobSectionNotes(jobId: string, sectionKey?: string) {
  let q = supabase
    .from("job_section_notes")
    .select("id, body, created_at, author_id, section_key")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  if (sectionKey) q = q.eq("section_key", sectionKey);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as (JobSectionNote & { section_key: string })[];

  const ids = [...new Set(rows.map((r) => r.author_id).filter(Boolean))] as string[];
  if (ids.length) {
    const { data: people } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    const byId = new Map((people ?? []).map((p) => [p.user_id, p]));
    for (const r of rows) r.profiles = r.author_id ? (byId.get(r.author_id) ?? null) : null;
  }
  return rows;
}

/**
 * Per-section notes. Yellow like timeline notes, newest first, and the same
 * rows show up in the job Timeline tagged with their section.
 */
export function JobSectionNotes({
  jobId,
  sectionKey,
  showLabel,
}: {
  jobId: string;
  sectionKey: string;
  showLabel?: boolean;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const q = useQuery({
    queryKey: ["job-section-notes", jobId, sectionKey],
    queryFn: () => fetchJobSectionNotes(jobId, sectionKey),
  });
  /*
   * Notes removed but still inside their Undo window. They are hidden here at
   * once and only deleted when the toast closes (see undoable-delete.ts), so
   * Undo is simply "never send it".
   */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(new Map<string, { job: Undoable; toastId: string | number }>());
  const notes = (q.data ?? []).filter((n) => !removing.has(n.id));
  /*
   * Only the newest is shown. Notes accumulate for the life of a job, and a
   * card that grows without limit pushes everything under it off the screen -
   * the older ones are history, not something anyone reads on the way past.
   */
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? notes : notes.slice(0, 1);
  const hidden = notes.length - visible.length;

  const save = async () => {
    if (!body.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("job_section_notes").insert({
      job_id: jobId,
      section_key: sectionKey,
      body: body.trim(),
      author_id: app.userId,
    });
    setSaving(false);
    if (error) return toastDbError(error, { action: "add the note" });
    setBody("");
    setOpen(false);
    toast.success("Note added");
    void qc.invalidateQueries({ queryKey: ["job-section-notes", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-timeline", jobId] });
  };

  const unhide = (id: string) =>
    setRemoving((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const remove = (id: string) => {
    if (pending.current.has(id)) return;
    setRemoving((prev) => new Set(prev).add(id));
    const job = undoableDelete({
      commit: async () => {
        const { error } = await supabase.from("job_section_notes").delete().eq("id", id);
        if (error) throw error;
        void qc.invalidateQueries({ queryKey: ["job-section-notes", jobId] });
        void qc.invalidateQueries({ queryKey: ["job-timeline", jobId] });
      },
      restore: () => unhide(id),
      onError: (error) => toastDbError(error, { action: "remove the note" }),
    });
    const settle = () => {
      pending.current.delete(id);
      void job.settle();
    };
    const toastId = toast("Note removed", {
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          pending.current.delete(id);
          job.undo();
        },
      },
      onAutoClose: settle,
      onDismiss: settle,
    });
    pending.current.set(id, { job, toastId });
  };

  /*
   * Sonner pauses a toast's clock while the page is hidden, so a crew member
   * who removes a note and pockets the phone would leave the delete hanging
   * until they next opened the app. Going hidden is as good as letting the
   * window run out: send whatever is pending.
   */
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      for (const [id, { job, toastId }] of pending.current) {
        pending.current.delete(id);
        void job.settle();
        toast.dismiss(toastId);
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, []);

  return (
    <div className="space-y-2 pt-2">
      {showLabel && (
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {jobSectionLabel(sectionKey)} notes
        </div>
      )}
      {visible.map((n) => (
        <div
          key={n.id}
          className="group flex items-start gap-2 rounded-sm border border-warning/40 bg-warning/10 px-2 py-1.5 text-[13px]"
        >
          <div className="min-w-0 flex-1">
            <div className="whitespace-pre-wrap">{n.body}</div>
            <div className="text-[11px] text-muted-foreground">
              {personLabel(n.profiles)} · {new Date(n.created_at).toLocaleString("en-US")}
            </div>
          </div>
          {!app.writesDisabled && (
            <Button
              size="icon"
              variant="ghost"
              // Hover-only on a phone meant invisible but still a live 44px
              // target (the touch tap-size rule grows it), so a tap near a
              // note's edge deleted it unseen. Shown outright on touch.
              className="size-6 opacity-0 group-hover:opacity-100 touch:opacity-100"
              aria-label="Remove note"
              onClick={() => remove(n.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      ))}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-left text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {hidden} earlier note{hidden === 1 ? "" : "s"}
        </button>
      )}
      {showAll && notes.length > 1 && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="text-left text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Show less
        </button>
      )}

      {open ? (
        <div className="space-y-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Note for this section…"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving || !body.trim()}>
              Save note
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        !app.writesDisabled && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => setOpen(true)}
          >
            <Plus className="mr-1 size-3.5" /> Note
          </Button>
        )
      )}
    </div>
  );
}
