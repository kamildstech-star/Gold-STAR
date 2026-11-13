import { useEffect, useState } from "react";
import { CloudOff, RefreshCw, Check, AlertTriangle } from "lucide-react";
import {
  drain,
  listQueue,
  queueRecoveryStatus,
  subscribe,
  startAutoDrain,
  KIND_LABEL,
  type QueuedItem,
} from "@/lib/offline-queue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Sync status. A rep must be able to tell at a glance whether what they
 * captured in a basement actually saved.
 */
export function SyncStatus({ className }: { className?: string }) {
  const [items, setItems] = useState<QueuedItem[]>([]);
  const [recovery, setRecovery] = useState<Awaited<ReturnType<typeof queueRecoveryStatus>> | null>(
    null,
  );
  const [checked, setChecked] = useState(false);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let generation = 0;
    let active = true;
    const refresh = () => {
      const request = ++generation;
      // Clear rendered labels immediately on auth notifications; an earlier
      // read must not repopulate the next account's popover.
      setItems([]);
      setRecovery(null);
      setChecked(false);
      void Promise.all([listQueue(), queueRecoveryStatus()])
        .then(([next, status]) => {
          if (!active || request !== generation) return;
          setItems(next);
          setRecovery(status);
          setChecked(true);
        })
        .catch(() => {
          /* Remain unverified, never claim everything synced. */
        });
    };
    refresh();
    const unsub = subscribe(refresh);
    const stopAuto = startAutoDrain();
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      active = false;
      generation += 1;
      unsub();
      stopAuto();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const recoveryCount = (recovery?.syncItems ?? 0) + (recovery?.photos ?? 0);
  const pending = items.length;
  const errored = items.filter((i) => i.status === "error").length;

  const tone = !online
    ? "text-warning"
    : errored || recoveryCount
      ? "text-destructive"
      : pending
        ? "text-warning"
        : "text-muted-foreground";

  const label = !checked
    ? "Checking saved work"
    : recoveryCount
      ? `${recoveryCount} need recovery`
      : !online
        ? `Offline${pending ? ` · ${pending} held` : ""}`
        : errored
          ? `${errored} failed`
          : pending
            ? `Syncing ${pending}`
            : "All synced";

  const Icon = !online
    ? CloudOff
    : errored || recoveryCount
      ? AlertTriangle
      : pending
        ? RefreshCw
        : Check;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] tabular-nums hover:bg-muted",
            tone,
            className,
          )}
          aria-label={`Sync status: ${label}`}
        >
          <Icon
            className={cn(
              "size-3.5",
              pending && online && !errored && !recoveryCount && "animate-spin",
            )}
          />
          <span className="hidden sm:inline">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="text-xs font-medium">{label}</div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px]"
            disabled={busy || !online || pending === 0}
            onClick={async () => {
              setBusy(true);
              try {
                await drain();
              } finally {
                setBusy(false);
              }
            }}
          >
            Retry now
          </Button>
        </div>
        {recoveryCount > 0 && recovery ? (
          <section role="status" className="border-b px-3 py-3 text-xs">
            <p className="font-medium">Older work needs recovery</p>
            <p className="mt-1">
              {recovery.syncItems} saved entries and {recovery.photos} photos.
            </p>
            <p className="mt-1 text-muted-foreground">{recovery.message}</p>
            <details className="mt-2">
              <summary className="cursor-pointer font-medium">How to request safe recovery</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
                <li>
                  Keep this device and browser profile. Do not clear site data or reinstall the
                  browser.
                </li>
                <li>
                  Contact your organization's support team and report these counts. Ask for assisted
                  recovery on this device.
                </li>
                <li>
                  Support must independently verify who captured the work and where it belongs
                  before reviewing or resubmitting it. Signing in, even with an old account, does
                  not establish ownership.
                </li>
              </ol>
              <p className="mt-2 text-muted-foreground">
                Retry now cannot recover these entries. Their contents remain hidden and preserved
                until ownership can be verified.
              </p>
            </details>
          </section>
        ) : null}
        {!checked ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            Saved work has not been verified yet. If this persists, sign in again; do not clear site
            data.
          </p>
        ) : pending === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {recoveryCount
              ? "No attributed entries are pending for this account."
              : "No entries are pending in this account’s sync queue."}
          </p>
        ) : (
          <ul className="max-h-64 divide-y overflow-auto">
            {items.map((i) => (
              <li key={i.id} className="px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{KIND_LABEL[i.kind]}</span>
                  <span
                    className={cn(
                      "text-[10px] uppercase",
                      i.status === "error" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {i.status}
                  </span>
                </div>
                <div className="truncate text-muted-foreground">{i.label}</div>
                {i.lastError ? (
                  <div className="truncate text-[10px] text-destructive">{i.lastError}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
