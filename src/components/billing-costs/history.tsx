import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Download, Filter, PanelRightOpen } from "lucide-react";

import { Pager, usePaged } from "@/components/billing-costs/pager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadError } from "@/components/ui-density";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTimeUS } from "@/lib/date-format";
import {
  AUDIT_BOOKS,
  AUDIT_BOOK_LABEL,
  CHANGE_LOG_LIMIT,
  auditFields,
  auditKind,
  auditSummary,
  auditValue,
  auditWhat,
  changeLogCsv,
  loadChangeLog,
  loadItemHistory,
  loadPeople,
  type AuditBook,
  type AuditEntry,
} from "@/lib/money-history";
import { cn } from "@/lib/utils";

/**
 * The clock on a row: that item's history at the office being viewed (or
 * everywhere) — who, old → new, when, office, note. Loads when opened.
 */
export function HistoryButton({
  book,
  itemKey,
  label,
  office,
  officeName,
}: {
  book: AuditBook;
  itemKey: string;
  label: string;
  /** undefined = every office. */
  office?: string | null;
  officeName?: (id: string | null) => string;
}) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["billing-costs", "history", book, itemKey, office ?? "all"],
    queryFn: async () => {
      const entries = await loadItemHistory({ book, key: itemKey, office });
      const people = await loadPeople(entries.map((e) => e.changed_by ?? ""));
      return { entries, people };
    },
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 text-muted-foreground md:h-8 md:w-8"
          aria-label={`History of ${label}`}
          title="History"
        >
          <Clock aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,26rem)] p-0" align="end">
        <p className="border-b px-3 py-2 text-sm font-medium">History — {label}</p>
        <div className="max-h-80 overflow-y-auto">
          {q.isLoading && <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>}
          {q.isError && (
            <p className="px-3 py-3 text-sm text-destructive">History could not be read.</p>
          )}
          {q.data && q.data.entries.length === 0 && (
            <p className="px-3 py-3 text-sm text-muted-foreground">No changes recorded.</p>
          )}
          <ol className="divide-y">
            {q.data?.entries.map((e) => (
              <HistoryLine
                key={e.id}
                e={e}
                who={e.changed_by ? (q.data.people.get(e.changed_by) ?? "Someone") : "System"}
                office={officeName?.(e.office_id) ?? (e.office_id ? "Office" : "Company default")}
              />
            ))}
          </ol>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function HistoryLine({ e, who, office }: { e: AuditEntry; who: string; office: string }) {
  return (
    <li className="space-y-0.5 px-3 py-2 text-sm">
      <p className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="font-medium">{auditWhat(e)}</span>
        <span className="text-xs text-muted-foreground">{formatDateTimeUS(e.changed_at)}</span>
      </p>
      <p className="tabular-nums">{auditSummary(e)}</p>
      <p className="text-xs text-muted-foreground">
        {who} · {office}
        {e.note ? <> · “{e.note}”</> : null}
      </p>
    </li>
  );
}

/**
 * Billing & Costs › Change log: every money change the viewer may read,
 * filtered by person, dates, book and office, exportable as CSV.
 */
export function ChangeLogTab() {
  const officesQ = useQuery({
    queryKey: ["billing-costs", "change-log", "offices"],
    queryFn: async () => {
      const { data } = await supabase.from("locations").select("id, name").order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const offices = useMemo(() => officesQ.data ?? [], [officesQ.data]);
  const [person, setPerson] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [books, setBooks] = useState<string[]>([]);
  const [office, setOffice] = useState<string>("all");
  const filter = {
    person: person === "all" ? null : person,
    from: from || null,
    to: to || null,
    books: books as AuditBook[],
    office: office === "all" ? null : office,
  };
  const q = useQuery({
    queryKey: ["billing-costs", "change-log", filter],
    queryFn: async () => {
      const log = await loadChangeLog(filter);
      const people = await loadPeople(log.entries.map((e) => e.changed_by ?? ""));
      return { ...log, people };
    },
  });
  // Everyone who appears in the unfiltered-by-person log, for the person filter.
  const peopleQ = useQuery({
    queryKey: ["billing-costs", "change-log", "people"],
    queryFn: async () => {
      const { data } = await supabase
        .from("money_audit_log" as never)
        .select("changed_by")
        .not("changed_by", "is", null)
        .limit(2000);
      return loadPeople(((data ?? []) as { changed_by: string }[]).map((r) => r.changed_by));
    },
  });
  const paged = usePaged(q.data?.entries ?? [], JSON.stringify(filter));
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const officeNames = useMemo(() => new Map(offices.map((o) => [o.id, o.name])), [offices]);
  const officeName = (id: string | null) =>
    id ? (officeNames.get(id) ?? "Office") : "Company default";

  function exportCsv() {
    if (!q.data) return;
    const csv = changeLogCsv(q.data.entries, q.data.people, officeNames);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `billing-costs-change-log-${new Date().toLocaleDateString("en-CA")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filtered = person !== "all" || from || to || books.length > 0 || office !== "all";
  return (
    <div className="space-y-3" data-change-log>
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" aria-hidden />
        <Select value={person} onValueChange={setPerson}>
          <SelectTrigger className="h-11 w-full sm:w-48 md:h-8" aria-label="Person">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {[...(peopleQ.data ?? new Map<string, string>()).entries()]
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-11 w-40 md:h-8"
            aria-label="From date"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-11 w-40 md:h-8"
            aria-label="To date"
          />
        </label>
        <MultiSelect
          options={AUDIT_BOOKS.map((b) => ({ value: b, label: AUDIT_BOOK_LABEL[b] }))}
          value={books}
          onChange={setBooks}
          emptyLabel="Every book"
          noun="book"
          pluralNoun="books"
          allLabel="Every book"
          ariaLabel="Book"
          className="h-11 md:h-8"
        />
        <Select value={office} onValueChange={setOffice}>
          <SelectTrigger className="h-11 w-full sm:w-48 md:h-8" aria-label="Office">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every office</SelectItem>
            <SelectItem value="default">Company default</SelectItem>
            {offices.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered && (
          <Button
            variant="ghost"
            className="h-11 md:h-8"
            onClick={() => {
              setPerson("all");
              setFrom("");
              setTo("");
              setBooks([]);
              setOffice("all");
            }}
          >
            Clear
          </Button>
        )}
        <Button
          variant="outline"
          className="h-11 sm:ml-auto md:h-8"
          onClick={exportCsv}
          disabled={!q.data?.entries.length}
        >
          <Download aria-hidden /> Export CSV
        </Button>
      </div>

      {q.isError ? (
        <LoadError what="the change log" error={q.error} />
      ) : q.isLoading || !q.data ? (
        <p className="p-3 text-sm text-muted-foreground">Loading the change log…</p>
      ) : (
        <Card className="max-md:border-0 max-md:bg-transparent max-md:shadow-none">
          <CardContent className="p-0">
            <div className="hidden md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 border-b bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[9.5rem_8rem_5.5rem_minmax(0,0.8fr)_minmax(0,1.7fr)_8rem] md:gap-3 md:px-3 md:py-2">
              <span>When</span>
              <span>Who</span>
              <span>Book</span>
              <span>Item</span>
              <span>Change</span>
              <span>Office</span>
            </div>
            {q.data.entries.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {filtered ? "No changes match these filters." : "No changes you can see yet."}
              </p>
            )}
            <ol className="space-y-2 md:space-y-0 md:divide-y">
              {paged.rows.map((e) => (
                <li
                  key={e.id}
                  className="space-y-1 rounded-lg border p-3 text-sm md:grid md:grid-cols-[9.5rem_8rem_5.5rem_minmax(0,0.8fr)_minmax(0,1.7fr)_8rem] md:gap-3 md:space-y-0 md:rounded-none md:border-0 md:px-3 md:py-2"
                >
                  <span className="block text-xs text-muted-foreground md:text-sm">
                    {formatDateTimeUS(e.changed_at)}
                  </span>
                  <span className="block truncate">
                    {e.changed_by ? (q.data.people.get(e.changed_by) ?? "Someone") : "System"}
                  </span>
                  <span>
                    <Badge variant="outline">{AUDIT_BOOK_LABEL[e.book] ?? e.book}</Badge>
                  </span>
                  <span className="block min-w-0">
                    <span className="font-mono text-xs">{e.entity_key}</span>{" "}
                    <span className="text-muted-foreground">{auditWhat(e)}</span>
                  </span>
                  <ChangeCell e={e} onOpen={() => setOpen(e)} />
                  <span className="block text-xs text-muted-foreground md:text-sm">
                    {officeName(e.office_id)}
                  </span>
                </li>
              ))}
            </ol>
            <Pager paged={paged} noun="changes" className="md:border-t" />
            {q.data.truncated && (
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                Showing the latest {CHANGE_LOG_LIMIT}. Narrow the dates to see older changes.
              </p>
            )}
          </CardContent>
        </Card>
      )}
      <ChangeDialog
        e={open}
        who={open?.changed_by ? (q.data?.people.get(open.changed_by) ?? "Someone") : "System"}
        office={open ? officeName(open.office_id) : ""}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------ one change */

const KIND_BADGE = {
  added: { label: "Added", variant: "success" },
  removed: { label: "Removed", variant: "destructive" },
  changed: { label: "Edited", variant: "default" },
} as const;

/** The Change column: what happened in one or two readable lines, and Details. */
function ChangeCell({ e, onOpen }: { e: AuditEntry; onOpen: () => void }) {
  const record = auditFields(e) !== null;
  const kind = KIND_BADGE[auditKind(e)];
  return (
    <span className="block min-w-0">
      <span className="flex min-w-0 items-start gap-1.5">
        {record && (
          <Badge variant={kind.variant} className="mt-0.5 shrink-0">
            {kind.label}
          </Badge>
        )}
        <span className="line-clamp-2 min-w-0 tabular-nums" title={auditSummary(e)}>
          {auditSummary(e)}
        </span>
      </span>
      {e.note && (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={e.note}>
          “{e.note}”
        </span>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="mt-0.5 inline-flex items-center gap-1 rounded text-xs font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:min-h-11"
        aria-label={`Details of ${auditWhat(e)} ${e.entity_key}`}
      >
        <PanelRightOpen className="h-3.5 w-3.5" aria-hidden /> Details
      </button>
    </span>
  );
}

/** Everything about one change: who, when, where, why, and field by field. */
function ChangeDialog({
  e,
  who,
  office,
  onClose,
}: {
  e: AuditEntry | null;
  who: string;
  office: string;
  onClose: () => void;
}) {
  const fields = e ? auditFields(e) : null;
  const kind = e ? auditKind(e) : "changed";
  const changed = fields?.filter((f) => f.changed) ?? [];
  const same = fields?.filter((f) => !f.changed) ?? [];
  return (
    <Dialog open={!!e} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-change-details>
        {e && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {auditWhat(e)}
                <span className="font-mono text-sm font-normal text-muted-foreground">
                  {e.entity_key}
                </span>
              </DialogTitle>
              <DialogDescription>{auditSummary(e)}</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">When</dt>
              <dd>{formatDateTimeUS(e.changed_at)}</dd>
              <dt className="text-muted-foreground">Who</dt>
              <dd>{who}</dd>
              <dt className="text-muted-foreground">Book</dt>
              <dd>{AUDIT_BOOK_LABEL[e.book] ?? e.book}</dd>
              <dt className="text-muted-foreground">Office</dt>
              <dd>{office}</dd>
              {e.note && (
                <>
                  <dt className="text-muted-foreground">Note</dt>
                  <dd>“{e.note}”</dd>
                </>
              )}
            </dl>
            {fields ? (
              <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Field</th>
                      {kind !== "added" && (
                        <th className="px-3 py-2 text-left font-medium">Before</th>
                      )}
                      {kind !== "removed" && (
                        <th className="px-3 py-2 text-left font-medium">
                          {kind === "added" ? "Value" : "After"}
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {[...changed, ...same].map((f, i) => (
                      <tr
                        key={f.key}
                        className={cn(
                          kind === "changed" && !f.changed && "text-muted-foreground",
                          kind === "changed" &&
                            i === changed.length &&
                            changed.length > 0 &&
                            "border-t-2",
                        )}
                      >
                        <th className="px-3 py-1.5 text-left font-medium">{f.label}</th>
                        {kind !== "added" && (
                          <td
                            className={cn(
                              "px-3 py-1.5 break-words",
                              kind === "changed" &&
                                f.changed &&
                                "text-muted-foreground line-through",
                            )}
                          >
                            {f.old}
                          </td>
                        )}
                        {kind !== "removed" && (
                          <td
                            className={cn(
                              "px-3 py-1.5 break-words",
                              kind === "changed" && f.changed && "font-semibold",
                            )}
                          >
                            {f.new}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Before</p>
                  <p className="mt-1 tabular-nums">{auditValue(e.old_value)}</p>
                </div>
                <div className="rounded-md border p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">After</p>
                  <p className="mt-1 font-semibold tabular-nums">{auditValue(e.new_value)}</p>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
