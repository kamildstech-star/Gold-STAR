import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileText, Images, Mail, Receipt, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useWritesDisabled } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { toastDbError } from "@/lib/db-errors";
import { fmtDate } from "@/lib/jobs";
import {
  PORTAL_INVITE_HOURS,
  fetchPortalCandidates,
  fetchShareItems,
  invitePortalCustomer,
  portalStatus,
  setPortalCustomerDisabled,
  setShareItem,
  sharePortalJob,
  unsharePortalJob,
  type PortalCandidate,
  type PortalItemKind,
  type PortalStatus,
} from "@/lib/portal";
import { isMissingSchema } from "@/lib/schema-fallback";
import { cn } from "@/lib/utils";
import { assertWritesEnabled } from "@/lib/write-guard";

/**
 * The job's Customer portal tab: who on this job may see it, and exactly what.
 *
 * David, 24 Sep: "they should only have access to whatever is shared to them
 * on a job-by-job basis." So sharing is two decisions, both made here, both
 * per job: share the job with this person, then tick what they see. A job
 * shared with nothing ticked shows the customer an empty job — the default is
 * nothing. Unticking or unsharing takes effect on their next page load; there
 * is no cache on their side to wait out.
 *
 * The rules are the database's, not this panel's: only people on the job can
 * be invited or shared with, only this job's files can be ticked, draft
 * invoices can't be, and only someone who can manage the job may do any of
 * it. This panel offers the choices those rules allow and shows the refusal
 * in words when one is made anyway.
 */

const STATUS: Record<PortalStatus, { label: string; tone: string }> = {
  none: { label: "No portal access", tone: "text-muted-foreground" },
  invited: { label: "Invited", tone: "border-info/40 text-info" },
  expired: { label: "Invitation expired", tone: "border-warning/40 text-warning" },
  active: { label: "Has portal access", tone: "border-success/40 text-success" },
  disabled: { label: "Access turned off", tone: "border-destructive/40 text-destructive" },
};

type Shareable = { kind: PortalItemKind; id: string; label: string; detail?: string };

async function fetchShareable(jobId: string) {
  const [docs, albums, invoices] = await Promise.all([
    supabase
      .from("documents")
      .select("id, name, created_at, storage_path, voided_at")
      .eq("job_id", jobId)
      .not("storage_path", "is", null)
      .is("voided_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("projects")
      .select("id, name, archived_at")
      .eq("job_id", jobId)
      .is("archived_at", null)
      .order("created_at"),
    supabase
      .from("invoices")
      .select("id, invoice_number, title, status, total")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
  ]);
  if (docs.error) throw docs.error;
  if (albums.error) throw albums.error;
  if (invoices.error) throw invoices.error;
  const albumIds = (albums.data ?? []).map((a) => a.id);
  const folders = albumIds.length
    ? await supabase
        .from("photo_folders")
        .select("id, name, project_id")
        .in("project_id", albumIds)
        .order("sort_order")
    : { data: [], error: null };
  if (folders.error) throw folders.error;

  const albumName = new Map((albums.data ?? []).map((a) => [a.id, a.name ?? "Album"]));
  const photos: Shareable[] = [];
  for (const a of albums.data ?? []) {
    photos.push({ kind: "photo_album", id: a.id, label: a.name ?? "Album", detail: "whole album" });
    for (const f of (folders.data ?? []).filter((x) => x.project_id === a.id)) {
      photos.push({
        kind: "photo_folder",
        id: f.id,
        label: f.name ?? "Folder",
        detail: `folder in ${albumName.get(a.id)}`,
      });
    }
  }
  return {
    documents: (docs.data ?? []).map<Shareable>((d) => ({
      kind: "document",
      id: d.id,
      label: d.name ?? "Document",
      detail: fmtDate(d.created_at),
    })),
    photos,
    invoices: (invoices.data ?? [])
      .filter((v) => v.status !== "draft")
      .map<Shareable>((v) => ({
        kind: "invoice",
        id: v.id,
        label: v.invoice_number ? `Invoice ${v.invoice_number}` : (v.title ?? "Invoice"),
        detail: v.status,
      })),
    drafts: (invoices.data ?? []).filter((v) => v.status === "draft").length,
  };
}

export function JobPortalPanel({ jobId }: { jobId: string }) {
  const writes = useWritesDisabled();
  const qc = useQueryClient();
  const candidatesQ = useQuery({
    queryKey: ["portal-candidates", jobId],
    queryFn: () => fetchPortalCandidates(jobId),
    retry: false,
  });
  const shareIds = useMemo(
    () => (candidatesQ.data ?? []).map((c) => c.share_id).filter((v): v is string => !!v),
    [candidatesQ.data],
  );
  const itemsQ = useQuery({
    queryKey: ["portal-share-items", jobId, shareIds.join(",")],
    queryFn: () => fetchShareItems(shareIds),
    enabled: shareIds.length > 0,
  });
  const shareableQ = useQuery({
    queryKey: ["portal-shareable", jobId],
    queryFn: () => fetchShareable(jobId),
    enabled: shareIds.length > 0,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["portal-candidates", jobId] });
    void qc.invalidateQueries({ queryKey: ["portal-share-items", jobId] });
  };

  const share = useMutation({
    mutationFn: async (input: { candidate: PortalCandidate; on: boolean }) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      if (input.on) await sharePortalJob(jobId, input.candidate.portal_customer_id!);
      else await unsharePortalJob(input.candidate.share_id!);
    },
    onSuccess: (_d, v) => {
      toast.success(v.on ? "Job shared — nothing is visible until you tick it" : "Job unshared");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "change sharing" }),
  });
  const disable = useMutation({
    mutationFn: async (input: { id: string; disabled: boolean }) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      await setPortalCustomerDisabled(input.id, input.disabled);
    },
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "change portal access" }),
  });

  const [inviting, setInviting] = useState<PortalCandidate | null>(null);

  const notMigrated = candidatesQ.isError && isMissingSchema(candidatesQ.error);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Customer portal</CardTitle>
        <CardDescription>
          Share this job with someone on it. They sign in to a separate portal and see only what you
          tick below — read-only. No costs, notes or anything else on this job is ever shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {notMigrated ? (
          <p className="rounded-md bg-warning/15 px-3 py-2 text-[13px]">
            The customer portal isn't switched on in the database yet (migrations 20260928130000 and
            20260928131000).
          </p>
        ) : candidatesQ.isError ? (
          <p className="text-[13px] text-destructive">
            Portal access for this job could not be loaded.{" "}
            <button type="button" className="underline" onClick={() => void candidatesQ.refetch()}>
              Try again
            </button>
          </p>
        ) : candidatesQ.isLoading ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : (candidatesQ.data ?? []).length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Nobody is on this job yet. Add the customer as the job's primary contact or on its
            contact list, then invite them here.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {(candidatesQ.data ?? []).map((c) => {
              const status = portalStatus(c);
              const shareItems = (itemsQ.data ?? []).filter((i) => i.share_id === c.share_id);
              return (
                <li key={c.contact_id} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-medium">{c.full_name ?? "Contact"}</p>
                      <p className="truncate text-[12px] text-muted-foreground">
                        {c.relation}
                        {c.portal_email || c.email ? ` · ${c.portal_email ?? c.email}` : ""}
                      </p>
                    </div>
                    <Badge variant="outline" className={cn("text-[11px]", STATUS[status].tone)}>
                      {STATUS[status].label}
                      {status === "invited" && c.invite_expires_at
                        ? ` · until ${fmtDate(c.invite_expires_at)}`
                        : ""}
                    </Badge>
                  </div>

                  {!writes.disabled && (
                    <div className="flex flex-wrap gap-2">
                      {status !== "disabled" && status !== "active" && (
                        <Button
                          size="sm"
                          variant={status === "none" ? "default" : "outline"}
                          className="gap-1.5"
                          onClick={() => setInviting(c)}
                        >
                          <UserPlus className="size-4" />
                          {status === "none" ? "Invite to the portal" : "Send a new invitation"}
                        </Button>
                      )}
                      {status === "active" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-[12px] text-muted-foreground"
                          onClick={() => setInviting(c)}
                        >
                          Reset their password
                        </Button>
                      )}
                      {c.portal_customer_id && status !== "disabled" && (
                        <Button
                          size="sm"
                          variant={c.share_id ? "outline" : "secondary"}
                          disabled={share.isPending}
                          onClick={() => share.mutate({ candidate: c, on: !c.share_id })}
                        >
                          {c.share_id ? "Stop sharing this job" : "Share this job"}
                        </Button>
                      )}
                      {c.portal_customer_id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-[12px] text-muted-foreground"
                          disabled={disable.isPending}
                          onClick={() =>
                            disable.mutate({
                              id: c.portal_customer_id!,
                              disabled: status !== "disabled",
                            })
                          }
                        >
                          {status === "disabled" ? "Turn access back on" : "Turn off all access"}
                        </Button>
                      )}
                    </div>
                  )}

                  {c.share_id && (
                    <ShareChooser
                      shareId={c.share_id}
                      shareable={shareableQ.data}
                      loading={shareableQ.isLoading}
                      picked={new Set(shareItems.map((i) => `${i.item_kind}:${i.item_id}`))}
                      disabled={writes.disabled}
                      onChanged={refresh}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {inviting && (
        <InviteDialog
          jobId={jobId}
          candidate={inviting}
          onClose={() => setInviting(null)}
          onInvited={refresh}
        />
      )}
    </Card>
  );
}

function ShareChooser({
  shareId,
  shareable,
  loading,
  picked,
  disabled,
  onChanged,
}: {
  shareId: string;
  shareable: Awaited<ReturnType<typeof fetchShareable>> | undefined;
  loading: boolean;
  picked: ReadonlySet<string>;
  disabled: boolean;
  onChanged: () => void;
}) {
  const writes = useWritesDisabled();
  const toggle = useMutation({
    mutationFn: async (input: { item: Shareable; on: boolean }) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      await setShareItem(shareId, input.item.kind, input.item.id, input.on);
    },
    onSuccess: onChanged,
    onError: (e) => toastDbError(e, { action: "change what is shared" }),
  });

  if (loading || !shareable) {
    return <p className="text-[12px] text-muted-foreground">Loading this job's files…</p>;
  }

  const group = (title: string, Icon: typeof FileText, items: Shareable[], empty: string) => (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => {
            const on = picked.has(`${item.kind}:${item.id}`);
            return (
              <li key={`${item.kind}:${item.id}`}>
                <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-[13px] hover:bg-muted/40">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={on}
                    disabled={disabled || toggle.isPending}
                    onChange={() => toggle.mutate({ item, on: !on })}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.detail && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {item.detail}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <div className="space-y-3 rounded-md bg-muted/30 p-3">
      <p className="text-[12px] font-medium">What they can see on this job</p>
      {group("Documents", FileText, shareable.documents, "No documents with a file on this job.")}
      {group("Photos", Images, shareable.photos, "No photo albums on this job.")}
      {group("Invoices", Receipt, shareable.invoices, "No sent invoices on this job.")}
      {shareable.drafts > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {shareable.drafts} draft invoice{shareable.drafts === 1 ? "" : "s"} not listed — a draft
          can't be shared until it is sent.
        </p>
      )}
    </div>
  );
}

function InviteDialog({
  jobId,
  candidate,
  onClose,
  onInvited,
}: {
  jobId: string;
  candidate: PortalCandidate;
  onClose: () => void;
  onInvited: () => void;
}) {
  const writes = useWritesDisabled();
  const [email, setEmail] = useState(candidate.portal_email ?? candidate.email ?? "");
  const [link, setLink] = useState<{ url: string; email: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const locked = candidate.signed_up === true;

  const invite = useMutation({
    mutationFn: async () => {
      assertWritesEnabled(writes.disabled, writes.reason);
      return invitePortalCustomer({
        contactId: candidate.contact_id,
        jobId,
        email: locked ? null : email.trim() || null,
      });
    },
    onSuccess: (r) => {
      setLink(r);
      onInvited();
    },
    onError: (e) => toastDbError(e, { action: "create the invitation" }),
  });

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const mailto = link
    ? `mailto:${encodeURIComponent(link.email)}?subject=${encodeURIComponent(
        "Your Gold Star Restoration customer portal",
      )}&body=${encodeURIComponent(
        `Hello${candidate.full_name ? ` ${candidate.full_name}` : ""},\n\nYou can now see the documents, photos and invoices we share with you for your job. Open this link to set your password (it works once, and expires ${fmtDate(link.expiresAt)}):\n\n${link.url}\n\nGold Star Restoration`,
      )}`
    : "";

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite {candidate.full_name ?? "this person"} to the portal</DialogTitle>
          <DialogDescription>
            The link works once and expires in {PORTAL_INVITE_HOURS / 24} days. A new invitation
            replaces any earlier one.
          </DialogDescription>
        </DialogHeader>

        {!link ? (
          <div className="space-y-1.5">
            <Label htmlFor="portal-invite-email">Their email — what they will sign in with</Label>
            <Input
              id="portal-invite-email"
              type="email"
              value={email}
              disabled={locked}
              onChange={(e) => setEmail(e.target.value)}
            />
            {locked && (
              <p className="text-[12px] text-muted-foreground">
                They already have a sign-in with this email; the new link lets them set a new
                password.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Invitation link for {link.email}</Label>
            <div className="flex gap-2">
              <Input readOnly value={link.url} className="font-mono text-[12px]" />
              <Button variant="outline" size="icon" onClick={() => void copy()} aria-label="Copy">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
            <p className="text-[12px] text-muted-foreground">
              This is the only time the link is shown. Send it to them yourself — the portal does
              not send email in this first version. Don't open it yourself: whoever sets the
              password becomes the customer.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2">
          {!link ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={invite.isPending || !email.trim()} onClick={() => invite.mutate()}>
                Create invitation link
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" asChild>
                <a href={mailto}>
                  <Mail className="mr-1.5 size-4" />
                  Open in email
                </a>
              </Button>
              <Button onClick={onClose}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
