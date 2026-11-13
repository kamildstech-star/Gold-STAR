/**
 * "Connect Outlook" — a person's own Microsoft 365 sign-in, on their Security
 * page.
 *
 * IT asked for delegated access instead of one company credential that can
 * read every mailbox, and this is the person's half of that: they sign in to
 * Microsoft themselves, and Recovery Hub can then reach their mailbox and
 * calendar — theirs, and anything IT has already given them Full Access to,
 * nothing else. Microsoft enforces that, not us.
 *
 * Connecting is a top-level navigation to Microsoft's own sign-in page, never
 * a popup or a frame (startConnect, shared with the Mail page). The callback
 * brings them back here with `?outlook=<outcome>`.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Link2, Mail, Unlink } from "lucide-react";
import { toast } from "sonner";

import { LoadError } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { disconnectOutlook, myOutlookConnection } from "@/lib/microsoft-connection.functions";
import { OUTLOOK_OUTCOME_MESSAGES } from "@/lib/outlook-connect-outcomes";
import { startConnect } from "@/lib/outlook-connect-start";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export function OutlookConnectionCard({
  outcome,
  onOutcomeShown,
}: {
  outcome?: string;
  onOutcomeShown?: () => void;
}) {
  const qc = useQueryClient();
  const [shared, setShared] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const q = useQuery({
    queryKey: ["my-outlook-connection"],
    queryFn: () => myOutlookConnection(),
    retry: false,
  });

  useEffect(() => {
    if (!outcome) return;
    const message = OUTLOOK_OUTCOME_MESSAGES[outcome];
    if (message) (message.ok ? toast.success : toast.error)(message.text);
    onOutcomeShown?.();
  }, [outcome, onOutcomeShown]);

  const connect = useMutation({
    mutationFn: () => startConnect({ shared, returnTo: "security" }),
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectOutlook(),
    onSuccess: async () => {
      setConfirmingDisconnect(false);
      await qc.invalidateQueries({ queryKey: ["my-outlook-connection"] });
      toast.success("Outlook disconnected. Recovery Hub no longer holds your Microsoft sign-in.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isError) {
    return (
      <LoadError
        what="your Outlook connection"
        error={q.error as Error}
        onRetry={() => void q.refetch()}
      />
    );
  }
  if (q.isLoading || !q.data) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const { mode, configured, available, connection } = q.data;
  // Company-wide (application) mode: nothing for a person to connect.
  if (mode === "application") return null;

  const status = connection?.status ?? "not_connected";

  return (
    <Card className={status === "needs_reconnect" ? "border-amber-500/50" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Mail className="size-4" />
          Outlook mail &amp; calendar
          <Badge variant={status === "connected" ? "default" : "secondary"}>
            {status === "connected"
              ? "Connected"
              : status === "needs_reconnect"
                ? "Needs reconnecting"
                : "Not connected"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Sign in to Microsoft once so Recovery Hub can log email and meetings with your clients and
          send from your own address. It reaches your mailbox and calendar only — and only mail with
          people already in the CRM is ever recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!available ? (
          <p className="text-sm text-muted-foreground">
            Outlook connections are not switched on yet.
          </p>
        ) : !configured ? (
          <p className="text-sm text-muted-foreground">
            Microsoft 365 is not set up yet. An administrator needs to add the Outlook app details
            first.
          </p>
        ) : (
          <>
            {connection && (
              <div className="rounded-md border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  {status === "connected" ? (
                    <CheckCircle2 className="size-4 text-emerald-700 dark:text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-4 text-amber-700 dark:text-amber-400" />
                  )}
                  {connection.display_name ? `${connection.display_name} · ` : ""}
                  {connection.upn}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Connected{" "}
                  {new Date(connection.connected_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                  {connection.last_refreshed_at
                    ? ` · last used ${new Date(connection.last_refreshed_at).toLocaleString("en-US")}`
                    : ""}
                </div>
                {status === "needs_reconnect" && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                    Microsoft stopped accepting this sign-in — usually a password change, 90 days
                    without use, or IT signing you out everywhere. Mail and meetings are not being
                    logged until you reconnect.
                  </p>
                )}
                {status === "connected" && connection.missing_scopes.length > 0 && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                    Microsoft did not grant {connection.missing_scopes.join(", ")}. Reconnect and
                    accept every permission, or ask IT.
                  </p>
                )}
              </div>
            )}

            {!confirmingDisconnect && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="outlook-shared"
                  checked={shared}
                  onCheckedChange={(v) => setShared(v === true)}
                />
                <Label htmlFor="outlook-shared" className="text-sm font-normal leading-snug">
                  I also look after a shared office mailbox
                  <span className="block text-xs text-muted-foreground">
                    Lets Recovery Hub use mailboxes IT has already given you Full Access to
                    {connection ? " (tick it, then Reconnect)" : ""}.
                    {connection?.shared_scopes ? " Already granted." : ""}
                  </span>
                </Label>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                <Link2 className="mr-2 size-4" />
                {connection ? "Reconnect Outlook" : "Connect Outlook"}
              </Button>
              {connection && !confirmingDisconnect && (
                <Button variant="outline" onClick={() => setConfirmingDisconnect(true)}>
                  <Unlink className="mr-2 size-4" />
                  Disconnect
                </Button>
              )}
            </div>

            {confirmingDisconnect && (
              <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
                <p>
                  Recovery Hub will delete the Microsoft sign-in it holds for you and stop logging
                  your mail and meetings. To also cut it off on Microsoft's side, ask IT to revoke
                  Recovery Hub for your account in Entra.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => disconnect.mutate()}
                    disabled={disconnect.isPending}
                  >
                    Disconnect Outlook
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingDisconnect(false)}>
                    Keep it
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
