import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Star, Image as ImageIcon, Camera, FolderKanban } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { JOB_LOSS_LABELS, type JobLossType } from "@/lib/jobs";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { signStoredFile } from "@/lib/signed-url";

type ProjectRow = {
  id: string;
  name: string;
  address: string;
  locality: string | null;
  loss_type: JobLossType;
  status: "active" | "archived";
  location_id: string;
  updated_at: string;
  created_at: string;
};

type Filter = "all" | "starred" | "mine" | "archived";

export const Route = createFileRoute("/_authenticated/projects/")({
  head: () => ({
    meta: [
      { title: "Pictures · Recovery Hub" },
      {
        name: "description",
        content: "Photo-documented projects at loss sites — every element shot for the insurer.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>) => ({
    f: (typeof raw.f === "string" ? raw.f : "all") as Filter,
    q: typeof raw.q === "string" ? raw.q : "",
  }),
  component: ProjectsBoard,
});

function ProjectsBoard() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [mineIds, setMineIds] = useState<Set<string>>(new Set());
  const [photoCounts, setPhotoCounts] = useState<Record<string, number>>({});
  const [thumbs, setThumbs] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [qDraft, setQDraft] = useState(search.q);

  useEffect(() => setQDraft(search.q), [search.q]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      let q = supabase
        .from("projects")
        .select("id,name,address,locality,loss_type,status,location_id,updated_at,created_at")
        .order("updated_at", { ascending: false })
        .limit(200);
      if (search.f === "archived") q = q.eq("status", "archived");
      else q = q.eq("status", "active");
      if (search.q.trim())
        q = q.or(`name.ilike.%${search.q.trim()}%,address.ilike.%${search.q.trim()}%`);
      const { data } = await q;
      const list = (data ?? []) as ProjectRow[];

      const [stars, mine] = await Promise.all([
        app.viewerUserId
          ? supabase.from("project_stars").select("project_id").eq("user_id", app.viewerUserId)
          : Promise.resolve({ data: [] as { project_id: string }[] }),
        app.viewerUserId
          ? supabase.from("project_members").select("project_id").eq("user_id", app.viewerUserId)
          : Promise.resolve({ data: [] as { project_id: string }[] }),
      ]);
      setStarred(new Set((stars.data ?? []).map((s) => s.project_id)));
      setMineIds(new Set((mine.data ?? []).map((m) => m.project_id)));
      setRows(list);
      setLoading(false);

      // Counts + last 4 thumb paths per project (in parallel batches).
      if (list.length > 0) {
        const ids = list.map((r) => r.id);
        const { data: photos } = await supabase
          .from("photos")
          .select("id,project_id,captured_at,created_at")
          .in("project_id", ids)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1000);
        const byProj: Record<string, string[]> = {};
        const counts: Record<string, number> = {};
        for (const p of photos ?? []) {
          counts[p.project_id] = (counts[p.project_id] ?? 0) + 1;
          const arr = byProj[p.project_id] ?? (byProj[p.project_id] = []);
          if (arr.length < 4) arr.push(p.id);
        }
        setPhotoCounts(counts);
        // Fetch thumb variants for the ids we picked.
        const allIds = Object.values(byProj).flat();
        if (allIds.length > 0) {
          const { data: vs } = await supabase
            .from("photo_variants")
            .select("photo_id,storage_path")
            .in("photo_id", allIds)
            .eq("variant", "thumb");
          const pathById = new Map((vs ?? []).map((v) => [v.photo_id, v.storage_path]));
          const paths: Record<string, string[]> = {};
          for (const [pid, phs] of Object.entries(byProj)) {
            paths[pid] = phs.map((id) => pathById.get(id)).filter(Boolean) as string[];
          }
          setThumbs(paths);
        }
      }
    })();
  }, [app.viewerUserId, search.f, search.q]);

  const filtered = useMemo(() => {
    if (search.f === "starred") return rows.filter((r) => starred.has(r.id));
    if (search.f === "mine") return rows.filter((r) => mineIds.has(r.id));
    return rows;
  }, [rows, starred, mineIds, search.f]);

  const update = (patch: Partial<{ f: Filter; q: string }>) =>
    navigate({ search: (prev: { f: Filter; q: string }) => ({ ...prev, ...patch }) });

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "starred", label: "Starred" },
    { key: "mine", label: "Mine" },
    { key: "archived", label: "Archived" },
  ];

  const starredCount = filtered.filter((p) => starred.has(p.id)).length;
  const totalPhotos = filtered.reduce((sum, p) => sum + (photoCounts[p.id] ?? 0), 0);

  return (
    <main className="mx-auto max-w-6xl space-y-3 px-3 py-4 sm:px-4">
      {/* The sidebar calls this "Pictures", so the page answers to the name
          that was clicked. The records underneath are still projects, which is
          what the count tile and the subtitle go on calling them. */}
      <PageHeader
        title="Pictures"
        subtitle={`${filtered.length.toLocaleString("en-US")} project${filtered.length === 1 ? "" : "s"}`}
      >
        <Button asChild size="sm">
          <Link to="/projects/new">
            <Plus className="mr-1.5 size-4" />
            New project
          </Link>
        </Button>
      </PageHeader>

      <MetricStrip
        metrics={[
          { label: "Projects", value: filtered.length.toLocaleString("en-US"), icon: FolderKanban },
          { label: "Starred", value: starredCount.toLocaleString("en-US"), icon: Star },
          { label: "Photos", value: totalPhotos.toLocaleString("en-US"), icon: Camera },
        ]}
      />

      <Card>
        <CardContent className="space-y-3 p-3 sm:p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") update({ q: qDraft });
              }}
              onBlur={() => {
                if (qDraft !== search.q) update({ q: qDraft });
              }}
              placeholder="Search by project name or address"
              className="h-11 pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {filters.map((f) => (
              <Button
                key={f.key}
                size="sm"
                variant={search.f === f.key ? "default" : "outline"}
                onClick={() => update({ f: f.key })}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="px-3 py-2.5 text-[13px] text-muted-foreground">Loading…</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="px-3 py-2.5 text-[13px] text-muted-foreground">
            No projects.{" "}
            <Link to="/projects/new" className="text-primary underline-offset-2 hover:underline">
              New project
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <ProjectCard
              key={p.id}
              row={p}
              starred={starred.has(p.id)}
              count={photoCounts[p.id] ?? 0}
              thumbs={thumbs[p.id] ?? []}
              onToggleStar={async () => {
                if (!app.userId) return;
                if (starred.has(p.id)) {
                  await supabase
                    .from("project_stars")
                    .delete()
                    .eq("project_id", p.id)
                    .eq("user_id", app.userId);
                  setStarred((prev) => {
                    const n = new Set(prev);
                    n.delete(p.id);
                    return n;
                  });
                } else {
                  await supabase
                    .from("project_stars")
                    .insert({ project_id: p.id, user_id: app.userId });
                  setStarred((prev) => new Set(prev).add(p.id));
                }
              }}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function ProjectCard({
  row,
  starred,
  count,
  thumbs,
  onToggleStar,
}: {
  row: ProjectRow;
  starred: boolean;
  count: number;
  thumbs: string[];
  onToggleStar: () => void;
}) {
  const [thumbUrls, setThumbUrls] = useState<string[]>([]);
  useEffect(() => {
    if (thumbs.length === 0) return;
    (async () => {
      const urls = await Promise.all(
        thumbs.map(async (path) => {
          const { data } = await signStoredFile(supabase, "project-photos", path);
          return data?.signedUrl ?? "";
        }),
      );
      setThumbUrls(urls.filter(Boolean));
    })();
  }, [thumbs.join(",")]);

  return (
    <Card className="overflow-hidden transition hover:">
      <Link to="/projects/$id" params={{ id: row.id }} className="block">
        <div className="grid aspect-[16/9] grid-cols-4 gap-px bg-muted">
          {thumbUrls.length === 0 ? (
            <div className="col-span-4 grid place-items-center">
              <ImageIcon className="size-8 text-muted-foreground/50" />
            </div>
          ) : (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-muted">
                {thumbUrls[i] ? (
                  <img
                    src={thumbUrls[i]}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : null}
              </div>
            ))
          )}
        </div>
      </Link>
      <CardContent className="space-y-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <Link to="/projects/$id" params={{ id: row.id }} className="min-w-0 flex-1">
            <div className="truncate font-semibold">{row.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.address}
              {row.locality ? `, ${row.locality}` : ""}
            </div>
          </Link>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={(e) => {
              e.preventDefault();
              onToggleStar();
            }}
          >
            <Star
              className={`size-4 ${starred ? "fill-[var(--brand-gold)] text-[var(--brand-gold)]" : ""}`}
            />
          </Button>
        </div>
        <div className="flex items-center justify-between text-xs">
          <Badge variant="secondary" className="text-[10px]">
            {JOB_LOSS_LABELS[row.loss_type] ?? row.loss_type}
          </Badge>
          <span className="tabular-nums text-muted-foreground">
            {count} photo{count === 1 ? "" : "s"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
