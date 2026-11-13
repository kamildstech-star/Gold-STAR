import { createFileRoute } from "@tanstack/react-router";
import { OpenRecordButton } from "@/components/open-record-button";
import { activityHasTarget } from "@/lib/activity-open";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  Download,
  History as HistoryIcon,
  Loader2,
  Search,
  ShieldAlert,
  Zap,
} from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { isPrivileged } from "@/lib/roles";
import { useExportGate } from "@/lib/export-guard";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn } from "@/lib/export-table";
import {
  ACTIVITY_MODULES,
  MODULE_LABEL,
  activityCsv,
  changePair,
  fetchActivity,
  type ActivityEntry,
} from "@/lib/activity";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({
    meta: [
      { title: "Activity history — Recovery Hub" },
      {
        name: "description",
        content:
          "Every recorded action across the system in one feed: edits, stage changes, sign-ins, sends, payments, automations and admin changes.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: HistoryPage,
});

const RANGES: { key: string; label: string; days: number }[] = [
  { key: "1", label: "Last 24 hours", days: 1 },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "365", label: "Last year", days: 365 },
];

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** Same columns as `activityCsv`, typed so the timestamp sorts as a date in Excel. */
const ACTIVITY_COLUMNS: ExportColumn<ActivityEntry>[] = [
  { key: "occurred_at", label: "Timestamp", get: (r) => r.occurred_at, type: "datetime" },
  { key: "module", label: "Module", get: (r) => MODULE_LABEL[r.module] ?? r.module },
  { key: "event_type", label: "Event", get: (r) => r.event_type },
  { key: "via", label: "Via", get: (r) => r.via },
  { key: "user", label: "User", get: (r) => r.actor_name ?? r.actor_id ?? "" },
  { key: "summary", label: "Summary", get: (r) => r.summary },
  { key: "record_type", label: "Record type", get: (r) => r.record_type },
  { key: "record_id", label: "Record id", get: (r) => r.record_id },
  { key: "record", label: "Record", get: (r) => r.record_label },
  { key: "detail", label: "Detail", get: (r) => JSON.stringify(r.detail ?? {}) },
];

function HistoryPage() {
  const app = useAppContext();
  const exporter = useExportGate();

  const [rangeKey, setRangeKey] = useState("7");
  const [module, setModule] = useState<string>("all");
  const [eventType, setEventType] = useState<string>("all");
  const [actor, setActor] = useState<string>("all");
  const [location, setLocation] = useState<string>("all");
  const [recordId, setRecordId] = useState("");
  const [search, setSearch] = useState("");

  const allowed = isPrivileged(app.realRoles);

  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[2]!;
  const from = useMemo(() => isoDaysAgo(range.days), [range.days]);

  const peopleQ = useQuery({
    queryKey: ["history-people"],
    enabled: allowed,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const feedQ = useQuery({
    queryKey: ["global-activity", from, module, eventType, actor, location, recordId, search],
    enabled: allowed,
    queryFn: () =>
      fetchActivity({
        from,
        to: new Date().toISOString(),
        modules: module === "all" ? [] : [module],
        eventTypes: eventType === "all" ? [] : [eventType],
        actor: actor === "all" ? null : actor,
        location: location === "all" ? null : location,
        record: /^[0-9a-f-]{36}$/i.test(recordId.trim()) ? recordId.trim() : null,
        search,
        limit: 400,
      }),
  });

  const rows = feedQ.data ?? [];

  // Event types come from what is actually in the current window, so the list
  // never offers a filter that would return nothing.
  const eventTypes = useMemo(() => {
    const set = new Set<string>(rows.map((r) => r.event_type));
    if (eventType !== "all") set.add(eventType);
    return [...set].sort();
  }, [rows, eventType]);

  async function doExport() {
    await exporter.runExport({
      surface: "history",
      entity: "activity",
      recordCount: rows.length,
      filters: { from, module, eventType, actor, location, search },
      download: () => {
        const blob = new Blob([activityCsv(rows)], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      },
    });
  }

  if (!allowed) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="flex items-start gap-3 py-8">
            <ShieldAlert className="mt-0.5 size-5 text-destructive" />
            <div>
              <div className="font-semibold">Not available</div>
              <p className="text-sm text-muted-foreground">
                Activity history crosses every location and includes financial data. It is limited
                to Admins and Owners.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <HistoryIcon className="size-5 text-muted-foreground" />
        <h1 className="display-heavy text-lg">Activity history</h1>
        <span className="text-sm text-muted-foreground">
          {feedQ.isLoading ? "loading…" : `${rows.length} entries`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!exporter.allowed || rows.length === 0}
            title={exporter.reason ?? undefined}
            onClick={doExport}
          >
            <Download className="mr-1.5 size-3.5" />
            CSV
          </Button>
          <ExportExcelButton
            report="activity"
            surface="history"
            entity="activity"
            filters={{ from, module, eventType, actor, location, search }}
            sheets={[{ name: "Activity", rows, columns: ACTIVITY_COLUMNS }]}
          />
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-3 py-4 md:grid-cols-3 lg:grid-cols-6">
          <div className="md:col-span-3 lg:col-span-2">
            <Label className="text-xs">Search</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
              <Input
                className="pl-7"
                placeholder="Text, values, record names…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">Date range</Label>
            <Select value={rangeKey} onValueChange={setRangeKey}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Module</Label>
            <Select value={module} onValueChange={setModule}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {ACTIVITY_MODULES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODULE_LABEL[m] ?? m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Event</Label>
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All events</SelectItem>
                {eventTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">User</Label>
            <Select value={actor} onValueChange={setActor}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Anyone</SelectItem>
                {(peopleQ.data ?? []).map((p) => (
                  <SelectItem key={p.user_id} value={p.user_id}>
                    {p.full_name ?? p.user_id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Location</Label>
            <Select value={location} onValueChange={setLocation}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                {app.allLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-2">
            <Label className="text-xs">Record id</Label>
            <Input
              placeholder="Paste a record id to see only its history"
              value={recordId}
              onChange={(e) => setRecordId(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {feedQ.isError ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {(feedQ.error as Error).message}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {feedQ.isLoading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading activity…
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Nothing recorded for these filters.
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((e, i) => (
                <EntryRow key={`${e.occurred_at}-${i}`} entry={e} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EntryRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const link = activityHasTarget(entry);
  const pair = changePair(entry.detail);
  const when = new Date(entry.occurred_at);

  return (
    <li className="px-3 py-2 hover:bg-muted/40">
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-36 shrink-0 text-xs tabular-nums text-muted-foreground">
          {when.toLocaleString("en-US")}
        </div>
        <Badge variant="outline" className="shrink-0 text-[11px]">
          {MODULE_LABEL[entry.module] ?? entry.module}
        </Badge>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium">{entry.summary}</span>
            {entry.via === "assistant" ? (
              <Badge variant="secondary" className="gap-1 text-[11px]">
                <Bot className="size-3" /> Assistant
              </Badge>
            ) : null}
            {entry.via === "automation" ? (
              <Badge variant="secondary" className="gap-1 text-[11px]">
                <Zap className="size-3" /> Automation
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{entry.actor_name ?? (entry.via === "user" ? "Unknown user" : "System")}</span>
            <span>·</span>
            <span className="font-mono">{entry.event_type}</span>
            {link ? (
              <>
                <span>·</span>
                <OpenRecordButton
                  entry={entry}
                  className="text-primary hover:underline disabled:opacity-60"
                >
                  {entry.record_label ?? "Open record"}
                </OpenRecordButton>
              </>
            ) : entry.record_label ? (
              <>
                <span>·</span>
                <span>{entry.record_label}</span>
              </>
            ) : null}
          </div>
          {pair ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="rounded bg-muted px-1.5 py-0.5 line-through opacity-70">
                {pair.before}
              </span>
              <ArrowRight className="size-3 text-muted-foreground" />
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{pair.after}</span>
            </div>
          ) : null}
          {open ? (
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">
              {JSON.stringify(entry.detail ?? {}, null, 2)}
            </pre>
          ) : null}
        </div>
        {entry.detail && Object.keys(entry.detail).length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "Details"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
