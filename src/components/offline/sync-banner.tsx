import { useEffect, useState } from "react";
import { T } from "@/components/bilingual";
import {
  AlertTriangle,
  CloudOff,
  RefreshCw,
  Trash2,
  UploadCloud,
  Wifi,
  WifiOff,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { kindLabel, startAutoDrain } from "@/lib/offline-queue";
import { photoStateLabel } from "@/lib/photos";
import { useSyncAnnouncements, useSyncQueue, type SyncState } from "@/lib/sync-status";
import { cn } from "@/lib/utils";

function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

const at = (ts: number) => new Date(ts).toLocaleString("en-US");

/** Small online/offline chip for the cockpit header. */
export function ConnectionChip() {
  const { online, count } = useSyncQueue();
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-semibold"
      style={{
        borderColor: online
          ? "color-mix(in oklab, var(--success) 45%, transparent)"
          : "color-mix(in oklab, var(--warning) 55%, transparent)",
        color: online ? "var(--success)" : "var(--warning)",
      }}
    >
      {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
      {online ? "Online" : "Offline — work is saved on this device"}
      {count > 0 && <span className="opacity-80">· {count}</span>}
    </span>
  );
}

/**
 * Connection and queue state, in the top bar of every page.
 *
 * Offline is the state that has to be unmissable: a crew walking into a
 * basement used to find out only when a write silently queued, because the old
 * indicator hid its label below `sm` and read "All synced" the rest of the
 * time. So offline gets a filled amber pill with words on it at every width,
 * and the boring case — online, nothing held — stays an icon that costs the
 * record's name no room. Tapping it opens what is waiting.
 *
 * This is also where the queue is wired to drain itself, so exactly one mount
 * owns the interval.
 */
export function SyncIndicator({ className }: { className?: string }) {
  const sync = useSyncQueue();
  const [open, setOpen] = useState(false);
  useSyncAnnouncements(sync);
  useEffect(() => startAutoDrain(), []);

  const idle = sync.online && sync.count === 0 && sync.rejected === 0;
  const label = !sync.online
    ? sync.count > 0
      ? `Offline · ${sync.count}`
      : "Offline"
    : sync.rejected > 0
      ? `${sync.rejected} stuck`
      : sync.count > 0
        ? `Sending ${sync.count}`
        : "Online";

  const Icon = !sync.online
    ? WifiOff
    : sync.rejected > 0
      ? AlertTriangle
      : sync.count > 0
        ? UploadCloud
        : Wifi;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={
          sync.online
            ? `Connection: online. ${sync.count} item${sync.count === 1 ? "" : "s"} waiting to upload.`
            : `Connection: offline. ${sync.count} item${sync.count === 1 ? "" : "s"} saved on this phone.`
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 text-[12px] font-semibold tabular-nums",
          idle ? "text-muted-foreground hover:bg-muted" : "border",
          className,
        )}
        style={
          idle
            ? undefined
            : {
                borderColor: "color-mix(in oklab, var(--warning) 55%, transparent)",
                background: "color-mix(in oklab, var(--warning) 16%, var(--card))",
                color: "var(--warning)",
              }
        }
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        {/* Only the reassuring case is allowed to be silent on a narrow screen. */}
        <span className={idle ? "hidden md:inline" : ""}>{label}</span>
      </button>
      <SyncQueueSheet sync={sync} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * "3 items saved on this phone" — tap for the list, retry by hand, and it
 * clears itself once everything has landed. Lives in the page rather than the
 * top bar, so it costs no height when there is nothing waiting; the indicator
 * in the bar is what covers offline-with-an-empty-queue.
 */
export function SyncBanner() {
  const sync = useSyncQueue();
  const [open, setOpen] = useState(false);

  if (sync.count === 0) return null;

  const warn = !sync.online || sync.rejected > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 rounded-[8px] border px-4 py-2.5 text-left"
        style={{
          borderColor: warn
            ? "color-mix(in oklab, var(--warning) 55%, transparent)"
            : "var(--border)",
          background: warn ? "color-mix(in oklab, var(--warning) 14%, var(--card))" : "var(--card)",
        }}
      >
        {sync.online ? (
          <UploadCloud className="size-4 shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <CloudOff className="size-4 shrink-0 text-[var(--warning)]" />
        )}
        <span className="flex-1 text-[13px] font-semibold">
          {sync.count} item{sync.count === 1 ? "" : "s"} saved on this phone
          {sync.rejected > 0 && (
            <span className="ml-2 font-medium text-[var(--warning)]">
              · {sync.rejected} need{sync.rejected === 1 ? "s" : ""} attention
            </span>
          )}
        </span>
        <span className="hidden text-[12px] text-[var(--muted-foreground)] sm:inline">
          {sync.online ? "Uploading…" : "Uploads when you have signal"}
        </span>
      </button>

      <SyncQueueSheet sync={sync} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** What is waiting, when it was captured, and a way to push it now. */
function SyncQueueSheet({
  sync,
  open,
  onOpenChange,
}: {
  sync: SyncState;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-[460px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {sync.online ? "Waiting to upload" : "Saved on this phone"}
            <Badge variant="outline">{sync.count}</Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-3 space-y-2 px-4 pb-6">
          {sync.count === 0 ? (
            <p className="text-[13px] text-[var(--muted-foreground)]">
              Nothing is waiting. Everything you have captured has reached the server
              {sync.online
                ? "."
                : ", and anything you save now is held here until you have signal."}
            </p>
          ) : (
            <Button
              className="w-full"
              disabled={busy || !sync.online}
              onClick={async () => {
                setBusy(true);
                try {
                  await sync.syncNow();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
              {sync.online ? "Upload all now" : "Offline — uploads when connected"}
            </Button>
          )}

          {sync.items.map((item) => (
            <div key={item.id} className="rounded-[8px] border border-[var(--border)] p-3">
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <div className="text-[13px] font-semibold">{item.label}</div>
                  <div
                    className="text-[12px] text-[var(--muted-foreground)]"
                    title={at(item.createdAt)}
                  >
                    {kindLabel(item.kind)} · captured {ago(item.createdAt)}
                    {item.attempts > 0 &&
                      ` · ${item.attempts} attempt${item.attempts === 1 ? "" : "s"}`}
                  </div>
                  {item.lastError && (
                    <div className="mt-1 flex items-start gap-1.5 text-[12px] text-[var(--warning)]">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        {item.status === "rejected" ? "Rejected by the server: " : ""}
                        {item.lastError}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => void sync.retryOne(item.id)}>
                    Retry
                  </Button>
                  {item.status === "rejected" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Discard"
                      onClick={() => void sync.discard(item.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {sync.photos.map((p) => {
            const progress = sync.photoProgress[p.id];
            const live = progress !== undefined;
            return (
              <div key={p.id} className="rounded-[8px] border border-[var(--border)] p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <div className="text-[13px] font-semibold">
                      <T>Photo (full resolution)</T>
                    </div>
                    <div
                      className="text-[12px] text-[var(--muted-foreground)]"
                      title={at(p.createdAt)}
                    >
                      {photoStateLabel(p, live)} · captured {ago(p.createdAt)}
                      {p.attempts > 0 && ` · ${p.attempts} attempt${p.attempts === 1 ? "" : "s"}`}
                    </div>
                    {p.errorMessage && (
                      <div className="mt-1 flex items-start gap-1.5 text-[12px] text-[var(--warning)]">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span>{p.errorMessage}</span>
                      </div>
                    )}
                    {/*
                     * A bar only when there are real bytes behind it. This used
                     * to be hard-coded to 60% for anything marked "uploading",
                     * so three photos that had been dead for four hours showed
                     * a crew a job in progress. No number is better than a
                     * number that is not true.
                     */}
                    {live && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--muted)]">
                          <div
                            className="h-full rounded-full bg-[var(--primary)] transition-all"
                            style={{ width: `${Math.round(progress * 100)}%` }}
                          />
                        </div>
                        <span className="text-[11px] tabular-nums text-[var(--muted-foreground)]">
                          {Math.round(progress * 100)}%
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => void sync.retryPhoto(p)}>
                      Retry
                    </Button>
                    {p.status === "rejected" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Discard"
                        onClick={() => void sync.discardPhoto(p.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          <p className="pt-2 text-[12px] text-[var(--muted-foreground)]">
            Everything here is stored on this device. Closing the app won't lose it.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
