import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Link2, Share2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { toastDbError } from "@/lib/db-errors";
import { fmtDate } from "@/lib/jobs";
import {
  SHARE_DISPLAY_DEFAULTS,
  SHARE_DISPLAY_OPTIONS,
  normalizeDisplayOptions,
  type ShareDisplayOptions,
} from "@/lib/job-share";
import {
  createJobShareLink,
  jobShareUrl,
  listJobShareLinks,
  revokeJobShareLink,
} from "@/lib/job-share-links";

/**
 * Sharing this job's schedule with someone who has no login.
 *
 * The list of live links is as much the point as the button that makes them.
 * A link nobody can find again is a link nobody can revoke, and this one keeps
 * showing an outsider the job until it expires.
 */
export function JobScheduleShare({ jobId }: { jobId: string }) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);

  const linksQ = useQuery({
    queryKey: ["job-share-links", jobId],
    queryFn: () => listJobShareLinks(jobId),
  });

  const notMigrated = linksQ.data?.migrated === false;
  const live = (linksQ.data?.links ?? []).filter(
    (l) => !l.revokedAt && new Date(l.expiresAt).getTime() > Date.now(),
  );

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {notMigrated && (
        <span className="mr-auto text-xs text-muted-foreground">
          Sharing needs a database update before it can be switched on.
        </span>
      )}
      {/* Never offer the button on a failed read: the existing links would be
          invisible, and a new one would be minted on top of links nobody can
          see to revoke. */}
      {linksQ.isError && (
        <span className="mr-auto text-xs text-destructive">
          This job&apos;s share links could not be read, so sharing is off for now.
        </span>
      )}
      {!notMigrated && !linksQ.isError && live.length > 0 && (
        <span className="mr-auto text-xs text-muted-foreground">
          {live.length} live share link{live.length === 1 ? "" : "s"} on this job.
        </span>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={notMigrated || linksQ.isError || linksQ.isLoading}
        onClick={() => setOpen(true)}
      >
        <Share2 className="mr-2 size-4" />
        Share schedule
      </Button>

      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        jobId={jobId}
        userId={app.userId}
        writesDisabled={app.writesDisabled}
        onChanged={() => void linksQ.refetch()}
        links={linksQ.data?.links ?? []}
      />
    </div>
  );
}

function ShareDialog({
  open,
  onOpenChange,
  jobId,
  userId,
  writesDisabled,
  onChanged,
  links,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string;
  userId: string | null;
  writesDisabled: boolean;
  onChanged: () => void;
  links: Awaited<ReturnType<typeof listJobShareLinks>>["links"];
}) {
  const [options, setOptions] = useState<ShareDisplayOptions>(SHARE_DISPLAY_DEFAULTS);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setOptions(SHARE_DISPLAY_DEFAULTS);
    setNote("");
  }, [open]);

  const toggle = (key: keyof ShareDisplayOptions, value: boolean) =>
    /* Normalising on every keystroke is what stops "crew names" staying on
       underneath a "crew" the sender just switched off. */
    setOptions((prev) => normalizeDisplayOptions({ ...prev, [key]: value }));

  const create = async () => {
    setBusy(true);
    try {
      const res = await createJobShareLink({
        jobId,
        userId,
        options,
        expiresInDays,
        note: note.trim() || null,
      });
      setCreated({ url: res.url });
      onChanged();
      toast.success("Share link created");
    } catch (e) {
      toastDbError(e, { action: "Create share link" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await revokeJobShareLink(id, userId);
      onChanged();
      toast.success("Link revoked");
    } catch (e) {
      toastDbError(e, { action: "Revoke share link" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share this job&apos;s schedule</DialogTitle>
          <DialogDescription>
            A link to the schedule only. Whoever opens it needs no account, and everything below
            starts switched off — tick only what this person should see.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <Label className="text-xs">Shareable link</Label>
            <div className="flex gap-2">
              <Input readOnly value={created.url} className="font-mono text-xs" />
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(created.url);
                  toast.success("Link copied");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="rounded-sm border border-warning/50 bg-warning/10 p-2 text-xs">
              This link stays live. The recipient keeps seeing the schedule as it changes, for the
              next {expiresInDays} days, until you revoke it.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">What the recipient can see</Label>
              <div className="space-y-2 rounded-sm border p-3">
                {SHARE_DISPLAY_OPTIONS.map((def) => {
                  const blocked = def.requires ? !options[def.requires] : false;
                  return (
                    <label
                      key={def.key}
                      className={cn(
                        "flex items-start gap-2 text-sm",
                        def.requires && "pl-6",
                        blocked && "opacity-50",
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={options[def.key]}
                        disabled={blocked}
                        onCheckedChange={(v) => toggle(def.key, v === true)}
                      />
                      <span>
                        {def.label}
                        <span className="block text-xs text-muted-foreground">{def.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Expires in (days)</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value) || 1)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Note for the recipient (optional)</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
              </div>
            </div>

            <p className="rounded-sm border border-warning/50 bg-warning/10 p-2 text-xs">
              This is a live view, not a snapshot. Whoever holds the link keeps seeing this
              job&apos;s schedule update — including changes made after you send it — until it
              expires or you revoke it.
            </p>
          </div>
        )}

        {links.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <Label className="text-xs">Existing links</Label>
            <ul className="space-y-1.5">
              {links.map((l) => {
                const expired = new Date(l.expiresAt).getTime() < Date.now();
                const dead = Boolean(l.revokedAt) || expired;
                return (
                  <li key={l.id} className="flex items-center gap-2 text-xs">
                    <span className={cn("min-w-0 grow truncate", dead && "text-muted-foreground")}>
                      {l.note || "Schedule link"} ·{" "}
                      {l.revokedAt
                        ? "revoked"
                        : expired
                          ? "expired"
                          : `expires ${fmtDate(l.expiresAt.slice(0, 10))}`}
                    </span>
                    {!dead && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void navigator.clipboard.writeText(jobShareUrl(l.token));
                            toast.success("Link copied");
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={writesDisabled}
                          onClick={() => void revoke(l.id)}
                        >
                          Revoke
                        </Button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {created ? "Done" : "Cancel"}
          </Button>
          {!created && (
            <Button onClick={create} disabled={busy || writesDisabled}>
              <Link2 className="mr-2 size-4" />
              Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
