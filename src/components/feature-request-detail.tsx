// Full record view for one suggestion: description, attachments, comments,
// status history, and the management controls (status, priority, dismissal,
// duplicate merge) that only owner / admin / dev see.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FileText, Loader2, ThumbsUp } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { categoryLabel, useFrCategories } from "@/components/feature-request-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyLine } from "@/components/ui-density";
import { toastDbError } from "@/lib/db-errors";
import { isPrivileged } from "@/lib/roles";
import {
  FR_PRIORITIES,
  FR_PRIORITY_LABEL,
  FR_STATUSES,
  FR_STATUS_CLASS,
  FR_STATUS_LABEL,
  detailsText,
  formatDate,
  formatDateTime,
  isImage,
  signAttachments,
  signOriginal,
  submitterLine,
  type FeatureRequest,
  type FrAttachment,
  type FrComment,
  type FrHistory,
  type FrPriority,
  type FrStatus,
} from "@/lib/feature-requests";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: FrStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 rounded-md px-1.5 text-[10px] uppercase tracking-wide",
        FR_STATUS_CLASS[status],
      )}
    >
      {FR_STATUS_LABEL[status]}
    </Badge>
  );
}

export function AttachmentThumbs({
  attachments,
  onOpen,
  max = 4,
}: {
  attachments: FrAttachment[];
  onOpen?: (a: FrAttachment) => void;
  max?: number;
}) {
  const [urls, setUrls] = React.useState<Map<string, string>>(new Map());
  const shown = attachments.slice(0, max);

  React.useEffect(() => {
    let cancelled = false;
    if (shown.length === 0) return;
    signAttachments(shown).then((m) => {
      if (!cancelled) setUrls(m);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((a) => a.id).join(",")]);

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((a) => {
        const url = urls.get(a.id);
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onOpen?.(a)}
            className="grid h-14 w-20 place-items-center overflow-hidden rounded-md border bg-muted"
            title={a.file_name ?? "Attachment"}
          >
            {isImage(a.mime_type) && url ? (
              <img
                src={url}
                alt={a.file_name ?? ""}
                className="size-full object-cover"
                loading="lazy"
              />
            ) : (
              <FileText className="size-4 text-muted-foreground" />
            )}
          </button>
        );
      })}
      {attachments.length > max && (
        <span className="text-[11px] text-muted-foreground">+{attachments.length - max}</span>
      )}
    </div>
  );
}

export function Lightbox({
  attachment,
  onClose,
}: {
  attachment: FrAttachment | null;
  onClose: () => void;
}) {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (!attachment) return;
    signOriginal(attachment.storage_path).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment]);

  return (
    <Dialog open={Boolean(attachment)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate text-[14px]">
            {attachment?.file_name ?? "Attachment"}
          </DialogTitle>
        </DialogHeader>
        {!url ? (
          <EmptyLine>Preparing file…</EmptyLine>
        ) : attachment && isImage(attachment.mime_type) ? (
          <img
            src={url}
            alt={attachment.file_name ?? ""}
            className="max-h-[75vh] w-full object-contain"
          />
        ) : (
          <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">
            Open file
          </a>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function FeatureRequestDetail({
  request,
  allRequests,
  voters,
  onClose,
}: {
  request: FeatureRequest;
  allRequests: FeatureRequest[];
  voters: Set<string>;
  onClose: () => void;
}) {
  const { userId, roles } = useAppContext();
  const { disabled: writesDisabled, reason: writesReason } = useWritesDisabled();
  const qc = useQueryClient();
  const categories = useFrCategories();
  const canManage = isPrivileged(roles);

  const [comment, setComment] = React.useState("");
  const [dismissReason, setDismissReason] = React.useState("");
  const [dupTarget, setDupTarget] = React.useState<string>("");
  const [lightbox, setLightbox] = React.useState<FrAttachment | null>(null);

  const attachments = useQuery({
    queryKey: ["feature-requests", "attachments", request.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_request_attachments")
        .select("*")
        .eq("request_id", request.id)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as FrAttachment[];
    },
  });

  const comments = useQuery({
    queryKey: ["feature-requests", "comments", request.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_request_comments")
        .select("*")
        .eq("request_id", request.id)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as FrComment[];
    },
  });

  const history = useQuery({
    queryKey: ["feature-requests", "history", request.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_request_status_history")
        .select("*")
        .eq("request_id", request.id)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as FrHistory[];
    },
  });

  const people = useQuery({
    queryKey: ["feature-requests", "people"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("user_id, full_name");
      if (error) throw error;
      const map = new Map<string, string>();
      for (const p of data ?? []) map.set(p.user_id, personLabel(p));
      return map;
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["feature-requests"] });

  const addComment = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("feature_request_comments")
        .insert({ request_id: request.id, author: userId, body: comment.trim() });
      if (error) throw error;
    },
    onSuccess: () => {
      setComment("");
      invalidate();
    },
    onError: (error) => toastDbError(error, { action: "add comment" }),
  });

  const patch = useMutation({
    mutationFn: async (values: Partial<FeatureRequest>) => {
      const { error } = await supabase
        .from("feature_requests")
        .update(values as never)
        .eq("id", request.id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(),
    onError: (error) => toastDbError(error, { action: "update request" }),
  });

  const vote = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      if (voters.has(userId)) {
        const { error } = await supabase
          .from("feature_request_votes")
          .delete()
          .eq("request_id", request.id)
          .eq("user_id", userId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("feature_request_votes")
          .insert({ request_id: request.id, user_id: userId });
        if (error) throw error;
      }
    },
    onSuccess: () => invalidate(),
    onError: (error) => toastDbError(error, { action: "vote" }),
  });

  const catLabel = categoryLabel(categories.data ?? [], request.category);
  const duplicateTargets = allRequests.filter((r) => r.id !== request.id && !r.duplicate_of);
  const duplicateOf = allRequests.find((r) => r.id === request.duplicate_of) ?? null;

  const copy = async () => {
    await navigator.clipboard.writeText(detailsText(request, catLabel));
    toast.success("Details copied");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={request.status} />
            <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] uppercase">
              {catLabel}
            </Badge>
            {request.priority && (
              <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] uppercase">
                {FR_PRIORITY_LABEL[request.priority]}
              </Badge>
            )}
            {duplicateOf && (
              <span className="text-[11px] text-muted-foreground">
                Duplicate of “{duplicateOf.title}”
              </span>
            )}
          </div>
          <DialogTitle className="text-[16px] leading-snug">{request.title}</DialogTitle>
          <p className="text-[12px] text-muted-foreground">
            {submitterLine(request)} · {formatDate(request.created_at)}
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
            {request.description.trim() || "No detail was written."}
          </p>

          {request.status === "dismissed" && request.dismissed_reason && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[12px]">
              <span className="font-medium">Dismissed:</span> {request.dismissed_reason}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={userId && voters.has(userId) ? "default" : "outline"}
              disabled={writesDisabled || vote.isPending}
              onClick={() => vote.mutate()}
            >
              <ThumbsUp className="mr-1.5 size-3.5" />
              {voters.size} {voters.size === 1 ? "vote" : "votes"}
            </Button>
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="mr-1.5 size-3.5" />
              Copy details
            </Button>
          </div>

          <section className="space-y-1.5">
            <h3 className="label-caps text-muted-foreground">Attachments</h3>
            {(attachments.data ?? []).length === 0 ? (
              <EmptyLine className="px-0">No screenshots or files attached.</EmptyLine>
            ) : (
              <AttachmentThumbs
                attachments={attachments.data ?? []}
                max={20}
                onOpen={setLightbox}
              />
            )}
          </section>

          {canManage && (
            <section className="space-y-2 rounded-md border p-2.5">
              <h3 className="label-caps text-muted-foreground">Manage</h3>
              {writesDisabled ? (
                <p className="text-[12px] text-muted-foreground">
                  {writesReason ?? "Writes are disabled."}
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-[11px]">Status</Label>
                    <Select
                      value={request.status}
                      onValueChange={(v) => {
                        const next = v as FrStatus;
                        if (next === "dismissed") {
                          toast.info("Add a reason below, then dismiss.");
                          return;
                        }
                        patch.mutate({ status: next });
                      }}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FR_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {FR_STATUS_LABEL[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-[11px]">Priority</Label>
                    <Select
                      value={request.priority ?? "__none"}
                      onValueChange={(v) =>
                        patch.mutate({ priority: v === "__none" ? null : (v as FrPriority) })
                      }
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Not set" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Not set</SelectItem>
                        {FR_PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {FR_PRIORITY_LABEL[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-[11px]">Dismiss with a reason</Label>
                    <div className="flex gap-1.5">
                      <Input
                        value={dismissReason}
                        onChange={(e) => setDismissReason(e.target.value)}
                        placeholder="Why this is not going ahead — the submitter is told"
                        className="h-8"
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={dismissReason.trim().length < 3 || patch.isPending}
                        onClick={() =>
                          patch.mutate({
                            status: "dismissed",
                            dismissed_reason: dismissReason.trim(),
                            dismissed_at: new Date().toISOString(),
                          })
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-[11px]">Mark as duplicate</Label>
                    <div className="flex gap-1.5">
                      <Select value={dupTarget} onValueChange={setDupTarget}>
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder="Choose the surviving request" />
                        </SelectTrigger>
                        <SelectContent>
                          {duplicateTargets.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!dupTarget || patch.isPending}
                        onClick={() => {
                          const target = allRequests.find((r) => r.id === dupTarget);
                          patch.mutate({
                            duplicate_of: dupTarget,
                            status: "dismissed",
                            dismissed_reason: `Duplicate of “${target?.title ?? "another request"}” — votes carried across.`,
                            dismissed_at: new Date().toISOString(),
                          });
                        }}
                      >
                        Merge
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="label-caps text-muted-foreground">
              Discussion {comments.data ? `(${comments.data.length})` : ""}
            </h3>
            {(comments.data ?? []).length === 0 ? (
              <EmptyLine className="px-0">No comments yet.</EmptyLine>
            ) : (
              <ul className="space-y-2">
                {(comments.data ?? []).map((c) => (
                  <li key={c.id} className="border-b pb-2 last:border-b-0">
                    <div className="text-[11px] text-muted-foreground">
                      {people.data?.get(c.author ?? "") ?? "Removed user"} ·{" "}
                      {formatDateTime(c.created_at)}
                    </div>
                    <p className="whitespace-pre-wrap text-[13px]">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-1.5">
              <Textarea
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add to the discussion"
              />
              <Button
                size="sm"
                disabled={comment.trim().length < 2 || addComment.isPending || writesDisabled}
                onClick={() => addComment.mutate()}
              >
                {addComment.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                Post
              </Button>
            </div>
          </section>

          <section className="space-y-1">
            <h3 className="label-caps text-muted-foreground">Status history</h3>
            {(history.data ?? []).length === 0 ? (
              <EmptyLine className="px-0">
                Submitted {formatDateTime(request.created_at)}. No status changes yet.
              </EmptyLine>
            ) : (
              <ul className="space-y-1 text-[12px]">
                {(history.data ?? []).map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-1.5">
                    <span className="tabular-nums text-muted-foreground">
                      {formatDateTime(h.created_at)}
                    </span>
                    <span>
                      {h.from_status ? `${FR_STATUS_LABEL[h.from_status]} → ` : ""}
                      {FR_STATUS_LABEL[h.to_status]}
                    </span>
                    <span className="text-muted-foreground">
                      {people.data?.get(h.changed_by ?? "") ?? "Removed user"}
                    </span>
                    {h.note && <span className="text-muted-foreground">· {h.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
      </DialogContent>
    </Dialog>
  );
}
