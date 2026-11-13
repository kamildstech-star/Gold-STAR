import { useState } from "react";
import { Copy, Link2, Mail, RefreshCw, Share2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toastDbError } from "@/lib/db-errors";
import {
  intakeLinkMailto,
  intakeLinkMessage,
  useRotateStandingIntakeLink,
  useStandingIntakeLink,
  type StandingLinkState,
} from "@/lib/standing-intake-link";

/*
 * The standing intake link, reachable from the top bar on every screen.
 *
 * David, 22 Sep: a field tech on a call "could just send a link — not go into
 * the system, create a link, then send." So it lives where their thumb already
 * is, not on the intake inbox (which field roles do not even have), and it
 * never asks which office: the form routes by the property. The link is
 * fetched when the menu opens, not on every page load, so nobody gets a link
 * minted for them just by signing in.
 */

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.success("Intake link copied", {
      description: "Paste it into a text or an email. It works every time.",
    });
  } catch {
    // Some in-app browsers refuse the clipboard; the link itself still helps.
    toast.message("Copy this link", { description: url, duration: 20_000 });
  }
}

const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

async function shareLink(url: string) {
  const { subject, body } = intakeLinkMessage(url);
  try {
    await navigator.share({ title: subject, text: body });
  } catch {
    // Dismissing the share sheet throws AbortError; nothing to say about it.
  }
}

/** The shared actions: used by the top-bar menu and the intake inbox header. */
function useLinkActions(open: boolean) {
  const link = useStandingIntakeLink(open);
  const rotate = useRotateStandingIntakeLink();
  const state: StandingLinkState | undefined = link.data;
  const url = state?.status === "ready" ? state.url : null;
  return { link, rotate, state, url };
}

export function IntakeLinkMenu({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const { link, rotate, state, url } = useLinkActions(open);

  const hint = link.isError
    ? "Could not load your link. Close and try again."
    : state?.status === "unavailable"
      ? "Not switched on yet — the database update for standing links is pending."
      : !url
        ? "Loading your link…"
        : null;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className={className ?? "gap-1.5 px-2"}
            title="Intake link"
            aria-label="Intake link"
          >
            <Link2 className="size-4" />
            <span className="hidden text-xs md:inline">Intake link</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Your intake link — the same one every time. Each form goes to the closest office.
          </DropdownMenuLabel>
          {hint ? <p className="px-2 pb-1.5 text-xs text-muted-foreground">{hint}</p> : null}
          <DropdownMenuItem
            className="min-h-11 md:min-h-8"
            disabled={!url}
            onSelect={() => url && void copyLink(url)}
          >
            <Copy className="mr-2 size-4" />
            Copy intake link
          </DropdownMenuItem>
          {canShare() ? (
            <DropdownMenuItem
              className="min-h-11 md:min-h-8"
              disabled={!url}
              onSelect={() => url && void shareLink(url)}
            >
              <Share2 className="mr-2 size-4" />
              Text or share…
            </DropdownMenuItem>
          ) : null}
          {url ? (
            <DropdownMenuItem className="min-h-11 md:min-h-8" asChild>
              <a href={intakeLinkMailto(url)}>
                <Mail className="mr-2 size-4" />
                Email the link
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className="min-h-11 md:min-h-8" disabled>
              <Mail className="mr-2 size-4" />
              Email the link
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="min-h-11 text-xs text-muted-foreground md:min-h-8"
            disabled={!url || rotate.isPending}
            onSelect={() => setConfirmRotate(true)}
          >
            <RefreshCw className="mr-2 size-3.5" />
            Replace my link…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your intake link?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current link stops working straight away, including every copy you have already
              sent or saved. Use this if the link got into the wrong hands. Forms already sent in
              are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my link</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                rotate.mutate(undefined, {
                  onSuccess: (next) =>
                    next.status === "ready"
                      ? void copyLink(next.url)
                      : toast.error("Standing links are not switched on yet."),
                  onError: (e) => toastDbError(e, { action: "Replacing your intake link" }),
                })
              }
            >
              Replace and copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * One tap, for the intake inbox header: the office staff who live on that
 * screen get the same link without opening a menu.
 */
export function CopyIntakeLinkButton() {
  const { link, url, state } = useLinkActions(true);
  if (state?.status === "unavailable") return null;
  return (
    <>
      <Button size="sm" disabled={!url} onClick={() => url && void copyLink(url)}>
        <Copy className="mr-1.5 size-4" />
        {link.isLoading ? "Loading link…" : "Copy intake link"}
      </Button>
      {url ? (
        <Button size="sm" variant="outline" asChild>
          <a href={intakeLinkMailto(url)}>
            <Mail className="mr-1.5 size-4" />
            Email it
          </a>
        </Button>
      ) : null}
    </>
  );
}
