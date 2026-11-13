import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Copy, Link2, QrCode as QrIcon } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { useWritableLocations } from "@/components/location-picker";
import { QrCode } from "@/components/qr-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastDbError } from "@/lib/db-errors";
import {
  createTradeshowIntakeLink,
  defaultShowLinkLabel,
  isLinkLive,
  listTradeshowIntakeLinks,
  revokeIntakeLink,
  tradeshowIntakeUrl,
  type TradeshowIntakeLink,
} from "@/lib/tradeshow-intake";
import type { Tradeshow } from "@/lib/tradeshows";
import { cn } from "@/lib/utils";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const TRADESHOW_LINKS_KEY = (id: string) => ["tradeshow-intake-links", id] as const;

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);

/**
 * The show's own intake form: one URL to put on the booth as a QR code, on a
 * tablet, or in the follow-up email. Everything submitted through it lands
 * attributed to this show. Minting follows the same rule as a standalone
 * intake link — you must be able to manage the office the link belongs to.
 */
export function TradeshowIntakeLinks({ show }: { show: Tradeshow }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const writable = useWritableLocations();
  const locationId = show.location_id ?? app.currentLocationId ?? writable[0]?.id ?? null;
  const canMint = !!locationId && writable.some((l) => l.id === locationId) && !app.writesDisabled;

  const linksQ = useQuery({
    queryKey: TRADESHOW_LINKS_KEY(show.id),
    queryFn: () => listTradeshowIntakeLinks(show.id),
  });

  const [label, setLabel] = React.useState("");
  const [qr, setQr] = React.useState<TradeshowIntakeLink | null>(null);
  const [confirmRevoke, setConfirmRevoke] = React.useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: TRADESHOW_LINKS_KEY(show.id) });
  };

  const mint = useMutation({
    mutationFn: () =>
      createTradeshowIntakeLink({
        show,
        locationId: locationId!,
        label: label.trim() || null,
        userId: app.userId,
      }),
    onSuccess: (link) => {
      setLabel("");
      refresh();
      setQr(link);
      toast.success("Intake link created");
    },
    onError: (e) => toastDbError(e, { action: "create the intake link" }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeIntakeLink(id),
    onSuccess: () => {
      setConfirmRevoke(null);
      refresh();
      toast.success("Link withdrawn");
    },
    onError: (e) => toastDbError(e, { action: "withdraw the link" }),
  });

  const copy = (link: TradeshowIntakeLink) => {
    void navigator.clipboard.writeText(tradeshowIntakeUrl(link.token));
    toast.success("Link copied");
  };

  const links = linksQ.data?.links ?? [];
  const available = linksQ.data?.available !== false;

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-[14px] font-bold">Intake link</h2>
        <p className="text-[11px] text-muted-foreground">
          A form URL for this show — QR on the booth, tablet, or email. Every submission is
          attributed here.
        </p>
      </header>

      {!available ? (
        <p className="px-4 py-3 text-[12px] text-warning">
          Not live yet — the database is still missing the migration that gives an intake link a
          show.
        </p>
      ) : null}

      <div className="divide-y">
        {linksQ.isLoading && (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">Loading…</p>
        )}
        {available && !linksQ.isLoading && links.length === 0 && (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">No link yet.</p>
        )}
        {links.map((l) => {
          const live = isLinkLive(l);
          return (
            <div key={l.id} className="px-4 py-2.5 text-[13px]">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div
                    className={cn(
                      "truncate font-semibold",
                      !live && "text-muted-foreground line-through",
                    )}
                  >
                    {l.label ?? "Intake link"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {l.revoked_at
                      ? `Withdrawn ${dayLabel(l.revoked_at)}`
                      : `Expires ${dayLabel(l.expires_at)}`}
                    {" · "}
                    {l.submissions} submission{l.submissions === 1 ? "" : "s"}
                  </div>
                </div>
                {live && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      onClick={() => copy(l)}
                      title="Copy link"
                    >
                      <Copy className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      onClick={() => setQr(l)}
                      title="Show QR code"
                    >
                      <QrIcon className="size-3.5" />
                    </Button>
                    {canMint &&
                      (confirmRevoke === l.id ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 px-2 text-[11px]"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(l.id)}
                        >
                          Withdraw?
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          onClick={() => setConfirmRevoke(l.id)}
                          title="Withdraw this link"
                        >
                          <Ban className="size-3.5" />
                        </Button>
                      ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {available && canMint && (
        <div className="flex items-end gap-2 border-t p-3">
          <div className="min-w-0 flex-1">
            <Input
              className="h-8 text-[13px]"
              placeholder={defaultShowLinkLabel(show)}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <Button size="sm" className="h-8" disabled={mint.isPending} onClick={() => mint.mutate()}>
            <Link2 className="mr-1 size-3.5" /> {mint.isPending ? "Creating…" : "Create link"}
          </Button>
        </div>
      )}

      <QrDialog link={qr} show={show} onClose={() => setQr(null)} />
    </section>
  );
}

function QrDialog({
  link,
  show,
  onClose,
}: {
  link: TradeshowIntakeLink | null;
  show: Tradeshow;
  onClose: () => void;
}) {
  const url = link ? tradeshowIntakeUrl(link.token) : "";
  return (
    <Dialog open={!!link} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{link?.label ?? show.name}</DialogTitle>
          <DialogDescription>
            Scan to open the show&apos;s intake form. Print it for the booth, or show this screen.
          </DialogDescription>
        </DialogHeader>
        {link && (
          <div className="flex flex-col items-center gap-3">
            <QrCode value={url} size={288} title={`Intake form for ${show.name}`} />
            <div className="flex w-full gap-2">
              <Input
                readOnly
                value={url}
                className="h-9 text-[12px]"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="outline"
                className="h-9"
                onClick={() => {
                  void navigator.clipboard.writeText(url);
                  toast.success("Link copied");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
