/**
 * Delivery trail for one sent email: sent -> delivered -> opened, with times
 * and recipient, straight from the mail provider's webhook.
 *
 * The presentation is deliberately lopsided. Sent, delivered, delayed, bounced
 * and complained each get their own row and are stated plainly — they are the
 * provider reporting on its own handoff. Opens get one collapsed row, because
 * the client's own reference screenshots showed thirty-plus "Opened" events
 * minutes apart on a single email: Gmail caching the image, Apple Mail Privacy
 * Protection prefetching it, and security scanners walking the pixel. Listing
 * those as reads invites a rep to tell a client something untrue.
 *
 * An email that went out through the sender's own Outlook has no trail at
 * all: Graph's sendMail answers "accepted" and nothing more, and there is no
 * tracking pixel. Rather than "no delivery events yet — the provider reports
 * these within a minute or two", which would never become true, it says what
 * is known (sent, when, from which mailbox) and where a bounce would land.
 * An email that has not gone says that, not "no events yet".
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Info,
  MailCheck,
  MailOpen,
  MousePointerClick,
  Send,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchEmailDeliveryDetail } from "@/lib/email-delivery-detail";
import {
  emailEventLabel,
  fetchEmailEvents,
  summarizeEmailTrail,
  type EmailEvent,
} from "@/lib/email-events";

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US");
}

const EVENT_ICON: Record<string, typeof Send> = {
  "email.sent": Send,
  "email.delivered": MailCheck,
  "email.delivery_delayed": Clock,
  "email.bounced": CircleAlert,
  "email.complained": AlertTriangle,
  "email.clicked": MousePointerClick,
};

function eventTone(type: string): "success" | "destructive" | "warning" | "secondary" {
  if (type === "email.delivered") return "success";
  if (type === "email.bounced" || type === "email.complained") return "destructive";
  if (type === "email.delivery_delayed") return "warning";
  return "secondary";
}

function MilestoneRow({ event }: { event: EmailEvent }) {
  const Icon = EVENT_ICON[event.event_type] ?? Send;
  return (
    <li className="flex items-start gap-3 py-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={eventTone(event.event_type)}>{emailEventLabel(event.event_type)}</Badge>
          <span className="text-sm text-muted-foreground">{when(event.occurred_at)}</span>
        </div>
        {event.recipient ? (
          <p className="truncate text-sm text-muted-foreground">{event.recipient}</p>
        ) : null}
      </div>
    </li>
  );
}

export function EmailStatusDialog({
  emailMessageId,
  subject,
  open,
  onOpenChange,
}: {
  emailMessageId: string;
  subject?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [showRawOpens, setShowRawOpens] = useState(false);

  const q = useQuery({
    queryKey: ["email-events", emailMessageId],
    queryFn: () => fetchEmailEvents(emailMessageId),
    enabled: open,
  });

  const trail = q.data ? summarizeEmailTrail(q.data) : null;

  const detailQ = useQuery({
    queryKey: ["email-delivery", emailMessageId, "trail"],
    queryFn: () => fetchEmailDeliveryDetail(emailMessageId, null),
    enabled: open,
  });
  const detail = detailQ.data;
  const viaOutlook = detail?.provider === "outlook";
  const notSent =
    detail != null &&
    !detail.sent_at &&
    ["queued", "failed", "held", "cancelled"].includes(detail.status ?? "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delivery status</DialogTitle>
          <DialogDescription className="truncate">
            {subject?.trim() || "Sent email"}
          </DialogDescription>
        </DialogHeader>

        {notSent ? (
          <p className="py-2 text-sm text-muted-foreground" data-trail-not-sent>
            {detail?.status === "held"
              ? "Not sent yet — it is still in its undo window."
              : detail?.status === "cancelled"
                ? "Canceled — this email was never sent."
                : "Not sent yet — there is nothing to track until it goes out. The email row says why."}
          </p>
        ) : viaOutlook ? (
          <div className="space-y-2 py-2 text-sm" data-trail-outlook>
            <p className="flex items-start gap-2">
              <Send className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                Sent {detail?.sent_at ? when(detail.sent_at) : ""} through Outlook
                {detail?.sent_from ? ` from ${detail.sent_from}` : ""}. A copy is in that
                mailbox&apos;s Sent Items.
              </span>
            </p>
            <p className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Outlook does not report delivery or opens back to Recovery Hub, so there is no
                delivered or opened status for this email. If the address bounces, the bounce
                arrives in that Outlook inbox.
              </span>
            </p>
          </div>
        ) : q.isPending ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-4/5" />
            <Skeleton className="h-8 w-3/5" />
          </div>
        ) : q.isError ? (
          /* An error is said out loud. Rendering an empty trail here would read
             as "nothing happened to this email", which is a different claim. */
          <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium">Could not load the delivery trail.</p>
            <p className="text-sm text-muted-foreground">
              {q.error instanceof Error ? q.error.message : String(q.error)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
              Try again
            </Button>
          </div>
        ) : !trail || (trail.milestones.length === 0 && trail.openCount === 0) ? (
          <p className="py-2 text-sm text-muted-foreground">
            No delivery events yet. The provider reports these within a minute or two of a send;
            older emails sent before delivery tracking was switched on have none.
          </p>
        ) : (
          <div className="space-y-3">
            {trail.recipients.length > 0 ? (
              <p className="truncate text-sm text-muted-foreground">
                To {trail.recipients.join(", ")}
              </p>
            ) : null}

            <ul className="divide-y">
              {trail.milestones.map((event) => (
                <MilestoneRow key={event.id} event={event} />
              ))}

              {trail.openCount > 0 ? (
                <li className="py-2">
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 text-left"
                    onClick={() => setShowRawOpens((v) => !v)}
                    aria-expanded={showRawOpens}
                  >
                    <MailOpen
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">Opened</Badge>
                        <span className="text-sm text-muted-foreground">
                          First opened {when(trail.firstOpenAt!)} · {trail.openCount}{" "}
                          {trail.openCount === 1 ? "time" : "times"}
                        </span>
                      </span>
                    </span>
                    {showRawOpens ? (
                      <ChevronDown
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      <ChevronRight
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                  </button>

                  {showRawOpens ? (
                    <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto border-l pl-7 text-sm text-muted-foreground">
                      {trail.opens.map((event) => (
                        <li key={event.id} className="truncate">
                          {when(event.occurred_at)}
                          {event.recipient ? ` · ${event.recipient}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ) : null}

              {trail.clicks.map((event) => (
                <MilestoneRow key={event.id} event={event} />
              ))}
            </ul>

            {trail.openCount > 0 ? (
              <p className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  Opens are not reliable. Gmail and Apple Mail load the tracking image themselves,
                  before anyone reads the message, and spam filters do the same — so one email can
                  show dozens of opens nobody made. Treat “opened” as “the image was fetched”, not
                  “they read it”.
                </span>
              </p>
            ) : null}
          </div>
        )}

        <p className="border-t pt-3 text-xs text-muted-foreground">
          Covers email sent by this system only. Mail a rep sends from Outlook arrives through the
          Graph sync and has no delivery trail here.
        </p>
      </DialogContent>
    </Dialog>
  );
}
