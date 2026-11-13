import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Phone, MessageSquare } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { EmailStatusDialog } from "@/components/email-status-dialog";
import {
  HELD_EMAIL_COLUMNS,
  HeldEmailControls,
  type HeldEmailRow,
} from "@/components/held-email-controls";
import { Button } from "@/components/ui/button";
import { useOptionList, optionLabel } from "@/lib/option-lists";
import { fetchJobContacts } from "@/lib/job-relationships";
import { isMissingSchema } from "@/lib/schema-fallback";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
interface CommRow {
  id: string;
  kind: "email" | "call" | "sms";
  when: string;
  who: string;
  subject: string;
  /** Set only for mail we sent ourselves, which is all the provider reports on. */
  emailMessageId?: string;
  /** Our own email, for the undo window's "Sending in 4:32 — Edit · Cancel". */
  email?: HeldEmailRow;
  preview: string | null;
  contactId: string | null;
  address: string | null;
}

/**
 * Communications — calls, emails and SMS only. Deliberately separate from the
 * Timeline: a rep asking "what did we tell them" does not want stage-change
 * noise mixed in.
 */
export function JobCommunicationsTab({
  jobId,
  accountId,
}: {
  jobId: string;
  accountId?: string | null;
}) {
  const { options: roles } = useOptionList("job_contact_role");
  const [roleFilter, setRoleFilter] = useState("all");

  const contactsQ = useQuery({
    queryKey: ["job-contacts", jobId],
    queryFn: () => fetchJobContacts(jobId),
  });
  const jobContacts = contactsQ.data ?? [];

  const q = useQuery({
    queryKey: ["job-comms", jobId, accountId],
    queryFn: async (): Promise<CommRow[]> => {
      const emailSelect = (cols: string) =>
        supabase
          .from("email_messages")
          .select(cols)
          .eq("job_id", jobId)
          .order("created_at", { ascending: false })
          .limit(100);
      // The held columns arrive with 20260928122000; until then the history
      // still loads, just without the countdown.
      const emailsP = emailSelect(
        `id, sent_at, created_at, contact_id, category, ${HELD_EMAIL_COLUMNS}`,
      ).then((r) =>
        r.error && isMissingSchema(r.error)
          ? emailSelect(
              "id, subject, to_emails, body_html, sent_at, created_at, contact_id, category, status, sent_by",
            )
          : r,
      );

      const contactIds = (await contactsQ.refetch()).data?.map((c) => c.contact_id).filter(Boolean);
      const capturedP = contactIds?.length
        ? supabase
            .from("captured_communications")
            .select(
              "id, channel, direction, occurred_at, subject, body_preview, from_address, to_address, contact_id",
            )
            .in("contact_id", contactIds as string[])
            .order("occurred_at", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [], error: null });

      const [emails, captured] = await Promise.all([emailsP, capturedP]);
      if (emails.error) throw emails.error;

      const rows: CommRow[] = [];
      type EmailRead = HeldEmailRow & {
        sent_at: string | null;
        created_at: string;
        contact_id: string | null;
        category: string | null;
      };
      for (const e of (emails.data ?? []) as unknown as EmailRead[]) {
        rows.push({
          id: `e-${e.id}`,
          kind: "email",
          when: e.sent_at ?? e.created_at,
          who: (e.to_emails ?? []).join(", "),
          subject: e.subject ?? "(no subject)",
          preview: e.category ?? null,
          contactId: e.contact_id ?? null,
          address: (e.to_emails ?? [])[0] ?? null,
          emailMessageId: e.id as string,
          email: e,
        });
      }
      for (const c of captured.data ?? []) {
        rows.push({
          id: `c-${c.id}`,
          kind: c.channel === "call" ? "call" : c.channel === "sms" ? "sms" : "email",
          when: c.occurred_at,
          who: (c.direction === "inbound" ? c.from_address : c.to_address) ?? "Unknown",
          subject: c.subject ?? (c.channel === "call" ? "Call" : "Message"),
          preview: c.body_preview ?? null,
          contactId: c.contact_id ?? null,
          address: c.direction === "inbound" ? c.from_address : c.to_address,
        });
      }
      return rows.sort((a, b) => (a.when < b.when ? 1 : -1));
    },
  });

  const roleOf = (row: CommRow): string | null => {
    const byContact = row.contactId
      ? jobContacts.find((c) => c.contact_id === row.contactId)
      : undefined;
    if (byContact) return byContact.role;
    const addr = (row.address ?? "").toLowerCase();
    const byEmail = addr
      ? jobContacts.find((c) => (c.email ?? "").toLowerCase() === addr)
      : undefined;
    return byEmail?.role ?? null;
  };

  const rows = (q.data ?? []).filter((r) => roleFilter === "all" || roleOf(r) === roleFilter);
  const [trailFor, setTrailFor] = useState<string | null>(null);
  const usedRoles = Array.from(new Set(jobContacts.map((c) => c.role)));

  return (
    <div className="space-y-3">
      {/* Wraps on a phone. A fixed 220px filter beside a sentence that could
          not wrap away squeezed the sentence into a one-word column; below sm
          the filter takes the row and the sentence goes under it. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="h-8 w-full sm:w-[220px]">
            <SelectValue placeholder="All relationships" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All relationships</SelectItem>
            {usedRoles.map((r) => (
              <SelectItem key={r} value={r}>
                {optionLabel(roles, r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Everything sent to the adjuster versus everything sent to the customer.
        </p>
      </div>

      <div className="rounded-md border">
        {/* A failed read is not "we never contacted them" — the difference
            decides whether someone picks up the phone. */}
        {q.isError ? (
          <div className="p-3 text-sm text-destructive">
            Communications could not be loaded — this is not an empty history.
          </div>
        ) : (
          rows.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">
              {q.isLoading ? "Loading…" : "No calls, emails or texts recorded for this job."}
            </div>
          )
        )}
        {rows.map((r) => {
          const role = roleOf(r);
          const Icon = r.kind === "call" ? Phone : r.kind === "sms" ? MessageSquare : Mail;
          return (
            /*
             * Subject on its own line, everything about it underneath. Kept on
             * one row the date and the relationship badge ate the subject on a
             * phone, and "what did we tell them" is exactly the subject line.
             */
            <div key={r.id} className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium sm:truncate">{r.subject}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[r.who, r.preview].filter(Boolean).join(" · ")}
                </div>
                {r.email ? (
                  <HeldEmailControls
                    row={r.email}
                    className="mt-1"
                    onChanged={() => void q.refetch()}
                  />
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-2 sm:hidden">
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.when).toLocaleDateString(DATE_LOCALE, US_DATE)}
                  </span>
                  {role && <Badge variant="secondary">{optionLabel(roles, role)}</Badge>}
                  {r.emailMessageId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setTrailFor(r.emailMessageId!)}
                    >
                      Delivery
                    </Button>
                  )}
                </div>
              </div>
              {r.emailMessageId && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="hidden h-6 shrink-0 px-2 text-[11px] sm:inline-flex"
                  onClick={() => setTrailFor(r.emailMessageId!)}
                >
                  Delivery
                </Button>
              )}
              {role && (
                <Badge variant="secondary" className="hidden sm:inline-flex">
                  {optionLabel(roles, role)}
                </Badge>
              )}
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {new Date(r.when).toLocaleDateString(DATE_LOCALE, US_DATE)}
              </span>
            </div>
          );
        })}
      </div>

      {trailFor && (
        <EmailStatusDialog
          emailMessageId={trailFor}
          open
          onOpenChange={(o) => !o && setTrailFor(null)}
        />
      )}
    </div>
  );
}
