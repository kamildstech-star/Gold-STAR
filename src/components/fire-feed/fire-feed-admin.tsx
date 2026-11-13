import { useState, type ComponentType } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, Play, Plus, Trash2 } from "lucide-react";
import {
  FireFeedCallDialog,
  type FireFeedCallView,
} from "@/components/fire-feed/fire-feed-call-dialog";

import { CommitInput } from "@/components/commit-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LoadError } from "@/components/ui-density";
import { useWritesDisabled } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { SKIP_REASON_LABEL, type SkipReason } from "@/lib/fire-feed/decide";
import {
  addArea,
  addRssFeed,
  deleteArea,
  deleteSource,
  loadFireFeedAdmin,
  normaliseState,
  parseZipList,
  saveFireFeedConfig,
  updateArea,
  updateSource,
  type AdminItem,
  type AdminRun,
  type AdminSource,
} from "@/lib/fire-feed/fire-feed-admin";
import {
  fireFeedCapabilities,
  runFireFeedNow,
  type FireFeedRunNowResult,
} from "@/lib/fire-feed/fire-feed.functions";
import type { WatchArea } from "@/lib/fire-feed/types";

const KEY = ["fire-feed-admin"] as const;

/**
 * Extra panels a later source kind brings with it (the public incident page
 * source adds its own), found by file name like the sources themselves, so
 * this screen never has to be edited to show them.
 */
const PANELS = Object.entries(
  import.meta.glob<{ default: ComponentType<{ areas: WatchArea[]; onChange: () => void }> }>(
    "./*.panel.tsx",
    {
      eager: true,
    },
  ),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, m]) => m.default)
  .filter(Boolean);

const MERGE_REASON: Record<string, string> = {
  same_address: "Same address as a fire already on file",
  same_point: "Same building as a fire already on file",
  same_town: "Same town, same hours, as a fire already on file",
  database_duplicate: "The database's own duplicate check",
};

function reasonLabel(decision: string, reason: string | null): string {
  if (!reason) return decision === "lead" ? "New lead" : "";
  if (decision === "merged") return MERGE_REASON[reason] ?? reason;
  return SKIP_REASON_LABEL[reason as SkipReason] ?? reason;
}

/** A feed's link is shown only when it is a web address — never javascript: or data:. */
function safeHref(url: string | null | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

function ago(ts: string | null): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

function skippedLine(skipped: Record<string, number>): string {
  const parts = Object.entries(skipped ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${(SKIP_REASON_LABEL[k as SkipReason] ?? k).toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "none";
}

/**
 * Settings › Sales › Fire feed.
 *
 * Mark: "we need to make a feed that crawls google and x for fires in certain
 * areas and gathers those and can implement it into the program in place of
 * bnn", then "I don't want to pay API fees." This is that feed's control
 * room: the on/off switch and the last runs, the towns it watches, the free
 * sources it reads, and every item it decided about with the reason. Leads
 * it creates go to the chase deck exactly like any other alert.
 */
export function FireFeedAdmin() {
  const qc = useQueryClient();
  const screen = useQuery({ queryKey: KEY, queryFn: loadFireFeedAdmin, refetchInterval: 60_000 });
  const caps = useQuery({
    queryKey: ["fire-feed-capabilities"],
    queryFn: () => fireFeedCapabilities(),
    staleTime: 300_000,
  });
  const { disabled } = useWritesDisabled();
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });

  async function save(write: () => Promise<void>, what: string): Promise<boolean> {
    try {
      await write();
      refresh();
      return true;
    } catch (err) {
      if (err instanceof Error && !("code" in err)) toast.error(err.message);
      else toastDbError(err, { action: what });
      return false;
    }
  }

  if (screen.isError)
    return (
      <LoadError what="the fire feed" error={screen.error} onRetry={() => void screen.refetch()} />
    );
  if (screen.isLoading || !screen.data)
    return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  if (!screen.data.migrated) {
    return (
      <Card>
        <CardContent className="space-y-1 p-3 text-sm">
          <p className="font-medium">The fire feed is not set up on this database yet.</p>
          <p className="text-muted-foreground">
            Its tables arrive with migration 20261011140000. Until it is applied nothing runs, and
            the chase deck keeps working exactly as it does today.
          </p>
        </CardContent>
      </Card>
    );
  }

  const data = screen.data;
  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-muted-foreground">
        Gold Star&rsquo;s own fire alerts, in place of BNN: free, published sources only — Google
        News&rsquo;s RSS feed, RSS feeds from fire departments and local papers, and public
        government incident pages. Nothing here scrapes google.com or x.com, logs in anywhere or
        pays per call. A structure fire inside a watch area becomes an incident in the chase deck,
        through the same path BNN&rsquo;s alerts use; anything else is listed below with the reason
        it was skipped.
      </p>
      <StatusCard
        enabled={data.config.enabled}
        rawConfig={data.rawConfig}
        config={data.config}
        runs={data.runs}
        caps={caps.data ?? null}
        disabled={disabled}
        save={save}
        onRan={refresh}
      />
      <AreasCard areas={data.areas} disabled={disabled} save={save} />
      <SourcesCard
        sources={data.sources}
        areas={data.areas}
        kinds={caps.data?.kinds ?? null}
        disabled={disabled}
        save={save}
      />
      {PANELS.map((Panel, i) => (
        <Panel key={i} areas={data.areas} onChange={refresh} />
      ))}
      <ItemsCard items={data.items} areas={data.areas} />
    </div>
  );
}

type Save = (write: () => Promise<void>, what: string) => Promise<boolean>;

/* ---------------------------------------------------------------- status -- */

function StatusCard({
  enabled,
  rawConfig,
  config,
  runs,
  caps,
  disabled,
  save,
  onRan,
}: {
  enabled: boolean;
  rawConfig: unknown;
  config: { requireStreetAddress: boolean; useAi: boolean; maxAgeHours: number };
  runs: AdminRun[];
  caps: { aiConfigured: boolean; googleGeocoding: boolean } | null;
  disabled: boolean;
  save: Save;
  onRan: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FireFeedRunNowResult | null>(null);
  const last = runs[0] ?? null;
  const lastLive = runs.find((r) => !r.dry_run) ?? null;

  async function runNow() {
    setRunning(true);
    try {
      const r = await runFireFeedNow();
      setResult(r);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      onRan();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 p-3">
        <CardTitle className="text-sm">Fire feed status</CardTitle>
        <label className="flex items-center gap-2 text-sm">
          <span className={enabled ? "font-medium text-success" : "text-muted-foreground"}>
            {enabled ? "On" : "Off"}
          </span>
          <Switch
            checked={enabled}
            disabled={disabled}
            aria-label="Fire feed on or off"
            onCheckedChange={(v) =>
              void save(() => saveFireFeedConfig(rawConfig, { enabled: v }), "switch the fire feed")
            }
          />
        </label>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-0 text-sm">
        {!enabled && (
          <p className="rounded border border-warning/30 bg-warning/10 p-2 text-xs">
            Off — nothing is fetched on the schedule and nothing reaches the chase deck. &ldquo;Run
            now&rdquo; does a dry run: it reads every source and shows what it would do, and writes
            nothing.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-xs text-muted-foreground">Last run</div>
            {last ? (
              <div>
                {ago(last.started_at)} · <RunStatus run={last} />
                {last.dry_run ? " (dry run)" : ""}
              </div>
            ) : (
              <div>Never run</div>
            )}
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Last live run</div>
            {lastLive ? (
              <div>
                {lastLive.leads_created} new lead{lastLive.leads_created === 1 ? "" : "s"} ·{" "}
                {lastLive.merged} merged · {lastLive.new_items} new items read
              </div>
            ) : (
              <div>None yet</div>
            )}
          </div>
        </div>
        {last && (
          <div className="space-y-1 text-xs">
            <div>
              <span className="text-muted-foreground">Skipped: </span>
              {skippedLine(last.skipped)}
            </div>
            {Object.values(last.fetched ?? {}).map((f, i) => (
              <div key={i}>
                <span className="text-muted-foreground">{f.label}: </span>
                {f.items} item{f.items === 1 ? "" : "s"}
                {f.error ? <span className="text-destructive"> · {f.error}</span> : null}
              </div>
            ))}
            {last.extractor?.ai_error && (
              <div className="text-warning">AI: {last.extractor.ai_error}</div>
            )}
            {(last.errors ?? []).slice(0, 5).map((e, i) => (
              <div key={i} className="text-destructive">
                {e}
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">
            {caps == null
              ? "Checking AI…"
              : caps.aiConfigured
                ? "AI reading on (Lovable gateway)"
                : "AI not configured — rules only"}
          </Badge>
          <Badge variant="outline">
            {caps == null
              ? "Checking geocoder…"
              : caps.googleGeocoding
                ? "Geocoding: Google"
                : "Geocoding: OpenStreetMap (free)"}
          </Badge>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex items-center justify-between gap-2 rounded border p-2 text-xs">
            <span>Read items with AI</span>
            <Switch
              checked={config.useAi}
              disabled={disabled}
              onCheckedChange={(v) =>
                void save(() => saveFireFeedConfig(rawConfig, { use_ai: v }), "change AI reading")
              }
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded border p-2 text-xs">
            <span>Require a street address</span>
            <Switch
              checked={config.requireStreetAddress}
              disabled={disabled}
              onCheckedChange={(v) =>
                void save(
                  () => saveFireFeedConfig(rawConfig, { require_street_address: v }),
                  "change the address rule",
                )
              }
            />
          </label>
          <label className="flex items-center justify-between gap-2 rounded border p-2 text-xs">
            <span>Ignore reports older than (hours)</span>
            <CommitInput
              className="h-7 w-16"
              inputMode="numeric"
              value={String(config.maxAgeHours)}
              disabled={disabled}
              onCommit={async (v) => {
                const n = Number(v);
                if (!Number.isFinite(n) || n < 1 || n > 168) {
                  toast.error("Between 1 and 168 hours.");
                  return false;
                }
                return save(
                  () => saveFireFeedConfig(rawConfig, { max_age_hours: Math.round(n) }),
                  "change the age limit",
                );
              }}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          A report that names only a town still becomes a lead, marked for review, unless a street
          address is required. Leads route to a market by ZIP like every alert; a ZIP no zone covers
          goes to admin, as Territory decides.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={running || disabled}
          onClick={() => void runNow()}
        >
          <Play className="mr-1 size-3.5" />
          {running ? "Running…" : enabled ? "Run now" : "Dry run now"}
        </Button>
        {result && result.decisions.length > 0 && (
          <DecisionList decisions={result.decisions} dryRun={result.dryRun} />
        )}
      </CardContent>
    </Card>
  );
}

function RunStatus({ run }: { run: AdminRun }) {
  const tone =
    run.status === "ok"
      ? "text-success"
      : run.status === "failed"
        ? "text-destructive"
        : run.status === "partial"
          ? "text-warning"
          : "";
  const label = { ok: "OK", partial: "Partly failed", failed: "Failed", running: "Running" }[
    run.status
  ];
  return <span className={tone}>{label}</span>;
}

function DecisionList({
  decisions,
  dryRun,
}: {
  decisions: FireFeedRunNowResult["decisions"];
  dryRun: boolean;
}) {
  const [open, setOpen] = useState<FireFeedCallView | null>(null);
  return (
    <div className="max-h-72 overflow-auto rounded border">
      <FireFeedCallDialog call={open} onOpenChange={(o) => !o && setOpen(null)} />
      <div className="sticky top-0 bg-muted px-2 py-1 text-xs font-medium">
        {dryRun ? "What this dry run would have done" : "What this run did"}
      </div>
      <ul className="divide-y text-xs">
        {decisions.map((d) => (
          <li key={d.key} className="flex items-start gap-2 px-2 py-1">
            <DecisionBadge decision={d.decision} />
            <div className="min-w-0 flex-1">
              <div className="truncate">
                {/* Details in a pop-up, not the source page (4 Nov). */}
                <button
                  type="button"
                  className="max-w-full truncate text-left hover:underline"
                  onClick={() =>
                    setOpen({
                      title: d.title,
                      source: d.source_kind,
                      at: null,
                      url: safeHref(d.url) ?? null,
                      decision: d.decision,
                      reason: d.reason,
                      area: d.area,
                    })
                  }
                >
                  {d.title}
                </button>
              </div>
              <div className="text-muted-foreground">
                {reasonLabel(d.decision, d.reason)}
                {d.area ? ` · ${d.area}` : ""}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: "lead" | "merged" | "skipped" }) {
  const cls =
    decision === "lead"
      ? "bg-success/15 text-success border-success/30"
      : decision === "merged"
        ? "bg-primary/10 text-primary border-primary/30"
        : "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`shrink-0 ${cls}`}>
      {decision === "lead" ? "Lead" : decision === "merged" ? "Merged" : "Skipped"}
    </Badge>
  );
}

/* ----------------------------------------------------------------- areas -- */

function AreasCard({
  areas,
  disabled,
  save,
}: {
  areas: WatchArea[];
  disabled: boolean;
  save: Save;
}) {
  const [form, setForm] = useState({ locality: "", county: "", state: "", zips: "", radius: "15" });
  const [busy, setBusy] = useState(false);
  const active = areas.filter((a) => a.active).length;

  return (
    <Card>
      <CardHeader className="p-3">
        <CardTitle className="text-sm">
          Watch areas{" "}
          <span className="font-normal text-muted-foreground">
            · {active} of {areas.length} on
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        <p className="text-xs text-muted-foreground">
          The towns to watch. Each office&rsquo;s town was added with a 15-mile radius around the
          office. A fire counts when it falls inside the radius, or in one of the area&rsquo;s ZIP
          codes when you list them. Adding the county makes the news search wider.
        </p>
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">Town</th>
                <th className="py-1 pr-2">County</th>
                <th className="py-1 pr-2">State</th>
                <th className="py-1 pr-2">ZIP codes</th>
                <th className="py-1 pr-2">Radius (mi)</th>
                <th className="py-1 pr-2">On</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {areas.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="py-1 pr-2">
                    <CommitInput
                      value={a.locality}
                      disabled={disabled}
                      placeholder="Town"
                      onCommit={(v) =>
                        save(
                          () =>
                            updateArea(a.id, {
                              locality: v || null,
                              label: `${v || a.county || a.label}, ${a.state}`,
                            }),
                          "rename the area",
                        )
                      }
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <CommitInput
                      value={a.county}
                      disabled={disabled}
                      placeholder="e.g. Ocean"
                      onCommit={(v) =>
                        save(
                          () => updateArea(a.id, { county: v.replace(/\s+county$/i, "") || null }),
                          "set the county",
                        )
                      }
                    />
                  </td>
                  <td className="w-16 py-1 pr-2">
                    <CommitInput
                      value={a.state}
                      disabled={disabled}
                      onCommit={(v) =>
                        save(
                          async () => updateArea(a.id, { state: normaliseState(v) }),
                          "set the state",
                        )
                      }
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <CommitInput
                      value={a.postal_codes.join(", ")}
                      disabled={disabled}
                      placeholder="optional"
                      onCommit={(v) =>
                        save(
                          async () => updateArea(a.id, { postal_codes: parseZipList(v) }),
                          "set the ZIP codes",
                        )
                      }
                    />
                  </td>
                  <td className="w-20 py-1 pr-2">
                    <CommitInput
                      value={String(a.radius_miles)}
                      disabled={disabled}
                      inputMode="decimal"
                      onCommit={(v) => {
                        const n = Number(v);
                        if (!Number.isFinite(n) || n <= 0 || n > 100) {
                          toast.error("Radius is between 1 and 100 miles.");
                          return Promise.resolve(false);
                        }
                        return save(() => updateArea(a.id, { radius_miles: n }), "set the radius");
                      }}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <Switch
                      checked={a.active}
                      disabled={disabled}
                      aria-label={`Watch ${a.label}`}
                      onCheckedChange={(v) =>
                        void save(() => updateArea(a.id, { active: v }), "switch the area")
                      }
                    />
                  </td>
                  <td className="py-1 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={`Remove ${a.label}`}
                      onClick={() => {
                        if (window.confirm(`Stop watching ${a.label} and remove it?`))
                          void save(() => deleteArea(a.id), "remove the area");
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {areas.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-2 text-xs text-muted-foreground">
                    No watch areas. Add a town below; the feed does nothing until one is on.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <form
          className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_2fr_1fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = await save(() => addArea(form), "add the area");
            setBusy(false);
            if (ok)
              setForm({ locality: "", county: "", state: form.state, zips: "", radius: "15" });
          }}
        >
          <Input
            className="h-8"
            placeholder="Town"
            value={form.locality}
            onChange={(e) => setForm({ ...form, locality: e.target.value })}
          />
          <Input
            className="h-8"
            placeholder="County (optional)"
            value={form.county}
            onChange={(e) => setForm({ ...form, county: e.target.value })}
          />
          <Input
            className="h-8"
            placeholder="NJ"
            maxLength={2}
            value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value })}
          />
          <Input
            className="h-8"
            placeholder="ZIPs (optional)"
            value={form.zips}
            onChange={(e) => setForm({ ...form, zips: e.target.value })}
          />
          <Input
            className="h-8"
            placeholder="Miles"
            inputMode="decimal"
            value={form.radius}
            onChange={(e) => setForm({ ...form, radius: e.target.value })}
          />
          <Button type="submit" size="sm" disabled={busy || disabled}>
            <Plus className="mr-1 size-3.5" />
            Add
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          A new town has no center point, so it counts fires in that town by name, or in its ZIP
          codes if you list them.
        </p>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- sources -- */

function SourcesCard({
  sources,
  areas,
  kinds,
  disabled,
  save,
}: {
  sources: AdminSource[];
  areas: WatchArea[];
  kinds: string[] | null;
  disabled: boolean;
  save: Save;
}) {
  const [form, setForm] = useState({ label: "", url: "", poll: "10", publisher: "" });
  const [busy, setBusy] = useState(false);
  const google = sources.filter((s) => s.kind === "google_news");
  const feeds = sources.filter((s) => s.kind === "rss");
  const others = sources.filter((s) => s.kind !== "google_news" && s.kind !== "rss");

  return (
    <Card>
      <CardHeader className="p-3">
        <CardTitle className="text-sm">Sources</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-0 text-sm">
        {google.map((s) => (
          <div key={s.id} className="space-y-1 rounded border p-2">
            <SourceRow source={s} areas={areas} disabled={disabled} save={save} canDelete={false} />
            <p className="text-xs text-muted-foreground">
              One search per watch area for fire stories from the last day, through the RSS feed
              Google publishes (news.google.com/rss) — not google.com search, which forbids
              automated use.{" "}
              <span className="text-warning">
                Google&rsquo;s notice on that feed says it is for personal, non-commercial use in a
                feed reader. Whether Gold Star relies on it is Gold Star&rsquo;s decision; switch it
                off here to use only the feeds below.
              </span>
            </p>
          </div>
        ))}

        <div className="space-y-2">
          <div className="text-xs font-medium">RSS / Atom feeds</div>
          <p className="text-xs text-muted-foreground">
            Fire department alert feeds, a local paper&rsquo;s breaking news, or a county 911
            center&rsquo;s incident feed. Public feeds only — paste the feed&rsquo;s own address.
          </p>
          {feeds.map((s) => (
            <div key={s.id} className="rounded border p-2">
              <SourceRow source={s} areas={areas} disabled={disabled} save={save} canDelete />
            </div>
          ))}
          <form
            className="grid gap-2 sm:grid-cols-[2fr_3fr_1fr_auto]"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const ok = await save(() => addRssFeed(form), "add the feed");
              setBusy(false);
              if (ok) setForm({ label: "", url: "", poll: "10", publisher: "" });
            }}
          >
            <Input
              className="h-8"
              placeholder="Name (e.g. Lakewood FD)"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <Input
              className="h-8"
              placeholder="https://…/feed.xml"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
            <Input
              className="h-8"
              placeholder="Every … min"
              inputMode="numeric"
              value={form.poll}
              onChange={(e) => setForm({ ...form, poll: e.target.value })}
            />
            <Button type="submit" size="sm" disabled={busy || disabled}>
              <Plus className="mr-1 size-3.5" />
              Add feed
            </Button>
          </form>
        </div>

        {others.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium">Other sources</div>
            {others.map((s) => (
              <div key={s.id} className="rounded border p-2">
                <SourceRow source={s} areas={areas} disabled={disabled} save={save} canDelete />
                {kinds && !kinds.includes(s.kind) && (
                  <p className="mt-1 text-xs text-warning">
                    This build has no reader for &ldquo;{s.kind}&rdquo; sources yet, so the feed
                    skips this row.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SourceRow({
  source: s,
  areas,
  disabled,
  save,
  canDelete,
}: {
  source: AdminSource;
  areas: WatchArea[];
  disabled: boolean;
  save: Save;
  canDelete: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Switch
        checked={s.enabled}
        disabled={disabled}
        aria-label={`Read ${s.label}`}
        onCheckedChange={(v) =>
          void save(() => updateSource(s.id, { enabled: v }), "switch the source")
        }
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{s.label}</div>
        {safeHref(s.url) && (
          <a
            href={safeHref(s.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-xs text-muted-foreground hover:underline"
          >
            {s.url}
          </a>
        )}
        <div className="text-xs text-muted-foreground">
          Last checked {ago(s.last_fetched_at)}
          {s.last_error ? (
            <span className="text-destructive"> · {s.last_error}</span>
          ) : s.last_fetched_at ? (
            " · OK"
          ) : (
            ""
          )}
          {s.area_id ? ` · only ${areas.find((a) => a.id === s.area_id)?.label ?? "one area"}` : ""}
          {s.url && /^http:\/\//i.test(s.url) ? (
            <span className="text-warning"> · not encrypted (http)</span>
          ) : null}
        </div>
        {typeof s.config?.note === "string" && s.config.note.trim() && (
          <div className="text-xs italic text-muted-foreground">{s.config.note}</div>
        )}
      </div>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        every
        <CommitInput
          className="h-7 w-14"
          inputMode="numeric"
          value={String(s.poll_minutes)}
          disabled={disabled}
          onCommit={(v) => {
            const n = Math.round(Number(v));
            if (!Number.isFinite(n) || n < 2 || n > 1440) {
              toast.error("Every 2 to 1440 minutes.");
              return Promise.resolve(false);
            }
            return save(
              () => updateSource(s.id, { poll_minutes: n }),
              "change how often it is checked",
            );
          }}
        />
        min
      </label>
      {canDelete && (
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          aria-label={`Remove ${s.label}`}
          onClick={() => {
            if (
              window.confirm(`Remove ${s.label}? Leads it already created stay in the chase deck.`)
            )
              void save(() => deleteSource(s.id), "remove the source");
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- items -- */

function ItemsCard({ items, areas }: { items: AdminItem[]; areas: WatchArea[] }) {
  const [filter, setFilter] = useState<"all" | "lead" | "merged" | "skipped">("all");
  const shown = items.filter((i) => filter === "all" || i.decision === filter);
  const areaName = (id: string | null) =>
    id ? (areas.find((a) => a.id === id)?.label ?? null) : null;
  const [openItem, setOpenItem] = useState<FireFeedCallView | null>(null);
  return (
    <Card>
      <FireFeedCallDialog call={openItem} onOpenChange={(o) => !o && setOpenItem(null)} />
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 p-3">
        <CardTitle className="text-sm">Recent items</CardTitle>
        <div className="flex gap-1">
          {(["all", "lead", "merged", "skipped"] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "lead" ? "Leads" : f === "merged" ? "Merged" : "Skipped"}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {shown.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing yet. Items appear here after the first live run.
          </p>
        ) : (
          <ul className="divide-y text-xs">
            {shown.map((i) => (
              <li key={i.id} className="flex items-start gap-2 py-1.5">
                <DecisionBadge decision={i.decision} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    {/* Details in a pop-up, not the source page (4 Nov). */}
                    <button
                      type="button"
                      className="max-w-full truncate text-left hover:underline"
                      onClick={() =>
                        setOpenItem({
                          title: i.title ?? i.url ?? "(untitled)",
                          source: i.publisher ?? i.source_kind,
                          at: i.published_at ?? i.created_at,
                          url: safeHref(i.url) ?? null,
                          decision: i.decision,
                          reason: i.reason,
                          area: areaName(i.area_id),
                          extraction: (i.extraction ?? null) as FireFeedCallView["extraction"],
                          readBy: i.extracted_by,
                        })
                      }
                    >
                      {i.title ?? i.url ?? "(untitled)"}
                    </button>
                  </div>
                  <div className="text-muted-foreground">
                    {[
                      i.publisher,
                      reasonLabel(i.decision, i.reason),
                      areaName(i.area_id),
                      i.extracted_by === "ai"
                        ? "read by AI"
                        : i.extracted_by === "rules"
                          ? "read by rules"
                          : null,
                      ago(i.created_at),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
