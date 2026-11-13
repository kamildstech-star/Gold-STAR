/**
 * The Field Camera's bottom sheets: pick a job, file into a folder / tag,
 * choose the stamp template, and review this session's shots.
 */
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CloudOff,
  CloudUpload,
  Folder,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Search,
  StickyNote,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { jobChipLabel, matchesJob, type CameraJob } from "@/lib/field-camera/jobs";
import {
  normaliseFields,
  STAMP_FIELD_LABEL,
  STAMP_FIELDS,
  STAMP_PRESETS,
  type StampField,
} from "@/lib/field-camera/stamp";
import type { StoredTemplate } from "@/lib/field-camera/prefs";
import type { ShotStatus } from "@/lib/field-camera/upload";
import type { Label } from "@/lib/labels";
import { buildTree, flattenTree, type PhotoFolder } from "@/lib/photo-folders";

/* ── job picker ─────────────────────────────────────────────────────────── */

export type PickerJob = CameraJob & { canAdd: boolean; assigned: boolean };

export function JobPickerSheet({
  open,
  onOpenChange,
  jobs,
  loading,
  error,
  selectedId,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobs: PickerJob[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  // Only jobs this person can file photos into are listed at all.
  const shown = useMemo(
    () => jobs.filter((j) => j.canAdd && matchesJob(j, q)).slice(0, 150),
    [jobs, q],
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85svh] gap-3 p-4">
        <SheetHeader className="text-left">
          <SheetTitle>Which job?</SheetTitle>
          <SheetDescription>Photos file into the job&apos;s album.</SheetDescription>
        </SheetHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Job number, name, customer or address"
            className="h-11 pl-8"
            aria-label="Search jobs"
          />
        </div>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading jobs…
            </p>
          ) : error ? (
            <p className="flex items-start gap-2 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No jobs match.</p>
          ) : (
            <ul className="space-y-1" data-testid="camera-job-list">
              {shown.map((j) => (
                <li key={j.id}>
                  <button
                    type="button"
                    data-job-id={j.id}
                    onClick={() => onPick(j.id)}
                    className={`flex min-h-12 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm ${
                      j.id === selectedId ? "bg-primary/10" : "hover:bg-muted"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{jobChipLabel(j)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[j.customer_name, j.address].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {j.assigned && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Assigned
                      </span>
                    )}
                    {j.id === selectedId && <Check className="size-4 shrink-0 text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── folder & tag ───────────────────────────────────────────────────────── */

export function FilingSheet({
  open,
  onOpenChange,
  folders,
  folderId,
  onFolder,
  tags,
  tagId,
  onTag,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  folders: PhotoFolder[];
  folderId: string | null;
  onFolder: (id: string | null) => void;
  tags: Label[];
  tagId: string | null;
  onTag: (id: string | null) => void;
}) {
  const nodes = useMemo(() => flattenTree(buildTree(folders)), [folders]);
  const row =
    "flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-muted";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85svh] gap-3 p-4">
        <SheetHeader className="text-left">
          <SheetTitle>File photos into</SheetTitle>
          <SheetDescription>The room folder and tag every new shot gets.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Folder / room
            </h3>
            <button type="button" className={row} onClick={() => onFolder(null)}>
              <ImageIcon className="size-4 text-muted-foreground" />
              <span className="flex-1">No folder (All photos)</span>
              {folderId == null && <Check className="size-4 text-primary" />}
            </button>
            {nodes.map((f) => (
              <button
                key={f.id}
                type="button"
                className={row}
                style={{ paddingLeft: 8 + f.depth * 14 }}
                onClick={() => onFolder(f.id)}
              >
                <Folder className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate">{f.name}</span>
                {folderId === f.id && <Check className="size-4 text-primary" />}
              </button>
            ))}
            {nodes.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                This job has no folders yet — add rooms on the job&apos;s Rooms tab.
              </p>
            )}
          </section>
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Tag
            </h3>
            <button type="button" className={row} onClick={() => onTag(null)}>
              <TagIcon className="size-4 text-muted-foreground" />
              <span className="flex-1">No tag</span>
              {tagId == null && <Check className="size-4 text-primary" />}
            </button>
            {tags.map((t) => (
              <button key={t.id} type="button" className={row} onClick={() => onTag(t.id)}>
                <span className="size-3 rounded-full" style={{ background: t.color }} aria-hidden />
                <span className="flex-1 truncate">{t.name}</span>
                {tagId === t.id && <Check className="size-4 text-primary" />}
              </button>
            ))}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── templates ──────────────────────────────────────────────────────────── */

export function TemplateSheet({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  value: StoredTemplate;
  onChange: (t: StoredTemplate) => void;
}) {
  const on = new Set(value.fields);
  const toggle = (f: StampField) => {
    const next = on.has(f) ? value.fields.filter((x) => x !== f) : [...value.fields, f];
    onChange({ presetId: "custom", fields: normaliseFields(next) });
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85svh] gap-3 p-4">
        <SheetHeader className="text-left">
          <SheetTitle>Stamp template</SheetTitle>
          <SheetDescription>
            What is printed on each photo. Saved on this device for you.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap gap-2">
          {STAMP_PRESETS.map((p) => (
            <Button
              key={p.id}
              type="button"
              size="sm"
              variant={value.presetId === p.id ? "default" : "outline"}
              className="h-10"
              onClick={() => onChange({ presetId: p.id, fields: [...p.fields] })}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="space-y-1">
          {STAMP_FIELDS.map((f) => (
            <label key={f} className="flex min-h-11 items-center gap-3 rounded-sm px-1 text-sm">
              <Checkbox checked={on.has(f)} onCheckedChange={() => toggle(f)} />
              {STAMP_FIELD_LABEL[f]}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Whatever the stamp shows, the photo record always keeps the time, time zone, GPS and job.
        </p>
      </SheetContent>
    </Sheet>
  );
}

/* ── review ─────────────────────────────────────────────────────────────── */

export type SessionShot = {
  localId: string;
  photoId: string | null;
  projectId: string | null;
  captionId: string | null;
  url: string;
  note: string;
  status: ShotStatus | "saving" | "error";
  takenAt: Date;
};

const STATUS_TEXT: Record<SessionShot["status"], string> = {
  saving: "Saving…",
  queued: "Waiting for signal",
  uploading: "Uploading…",
  uploaded: "Uploaded",
  failed: "Upload failed — retrying",
  error: "Not saved",
};

export function StatusIcon({
  status,
  className,
}: {
  status: SessionShot["status"];
  className?: string;
}) {
  if (status === "uploaded") return <Check className={className} aria-label="Uploaded" />;
  if (status === "uploading" || status === "saving") {
    return <Loader2 className={`${className ?? ""} animate-spin`} aria-label="Uploading" />;
  }
  if (status === "queued") return <CloudUpload className={className} aria-label="Queued" />;
  return <CloudOff className={className} aria-label="Not uploaded" />;
}

export function ReviewSheet({
  open,
  onOpenChange,
  shots,
  onDelete,
  onRetake,
  onSaveNote,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  shots: SessionShot[];
  onDelete: (s: SessionShot) => Promise<void>;
  onRetake: (s: SessionShot) => Promise<void>;
  onSaveNote: (s: SessionShot, note: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85svh] gap-3 p-4">
        <SheetHeader className="text-left">
          <SheetTitle>This session ({shots.length})</SheetTitle>
          <SheetDescription>
            Shots stay on this phone until they upload — closing the app does not lose them.
          </SheetDescription>
        </SheetHeader>
        {shots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No photos yet.</p>
        ) : (
          <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
            {shots.map((s) => (
              <li key={s.localId} className="w-56 shrink-0 snap-start space-y-2">
                <div className="relative overflow-hidden rounded-sm bg-muted">
                  <img src={s.url} alt="" className="aspect-[3/4] w-full object-cover" />
                  <span className="absolute left-1 top-1 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
                    <StatusIcon status={s.status} className="size-3" />
                    {STATUS_TEXT[s.status]}
                  </span>
                </div>
                {editing === s.localId ? (
                  <div className="space-y-1">
                    <Input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="What does this show?"
                      className="h-10"
                      maxLength={500}
                    />
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        className="h-10 flex-1"
                        disabled={busy === s.localId}
                        onClick={() =>
                          void run(s.localId, async () => {
                            await onSaveNote(s, draft);
                            setEditing(null);
                          })
                        }
                      >
                        Save note
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-10"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    {s.note && (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{s.note}</p>
                    )}
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-10 flex-1"
                        disabled={!s.photoId || busy === s.localId}
                        onClick={() => {
                          setDraft(s.note);
                          setEditing(s.localId);
                        }}
                      >
                        <StickyNote className="size-4" /> Note
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-10"
                        aria-label="Retake"
                        disabled={busy === s.localId}
                        onClick={() => void run(s.localId, () => onRetake(s))}
                      >
                        <RotateCcw className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-10 text-destructive"
                        aria-label="Delete"
                        disabled={busy === s.localId}
                        onClick={() => void run(s.localId, () => onDelete(s))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}
