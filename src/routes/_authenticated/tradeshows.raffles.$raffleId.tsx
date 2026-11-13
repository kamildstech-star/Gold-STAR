import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  Download,
  Gift,
  Lock,
  Mail,
  Pencil,
  Phone,
  QrCode as QrIcon,
  RotateCcw,
  Search,
  Shuffle,
  Trash2,
  Trophy,
  Unlock,
  Users,
} from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { BackLink } from "@/components/back-link";
import { MetricStat } from "@/components/metric-stat";
import { RaffleDialog } from "@/components/raffle-dialog";
import { RaffleQrDialog } from "@/components/raffle-qr-dialog";
import { RafflePhasePill } from "@/components/tradeshow-raffles-panel";
import { PageHeader } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { toastDbError } from "@/lib/db-errors";
import {
  activeWinners,
  deleteRaffle,
  drawWinners,
  eligibleEntries,
  fetchRaffleDetail,
  fullName,
  isRaffleOpen,
  prizeMoney,
  rafflesCsv,
  setEntryDisqualified,
  setRaffleStatus,
  setWinnerStatus,
  totalPrizeValue,
  WINNER_STATUS,
  type RaffleDetail,
  type RaffleEntry,
  type RafflePrize,
  type RaffleWinner,
  type WinnerStatus,
} from "@/lib/raffles";
import { canManageTradeshows } from "@/lib/roles";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/tradeshows/raffles/$raffleId")({
  head: () => ({
    meta: [
      { title: "Raffle · Recovery Hub" },
      { name: "description", content: "A trade show raffle: its contacts and its prize draw." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): { tab?: "contacts" | "draw" } =>
    raw.tab === "draw" ? { tab: "draw" } : {},
  component: RafflePage,
});

const when = (iso: string) =>
  new Date(iso).toLocaleString(DATE_LOCALE, { ...US_DATE, hour: "numeric", minute: "2-digit" });

const KEY = (id: string) => ["tradeshow-raffle", id] as const;

function RafflePage() {
  const { raffleId } = Route.useParams();
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = canManageTradeshows(app.roles) && !app.writesDisabled;
  const initialTab = Route.useSearch().tab;
  const [tab, setTab] = React.useState<"contacts" | "draw">(initialTab ?? "contacts");
  const [editing, setEditing] = React.useState(false);
  const [qr, setQr] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const q = useQuery({
    queryKey: KEY(raffleId),
    queryFn: () => fetchRaffleDetail(raffleId),
    // A booth tablet left on this page watches entries arrive.
    refetchInterval: 20_000,
  });
  const refresh = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: KEY(raffleId) });
    void qc.invalidateQueries({ queryKey: ["tradeshow-raffles"] });
  }, [qc, raffleId]);

  const status = useMutation({
    mutationFn: (open: boolean) => setRaffleStatus(raffleId, open ? "open" : "closed", open),
    onSuccess: (_v, open) => {
      toast.success(open ? "Entries reopened" : "Entries closed");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "change the raffle" }),
  });
  const remove = useMutation({
    mutationFn: () => deleteRaffle(raffleId),
    onSuccess: () => {
      toast.success("Raffle deleted");
      void qc.invalidateQueries({ queryKey: ["tradeshow-raffles"] });
      if (q.data) void navigate({ to: "/tradeshows/$id", params: { id: q.data.show.id } });
    },
    onError: (e) =>
      e instanceof Error
        ? toast.error(e.message)
        : toastDbError(e, { action: "delete the raffle" }),
  });

  if (q.isLoading)
    return <div className="px-5 py-6 text-[13px] text-muted-foreground">Loading raffle…</div>;
  if (q.error || !q.data) {
    return (
      <div className="space-y-2 px-5 py-6 text-[13px]">
        <p className="text-muted-foreground">This raffle could not be loaded.</p>
        <BackLink fallbackTo="/tradeshows/raffles" label="Raffles" className="entity-link">
          Back to raffles
        </BackLink>
      </div>
    );
  }

  const d = q.data;
  const open = isRaffleOpen(d.raffle);
  const live = d.winners.filter((w) => w.status !== "forfeited");
  const slots = d.prizes.reduce((s, p) => s + p.quantity, 0);
  const eligible = eligibleEntries(d.entries, d.winners);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = d.entries.filter((e) => new Date(e.created_at) >= startOfDay).length;
  const optIns = d.entries.filter((e) => e.consent_marketing).length;
  const prizeValue = totalPrizeValue(d.prizes);

  const exportCsv = () => {
    const blob = new Blob([rafflesCsv(d)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${d.raffle.title.replace(/[^\w-]+/g, "-").toLowerCase()}-contacts.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 px-5 py-5">
      <BackLink
        fallbackTo="/tradeshows/raffles"
        label={d.show.name}
        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> {d.show.name}
      </BackLink>

      <PageHeader
        title={d.raffle.title}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {d.show.name}
            <RafflePhasePill raffle={{ ...d.raffle, winners: live.length }} />
            {d.raffle.closes_at && open && <span>Closes {when(d.raffle.closes_at)}</span>}
          </span>
        }
      >
        <Button size="sm" onClick={() => setQr(true)}>
          <QrIcon className="mr-1 h-3.5 w-3.5" /> QR code &amp; poster
        </Button>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={d.entries.length === 0}>
          <Download className="mr-1 h-3.5 w-3.5" /> Export CSV
        </Button>
        {canManage && (
          <>
            {open ? (
              <Button
                size="sm"
                variant="outline"
                disabled={status.isPending}
                onClick={() => status.mutate(false)}
              >
                <Lock className="mr-1 h-3.5 w-3.5" /> Close entries
              </Button>
            ) : live.length === 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={status.isPending}
                onClick={() => status.mutate(true)}
              >
                <Unlock className="mr-1 h-3.5 w-3.5" /> Reopen entries
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
            </Button>
            {d.entries.length === 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(true)}
                title="Delete raffle"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricStat
          value={d.entries.length.toLocaleString("en-US")}
          label="Contacts"
          hint={
            d.raffle.max_entries == null
              ? "No entry limit"
              : d.entries.length >= d.raffle.max_entries
                ? `Full — limit ${d.raffle.max_entries.toLocaleString("en-US")}`
                : `of ${d.raffle.max_entries.toLocaleString("en-US")} max`
          }
          tone={
            d.raffle.max_entries != null && d.entries.length >= d.raffle.max_entries
              ? "warning"
              : "default"
          }
          icon={<Users className="size-4" />}
        />
        <MetricStat value={today.toLocaleString("en-US")} label="Entered today" />
        <MetricStat
          value={d.entries.length ? `${Math.round((optIns / d.entries.length) * 100)}%` : "—"}
          label="Marketing opt-in"
          hint={`${optIns} of ${d.entries.length}`}
        />
        <MetricStat value={eligible.length.toLocaleString("en-US")} label="Still in the draw" />
        <MetricStat
          value={`${live.length}/${slots}`}
          label="Prizes drawn"
          tone={slots > 0 && live.length >= slots ? "success" : "default"}
          icon={<Trophy className="size-4" />}
        />
        <MetricStat value={prizeValue ? prizeMoney(prizeValue) : "—"} label="Prize value" />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="contacts">
            <Users /> Contacts <TabsCount>{d.entries.length}</TabsCount>
          </TabsTrigger>
          <TabsTrigger value="draw">
            <Gift /> Prize draw <TabsCount>{`${live.length}/${slots}`}</TabsCount>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="contacts" className="mt-3">
          <ContactsTab
            detail={d}
            canManage={canManage}
            onChanged={refresh}
            onShowQr={() => setQr(true)}
          />
        </TabsContent>
        <TabsContent value="draw" className="mt-3">
          <DrawTab detail={d} canManage={canManage} onChanged={refresh} />
        </TabsContent>
      </Tabs>

      <RaffleQrDialog
        raffle={d.raffle}
        prizes={d.prizes}
        showName={d.show.name}
        open={qr}
        onClose={() => setQr(false)}
      />
      <RaffleDialog
        open={editing}
        onClose={() => setEditing(false)}
        tradeshowId={d.show.id}
        showName={d.show.name}
        raffle={d.raffle}
        prizes={d.prizes}
        winners={d.winners}
        onSaved={() => {
          setEditing(false);
          refresh();
        }}
      />
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this raffle?</DialogTitle>
            <DialogDescription>
              Nobody has entered yet. Its QR code will stop working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

type Filter = "all" | "optin" | "winners" | "out";

function ContactsTab({
  detail,
  canManage,
  onChanged,
  onShowQr,
}: {
  detail: RaffleDetail;
  canManage: boolean;
  onChanged: () => void;
  onShowQr: () => void;
}) {
  const app = useAppContext();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [dq, setDq] = React.useState<RaffleEntry | null>(null);
  const [reason, setReason] = React.useState("");

  const winBy = React.useMemo(
    () => new Map(detail.winners.map((w) => [w.entry_id, w])),
    [detail.winners],
  );
  const prizeName = React.useMemo(
    () => new Map(detail.prizes.map((p) => [p.id, p.name])),
    [detail.prizes],
  );

  const rows = React.useMemo(() => {
    const s = search.trim().toLowerCase();
    return detail.entries.filter((e) => {
      if (filter === "optin" && !e.consent_marketing) return false;
      if (filter === "winners" && !winBy.has(e.id)) return false;
      if (filter === "out" && !e.disqualified_at) return false;
      if (!s) return true;
      return [e.first_name, e.last_name, e.email, e.phone, e.company, e.job_title, e.industry]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(s));
    });
  }, [detail.entries, search, filter, winBy]);

  const toggle = useMutation({
    mutationFn: (v: { entry: RaffleEntry; out: boolean; reason: string | null }) =>
      setEntryDisqualified(v.entry.id, v.out, v.reason, app.userId),
    onSuccess: (_r, v) => {
      toast.success(v.out ? "Removed from the draw" : "Back in the draw");
      setDq(null);
      setReason("");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "update the entry" }),
  });

  if (detail.entries.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-12 text-center">
        <Users className="size-8 text-muted-foreground" />
        <div>
          <p className="font-semibold">No entries yet</p>
          <p className="text-[13px] text-muted-foreground">
            Put the QR code on the booth. Every entry shows up here within seconds.
          </p>
        </div>
        <Button size="sm" onClick={onShowQr}>
          <QrIcon className="mr-1 size-3.5" /> Show QR code
        </Button>
      </div>
    );
  }

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "optin", label: "Opted in" },
    { id: "winners", label: "Winners" },
    { id: "out", label: "Disqualified" },
  ];

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-[13px]"
            placeholder="Search name, email, phone, company, industry…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={filter === f.id ? "default" : "outline"}
              className="h-8 px-2.5 text-[12px]"
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-muted/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Contact</th>
              <th className="px-3 py-2 font-semibold">Company</th>
              <th className="px-3 py-2 font-semibold">Entered</th>
              <th className="px-3 py-2 font-semibold">Opt-in</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              {canManage && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((e) => {
              const w = winBy.get(e.id);
              return (
                <tr key={e.id} className={cn(e.disqualified_at && "text-muted-foreground")}>
                  <td className="px-3 py-2 font-semibold">{fullName(e)}</td>
                  <td className="px-3 py-2">
                    <a href={`mailto:${e.email}`} className="entity-link block truncate">
                      {e.email}
                    </a>
                    {e.phone && (
                      <a
                        href={`tel:${e.phone}`}
                        className="block text-[12px] text-muted-foreground hover:underline"
                      >
                        {e.phone}
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {e.company ?? <span className="text-muted-foreground">—</span>}
                    {(e.job_title || e.industry) && (
                      <div className="text-[12px] text-muted-foreground">
                        {[e.job_title, e.industry].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">
                    {when(e.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    {e.consent_marketing ? (
                      <CheckCircle2 className="size-4 text-success" aria-label="Opted in" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {e.disqualified_at ? (
                      <Pill tone="danger" title={e.disqualified_reason ?? undefined}>
                        Disqualified
                      </Pill>
                    ) : w ? (
                      <Pill tone={w.status === "forfeited" ? "danger" : "success"}>
                        <Trophy className="mr-1 size-3" />
                        {prizeName.get(w.prize_id) ?? "Winner"}
                        {w.status === "forfeited" ? " · forfeited" : ""}
                      </Pill>
                    ) : (
                      <Pill tone="neutral">In the draw</Pill>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2 text-right">
                      {!w &&
                        (e.disqualified_at ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[12px]"
                            onClick={() => toggle.mutate({ entry: e, out: false, reason: null })}
                          >
                            <RotateCcw className="mr-1 size-3.5" /> Restore
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            title="Remove from the draw"
                            onClick={() => setDq(e)}
                          >
                            <Ban className="size-3.5" />
                          </Button>
                        ))}
                    </td>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                  Nobody matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!dq} onOpenChange={(v) => !v && setDq(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {dq ? fullName(dq) : ""} from the draw?</DialogTitle>
            <DialogDescription>
              They stay in your contacts and can be restored. Use this for staff, duplicates or test
              entries.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Reason, e.g. Duplicate entry"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDq(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={toggle.isPending}
              onClick={() =>
                dq && toggle.mutate({ entry: dq, out: true, reason: reason.trim() || null })
              }
            >
              Remove from draw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Pill({
  tone,
  children,
  title,
}: {
  tone: keyof typeof TONE;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-[220px] items-center truncate rounded-full border px-2 text-[11px] font-semibold",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Prize draw                                                          */
/* ------------------------------------------------------------------ */

function DrawTab({
  detail,
  canManage,
  onChanged,
}: {
  detail: RaffleDetail;
  canManage: boolean;
  onChanged: () => void;
}) {
  const entryBy = React.useMemo(
    () => new Map(detail.entries.map((e) => [e.id, e])),
    [detail.entries],
  );
  const eligible = eligibleEntries(detail.entries, detail.winners);
  const [reveal, setReveal] = React.useState<{
    prize: RafflePrize;
    winners: RaffleWinner[];
  } | null>(null);
  const [forfeit, setForfeit] = React.useState<RaffleWinner | null>(null);
  const [reason, setReason] = React.useState("");

  const draw = useMutation({
    mutationFn: (prize: RafflePrize) => drawWinners(prize.id, 1),
    onSuccess: (winners, prize) => {
      setReveal({ prize, winners });
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "run the draw" }),
  });

  const move = useMutation({
    mutationFn: (v: { id: string; status: WinnerStatus; reason?: string | null }) =>
      setWinnerStatus(v.id, v.status, v.reason),
    onSuccess: (_r, v) => {
      toast.success(
        v.status === "forfeited"
          ? "Forfeited — the prize can be drawn again"
          : `Marked ${WINNER_STATUS[v.status].label.toLowerCase()}`,
      );
      setForfeit(null);
      setReason("");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "update the winner" }),
  });

  if (detail.prizes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed bg-card px-6 py-10 text-center text-[13px] text-muted-foreground">
        This raffle has no prizes yet. Add them with Edit.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-4 py-2.5 text-[13px]">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <Shuffle className="size-4" /> {eligible.length}{" "}
          {eligible.length === 1 ? "entry" : "entries"} in the hat
        </span>
        <span className="text-[12px] text-muted-foreground">
          Winners are picked at random by the server, one at a time. Drawing closes entries. Nobody
          can win twice; disqualified entries are skipped.
        </span>
      </div>

      {detail.prizes.map((p, i) => {
        const won = detail.winners.filter((w) => w.prize_id === p.id);
        const holding = activeWinners(detail.winners, p.id).length;
        const full = holding >= p.quantity;
        return (
          <section key={p.id} className="rounded-xl border bg-card shadow-sm">
            <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                <Gift className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {detail.prizes.length > 1 ? `Prize ${i + 1}` : "Prize"}
                  {p.value ? ` · ${prizeMoney(p.value)}` : ""}
                </div>
                <h3 className="truncate text-[15px] font-bold">{p.name}</h3>
                {p.description && (
                  <p className="text-[12px] text-muted-foreground">{p.description}</p>
                )}
              </div>
              <span className="text-[13px] font-semibold tabular-nums">
                {holding}/{p.quantity} drawn
              </span>
              {canManage && (
                <Button
                  disabled={full || eligible.length === 0 || draw.isPending}
                  onClick={() => draw.mutate(p)}
                  title={
                    full
                      ? "Every winner for this prize is drawn"
                      : eligible.length === 0
                        ? "Nobody left to draw"
                        : undefined
                  }
                >
                  <Shuffle className="mr-1.5 size-4" />
                  {draw.isPending && draw.variables?.id === p.id
                    ? "Drawing…"
                    : won.some((w) => w.status === "forfeited") && !full
                      ? "Redraw"
                      : "Draw winner"}
                </Button>
              )}
            </header>
            {won.length === 0 ? (
              <p className="px-4 py-3 text-[12px] text-muted-foreground">Not drawn yet.</p>
            ) : (
              <ul className="divide-y">
                {won.map((w) => {
                  const e = entryBy.get(w.entry_id);
                  const st = WINNER_STATUS[w.status];
                  return (
                    <li
                      key={w.id}
                      className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]"
                    >
                      <Trophy
                        className={cn(
                          "size-4 shrink-0",
                          w.status === "forfeited" ? "text-muted-foreground" : "text-warning",
                        )}
                      />
                      <div
                        className={cn(
                          "min-w-0 flex-1",
                          w.status === "forfeited" && "text-muted-foreground line-through",
                        )}
                      >
                        <div className="font-semibold">{e ? fullName(e) : "Entry removed"}</div>
                        <div className="flex flex-wrap gap-x-3 text-[12px] text-muted-foreground">
                          {e?.email && (
                            <a
                              href={`mailto:${e.email}`}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              <Mail className="size-3" /> {e.email}
                            </a>
                          )}
                          {e?.phone && (
                            <a
                              href={`tel:${e.phone}`}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              <Phone className="size-3" /> {e.phone}
                            </a>
                          )}
                          {e?.company && <span>{e.company}</span>}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Drawn {when(w.drawn_at)} from {w.pool_size} eligible
                          {w.forfeit_reason ? ` · ${w.forfeit_reason}` : ""}
                        </div>
                      </div>
                      <Pill tone={st.tone}>{st.label}</Pill>
                      {canManage && (w.status === "drawn" || w.status === "notified") && (
                        <div className="flex gap-1">
                          {w.status === "drawn" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[12px]"
                              onClick={() => move.mutate({ id: w.id, status: "notified" })}
                            >
                              <Mail className="mr-1 size-3.5" /> Contacted
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[12px]"
                            onClick={() => move.mutate({ id: w.id, status: "claimed" })}
                          >
                            <CheckCircle2 className="mr-1 size-3.5" /> Claimed
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[12px]"
                            title="Forfeit and free the prize for a redraw"
                            onClick={() => setForfeit(w)}
                          >
                            <Ban className="size-3.5" />
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <DrawReveal
        state={reveal}
        names={eligible.map(fullName)}
        entryBy={entryBy}
        onClose={() => setReveal(null)}
      />

      <Dialog open={!!forfeit} onOpenChange={(v) => !v && setForfeit(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Forfeit this win?</DialogTitle>
            <DialogDescription>
              The prize opens again for a redraw. The person keeps their record but cannot be drawn
              again.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Reason, e.g. No reply after 14 days"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setForfeit(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={move.isPending}
              onClick={() =>
                forfeit &&
                move.mutate({ id: forfeit.id, status: "forfeited", reason: reason.trim() || null })
              }
            >
              Forfeit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The moment on the booth screen. The winner is already chosen and saved by
 * the server before this opens — the shuffle is only theatre, so closing it
 * early changes nothing.
 */
function DrawReveal({
  state,
  names,
  entryBy,
  onClose,
}: {
  state: { prize: RafflePrize; winners: RaffleWinner[] } | null;
  names: string[];
  entryBy: Map<string, RaffleEntry>;
  onClose: () => void;
}) {
  const [shown, setShown] = React.useState<string>("");
  const [done, setDone] = React.useState(false);
  const winner = state?.winners[0] ? entryBy.get(state.winners[0].entry_id) : undefined;

  React.useEffect(() => {
    if (!state) return;
    setDone(false);
    const pool = names.length ? names : ["…"];
    const started = Date.now();
    const id = window.setInterval(() => {
      setShown(pool[Math.floor(Math.random() * pool.length)] ?? "");
      if (Date.now() - started > 2200) {
        window.clearInterval(id);
        setDone(true);
      }
    }, 80);
    return () => window.clearInterval(id);
    // names is a snapshot from when the draw ran.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Dialog open={!!state} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md text-center">
        <DialogHeader>
          <DialogTitle className="text-center">{state?.prize.name}</DialogTitle>
          <DialogDescription className="text-center">
            {done ? "And the winner is…" : "Drawing at random…"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[140px] flex-col items-center justify-center gap-2">
          {done && winner ? (
            <>
              <Trophy className="size-10 text-warning" />
              <p className="text-2xl font-extrabold">{fullName(winner)}</p>
              <p className="text-[13px] text-muted-foreground">
                {[winner.company, winner.email].filter(Boolean).join(" · ")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Picked from {state?.winners[0]?.pool_size} eligible entries
              </p>
            </>
          ) : (
            <p className="text-2xl font-bold text-muted-foreground tabular-nums">{shown}</p>
          )}
        </div>
        <DialogFooter className="sm:justify-center">
          <Button onClick={onClose}>{done ? "Done" : "Skip"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
