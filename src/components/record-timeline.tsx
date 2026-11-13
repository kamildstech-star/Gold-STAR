import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Bot,
  Camera,
  CheckCircle2,
  DollarSign,
  FileText,
  GitBranch,
  Mail,
  Package,
  Phone,
  Search,
  StickyNote,
  Users,
  Wrench,
} from "lucide-react";

import { JobFieldEditRow } from "@/components/job-field-revert-row";
import { HistoryTimelineRow } from "@/components/record-history-restore";
import { OpenRecordButton } from "@/components/open-record-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  changePair,
  fetchRecordActivity,
  RECORD_ACTIVITY_GROUPS,
  recordActivityGroup,
  VIA_LABEL,
  type ActivityEntry,
  type RecordActivityType,
} from "@/lib/activity";
import {
  fetchJobFieldChanges,
  fieldEditHeadline,
  fieldLabel,
  fieldValueLabel,
  groupFieldChanges,
  withFieldEdits,
} from "@/lib/job-field-revert";
import {
  buildHistoryItems,
  fetchJobHistory,
  historySearchText,
  mergeTimeline,
} from "@/lib/record-history";

const GROUP_ICON: Record<string, typeof Activity> = {
  notes: StickyNote,
  fields: GitBranch,
  status: GitBranch,
  crew: Users,
  photos: Camera,
  documents: FileText,
  billing: DollarSign,
  money: DollarSign,
  time: CheckCircle2,
  equipment: Wrench,
  supplies: Package,
  tasks: CheckCircle2,
  comms: Mail,
  calls: Phone,
  automation: Bot,
  other: Activity,
};

/**
 * The full audit trail for one record — every action by anyone, drawn from the
 * `record_activity` feed (the same trails the global History view reads).
 *
 * On a job it also carries the job's delete and edit history
 * (`record_history`), each entry with its Restore or Revert — Mark: "in
 * timeline have a restore button for each item that gets removed or
 * changed". Until that migration is applied the history read comes back
 * empty and the Timeline is exactly what it was.
 *
 * The job's own field changes are grouped per save with a Revert
 * (`job_field_changes`, migration 20261006152000). Until that one is applied
 * the feed's plain "Field … changed" rows stay as they are.
 */
export function RecordTimeline({
  type,
  id,
  emptyLabel = "Nothing on the timeline yet.",
}: {
  type: RecordActivityType;
  id: string;
  emptyLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string>("all");
  const [jumpTo, setJumpTo] = useState("");

  const q = useQuery({
    queryKey: ["record-activity", type, id],
    queryFn: () => fetchRecordActivity(type, id),
  });
  const history = useQuery({
    queryKey: ["record-history", id],
    queryFn: () => fetchJobHistory(id),
    enabled: type === "job",
  });

  const fieldChanges = useQuery({
    queryKey: ["job-field-changes", id],
    queryFn: () => fetchJobFieldChanges(id),
    enabled: type === "job",
  });
  const names = useMemo(
    () => ({
      people: fieldChanges.data?.people ?? {},
      stages: fieldChanges.data?.stages ?? {},
    }),
    [fieldChanges.data],
  );

  const items = useMemo(() => {
    const merged = mergeTimeline(q.data ?? [], buildHistoryItems(history.data?.rows ?? []));
    if (!fieldChanges.data?.available) return merged;
    return withFieldEdits(merged, groupFieldChanges(fieldChanges.data.rows));
  }, [q.data, history.data, fieldChanges.data]);

  const rows = useMemo(() => {
    let list = items;
    if (group !== "all") {
      list = list.filter((it) =>
        it.kind === "history"
          ? group === "history"
          : it.kind === "field"
            ? group === "fields"
            : recordActivityGroup(it.entry) === group,
      );
    }
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((it) =>
        it.kind === "field"
          ? [
              fieldEditHeadline(it.edit, names.people[it.edit.actorId ?? ""] ?? null),
              ...it.edit.changes.flatMap((c) => [
                fieldLabel(c.field),
                fieldValueLabel(c.field, c.before, names),
                fieldValueLabel(c.field, c.after, names),
              ]),
            ]
              .join(" ")
              .toLowerCase()
              .includes(term)
          : it.kind === "history"
            ? historySearchText(it.entry).includes(term)
            : [
                it.entry.summary,
                it.entry.event_type,
                it.entry.actor_name,
                it.entry.record_label,
                JSON.stringify(it.entry.detail ?? {}),
              ]
                .join(" ")
                .toLowerCase()
                .includes(term),
      );
    }
    if (jumpTo) list = list.filter((it) => it.at.slice(0, 10) <= jumpTo);
    return list;
  }, [items, group, search, jumpTo, names]);

  const groups = useMemo(() => {
    const present = new Set(
      items.map((it) =>
        it.kind === "history"
          ? "history"
          : it.kind === "field"
            ? "fields"
            : recordActivityGroup(it.entry),
      ),
    );
    return RECORD_ACTIVITY_GROUPS.filter((g) => present.has(g.key));
  }, [items]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search history"
            className="h-8 pl-7 text-[13px]"
          />
        </div>
        <Select value={group} onValueChange={setGroup}>
          <SelectTrigger className="h-8 w-[170px] text-[13px]">
            <SelectValue placeholder="All activity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All activity</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.key} value={g.key}>
                {g.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={jumpTo}
          onChange={(e) => setJumpTo(e.target.value)}
          className="h-8 w-[150px] text-[13px]"
          title="Jump to date"
        />
        {(search || group !== "all" || jumpTo) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={() => {
              setSearch("");
              setGroup("all");
              setJumpTo("");
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        {rows.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">
            {q.isLoading ? "Loading…" : q.error ? "Couldn't load the history." : emptyLabel}
          </div>
        )}
        {rows.map((it, i) =>
          it.kind === "field" ? (
            <JobFieldEditRow key={`field-${it.edit.id}`} edit={it.edit} names={names} />
          ) : it.kind === "history" ? (
            <HistoryTimelineRow key={`history-${it.entry.id}`} entry={it.entry} />
          ) : (
            <TimelineRow key={`${it.entry.event_type}-${it.at}-${i}`} entry={it.entry} />
          ),
        )}
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: ActivityEntry }) {
  const Icon = GROUP_ICON[recordActivityGroup(entry)] ?? Activity;
  const change = changePair(entry.detail);
  const via = entry.via && entry.via !== "user" ? (VIA_LABEL[entry.via] ?? entry.via) : null;

  return (
    <div className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap text-[13px]">{entry.summary}</div>
        {change && (
          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <span className="line-through">{change.before}</span>
            <ArrowRight className="size-3" />
            <span className="text-foreground">{change.after}</span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{entry.actor_name ?? (via ? "" : "System")}</span>
          {via && <span className="italic">{via}</span>}
          <OpenRecordButton entry={entry} />
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {new Date(entry.occurred_at).toLocaleString("en-US")}
      </span>
    </div>
  );
}

/** Collapsible "History" card for record pages that have no timeline tab. */
export function RecordHistoryCard({
  type,
  id,
  title = "History",
}: {
  type: RecordActivityType;
  id: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          {title}
        </span>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="border-t p-2">
          <RecordTimeline type={type} id={id} emptyLabel="No recorded activity yet." />
        </div>
      )}
    </div>
  );
}
