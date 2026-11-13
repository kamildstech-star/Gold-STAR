/**
 * Admin → Users → Staff roster: the company's people as imported by
 * 20261022120000_staff_roster_import.sql, what the import did to each, and
 * the one-person-at-a-time buttons that give somebody an account.
 *
 * Nothing here sends mail unless "Send invite" is pressed for that person.
 * "Copy invite link" sends nothing — the link goes to them by text.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronRight, Link2, Mail, RefreshCw, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";
import {
  ROSTER_OUTCOME_LABEL,
  rosterActions,
  rosterOfficeText,
  rosterSummary,
  type RosterOutcome,
  type RosterProvisionMode,
  type StaffRosterRow,
} from "@/lib/staff-roster";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  adminApplyStaffRoster,
  adminCreateMissingRosterAccounts,
  adminProvisionFromRoster,
  type BulkCreateRow,
} from "@/lib/staff-roster.functions";
import { cn } from "@/lib/utils";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const TONE: Record<RosterOutcome, string> = {
  created: "bg-success/15 text-success",
  updated: "bg-primary/10 text-primary",
  unchanged: "bg-muted text-muted-foreground",
  awaiting_account: "bg-warning/15 text-warning",
  held: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

const db = supabase as unknown as {
  from: (t: string) => {
    select: (c: string) => {
      order: (c: string) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
};

export function StaffRosterPanel({ onChanged }: { onChanged?: () => void }) {
  const qc = useQueryClient();
  const apply = useServerFn(adminApplyStaffRoster);
  const provision = useServerFn(adminProvisionFromRoster);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const rosterQ = useQuery({
    queryKey: ["staff-roster"],
    queryFn: async () => {
      const [rows, offices] = await Promise.all([
        db.from("staff_roster").select("*").order("full_name"),
        db.from("staff_roster_offices").select("key, label").order("key"),
      ]);
      // Before the migration is applied there is no roster to show.
      if (rows.error && isMissingSchema(rows.error)) return null;
      if (rows.error) throw new Error(rows.error.message);
      const labels = new Map(
        ((offices.data ?? []) as { key: string; label: string }[]).map((o) => [o.key, o.label]),
      );
      return { rows: (rows.data ?? []) as StaffRosterRow[], labels };
    },
  });

  const summary = useMemo(() => rosterSummary(rosterQ.data?.rows ?? []), [rosterQ.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["staff-roster"] });
    onChanged?.();
  };

  const createAll = useServerFn(adminCreateMissingRosterAccounts);
  const [confirmAll, setConfirmAll] = useState(false);
  const [bulkReport, setBulkReport] = useState<BulkCreateRow[] | null>(null);
  const createMissing = useMutation({
    mutationFn: () => createAll(),
    onSuccess: (report) => {
      setBulkReport(report);
      refresh();
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not create the missing accounts"),
  });

  const applyAll = useMutation({
    mutationFn: () => apply({ data: {} }),
    onSuccess: (rows) => {
      const changed = rows.filter((r) => r.outcome === "updated").length;
      toast.success(
        changed ? `Roster applied — ${changed} account(s) updated` : "Roster applied — no changes",
      );
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply the roster"),
  });

  const run = async (row: StaffRosterRow, mode: RosterProvisionMode) => {
    setBusy(`${row.email}:${mode}`);
    try {
      const res = await provision({ data: { email: row.email, mode } });
      if (mode === "link" && res.link) {
        try {
          await navigator.clipboard.writeText(res.link);
          toast.success(`Invite link for ${row.full_name} copied`, {
            description: "Nothing was emailed. Send it to them by text.",
          });
        } catch {
          toast.success(`Invite link for ${row.full_name}`, {
            description: res.link,
            duration: 60000,
          });
        }
      } else if (mode === "invite") {
        toast.success(`Invite emailed to ${row.email}`);
      } else {
        toast.success(`Account ready for ${row.full_name}`, {
          description: "No email was sent.",
        });
      }
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not provision this person");
    } finally {
      setBusy(null);
    }
  };

  if (!rosterQ.data) return null;
  const { rows, labels } = rosterQ.data;
  const label = (k: string) => labels.get(k) ?? k;
  // Roster rows with no account linked. The server re-checks the live
  // account list, so one made elsewhere since is skipped, not duplicated.
  const missing = rows.filter((r) => !r.user_id).length;

  return (
    <Card data-staff-roster>
      <CardContent className="space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-medium"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Staff roster ({rows.length})
            <span className="text-xs font-normal text-muted-foreground">
              {(Object.keys(summary) as RosterOutcome[])
                .filter((k) => summary[k] > 0)
                .map((k) => `${summary[k]} ${ROSTER_OUTCOME_LABEL[k].toLowerCase()}`)
                .join(" · ")}
            </span>
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={createMissing.isPending || missing === 0}
              onClick={() => setConfirmAll(true)}
              title="One account per person without one — no email is sent to anybody"
              data-create-all-missing
            >
              <Users className="mr-1.5 size-3.5" />
              {createMissing.isPending
                ? "Creating accounts…"
                : `Create all missing accounts (${missing})`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={applyAll.isPending}
              onClick={() => applyAll.mutate()}
              title="Apply names, roles and offices to everybody on the roster who has an account"
            >
              <RefreshCw className="mr-1.5 size-3.5" />
              {applyAll.isPending ? "Applying…" : "Re-apply roster"}
            </Button>
          </div>
        </div>

        <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Create {missing} missing accounts?</AlertDialogTitle>
              <AlertDialogDescription>
                Everybody on the roster without an account gets one, with their roster roles and
                offices. <strong>No email is sent to anybody.</strong> Nobody can sign in until you
                send them an invite link or invite, or they use Forgot password. Anybody who already
                has an account is skipped.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => createMissing.mutate()}>
                Create accounts
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={bulkReport != null} onOpenChange={(v) => !v && setBulkReport(null)}>
          <DialogContent className="max-h-[85svh] max-w-2xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Accounts report</DialogTitle>
              <DialogDescription>
                {bulkReport
                  ? `${bulkReport.filter((r) => r.result === "created").length} created · ${
                      bulkReport.filter((r) => r.result === "skipped").length
                    } skipped · ${bulkReport.filter((r) => r.result === "error").length} errors. No email was sent.`
                  : null}
              </DialogDescription>
            </DialogHeader>
            <ul className="divide-y rounded-sm border text-xs" data-bulk-report>
              {(bulkReport ?? []).map((r) => (
                <li key={r.email} className="flex items-start justify-between gap-3 px-2 py-1.5">
                  <span className="min-w-0">
                    <span className="font-medium">{r.full_name}</span>{" "}
                    <span className="text-muted-foreground">{r.email}</span>
                    <span className="block text-[11px] text-muted-foreground">{r.reason}</span>
                  </span>
                  <Badge
                    className={cn(
                      "shrink-0 font-normal",
                      r.result === "created"
                        ? TONE.created
                        : r.result === "error"
                          ? TONE.error
                          : TONE.unchanged,
                    )}
                  >
                    {r.result}
                  </Badge>
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>

        {open ? (
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-sm border">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Name</th>
                  <th className="px-2 py-1.5 font-medium">Role</th>
                  <th className="px-2 py-1.5 font-medium">Offices</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 text-right font-medium">Give access</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const outcome: RosterOutcome =
                    r.last_outcome ?? (r.user_id ? "unchanged" : "awaiting_account");
                  const actions = rosterActions(r);
                  return (
                    <tr key={r.email} className="align-top">
                      <td className="px-2 py-1.5">
                        <div className="font-medium">{r.full_name}</div>
                        <div className="text-muted-foreground">{r.email}</div>
                        {r.job_title || r.note ? (
                          <div className="text-[11px] text-muted-foreground">
                            {[r.job_title, r.note].filter(Boolean).join(" · ")}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.roles.map((x) => ROLE_LABELS[x as AppRole] ?? x).join(", ")}
                      </td>
                      <td className="px-2 py-1.5">{rosterOfficeText(r, label)}</td>
                      <td className="px-2 py-1.5">
                        <Badge className={cn("font-normal", TONE[outcome])}>
                          {ROSTER_OUTCOME_LABEL[outcome]}
                        </Badge>
                        {r.last_detail ? (
                          <div className="mt-0.5 max-w-[16rem] text-[11px] text-muted-foreground">
                            {r.last_detail}
                          </div>
                        ) : null}
                        {r.invited_at ? (
                          <div className="text-[11px] text-muted-foreground">
                            Invited{" "}
                            {new Date(r.invited_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex flex-wrap justify-end gap-1">
                          {actions.includes("invite") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={busy != null}
                              onClick={() => void run(r, "invite")}
                              title="Supabase emails this one person an invite"
                            >
                              <Mail className="mr-1 size-3" /> Send invite
                            </Button>
                          ) : null}
                          {actions.includes("link") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={busy != null}
                              onClick={() => void run(r, "link")}
                              title="Make the account and copy an invite link — no email is sent"
                            >
                              <Link2 className="mr-1 size-3" /> Copy invite link
                            </Button>
                          ) : null}
                          {actions.includes("account") ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              disabled={busy != null}
                              onClick={() => void run(r, "account")}
                              title="Make the account with this roster's access; no email is sent"
                            >
                              <UserPlus className="mr-1 size-3" /> Create account
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
