import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Link2, Plus, Share2, TriangleAlert } from "lucide-react";
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
import type { JobPhoto } from "@/lib/job-photos";
import {
  PHOTO_SHARE_DEFAULTS,
  PHOTO_SHARE_OPTIONS,
  countOriginalCarriers,
  normalizePhotoShareOptions,
  type PhotoShareOptions,
} from "@/lib/photo-share";
import {
  createJobPhotoShareLink,
  listJobPhotoShareLinks,
  revokeJobPhotoShareLink,
  updateJobPhotoShareLink,
  type JobPhotoShareLink,
} from "@/lib/photo-share-links";

/**
 * Sending a set of this job's photographs to someone who has no login.
 *
 * Two halves, and the second is not optional. Making a link is the easy half;
 * the list of links that already exist is what lets anyone find one again to
 * turn it off. A link nobody can see is a link nobody can revoke, and it keeps
 * showing an outsider the inside of a customer's house until it expires.
 *
 * Adding photographs to a link that has already been sent happens here too, on
 * the same URL. That was asked for explicitly: the recipient reopens the
 * message they already have.
 */
export function JobPhotoShare({
  jobId,
  selected,
  disabled,
  onShared,
}: {
  jobId: string;
  /** The current grid selection, in the order it is shown. */
  selected: JobPhoto[];
  disabled: boolean;
  onShared: () => void;
}) {
  const [open, setOpen] = useState(false);

  const linksQ = useQuery({
    queryKey: ["job-photo-share-links", jobId],
    queryFn: () => listJobPhotoShareLinks(jobId),
  });

  const notMigrated = linksQ.data?.migrated === false;
  const blocked = notMigrated || linksQ.isError || linksQ.isLoading;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-11 sm:h-7"
        disabled={blocked || selected.length === 0}
        title={
          notMigrated
            ? "Sharing needs a database update before it can be switched on."
            : linksQ.isError
              ? "This job's share links could not be read, so sharing is off for now."
              : undefined
        }
        onClick={() => setOpen(true)}
      >
        <Share2 className="mr-1 size-4" />
        Share
      </Button>

      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        jobId={jobId}
        selected={selected}
        writesDisabled={disabled}
        links={linksQ.data?.links ?? []}
        onChanged={() => void linksQ.refetch()}
        onShared={onShared}
      />
    </>
  );
}

function ShareDialog({
  open,
  onOpenChange,
  jobId,
  selected,
  writesDisabled,
  links,
  onChanged,
  onShared,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string;
  selected: JobPhoto[];
  writesDisabled: boolean;
  links: JobPhotoShareLink[];
  onChanged: () => void;
  onShared: () => void;
}) {
  const app = useAppContext();
  const [options, setOptions] = useState<PhotoShareOptions>(PHOTO_SHARE_DEFAULTS);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setCreated(null);
    setOptions(PHOTO_SHARE_DEFAULTS);
    setNote("");
  }, [open]);

  const ids = selected.map((p) => p.id);
  const originals = countOriginalCarriers(selected);

  const toggle = (key: keyof PhotoShareOptions, value: boolean) =>
    /* Normalising on every keystroke is what stops "words in the markup"
       staying on underneath a "markup" the sender just switched off. */
    setOptions((prev) => normalizePhotoShareOptions({ ...prev, [key]: value }));

  const create = async () => {
    setBusy(true);
    try {
      const res = await createJobPhotoShareLink({
        jobId,
        /* share_links_insert_job requires created_by = auth.uid(); a null here
           is refused by RLS, not stored as an anonymous link. */
        userId: app.userId,
        ids,
        options,
        expiresInDays,
        note: note.trim() || null,
      });
      setCreated({ url: res.url });
      onChanged();
      toast.success(`Link created for ${ids.length} photo${ids.length === 1 ? "" : "s"}`);
    } catch (e) {
      toastDbError(e, { action: "Create photo share link" });
    } finally {
      setBusy(false);
    }
  };

  const addToLink = async (link: JobPhotoShareLink) => {
    const merged = [...link.photoIds, ...ids.filter((id) => !link.photoIds.includes(id))];
    const added = merged.length - link.photoIds.length;
    if (added === 0) {
      toast.info("Those photos are already on this link.");
      return;
    }
    try {
      await updateJobPhotoShareLink(link.id, { ids: merged });
      onChanged();
      onShared();
      toast.success(`${added} photo${added === 1 ? "" : "s"} added`, {
        description: "Same link — whoever has it will see them next time they open it.",
      });
    } catch (e) {
      toastDbError(e, { action: "Add photos to share link" });
    }
  };

  const revoke = async (link: JobPhotoShareLink) => {
    try {
      await revokeJobPhotoShareLink(link.id, app.userId);
      onChanged();
      toast.success("Link revoked");
    } catch (e) {
      toastDbError(e, { action: "Revoke share link" });
    }
  };

  const copy = (url: string) => {
    void navigator.clipboard.writeText(url);
    toast.success("Link copied");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Share {selected.length} photo{selected.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            A page of these pictures and nothing else. Whoever opens it needs no account, and
            everything below starts switched off — tick only what this person should see.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <Label className="text-xs">Shareable link</Label>
            <div className="flex gap-2">
              <Input readOnly value={created.url} className="font-mono text-xs" />
              <Button variant="secondary" onClick={() => copy(created.url)}>
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="rounded-sm border border-warning/50 bg-warning/10 p-2 text-xs">
              This link stays live for the next {expiresInDays} days, until you revoke it. You can
              add more photos to it later without sending a new link.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">What the recipient can see</Label>
              <div className="space-y-2 rounded-sm border p-3">
                {PHOTO_SHARE_OPTIONS.map((def) => {
                  const parentOff = def.requires ? !options[def.requires] : false;
                  return (
                    <label
                      key={def.key}
                      className={cn(
                        "flex items-start gap-2 text-sm",
                        def.requires && "pl-6",
                        parentOff && "opacity-50",
                      )}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={options[def.key]}
                        disabled={parentOff}
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

            <HonestyNote originals={originals} total={selected.length} />

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
          </div>
        )}

        {links.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <Label className="text-xs">Photo links already on this job</Label>
            <ul className="space-y-1.5">
              {links.map((l) => {
                const expired = new Date(l.expiresAt).getTime() < Date.now();
                const dead = Boolean(l.revokedAt) || expired;
                return (
                  <li key={l.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={cn("min-w-0 grow truncate", dead && "text-muted-foreground")}>
                      {l.note || `${l.count} photo${l.count === 1 ? "" : "s"}`} ·{" "}
                      {l.revokedAt
                        ? "revoked"
                        : expired
                          ? "expired"
                          : `expires ${fmtDate(l.expiresAt.slice(0, 10))}`}
                    </span>
                    {!dead && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => copy(l.url)}>
                          <Copy className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={writesDisabled || selected.length === 0}
                          title="Add the selected photos to this existing link — the URL does not change."
                          onClick={() => void addToLink(l)}
                        >
                          <Plus className="mr-1 size-3.5" />
                          Add {selected.length}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={writesDisabled}
                          onClick={() => void revoke(l)}
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
            <Button onClick={create} disabled={busy || writesDisabled || ids.length === 0}>
              <Link2 className="mr-2 size-4" />
              Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The part of the request that cannot be delivered, said out loud.
 *
 * The switches above take a fact off the page and out of the response. They
 * cannot reach inside the picture. Two cases, and a sender who does not know
 * about them will believe they hid something they did not.
 */
function HonestyNote({ originals, total }: { originals: number; total: number }) {
  return (
    <div className="flex gap-2 rounded-sm border border-warning/50 bg-warning/10 p-2 text-xs">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="space-y-1">
        <p>
          These switches control what this page shows and what it sends. They cannot change the
          picture itself: if the camera app printed a date, an address or a compass reading{" "}
          <em>onto</em> the photo, it is part of the image and no setting here removes it. Look at
          the thumbnails before you send.
        </p>
        {originals > 0 && (
          <p>
            {originals} of these {total} {originals === 1 ? "is" : "are"} sent as the original
            camera file, so any capture time or GPS stored inside the file goes with{" "}
            {originals === 1 ? "it" : "them"} even with those boxes unticked. The rest are re-saved
            copies that carry none of that.
          </p>
        )}
      </div>
    </div>
  );
}
