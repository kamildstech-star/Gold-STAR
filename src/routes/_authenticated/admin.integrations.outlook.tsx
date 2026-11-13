/**
 * Microsoft 365 sync, for owners/admins/devs.
 *
 * Two modes (`OUTLOOK_AUTH_MODE`). Delegated — the default, and what IT asked
 * for — means each person connects their own Outlook and every mailbox is read
 * with its holder's own sign-in; this screen then shows who has connected,
 * which shared office mailbox each owner reads, and the registration IT was
 * asked for. Application mode keeps the original company-credential setup
 * request, minus `Mail.ReadWrite`, which no code ever used.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  DelegatedSetupRequest,
  MailboxAccessNote,
  MailboxOwnerSelect,
  PeopleConnectionsCard,
} from "@/components/outlook-delegated-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  addGraphMailbox,
  calendarPushStatus,
  graphStatus,
  importOfficeMailboxes,
  outlookDelegatedOverview,
  removeGraphMailbox,
  renewGraphSubscriptions,
  retryCalendarPushes,
  runGraphSync,
  setGraphMailboxFlags,
  setGraphMailboxOwner,
  type MailboxStatus,
} from "@/lib/graph.functions";

export const Route = createFileRoute("/_authenticated/admin/integrations/outlook")({
  head: () => ({
    meta: [
      { title: "Microsoft 365 sync · Recovery Hub" },
      {
        name: "description",
        content:
          "Connected mailboxes, change-notification subscriptions, delta reconciliation and the IT setup request for Microsoft Graph email and calendar sync.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: OutlookAdmin,
});

const HEALTH: Record<
  MailboxStatus["subscription_health"],
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  ok: {
    label: "Live",
    className:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/40",
    icon: CheckCircle2,
  },
  expiring: {
    label: "Renewing",
    className:
      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/40",
    icon: Clock,
  },
  missing: {
    label: "No subscription",
    className:
      "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40",
    icon: AlertTriangle,
  },
  failed: {
    label: "Failed",
    className:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/40",
    icon: AlertTriangle,
  },
};

function ago(value: string | null) {
  if (!value) return "never";
  const ms = Date.now() - new Date(value).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function OutlookAdmin() {
  const qc = useQueryClient();
  const fetchStatus = useServerFn(graphStatus);
  const addMailbox = useServerFn(addGraphMailbox);
  const importOffices = useServerFn(importOfficeMailboxes);
  const setFlags = useServerFn(setGraphMailboxFlags);
  const removeMailbox = useServerFn(removeGraphMailbox);
  const sync = useServerFn(runGraphSync);
  const renew = useServerFn(renewGraphSubscriptions);

  const fetchOverview = useServerFn(outlookDelegatedOverview);
  const setOwner = useServerFn(setGraphMailboxOwner);
  const fetchPush = useServerFn(calendarPushStatus);
  const retryPush = useServerFn(retryCalendarPushes);

  const status = useQuery({ queryKey: ["graph-status"], queryFn: () => fetchStatus() });
  // Who has connected, and whose sign-in reads each mailbox. Names only.
  const overviewQ = useQuery({
    queryKey: ["outlook-delegated-overview"],
    queryFn: () => fetchOverview(),
    retry: false,
  });

  // Outbound queue health. Its own query so a stuck push is visible even while
  // the mailbox registry is still loading.
  const pushStatus = useQuery({
    queryKey: ["calendar-push-status"],
    queryFn: () => fetchPush(),
    retry: false,
  });

  const locations = useQuery({
    queryKey: ["locations-min"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations")
        .select("id, code, name")
        .eq("active", true)
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  const [upn, setUpn] = useState("");
  const [kind, setKind] = useState<"user" | "shared_office">("user");
  const [locationId, setLocationId] = useState<string>("none");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["graph-status"] });
    qc.invalidateQueries({ queryKey: ["calendar-push-status"] });
    qc.invalidateQueries({ queryKey: ["outlook-delegated-overview"] });
  };

  const run = <T,>(fn: () => Promise<T>, pending: string, done: (r: T) => string) =>
    toast.promise(
      fn().then((r) => {
        invalidate();
        return r;
      }),
      {
        loading: pending,
        success: done,
        error: (e: Error) => e.message,
      },
    );

  const addMutation = useMutation({
    mutationFn: () =>
      addMailbox({
        data: {
          upn,
          kind,
          locationId: locationId === "none" ? null : locationId,
        },
      }),
    onSuccess: () => {
      setUpn("");
      invalidate();
      toast.success("Mailbox added. Run a sync to create its subscription.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = status.data;
  const push = pushStatus.data;
  const stalePush =
    !!push?.oldest_pending_at &&
    Date.now() - new Date(push.oldest_pending_at).getTime() > 6 * 3_600_000;
  const mailboxes = data?.mailboxes ?? [];
  const overview = overviewQ.data;
  const delegated = (overview?.mode ?? "delegated") === "delegated";
  const offices = mailboxes.filter((m) => m.kind === "shared_office");
  const users = mailboxes.filter((m) => m.kind !== "shared_office");

  return (
    <div className="space-y-4">
      {/* Title and the way back to Integrations are the Settings breadcrumb's. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-md border bg-muted/40 p-2">
            <Mail className="size-5" />
          </div>
          <div className="max-w-2xl space-y-1 text-sm text-muted-foreground">
            <Badge variant="outline">
              {delegated ? "Delegated · each person connects" : "Application · company-wide"}
            </Badge>
            <p>
              {delegated
                ? "Each person connects their own Outlook from their Security page, and every mailbox is read with its holder's own Microsoft sign-in — never a company credential. Shared office mailboxes need an owner with Full Access."
                : "App-only Graph access with admin consent. Reps never connect anything, and the relationship history stays company property when someone leaves."}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              run(
                () => renew(),
                "Renewing subscriptions…",
                () => "Subscriptions renewed.",
              )
            }
          >
            <ShieldCheck className="size-4" /> Renew subscriptions
          </Button>
          <Button
            size="sm"
            onClick={() =>
              run(
                () => sync({ data: { mailboxId: null } }),
                "Reconciling with Graph…",
                (r) =>
                  `Delta sync finished for ${(r as { results: unknown[] }).results.length} mailbox(es).`,
              )
            }
          >
            <RefreshCw className="size-4" /> Run delta sync
          </Button>
        </div>
      </div>

      {data && !data.configured && (
        <Card className="border-amber-200 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/15">
          <CardContent className="flex gap-3 p-4 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
            <div>
              <p className="font-medium text-amber-900 dark:text-amber-300">Not connected yet</p>
              <p className="text-amber-900/80">
                Missing credentials: {data.missing_secrets.join(", ")}. Add them in Project Settings
                → Secrets once IT completes the app registration below.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Outbound calendar queue ------------------------------------------
          A reschedule or a cancellation that never reached Outlook is
          invisible from inside the CRM — the row looks saved and the attendee
          turns up at the old time. So the queue states its own health here,
          with Microsoft's words on anything that gave up. */}
      {push && (push.pending > 0 || push.stuck > 0) && (
        <Card className={push.stuck > 0 ? "border-red-200 dark:border-red-500/40" : undefined}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarClock className="size-4" />
              Changes waiting to reach Outlook
            </CardTitle>
            {push.stuck > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  run(
                    () => retryPush(),
                    "Retrying…",
                    (r) => `${(r as { requeued: number }).requeued} event(s) requeued.`,
                  )
                }
              >
                <RefreshCw className="size-4" /> Retry stuck events
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <div>
                <div className="text-lg font-medium">{push.pending}</div>
                <div className="text-xs text-muted-foreground">
                  queued{push.oldest_pending_at ? ` · oldest ${ago(push.oldest_pending_at)}` : ""}
                </div>
              </div>
              <div>
                <div className={`text-lg font-medium ${push.stuck > 0 ? "text-red-600" : ""}`}>
                  {push.stuck}
                </div>
                <div className="text-xs text-muted-foreground">gave up</div>
              </div>
            </div>

            {!data?.configured && push.pending > 0 && (
              <p className="text-muted-foreground">
                Microsoft 365 is not connected, so these are held rather than failed. They send
                themselves once the credentials above are in place.
              </p>
            )}

            {data?.configured && stalePush && (
              <p className="text-red-600 dark:text-red-400">
                Something in this queue has been waiting since {ago(push.oldest_pending_at)} — with
                Microsoft 365 connected it should clear in minutes. Run a delta sync, then check the
                mailbox errors above.
              </p>
            )}

            {push.samples.length > 0 && (
              <div className="overflow-clip rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Event</th>
                      <th className="px-3 py-2 text-left font-medium">Starts</th>
                      <th className="px-3 py-2 text-left font-medium">Tries</th>
                      <th className="px-3 py-2 text-left font-medium">What Microsoft said</th>
                    </tr>
                  </thead>
                  <tbody>
                    {push.samples.map((s) => (
                      <tr key={s.id} className="border-t align-top">
                        <td className="px-3 py-2">{s.subject ?? "(no subject)"}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {s.starts_at ? new Date(s.starts_at).toLocaleString("en-US") : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{s.attempts}</td>
                        <td className="px-3 py-2 text-xs text-red-600 dark:text-red-400">
                          {s.error ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {delegated && overview && <PeopleConnectionsCard overview={overview} />}

      {/* Mailbox registry ------------------------------------------------ */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
          <CardTitle className="text-sm">Synced mailboxes ({mailboxes.length})</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              run(
                () => importOffices(),
                "Importing office mailboxes…",
                (r) => `${(r as { added: number }).added} office mailbox(es) registered.`,
              )
            }
          >
            <Building2 className="size-4" /> Import office mailboxes
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {mailboxes.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No mailboxes yet. Import the office mailboxes from the locations table, then add
              individual sales staff below.
            </p>
          )}

          {[
            { title: "Shared office mailboxes", rows: offices, shared: true },
            { title: "Staff mailboxes", rows: users, shared: false },
          ]
            .filter((g) => g.rows.length > 0)
            .map((group) => (
              <div key={group.title} className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </p>
                <div className="overflow-clip rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Mailbox</th>
                        {group.shared && delegated && (
                          <th className="px-3 py-2 text-left font-medium">Owner</th>
                        )}
                        <th className="px-3 py-2 text-left font-medium">Feed</th>
                        <th className="px-3 py-2 text-left font-medium">Mail</th>
                        <th className="px-3 py-2 text-left font-medium">Calendar</th>
                        <th className="px-3 py-2 text-left font-medium">Last delta</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((m) => {
                        const health = HEALTH[m.subscription_health];
                        const Icon = health.icon;
                        return (
                          <tr key={m.id} className="border-t">
                            <td className="px-3 py-2">
                              <div className="font-medium">{m.upn}</div>
                              {m.display_name && (
                                <div className="text-xs text-muted-foreground">
                                  {m.display_name}
                                </div>
                              )}
                              {m.last_error && (
                                <div className="text-xs text-red-600 dark:text-red-400">
                                  {m.last_error}
                                </div>
                              )}
                              {delegated && <MailboxAccessNote access={overview?.access[m.id]} />}
                            </td>
                            {group.shared && delegated && (
                              <td className="px-3 py-2">
                                {overview?.owners_available ? (
                                  <MailboxOwnerSelect
                                    access={overview.access[m.id]}
                                    staff={overview.staff}
                                    onChange={(ownerUserId) =>
                                      run(
                                        () => setOwner({ data: { id: m.id, ownerUserId } }),
                                        "Saving owner…",
                                        () =>
                                          ownerUserId
                                            ? "Owner set. They need Full Access in Exchange and to connect Outlook with the shared-mailbox box ticked."
                                            : "Owner cleared.",
                                      )
                                    }
                                  />
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    Needs migration 20261007210000
                                  </span>
                                )}
                              </td>
                            )}
                            <td className="px-3 py-2">
                              <Badge variant="outline" className={health.className}>
                                <Icon className="mr-1 size-3" />
                                {health.label}
                              </Badge>
                            </td>
                            <td className="px-3 py-2">
                              <Switch
                                checked={m.sync_mail}
                                onCheckedChange={(v) =>
                                  run(
                                    () => setFlags({ data: { id: m.id, syncMail: v } }),
                                    "Saving…",
                                    () => "Updated.",
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Switch
                                checked={m.sync_calendar}
                                onCheckedChange={(v) =>
                                  run(
                                    () => setFlags({ data: { id: m.id, syncCalendar: v } }),
                                    "Saving…",
                                    () => "Updated.",
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {ago(m.last_delta_sync_at)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    run(
                                      () => sync({ data: { mailboxId: m.id } }),
                                      `Syncing ${m.upn}…`,
                                      () => "Sync finished.",
                                    )
                                  }
                                >
                                  <RefreshCw className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    if (!confirm(`Stop syncing ${m.upn}?`)) return;
                                    run(
                                      () => removeMailbox({ data: { id: m.id } }),
                                      "Removing…",
                                      () => "Mailbox removed.",
                                    );
                                  }}
                                >
                                  <Trash2 className="size-4 text-red-600 dark:text-red-400" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

          <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label className="text-xs">Mailbox address</Label>
              <Input
                value={upn}
                placeholder="rep@goldstarrestoration.com"
                onChange={(e) => setUpn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">Staff mailbox</SelectItem>
                  <SelectItem value="shared_office">Shared office</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Location</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(locations.data ?? []).map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.code} · {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={!upn.trim() || addMutation.isPending}
              onClick={() => addMutation.mutate()}
            >
              <Plus className="size-4" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Privacy ---------------------------------------------------------- */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">What actually gets stored</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Only messages matching a known contact.</strong>{" "}
            Every message is checked against the sender and recipient addresses in contacts and
            accounts. Anything else is discarded on arrival — personal correspondence, HR matters
            and internal chatter never enter the CRM.
          </p>
          <p>
            Metadata plus an 800-character preview is stored. Full bodies are fetched from Graph on
            demand rather than warehoused.
          </p>
          <p>
            Outbound email is recorded but does not satisfy cadence until a genuine reply lands in
            the same conversation. Out-of-office and bounce replies are filtered out.
          </p>
          <p>
            Whether a meeting happened is derived from calendar state and attendee responses — no
            rep ticks a box.
          </p>
          <p className="text-foreground">
            The AI never drafts or sends client-facing email. The send path rejects anything not
            marked human-authored.
          </p>
        </CardContent>
      </Card>

      {/* IT request ------------------------------------------------------- */}
      {delegated ? (
        <DelegatedSetupRequest notificationUrl={data?.notification_url ?? null} />
      ) : (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Setup request for Gold Star IT</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div>
              <p className="font-medium">
                1. Register an application (Global Administrator required)
              </p>
              <p className="text-muted-foreground">
                Microsoft Entra admin center → App registrations → New registration. Name it
                “Recovery Hub CRM”, single tenant, no redirect URI needed. Record the{" "}
                <strong>Directory (tenant) ID</strong> and <strong>Application (client) ID</strong>,
                then create a client secret under Certificates &amp; secrets and record its value.
              </p>
            </div>
            <div>
              <p className="font-medium">2. Grant application permissions, then admin consent</p>
              <p className="text-muted-foreground">
                API permissions → Microsoft Graph → <strong>Application permissions</strong> (not
                delegated):
              </p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                <li>
                  <code>Mail.Read</code> — read matched messages
                </li>
                <li>
                  <code>Mail.Send</code> — send from the user’s own mailbox so replies thread
                </li>
                <li>
                  <code>Calendars.ReadWrite</code> — two-way meeting sync
                </li>
                <li>
                  <code>User.Read.All</code> — resolve mailbox IDs and display names
                </li>
              </ul>
              <p className="mt-1 text-muted-foreground">
                A Global Administrator must click <strong>Grant admin consent</strong>. Application
                permissions cannot be consented by an ordinary user.
              </p>
            </div>
            <div>
              <p className="font-medium">3. Scope access with an ApplicationAccessPolicy</p>
              <p className="text-muted-foreground">
                Without this, the app can read every mailbox in the tenant. Create a mail-enabled
                security group containing only sales and office staff, then in Exchange Online
                PowerShell:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">{`New-ApplicationAccessPolicy \`
  -AppId <APPLICATION_CLIENT_ID> \`
  -PolicyScopeGroupId CRM-Mailbox-Sync@goldstarrestoration.com \`
  -AccessRight RestrictAccess \`
  -Description "Recovery Hub CRM — sales and office mailboxes only"

# verify
Test-ApplicationAccessPolicy -Identity someone@goldstarrestoration.com \`
  -AppId <APPLICATION_CLIENT_ID>`}</pre>
            </div>
            <div>
              <p className="font-medium">4. Hand back four values</p>
              <p className="text-muted-foreground">
                Tenant ID, Client ID, Client secret, and the security group name. These go into
                Project Settings → Secrets as <code>OUTLOOK_TENANT_ID</code>,{" "}
                <code>OUTLOOK_CLIENT_ID</code>, <code>OUTLOOK_CLIENT_SECRET</code>. We also set{" "}
                <code>OUTLOOK_WEBHOOK_CLIENT_STATE</code> ourselves.
              </p>
            </div>
            <div>
              <p className="font-medium">Notification endpoint</p>
              <code className="mt-1 block break-all rounded-md bg-muted p-2 text-xs">
                {data?.notification_url ?? "/api/public/hooks/outlook"}
              </code>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
