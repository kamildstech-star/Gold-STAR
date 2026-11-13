/**
 * The job's pictures, tick to choose.
 *
 * Same tiles, same rooms, same shift-click as the Pictures tab; the only
 * difference is that clicking a picture selects it rather than opening a
 * viewer, because choosing is all this dialog is for.
 *
 * It was the invoice editor's own private component until job reports needed
 * the same act — David, on reports: "today's updated pictures, or select the
 * updated pictures that you want to put in". Two pickers over the same grid
 * would drift, and the ids they produce have to stay identical: a ULID for an
 * album photograph, `doc:<uuid>` for an image filed as a document, which is
 * what lets one selection make a share link, an invoice attachment and a
 * report attachment without a second identity scheme.
 *
 * What differs between callers is wording and the warning under the count, so
 * those are props and nothing else is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Images } from "lucide-react";
import type { ReactNode } from "react";

import { PhotoTile } from "@/components/job-photos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { groupJobPhotos, type JobPhoto } from "@/lib/job-photos";

export function JobPhotoPicker({
  open,
  onOpenChange,
  photos,
  loading,
  error,
  initial,
  title,
  description,
  confirmLabel,
  footerNote,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  photos: JobPhoto[];
  loading: boolean;
  error: string | null;
  /** What is already chosen — pre-ticked, and kept in its own order. */
  initial: string[];
  title: string;
  description: string;
  /** Defaults to "Use N photos". */
  confirmLabel?: (count: number) => string;
  /** Shown beside the count, e.g. how many pages of pictures this prints as. */
  footerNote?: (count: number) => ReactNode;
  onConfirm: (ids: string[]) => void;
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(initial));
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSel(new Set(initial));
    anchor.current = null;
  }, [open, initial]);

  const groups = useMemo(() => groupJobPhotos(photos), [photos]);
  const flat = useMemo(() => groups.flatMap((g) => g.dates.flatMap(([, list]) => list)), [groups]);

  const toggle = useCallback(
    (id: string, shiftKey: boolean) => {
      setSel((prev) => {
        const next = new Set(prev);
        if (shiftKey && anchor.current && anchor.current !== id) {
          const a = flat.findIndex((p) => p.id === anchor.current);
          const b = flat.findIndex((p) => p.id === id);
          if (a >= 0 && b >= 0) {
            for (const p of flat.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(p.id);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = id;
    },
    [flat],
  );

  const toggleRoom = (roomIds: string[], allOn: boolean) =>
    setSel((prev) => {
      const next = new Set(prev);
      for (const id of roomIds) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  /* Already-chosen pictures keep the order the office arranged; new ones
     follow in grid order. Reordering is a job for the card, not the picker. */
  const ordered = () => [
    ...initial.filter((id) => sel.has(id)),
    ...flat.filter((p) => sel.has(p.id) && !initial.includes(p.id)).map((p) => p.id),
  ];

  const count = sel.size;
  const note = footerNote?.(count);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Images className="size-4" /> {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {loading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading photos…</p>
          ) : error ? (
            <p className="flex items-center gap-2 rounded-sm border border-destructive/40 p-4 text-sm text-destructive">
              <AlertTriangle className="size-4" /> {error}
            </p>
          ) : photos.length === 0 ? (
            <p className="rounded-sm border border-dashed p-4 text-sm text-muted-foreground">
              No photos on this job yet. Upload some under All photos on the Rooms tab first.
            </p>
          ) : (
            groups.map((g) => {
              const roomIds = g.dates.flatMap(([, list]) => list.map((p) => p.id));
              const allOn = roomIds.length > 0 && roomIds.every((id) => sel.has(id));
              return (
                <section key={g.room} className="space-y-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    {g.room}
                    <Badge variant="secondary">{g.count}</Badge>
                    <button
                      type="button"
                      onClick={() => toggleRoom(roomIds, allOn)}
                      className="min-h-11 px-1 text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground sm:min-h-0 sm:px-0"
                    >
                      {allOn ? "Clear" : "Select all"}
                    </button>
                  </h3>
                  {g.dates.map(([date, list]) => (
                    <div key={date} className="space-y-1">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {date}
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-6">
                        {list.map((p) => (
                          <PhotoTile
                            key={p.id}
                            photo={p}
                            selectable
                            selected={sel.has(p.id)}
                            selectMode
                            onToggle={(shiftKey) => toggle(p.id, shiftKey)}
                            onOpen={() => toggle(p.id, false)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              );
            })
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-semibold tabular-nums text-foreground">{count}</span> selected
            {note}
          </span>
          <span className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => onConfirm(ordered())} disabled={loading || !!error}>
              {confirmLabel?.(count) ?? `Use ${count} photo${count === 1 ? "" : "s"}`}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
