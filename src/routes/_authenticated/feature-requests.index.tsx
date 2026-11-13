import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, Plus, ThumbsUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import {
  AttachmentThumbs,
  FeatureRequestDetail,
  Lightbox,
  StatusBadge,
} from "@/components/feature-request-detail";
import {
  SuggestFeatureDialog,
  categoryLabel,
  useFrCategories,
} from "@/components/feature-request-form";
import { MetricStrip } from "@/components/metric-strip";
import { EmptyLine, LoadError, PageHeader } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FR_STATUSES,
  FR_STATUS_LABEL,
  excerpt,
  formatDate,
  submitterLine,
  voteIndex,
  type FeatureRequest,
  type FrAttachment,
  type FrStatus,
  type FrVote,
} from "@/lib/feature-requests";
import { cn } from "@/lib/utils";

type Search = {
  status: string;
  category: string;
  location: string;
  submitter: string;
  sort: string;
  request: string;
};

const str = (v: unknown, dflt: string) => (typeof v === "string" && v ? v : dflt);

export const Route = createFileRoute("/_authenticated/feature-requests/")({
  validateSearch: (raw: Record<string, unknown>): Search => ({
    status: str(raw["status"], "all"),
    category: str(raw["category"], "all"),
    location: str(raw["location"], "all"),
    submitter: str(raw["submitter"], "all"),
    sort: str(raw["sort"], "newest"),
    request: str(raw["request"], ""),
  }),
  head: () => ({
    meta: [
      { title: "Feature requests · Recovery Hub" },
      {
        name: "description",
        content:
          "Shared board where Gold Star staff raise ideas and problems, attach screenshots, vote and track what happens next.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: FeatureRequestsPage,
});

function FeatureRequestsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { userId } = useAppContext();
  const categories = useFrCategories();
  const [suggestOpen, setSuggestOpen] = React.useState(false);
  const [lightbox, setLightbox] = React.useState<FrAttachment | null>(null);

  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (prev: Search) => ({ ...prev, ...patch }) });

  const requests = useQuery({
    queryKey: ["feature-requests", "list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_requests")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as FeatureRequest[];
    },
  });

  const votes = useQuery({
    queryKey: ["feature-requests", "votes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_request_votes")
        .select("request_id, user_id");
      if (error) throw error;
      return (data ?? []) as FrVote[];
    },
  });

  const attachments = useQuery({
    queryKey: ["feature-requests", "attachments-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_request_attachments")
        .select("*")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as FrAttachment[];
    },
  });

  const commentCounts = useQuery({
    queryKey: ["feature-requests", "comment-counts"],
    queryFn: async () => {
      const { data, error } = await supabase.from("feature_request_comments").select("request_id");
      if (error) throw error;
      const map = new Map<string, number>();
      for (const row of data ?? []) {
        map.set(row.request_id, (map.get(row.request_id) ?? 0) + 1);
      }
      return map;
    },
  });

  const all = requests.data ?? [];
  const voteMap = React.useMemo(() => voteIndex(all, votes.data ?? []), [all, votes.data]);
  const attachmentsByRequest = React.useMemo(() => {
    const map = new Map<string, FrAttachment[]>();
    for (const a of attachments.data ?? []) {
      const list = map.get(a.request_id) ?? [];
      list.push(a);
      map.set(a.request_id, list);
    }
    return map;
  }, [attachments.data]);

  const submitters = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const r of all) {
      if (r.submitted_by) map.set(r.submitted_by, r.submitter_name ?? "Unnamed");
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  const locations = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const r of all) {
      if (r.submitter_location_id) {
        map.set(r.submitter_location_id, r.submitter_location_name ?? "Office");
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const s of FR_STATUSES) c[s] = all.filter((r) => r.status === s).length;
    return c;
  }, [all]);

  const filtered = React.useMemo(() => {
    let list = all.filter((r) => {
      if (search.status !== "all" && r.status !== search.status) return false;
      if (search.category !== "all" && r.category !== search.category) return false;
      if (search.location !== "all" && r.submitter_location_id !== search.location) return false;
      if (search.submitter !== "all" && r.submitted_by !== search.submitter) return false;
      return true;
    });
    if (search.sort === "votes") {
      list = [...list].sort(
        (a, b) => (voteMap.get(b.id)?.size ?? 0) - (voteMap.get(a.id)?.size ?? 0),
      );
    } else if (search.sort === "status") {
      list = [...list].sort(
        (a, b) => FR_STATUSES.indexOf(a.status) - FR_STATUSES.indexOf(b.status),
      );
    }
    return list;
  }, [all, search, voteMap]);

  const open = all.find((r) => r.id === search.request) ?? null;
  const cats = categories.data ?? [];

  return (
    <div className="px-3 pb-8 md:px-4">
      <PageHeader title="Feature requests" count={all.length ? `${all.length}` : undefined}>
        <Button size="sm" onClick={() => setSuggestOpen(true)}>
          <Plus className="mr-1.5 size-3.5" />
          Suggest a feature
        </Button>
      </PageHeader>

      <MetricStrip
        className="mt-2"
        metrics={[
          { label: "Total", value: counts["all"] ?? 0 },
          { label: "New", value: counts["new"] ?? 0 },
          { label: "Reviewed", value: counts["reviewed"] ?? 0 },
          { label: "Planned", value: counts["planned"] ?? 0 },
          { label: "Completed", value: counts["completed"] ?? 0, tone: "success" },
          { label: "Dismissed", value: counts["dismissed"] ?? 0 },
        ]}
      />

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {(["all", ...FR_STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSearch({ status: s })}
            className={cn(
              "h-7 rounded-md border px-2 text-[12px]",
              search.status === s ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent",
            )}
          >
            {s === "all" ? "All" : FR_STATUS_LABEL[s as FrStatus]}
            <span className="ml-1 tabular-nums text-muted-foreground">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Select value={search.category} onValueChange={(v) => setSearch({ category: v })}>
          <SelectTrigger className="h-8 w-[160px] text-[12px]">
            <SelectValue placeholder="Area" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {cats.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={search.location} onValueChange={(v) => setSearch({ location: v })}>
          <SelectTrigger className="h-8 w-[170px] text-[12px]">
            <SelectValue placeholder="Office" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All offices</SelectItem>
            {locations.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={search.submitter} onValueChange={(v) => setSearch({ submitter: v })}>
          <SelectTrigger className="h-8 w-[170px] text-[12px]">
            <SelectValue placeholder="Submitter" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {submitters.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={search.sort} onValueChange={(v) => setSearch({ sort: v })}>
          <SelectTrigger className="h-8 w-[150px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="votes">Most voted</SelectItem>
            <SelectItem value="status">By status</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 space-y-2">
        {requests.isError ? (
          <LoadError
            what="feature requests"
            error={requests.error}
            onRetry={() => requests.refetch()}
          />
        ) : requests.isLoading ? (
          <EmptyLine className="px-0">Loading…</EmptyLine>
        ) : all.length === 0 ? (
          <EmptyLine className="px-0">
            Nothing has been raised yet. If something slows you down in the field or the office,{" "}
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => setSuggestOpen(true)}
            >
              be the first to raise it
            </button>
            .
          </EmptyLine>
        ) : filtered.length === 0 ? (
          <EmptyLine className="px-0">No requests match these filters.</EmptyLine>
        ) : (
          filtered.map((r) => {
            const voters = voteMap.get(r.id) ?? new Set<string>();
            const atts = attachmentsByRequest.get(r.id) ?? [];
            return (
              <article
                key={r.id}
                className="cursor-pointer rounded-md border p-2.5 hover:bg-accent/40"
                onClick={() => setSearch({ request: r.id })}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={r.status} />
                      <Badge
                        variant="outline"
                        className="h-5 rounded-md px-1.5 text-[10px] uppercase"
                      >
                        {categoryLabel(cats, r.category)}
                      </Badge>
                    </div>
                    <h2 className="mt-1 text-[14px] font-medium leading-snug">{r.title}</h2>
                    {r.description.trim() && (
                      <p className="mt-0.5 text-[12px] text-muted-foreground">
                        {excerpt(r.description)}
                      </p>
                    )}
                    {r.status === "dismissed" && r.dismissed_reason && (
                      <p className="mt-1 text-[12px] text-destructive">
                        Dismissed: {r.dismissed_reason}
                      </p>
                    )}
                    {atts.length > 0 && (
                      <div
                        className="mt-1.5"
                        onClick={(e) => e.stopPropagation()}
                        role="presentation"
                      >
                        <AttachmentThumbs attachments={atts} onOpen={setLightbox} />
                      </div>
                    )}
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      {submitterLine(r)} · {formatDate(r.created_at)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
                    <span className="flex items-center gap-1 tabular-nums">
                      <MessageSquare className="size-3.5" />
                      {commentCounts.data?.get(r.id) ?? 0}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1 rounded-md border px-1.5 py-1 tabular-nums",
                        userId && voters.has(userId) && "border-primary text-primary",
                      )}
                    >
                      <ThumbsUp className="size-3.5" />
                      {voters.size}
                    </span>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>

      <SuggestFeatureDialog open={suggestOpen} onOpenChange={setSuggestOpen} />
      <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
      {open && (
        <FeatureRequestDetail
          request={open}
          allRequests={all}
          voters={voteMap.get(open.id) ?? new Set<string>()}
          onClose={() => setSearch({ request: "" })}
        />
      )}
    </div>
  );
}
