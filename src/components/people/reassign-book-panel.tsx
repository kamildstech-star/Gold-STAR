import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Search, Undo2, UserX, Users } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadError } from "@/components/ui-density";
import { companyOwnedNote } from "@/lib/account-ownership";
import { toastDbError } from "@/lib/db-errors";
import { ACCOUNT_STATUS_LABEL } from "@/lib/accounts";
import {
  REASSIGN_REASONS,
  REASSIGN_REASON_LABEL,
  batchAccountIds,
  listBatches,
  loadBook,
  loadBookTasks,
  loadHoldings,
  loadOffices,
  loadPeople,
  reassignBook,
  staleSix,
  type ReassignmentReason,
} from "@/lib/reassignment";
import {
  ALL,
  EMPTY_FILTER,
  allSelected,
  bookSizes,
  companyRows,
  departedHolders,
  describeTasks,
  deselectIds,
  filterBook,
  fmtDaysAgo,
  fmtValue,
  isTransferable,
  officeOptions,
  orderSources,
  personLabel,
  pruneSelection,
  rankTargets,
  reassignBlocked,
  selectIds,
  stageOptions,
  tasksForSelection,
  toggleId,
  transferableRows,
  type BookFilter,
} from "@/lib/reassign-book";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";
import { isPrivileged } from "@/lib/roles";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const REASSIGN_REASON_OPTS = optionsFrom(REASSIGN_REASONS, REASSIGN_REASON_LABEL);

/**
 * Reassign a book — formerly its own page (/reassign), now the Book tab of a
 * person on People (Melly, 6 Nov: one People area instead of three pages).
 * `initialFromId` opens it on that person's book.
 */
export function ReassignBookPanel({ initialFromId }: { initialFromId?: string } = {}) {
  const app = useAppContext();
  /*
   * This page moves whole books of accounts between reps, so it needs its
   * own guard: hiding it from the sidebar does not stop anyone typing the
   * URL, and the router only checks that you are signed in. The database
   * function applies the reassignment tables' own gate (`is_sales_lead`)
   * again on every call.
   */
  const allowed = isPrivileged(app.roles);
  const qc = useQueryClient();

  const [fromId, setFromId] = useState<string>(initialFromId ?? "");
  const [toId, setToId] = useState<string>("");
  const [reason, setReason] = useState<ReassignmentReason>("rep_departed");
  const [note, setNote] = useState("");
  const [differently, setDifferently] = useState("");
  const [moveTasks, setMoveTasks] = useState(true);
  const [filter, setFilter] = useState<BookFilter>(EMPTY_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Ids to select once the book for `fromId` has loaded — "reverse this slice". */
  const [pendingSelect, setPendingSelect] = useState<string[] | null>(null);

  const peopleQ = useQuery({
    queryKey: ["reassign-people"],
    queryFn: loadPeople,
    enabled: allowed,
  });
  const officesQ = useQuery({
    queryKey: ["reassign-offices"],
    queryFn: loadOffices,
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
  const holdingsQ = useQuery({
    queryKey: ["reassign-holdings"],
    queryFn: loadHoldings,
    enabled: allowed,
  });
  const bookQ = useQuery({
    queryKey: ["reassign-book", fromId],
    queryFn: () => loadBook(fromId),
    enabled: allowed && !!fromId,
  });
  const book = useMemo(() => bookQ.data ?? [], [bookQ.data]);
  const bookIds = useMemo(() => book.map((a) => a.id), [book]);
  const tasksQ = useQuery({
    queryKey: ["reassign-book-tasks", fromId, bookIds],
    queryFn: () => loadBookTasks(fromId, bookIds),
    enabled: allowed && !!fromId && bookIds.length > 0,
  });
  const batchesQ = useQuery({
    queryKey: ["reassign-batches"],
    queryFn: () => listBatches(10),
    enabled: allowed,
  });

  const people = useMemo(() => peopleQ.data ?? [], [peopleQ.data]);
  const sizes = useMemo(() => bookSizes(holdingsQ.data ?? []), [holdingsQ.data]);
  const officeLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of officesQ.data ?? []) m.set(o.id, o.code || o.name);
    return m;
  }, [officesQ.data]);
  const officeOf = (id: string | null | undefined) => (id ? (officeLabel.get(id) ?? null) : null);
  const nameOf = (id: string | null) => {
    const p = people.find((x) => x.user_id === id);
    return p ? personLabel(p) : (id?.slice(0, 8) ?? "—");
  };

  const departed = useMemo(() => departedHolders(people, sizes), [people, sizes]);
  const sources = useMemo(() => orderSources(people, sizes), [people, sizes]);
  const targets = useMemo(
    () => rankTargets(people, sizes, fromId || null, officeOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, sizes, fromId, officeLabel],
  );

  const visible = useMemo(() => filterBook(book, filter), [book, filter]);
  /*
   * Mark: "House accounts belong to the company rather than a rep." A book is
   * gathered here to be handed to whoever inherits it, and a company account
   * is not the departing rep's to hand on — so every count, every Select-all
   * and every checkbox on this page works off `movable`, not `visible`.
   *
   * They are still listed. Hiding them would leave the Sales Head with a book
   * of 40 where the profile says 43, and a departed rep still sitting on a
   * company account is real work somebody has to clear; a row that says so is
   * how they find out it is there.
   */
  const movable = useMemo(() => transferableRows(visible), [visible]);
  const heldBack = useMemo(() => companyRows(book), [book]);
  const offices = useMemo(() => officeOptions(book), [book]);
  const stages = useMemo(() => stageOptions(book), [book]);
  const stale = useMemo(() => new Set(staleSix(transferableRows(book)).map((a) => a.id)), [book]);
  const taskSummary = useMemo(
    () => tasksForSelection(tasksQ.data ?? [], selected),
    [tasksQ.data, selected],
  );

  // A slice that just moved is no longer in the book; drop it from the
  // selection. A pending "reverse" selection is applied once the book is in.
  useEffect(() => {
    if (!bookQ.data) return;
    if (pendingSelect) {
      const live = new Set(bookQ.data.map((a) => a.id));
      setSelected(new Set(pendingSelect.filter((id) => live.has(id))));
      setPendingSelect(null);
      return;
    }
    setSelected((s) => pruneSelection(s, bookQ.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookQ.data]);

  const pickSource = (id: string) => {
    setFromId(id);
    setSelected(new Set());
    setFilter(EMPTY_FILTER);
    if (toId === id) setToId("");
  };

  const blocked = reassignBlocked({
    fromId,
    toId,
    selectedCount: selected.size,
    reason,
    doDifferently: differently,
  });

  const submit = useMutation({
    mutationFn: async () => {
      if (blocked) throw new Error(blocked);
      return reassignBook({
        fromUserId: fromId,
        toUserId: toId,
        accountIds: [...selected],
        reason,
        reasonNote: note.trim() || null,
        doDifferently: differently.trim() || null,
        moveTasks,
      });
    },
    onSuccess: (r) => {
      const accounts = `${r.count} account${r.count === 1 ? "" : "s"}`;
      const tasks =
        r.tasksFound === 0
          ? "No open tasks were on them."
          : r.tasksMoved > 0
            ? `${r.tasksMoved} open task${r.tasksMoved === 1 ? "" : "s"} moved too${
                r.tasksCadenceMoved ? ` (${r.tasksCadenceMoved} cadence/automation)` : ""
              }.`
            : `${r.tasksFound} open task${r.tasksFound === 1 ? "" : "s"} left with ${
                r.fromName ?? "the previous rep"
              }.`;
      toast.success(`${accounts} moved to ${r.toName ?? nameOf(toId)}`, {
        description: `${tasks} The previous rep is on the timeline, so this can be reassigned back.`,
      });
      setSelected(new Set());
      setNote("");
      setDifferently("");
      void qc.invalidateQueries({ queryKey: ["reassign-book"] });
      void qc.invalidateQueries({ queryKey: ["reassign-book-tasks"] });
      void qc.invalidateQueries({ queryKey: ["reassign-holdings"] });
      void qc.invalidateQueries({ queryKey: ["reassign-batches"] });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (e) => toastDbError(e, { action: "Reassign book" }),
  });

  const reverse = useMutation({
    mutationFn: async (batch: { id: string; from_user_id: string; to_user_id: string }) => {
      const ids = await batchAccountIds(batch.id);
      return { ids, batch };
    },
    onSuccess: ({ ids, batch }) => {
      // Swap the direction and preselect what that slice moved; whatever has
      // since moved on again simply is not in the book and stays unselected.
      setPendingSelect(ids);
      setFromId(batch.to_user_id);
      setToId(batch.from_user_id);
      setFilter(EMPTY_FILTER);
      setReason("other");
      setNote(
        `Reversing the slice moved ${new Date().toLocaleDateString(DATE_LOCALE, US_DATE)} in error`,
      );
      toast.info(`Reversing: ${ids.length} account${ids.length === 1 ? "" : "s"} preselected`, {
        description: "Check the slice, then reassign it back.",
      });
    },
    onError: (e) => toastDbError(e, { action: "Load batch" }),
  });

  // Owners, admins and developers only. The person page drops the Book tab for
  // everyone else; this is the backstop, and it draws nothing.
  if (!allowed) return null;

  const fromPerson = people.find((p) => p.user_id === fromId) ?? null;
  const toTarget = targets.find((t) => t.person.user_id === toId) ?? null;
  const everyVisibleSelected = allSelected(selected, visible);
  const heldBackNote = companyOwnedNote(heldBack.length);
  const anyLoadError = peopleQ.error ?? holdingsQ.error ?? officesQ.error;

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-xs text-muted-foreground">
        When a salesperson leaves, their entire book comes here. Pick the rep, filter their accounts
        by office or stage, select a slice, choose who gets it and apply — then repeat for the next
        slice. Each move is written to the account's timeline with the previous rep named, so a
        mistake is undone by reassigning it back. Nothing is deleted.
      </p>

      {anyLoadError ? (
        <LoadError
          what="reps"
          error={anyLoadError}
          onRetry={() => {
            void peopleQ.refetch();
            void holdingsQ.refetch();
            void officesQ.refetch();
          }}
        />
      ) : null}

      {departed.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <UserX className="size-4 text-warning" /> Departed reps still holding accounts
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {departed.map(({ person, count }) => (
              <Button
                key={person.user_id}
                size="sm"
                variant={fromId === person.user_id ? "default" : "outline"}
                className="h-8"
                onClick={() => pickSource(person.user_id)}
              >
                {personLabel(person)}
                <Badge variant="secondary" className="ml-2 text-[10px] tabular-nums">
                  {count}
                </Badge>
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="size-4" /> Who
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <div>
            <Label className="text-xs">Whose book</Label>
            <Select value={fromId} onValueChange={pickSource}>
              <SelectTrigger>
                <SelectValue placeholder="Select a rep" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((p) => (
                  <SelectItem key={p.user_id} value={p.user_id}>
                    {personLabel(p)}
                    {p.is_active === false ? " · deactivated" : ""}
                    {sizes.get(p.user_id) ? ` · ${sizes.get(p.user_id)} accounts` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fromPerson?.is_active === false ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {personLabel(fromPerson)} is deactivated; their book is still here until it is
                reassigned.
              </p>
            ) : null}
          </div>
          <div className="hidden items-end pb-2 sm:flex">
            <ArrowRight className="size-4 text-muted-foreground" />
          </div>
          <div>
            <Label className="text-xs">This slice goes to</Label>
            <Select value={toId} onValueChange={setToId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a rep" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.person.user_id} value={t.person.user_id}>
                    {personLabel(t.person)}
                    {" · "}
                    {t.office ?? "no office"}
                    {" · "}
                    {t.count} account{t.count === 1 ? "" : "s"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {toTarget ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {toTarget.office ?? "No office"} · currently holds {toTarget.count} account
                {toTarget.count === 1 ? "" : "s"}
                {selected.size ? ` · ${toTarget.count + selected.size} after this slice` : ""}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {fromId ? (
        <Card>
          <CardHeader className="space-y-2 pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm">
                Book — {book.length} account{book.length === 1 ? "" : "s"}
                {visible.length !== book.length ? ` · ${visible.length} shown` : ""}
                {selected.size ? ` · ${selected.size} selected` : ""}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() =>
                    setSelected((s) =>
                      everyVisibleSelected
                        ? deselectIds(
                            s,
                            movable.map((a) => a.id),
                          )
                        : selectIds(
                            s,
                            movable.map((a) => a.id),
                          ),
                    )
                  }
                  disabled={movable.length === 0}
                >
                  {everyVisibleSelected ? "Deselect" : "Select"} all in filter ({movable.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => setSelected((s) => selectIds(s, stale))}
                  disabled={stale.size === 0}
                >
                  Select 6-month stale ({stale.size})
                </Button>
                {selected.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
            {heldBackNote ? <p className="text-xs text-muted-foreground">{heldBackNote}</p> : null}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px_190px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter.q}
                  onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
                  placeholder="Search company, office, stage"
                  className="h-9 pl-8 text-[13px]"
                />
              </div>
              <Select
                value={filter.office}
                onValueChange={(v) => setFilter((f) => ({ ...f, office: v }))}
              >
                <SelectTrigger className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All offices</SelectItem>
                  {offices.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label} ({o.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={filter.stage}
                onValueChange={(v) => setFilter((f) => ({ ...f, stage: v }))}
              >
                <SelectTrigger className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All stages</SelectItem>
                  {stages.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label} ({s.count})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {bookQ.error ? (
              <div className="p-3">
                <LoadError what="book" error={bookQ.error} onRetry={() => void bookQ.refetch()} />
              </div>
            ) : (
              <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
                <Table className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <Checkbox
                          aria-label="Select all in filter"
                          checked={
                            everyVisibleSelected
                              ? true
                              : movable.some((a) => selected.has(a.id))
                                ? "indeterminate"
                                : false
                          }
                          disabled={movable.length === 0}
                          onCheckedChange={() =>
                            setSelected((s) =>
                              everyVisibleSelected
                                ? deselectIds(
                                    s,
                                    movable.map((a) => a.id),
                                  )
                                : selectIds(
                                    s,
                                    movable.map((a) => a.id),
                                  ),
                            )
                          }
                        />
                      </TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Office</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead className="hidden md:table-cell">Status</TableHead>
                      <TableHead className="hidden sm:table-cell">Last touch</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Held</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((a) => {
                      const canMove = isTransferable(a);
                      return (
                        <TableRow
                          key={a.id}
                          data-state={selected.has(a.id) ? "selected" : undefined}
                          className={canMove ? "cursor-pointer" : "opacity-70"}
                          onClick={
                            canMove ? () => setSelected((s) => toggleId(s, a.id)) : undefined
                          }
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              aria-label={
                                canMove
                                  ? `Select ${a.name}`
                                  : `${a.name} is a house account and cannot be reassigned`
                              }
                              checked={canMove && selected.has(a.id)}
                              disabled={!canMove}
                              onCheckedChange={() =>
                                canMove && setSelected((s) => toggleId(s, a.id))
                              }
                            />
                          </TableCell>
                          <TableCell className="max-w-[260px]">
                            <div className="flex items-center gap-1.5">
                              <Link
                                to="/accounts/$id"
                                params={{ id: a.id }}
                                className="truncate font-medium hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {a.name}
                              </Link>
                              {stale.has(a.id) && (
                                <Badge
                                  variant="outline"
                                  className="shrink-0 text-[10px] text-warning"
                                >
                                  6mo+
                                </Badge>
                              )}
                              {!canMove && (
                                <Badge
                                  variant="outline"
                                  className="shrink-0 text-[10px]"
                                  title="Belongs to the company, not to a rep's book — it stays put"
                                >
                                  House account
                                </Badge>
                              )}
                              {a.is_demo && (
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  demo
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>{a.office ?? "—"}</TableCell>
                          <TableCell>{a.stage_name ?? a.stage ?? "—"}</TableCell>
                          <TableCell className="hidden md:table-cell">
                            {a.status
                              ? (ACCOUNT_STATUS_LABEL[
                                  a.status as keyof typeof ACCOUNT_STATUS_LABEL
                                ] ?? a.status)
                              : "—"}
                          </TableCell>
                          <TableCell className="hidden tabular-nums sm:table-cell">
                            {fmtDaysAgo(a.last_touch_at)}
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {fmtValue(a.estimated_annual_value)}
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums md:table-cell">
                            {a.days_in_pipeline}d
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {visible.length === 0 && !bookQ.isLoading && (
                      <TableRow>
                        <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                          {book.length === 0
                            ? "This rep holds no accounts."
                            : "Nothing matches the filter."}
                        </TableCell>
                      </TableRow>
                    )}
                    {bookQ.isLoading && (
                      <TableRow>
                        <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                          Loading the book…
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Handover</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Why</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as ReassignmentReason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <ManagedOptionItems
                    listKey="reassignment_reason"
                    fallback={REASSIGN_REASON_OPTS}
                  />
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Detail (optional, goes on the timeline)</Label>
              <Textarea rows={1} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="text-xs">
              What to do differently next time
              {reason === "no_close_6_months" ? "" : " (optional)"}
            </Label>
            <Textarea
              rows={2}
              value={differently}
              onChange={(e) => setDifferently(e.target.value)}
              placeholder="Go through the regional facilities manager, not the property manager — she never had sign-off."
            />
          </div>
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              className="mt-0.5"
              checked={moveTasks}
              onCheckedChange={(v) => setMoveTasks(v === true)}
            />
            <span>
              <span className="font-medium">Move open tasks with the accounts.</span>{" "}
              <span className="text-muted-foreground">
                {!fromId
                  ? "Follow-ups and cadence tasks the departing rep holds on the selected accounts go to the new rep."
                  : selected.size === 0
                    ? tasksQ.data
                      ? `${nameOf(fromId)} holds ${tasksQ.data.length} open task${
                          tasksQ.data.length === 1 ? "" : "s"
                        } across this book — select accounts to see how many move.`
                      : "Select accounts to see how many move."
                    : `${describeTasks(taskSummary)} would go to ${
                        toTarget ? personLabel(toTarget.person) : "the new rep"
                      }. Unticked, they stay with ${nameOf(fromId)}.`}
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {blocked ??
                `Ready: ${selected.size} account${selected.size === 1 ? "" : "s"} from ${nameOf(fromId)} to ${nameOf(toId)}.`}
            </span>
            <Button
              disabled={submit.isPending || app.writesDisabled || !!blocked}
              title={app.writesDisabledReason ?? blocked ?? undefined}
              onClick={() => submit.mutate()}
            >
              {submit.isPending
                ? "Reassigning…"
                : `Reassign ${selected.size || ""} account${selected.size === 1 ? "" : "s"}${
                    toTarget ? ` to ${personLabel(toTarget.person)}` : ""
                  }`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {(batchesQ.data ?? []).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Undo2 className="size-4" /> Recent slices
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {(batchesQ.data ?? []).map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{nameOf(b.from_user_id)}</span>
                    <ArrowRight className="mx-1 inline size-3 text-muted-foreground" />
                    <span className="font-medium">{nameOf(b.to_user_id)}</span>
                    <span className="text-muted-foreground">
                      {" · "}
                      {b.account_count} account{b.account_count === 1 ? "" : "s"}
                      {" · "}
                      {REASSIGN_REASON_LABEL[b.reason] ?? b.reason}
                      {" · "}
                      {new Date(b.created_at).toLocaleString("en-US")}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={reverse.isPending || app.writesDisabled}
                    onClick={() => reverse.mutate(b)}
                  >
                    Reverse
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
