/**
 * The Microsoft 365 admin screen's delegated-mode pieces.
 *
 * IT (SM Tech Solutions) asked for per-user delegated access instead of one
 * company credential that can reach every mailbox; this is the admin half of
 * it. The setup request below is EXACTLY what IT was told — the two redirect
 * URIs and the delegated scope list come from microsoft-oauth.ts, the same
 * constants the sign-in code uses, so this card cannot drift from what the
 * code will ask Microsoft for.
 *
 * The people list shows names and a status, nothing else: no token, no
 * Microsoft account address. Whether to chase someone is the admin's call;
 * connecting is the person's own, from their Security page.
 */
import { AlertTriangle, CheckCircle2, CircleDashed, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DelegatedOverview, DelegatedPerson, MailboxAccess } from "@/lib/graph.functions";
import {
  DELEGATED_SCOPES,
  MICROSOFT_CALLBACK_PATH,
  SHARED_MAILBOX_SCOPES,
  redirectOrigins,
} from "@/lib/microsoft-oauth";
import { buildAppOrigin } from "@/lib/app-origin";

// The ones IT registered plus this build's public address, if it is another.
const REDIRECT_URIS = redirectOrigins(buildAppOrigin()).map(
  (o) => `${o}${MICROSOFT_CALLBACK_PATH}`,
);

const PERSON_STATUS: Record<
  DelegatedPerson["status"],
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  connected: {
    label: "Connected",
    className:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/40",
    icon: CheckCircle2,
  },
  needs_reconnect: {
    label: "Needs reconnect",
    className:
      "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40",
    icon: AlertTriangle,
  },
  not_connected: {
    label: "Not connected",
    className: "bg-muted text-muted-foreground",
    icon: CircleDashed,
  },
};

export function PersonStatusBadge({ status }: { status: DelegatedPerson["status"] }) {
  const s = PERSON_STATUS[status];
  const Icon = s.icon;
  return (
    <Badge variant="outline" className={s.className}>
      <Icon className="mr-1 size-3" />
      {s.label}
    </Badge>
  );
}

/** "Needs an owner", "Not connected" — under a mailbox in the registry. */
export function MailboxAccessNote({ access }: { access: MailboxAccess | undefined }) {
  if (!access || access.ok || !access.message) return null;
  return (
    <div className="mt-0.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      <span>{access.message}</span>
    </div>
  );
}

/** Pick (or clear) whose sign-in reads a shared office mailbox. */
export function MailboxOwnerSelect({
  access,
  staff,
  disabled,
  onChange,
}: {
  access: MailboxAccess | undefined;
  staff: DelegatedOverview["staff"];
  disabled?: boolean;
  onChange: (ownerUserId: string | null) => void;
}) {
  return (
    <Select
      value={access?.owner_user_id ?? "none"}
      disabled={disabled}
      onValueChange={(v) => onChange(v === "none" ? null : v)}
    >
      <SelectTrigger className="h-8 min-w-40 text-xs" aria-label="Mailbox owner">
        <SelectValue placeholder="Needs an owner" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">No owner</SelectItem>
        {access?.owner_user_id && !staff.some((s) => s.user_id === access.owner_user_id) && (
          <SelectItem value={access.owner_user_id}>
            {access.owner_name ?? "Former member"}
          </SelectItem>
        )}
        {staff.map((s) => (
          <SelectItem key={s.user_id} value={s.user_id}>
            {s.name}
            {s.status === "connected"
              ? ""
              : s.status === "needs_reconnect"
                ? " (needs reconnect)"
                : " (not connected)"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PeopleConnectionsCard({ overview }: { overview: DelegatedOverview }) {
  if (!overview.connections_available) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Per-person Outlook connections are not switched on yet (migration 20261007200000).
        </CardContent>
      </Card>
    );
  }
  const counts = { connected: 0, needs_reconnect: 0, not_connected: 0 };
  for (const p of overview.people) counts[p.status] += 1;
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="size-4" />
          Who has connected Outlook
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Each person connects their own mailbox from <strong>Security &amp; two-factor</strong> in
          their user menu. Anyone not connected is simply not synced. A sign-in lapses after 90 days
          unused, a password change, or IT revoking sessions — they then show "Needs reconnect"
          until they press Reconnect.
        </p>
        <div className="flex flex-wrap gap-4">
          <div>
            <div className="text-lg font-medium">{counts.connected}</div>
            <div className="text-xs text-muted-foreground">connected</div>
          </div>
          <div>
            <div
              className={`text-lg font-medium ${counts.needs_reconnect ? "text-amber-700" : ""}`}
            >
              {counts.needs_reconnect}
            </div>
            <div className="text-xs text-muted-foreground">need to reconnect</div>
          </div>
          <div>
            <div className="text-lg font-medium">{counts.not_connected}</div>
            <div className="text-xs text-muted-foreground">with a mailbox, not connected</div>
          </div>
        </div>
        {overview.people.length > 0 && (
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Person</th>
                  <th className="px-3 py-2 text-left font-medium">Outlook</th>
                  <th className="px-3 py-2 text-left font-medium">Shared mailboxes</th>
                  <th className="px-3 py-2 text-left font-medium">Last used</th>
                </tr>
              </thead>
              <tbody>
                {overview.people.map((p) => (
                  <tr key={p.user_id} className="border-t">
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2">
                      <PersonStatusBadge status={p.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {p.status === "not_connected" ? "—" : p.shared_scopes ? "Granted" : "No"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {p.last_refreshed_at
                        ? new Date(p.last_refreshed_at).toLocaleString("en-US")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The registration IT was asked for, word for word. */
export function DelegatedSetupRequest({ notificationUrl }: { notificationUrl: string | null }) {
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Setup request for Gold Star IT — delegated access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div>
          <p className="font-medium">1. Register an application</p>
          <p className="text-muted-foreground">
            Microsoft Entra admin center → App registrations → New registration. Name it “Recovery
            Hub CRM”, <strong>single tenant</strong>. Platform: <strong>Web</strong>, with these
            redirect URIs exactly:
          </p>
          <ul className="mt-1 space-y-1">
            {REDIRECT_URIS.map((u) => (
              <li key={u}>
                <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{u}</code>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">
            Record the <strong>Directory (tenant) ID</strong> (the GUID, not the domain name) and
            the <strong>Application (client) ID</strong>, then create a client secret under
            Certificates &amp; secrets and record its value.
          </p>
        </div>
        <div>
          <p className="font-medium">2. Delegated permissions only</p>
          <p className="text-muted-foreground">
            API permissions → Microsoft Graph → <strong>Delegated permissions</strong>.{" "}
            <strong>No application permissions.</strong>
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {DELEGATED_SCOPES.map((s) => (
              <code key={s} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {s}
              </code>
            ))}
          </div>
          <p className="mt-2 text-muted-foreground">
            Optional, for shared office mailboxes a user already has Full Access to:
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {SHARED_MAILBOX_SCOPES.map((s) => (
              <code key={s} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {s}
              </code>
            ))}
          </div>
          <p className="mt-2 text-muted-foreground">
            <strong>Grant admin consent for delegated permissions is optional.</strong> It only
            saves each person the consent prompt; it does not widen what any token can reach, which
            is always that person's own mailbox (plus shared mailboxes IT has given them Full Access
            to). No <code>User.Read.All</code>, no <code>Mail.ReadWrite</code>, and no
            ApplicationAccessPolicy is needed.
          </p>
        </div>
        <div>
          <p className="font-medium">3. Hand back three values</p>
          <p className="text-muted-foreground">
            Tenant ID, Client ID and the client secret go into Project Settings → Secrets as{" "}
            <code>OUTLOOK_TENANT_ID</code>, <code>OUTLOOK_CLIENT_ID</code>,{" "}
            <code>OUTLOOK_CLIENT_SECRET</code>. We set <code>OUTLOOK_WEBHOOK_CLIENT_STATE</code>{" "}
            ourselves. <code>OUTLOOK_AUTH_MODE</code> is <code>delegated</code> unless set to{" "}
            <code>application</code>.
          </p>
        </div>
        <div>
          <p className="font-medium">4. Revoking</p>
          <p className="text-muted-foreground">
            IT's lever, instantly and without us: Entra → Enterprise applications → Recovery Hub CRM
            → revoke a user's consent or sessions, or delete the app registration or its secret. A
            person's Disconnect button deletes the sign-in Recovery Hub holds.
          </p>
        </div>
        <div>
          <p className="font-medium">Notification endpoint</p>
          <code className="mt-1 block break-all rounded-md bg-muted p-2 text-xs">
            {notificationUrl ?? "/api/public/hooks/outlook"}
          </code>
        </div>
      </CardContent>
    </Card>
  );
}
