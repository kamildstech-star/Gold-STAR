import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, ArrowLeft, Camera, CloudOff, Link2, Pencil, Plus, X } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { BackLink } from "@/components/back-link";
import { PageHeader } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { toastDbError } from "@/lib/db-errors";
import { canManageTradeshows } from "@/lib/roles";
import {
  addShowAttendee,
  addShowNote,
  archiveTradeshow,
  fetchTradeshowDetail,
  formatShowDates,
  linkAccountToShow,
  removeShowAttendee,
  searchAccountsForShow,
  showMoney,
  showRoiNumbers,
  unlinkAccountFromShow,
} from "@/lib/tradeshows";
import { EntityPicker } from "@/components/entity-picker";
import type { EntityOption } from "@/components/entity-kinds";
import { TradeshowCaptureBar } from "@/components/tradeshow-capture-bar";
import { ShowDialog } from "@/components/tradeshow-show-dialog";
import { TradeshowReviewQueue } from "@/components/tradeshow-review-queue";
import { unreviewedAccountIds, useCaptureStates } from "@/lib/tradeshow-review";
import { TradeshowIntakeLinks } from "@/components/tradeshow-intake-links";
import { RafflesBoard, useRaffleBoardData, type RaffleSection } from "@/components/raffles-board";
import { TradeshowRafflesPanel } from "@/components/tradeshow-raffles-panel";
import { TAB_STRIP, TAB_TRIGGER, TabsCount } from "@/components/ui/tabs";
import { listTradeshowFormSubmissions } from "@/lib/tradeshow-intake";
import { VoiceNotePlayer } from "@/components/voice-note-field";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { subscribe, type QueuedItem } from "@/lib/offline-queue";
import {
  listQueuedLeads,
  mediaByAccount,
  useLeadMediaUrl,
  waveformPeaks,
  type LeadMedia,
} from "@/lib/tradeshow-capture";
import { FitText } from "@/components/ui/fit-text";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/tradeshows/$id")({
  head: () => ({
    meta: [
      { title: "Tradeshow detail · Recovery Hub" },
      {
        name: "description",
        content:
          "Everything a single show produced: cost, leads, accounts created, jobs won and return against cost.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): { tab?: ShowTab } =>
    SHOW_TABS.includes(raw.tab as ShowTab) && raw.tab !== "overview"
      ? { tab: raw.tab as ShowTab }
      : {},
  component: TradeshowDetailPage,
});

type ShowTab = "overview" | "leads" | "jobs" | "team" | "intake" | RaffleSection;
const SHOW_TABS: ShowTab[] = [
  "overview",
  "leads",
  "jobs",
  "raffles",
  "prizes",
  "winners",
  "team",
  "intake",
];
const RAFFLE_TABS: ShowTab[] = ["raffles", "prizes", "winners"];

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);

function TradeshowDetailPage() {
  const { id } = Route.useParams();
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = React.useState(false);
  const tab: ShowTab = Route.useSearch().tab ?? "overview";
  const setTab = (t: ShowTab) =>
    void navigate({
      to: "/tradeshows/$id",
      params: { id },
      search: t === "overview" ? {} : { tab: t },
      replace: true,
    });
  const raffleData = useRaffleBoardData(id);

  const canManage = canManageTradeshows(app.roles);
  /** Money rule: figures are a leadership view, never a rep view. */
  const canSeeMoney = canManage;

  const detailQ = useQuery({
    queryKey: ["tradeshow-detail", id],
    queryFn: () => fetchTradeshowDetail(id),
  });

  /** Accounts that arrived through the show's intake form, so the list can say so. */
  const formQ = useQuery({
    queryKey: ["tradeshow-form-submissions", id],
    queryFn: () => listTradeshowFormSubmissions(id),
  });
  const formAccountIds = React.useMemo(
    () => new Set((formQ.data ?? []).map((s) => s.account_id).filter((x): x is string => !!x)),
    [formQ.data],
  );

  /** Captures still waiting to be written up. Its own read: see the hook. */
  const capturesQ = useCaptureStates(id);
  const unreviewed = React.useMemo(
    () => unreviewedAccountIds(capturesQ.data?.rows ?? []),
    [capturesQ.data],
  );

  const invalidate = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["tradeshow-detail", id] });
    qc.invalidateQueries({ queryKey: ["tradeshow-capture-states", id] });
    qc.invalidateQueries({ queryKey: ["tradeshow-roi"] });
  }, [qc, id]);

  const archive = useMutation({
    mutationFn: () => archiveTradeshow(id),
    onSuccess: () => {
      toast.success("Show archived");
      navigate({ to: "/tradeshows" });
    },
    onError: (e) => toastDbError(e, { action: "archive show" }),
  });

  if (detailQ.isLoading) {
    return <div className="px-5 py-6 text-[13px] text-muted-foreground">Loading show…</div>;
  }
  if (detailQ.error || !detailQ.data) {
    return (
      <div className="px-5 py-6 text-[13px]">
        <p className="text-muted-foreground">This show could not be loaded.</p>
        <BackLink fallbackTo="/tradeshows" label="tradeshows" className="entity-link">
          Back to tradeshows
        </BackLink>
      </div>
    );
  }

  const d = detailQ.data;
  const roi = showRoiNumbers(d);
  const place = [d.show.city, d.show.state].filter(Boolean).join(", ") || "Location TBC";

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 px-5 py-5">
      <BackLink
        fallbackTo="/tradeshows"
        label="Tradeshows"
        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Tradeshows
      </BackLink>

      <PageHeader
        title={d.show.name}
        subtitle={`${place} · ${formatShowDates(d.show.starts_on, d.show.ends_on)}${
          canSeeMoney ? ` · ${showMoney(roi.cost)} cost` : ""
        }`}
      >
        {canManage && (
          <>
            {/*
             * Mark: "This edit button doesn't work at all. It just takes you
             * back to the page for trade shows." It did -- the form only
             * existed on the list page. Now it opens here.
             */}
            <Button
              size="sm"
              variant="outline"
              disabled={app.writesDisabled}
              onClick={() => setEditing(true)}
            >
              <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={app.writesDisabled}
              onClick={() => archive.mutate()}
            >
              <Archive className="mr-1 h-3.5 w-3.5" /> Archive
            </Button>
          </>
        )}
      </PageHeader>

      {/*
       * The booth interface, first thing under the title: "two large buttons
       * on top: Leave a voice note, and Capture a lead."
       */}
      <TradeshowCaptureBar show={d.show} onSaved={invalidate} />
      {editing && (
        <ShowDialog
          show={d.show}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            invalidate();
            qc.invalidateQueries({ queryKey: ["tradeshows"] });
          }}
        />
      )}

      {/* Mark, 10 Nov: the show page in tabs, one section at a time. The
          booth buttons stay above them so capture is always one tap away. */}
      <div role="tablist" className={cn(TAB_STRIP, "no-scrollbar flex max-w-full overflow-x-auto")}>
        {(
          [
            ["overview", "Overview", null],
            ["leads", "Leads & accounts", d.accounts.length],
            ["jobs", "Jobs", d.jobs.length],
            // Raffles, Prizes and Winners are one tab (11 Nov); the board
            // switches between the three lists inside it.
            ["raffles", "Raffles", raffleData.raffles.length],
            ["team", "Team & notes", d.attendees.length],
            ["intake", "Intake link", null],
          ] as const
        ).map(([key, label, count]) => {
          const on = key === "raffles" ? RAFFLE_TABS.includes(tab) : tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              data-state={on ? "active" : "inactive"}
              className={cn(TAB_TRIGGER, "shrink-0")}
              onClick={() => setTab(key)}
            >
              {label}
              {count != null && <TabsCount>{count}</TabsCount>}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <>
          <RoiBlock roi={roi} canSeeMoney={canSeeMoney} unreviewed={unreviewed.size} />
          <TradeshowRafflesPanel show={d.show} onSeeAll={() => setTab("prizes")} />
          <QueuedLeadsStrip tradeshowId={id} onDrained={invalidate} />
          <TradeshowReviewQueue
            detail={d}
            states={capturesQ.data?.rows ?? []}
            available={capturesQ.data?.available ?? true}
            onChanged={invalidate}
          />
        </>
      )}

      {tab === "leads" && (
        <>
          <AccountsPanel
            detail={d}
            formAccountIds={formAccountIds}
            unreviewedAccountIds={unreviewed}
            canManage={canManage}
            canSeeMoney={canSeeMoney}
            onChanged={invalidate}
          />
          <p className="text-[12px] text-muted-foreground">
            Accounts and jobs count here when they are attributed to the show on their own record.
            Use “Link an account” to fix attribution after the fact.
          </p>
        </>
      )}

      {tab === "jobs" && <JobsPanel detail={d} canSeeMoney={canSeeMoney} />}

      {RAFFLE_TABS.includes(tab) && (
        <RafflesBoard
          show={{ id: d.show.id, name: d.show.name }}
          section={tab as RaffleSection}
          onSection={setTab}
        />
      )}

      {tab === "team" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <AttendeesPanel detail={d} canManage={canManage} onChanged={invalidate} />
          <NotesPanel detail={d} onChanged={invalidate} />
        </div>
      )}

      {tab === "intake" && (
        <div className="max-w-xl">
          <TradeshowIntakeLinks show={d.show} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Leads captured on this device that have not reached the server. A rep in a
 * hall with no signal has to be able to see that the last three leads are
 * held, not lost — and the page refreshes itself when they go up.
 */
function QueuedLeadsStrip({
  tradeshowId,
  onDrained,
}: {
  tradeshowId: string;
  onDrained: () => void;
}) {
  const [items, setItems] = React.useState<QueuedItem[]>([]);
  const countRef = React.useRef(0);
  React.useEffect(() => {
    let alive = true;
    const refresh = () =>
      void listQueuedLeads(tradeshowId).then((list) => {
        if (!alive) return;
        if (list.length < countRef.current) onDrained();
        countRef.current = list.length;
        setItems(list);
      });
    refresh();
    const unsub = subscribe(refresh);
    return () => {
      alive = false;
      unsub();
    };
  }, [tradeshowId, onDrained]);

  if (items.length === 0) return null;
  const failed = items.filter((i) => i.status === "rejected");
  return (
    <section className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-2.5 text-[13px]">
      <div className="flex items-center gap-2 font-semibold">
        <CloudOff className="size-4 text-warning" />
        {items.length} lead{items.length === 1 ? "" : "s"} on this device, waiting to upload
      </div>
      <ul className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
        {items.map((i) => (
          <li key={i.id}>
            {i.label}
            {i.status === "rejected" && i.lastError && (
              <span className="ml-2 text-destructive">— {i.lastError}</span>
            )}
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <p className="mt-1 text-[12px] text-muted-foreground">
          Rejected leads stay in the sync list in the header, where they can be retried.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

/** The selfie and the voice note, on the row of the account they created. */
function CapturedCell({
  badge,
  photo,
  audio,
  onOpenPhoto,
}: {
  badge: LeadMedia | null;
  photo: LeadMedia | null;
  audio: LeadMedia | null;
  onOpenPhoto: (m: LeadMedia) => void;
}) {
  const badgeQ = useLeadMediaUrl(badge?.storage_path);
  const thumbQ = useLeadMediaUrl(photo ? (photo.thumb_path ?? photo.storage_path) : null);
  const audioQ = useLeadMediaUrl(audio?.storage_path ?? null);
  if (!photo && !audio && !badge) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-2">
      {badge && (
        <button
          type="button"
          onClick={() => onOpenPhoto(badge)}
          title="Open badge or business card"
          className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted"
        >
          {badgeQ.data ? (
            <img src={badgeQ.data} alt="Badge" className="size-full object-cover" />
          ) : (
            <Camera className="size-4" />
          )}
        </button>
      )}
      {photo && (
        <button
          type="button"
          onClick={() => onOpenPhoto(photo)}
          className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted"
          title="Open photo"
        >
          {thumbQ.data ? (
            <img src={thumbQ.data} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <Camera className="size-4 text-muted-foreground" />
          )}
        </button>
      )}
      {audio && (
        <VoiceNotePlayer
          src={audioQ.data ?? null}
          peaks={waveformPeaks(audio)}
          durationSec={Number(audio.duration_seconds ?? 0)}
          className="w-56"
        />
      )}
    </div>
  );
}

function LeadPhotoLightbox({ media, onClose }: { media: LeadMedia | null; onClose: () => void }) {
  const urlQ = useLeadMediaUrl(media?.storage_path ?? null);
  return (
    <Dialog open={!!media} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl bg-transparent p-0 shadow-none">
        <DialogHeader className="sr-only">
          <DialogTitle>Lead photo</DialogTitle>
        </DialogHeader>
        {urlQ.data && (
          <img src={urlQ.data} alt="" className="max-h-[85vh] w-auto rounded-sm object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

function RoiBlock({
  roi,
  canSeeMoney,
  unreviewed,
}: {
  roi: ReturnType<typeof showRoiNumbers>;
  canSeeMoney: boolean;
  /** Captures nobody has written up. They count as leads; they are also flagged. */
  unreviewed: number;
}) {
  type Cell = { label: string; value: string; tone?: "good" | "bad"; note?: string };
  // Money cells exist only for a role that may see what the show cost and
  // returned; anyone else gets the counts, with no "—" where the money was.
  const money = (cells: Cell[]): Cell[] => (canSeeMoney ? cells : []);
  const cells: Cell[] = [
    ...money([{ label: "Cost", value: showMoney(roi.cost) }]),
    {
      label: "Leads captured",
      value: roi.leads.toLocaleString("en-US"),
      // A voice note counts the moment it is spoken. Saying how many are still
      // only a voice note is the difference between a number and the truth.
      note: unreviewed > 0 ? `${unreviewed} not written up yet` : undefined,
    },
    { label: "Accounts created", value: roi.accounts.toLocaleString("en-US") },
    { label: "Jobs won", value: roi.jobsWon.toLocaleString("en-US") },
    ...money([
      { label: "Revenue signed", value: showMoney(roi.revenue) },
      {
        label: "Cost / lead",
        value: roi.costPerLead != null ? showMoney(roi.costPerLead) : "—",
      },
      {
        label: "Cost / account",
        value: roi.costPerAccount != null ? showMoney(roi.costPerAccount) : "—",
      },
      {
        label: "Cost / job",
        value: roi.costPerJob != null ? showMoney(roi.costPerJob) : "—",
      },
      {
        label: "Return vs cost",
        value: roi.returnVsCost != null ? `${roi.returnVsCost.toFixed(2)}×` : "—",
        tone: roi.returnVsCost != null ? (roi.returnVsCost >= 1 ? "good" : "bad") : undefined,
      },
    ]),
  ];
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-[14px] font-bold">Return on this show</h2>
        <p className="text-[11px] text-muted-foreground">
          The numbers that decide whether to go back next year.
        </p>
      </header>
      <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-3 lg:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label} className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {c.label}
            </div>
            <FitText
              className={cn(
                "mt-0.5 text-[18px] font-bold tabular-nums",
                c.tone === "good" && "text-success",
                c.tone === "bad" && "text-destructive",
              )}
            >
              {c.value}
            </FitText>
            {c.note && <div className="text-[11px] text-warning">{c.note}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function AccountsPanel({
  detail,
  formAccountIds,
  unreviewedAccountIds,
  canManage,
  canSeeMoney,
  onChanged,
}: {
  detail: Awaited<ReturnType<typeof fetchTradeshowDetail>>;
  /** Accounts created by a submission through the show's intake form. */
  formAccountIds: Set<string>;
  /** Captures still waiting on the review pass — flagged, never hidden. */
  unreviewedAccountIds: Set<string>;
  canManage: boolean;
  canSeeMoney: boolean;
  onChanged: () => void;
}) {
  const app = useAppContext();
  const [linking, setLinking] = React.useState(false);
  const [lightbox, setLightbox] = React.useState<LeadMedia | null>(null);
  const captured = React.useMemo(() => mediaByAccount(detail.media), [detail.media]);

  const unlink = useMutation({
    mutationFn: unlinkAccountFromShow,
    onSuccess: () => {
      toast.success("Attribution removed");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "remove attribution" }),
  });

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-[14px] font-bold">
          Leads &amp; accounts from this show{" "}
          <span className="text-muted-foreground">({detail.accounts.length})</span>
        </h2>
        {canManage && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={app.writesDisabled}
            onClick={() => setLinking(true)}
          >
            <Link2 className="mr-1 h-3.5 w-3.5" /> Link an account
          </Button>
        )}
      </header>
      <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Company</th>
              <th className="px-3 py-1.5 font-medium">Contact</th>
              <th className="px-3 py-1.5 font-medium">Captured</th>
              <th className="px-3 py-1.5 font-medium">Captured by</th>
              <th className="px-3 py-1.5 font-medium">Date</th>
              <th className="px-3 py-1.5 font-medium">Stage</th>
              {canSeeMoney && <th className="px-3 py-1.5 text-right font-medium">Value</th>}
              <th className="px-3 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {detail.accounts.length === 0 && (
              <tr>
                <td colSpan={canSeeMoney ? 8 : 7} className="px-3 py-6 text-muted-foreground">
                  Nothing attributed to this show yet. <strong>Leave a voice note</strong> or{" "}
                  <strong>Capture a lead</strong> at the top to add one.
                </td>
              </tr>
            )}
            {detail.accounts.map((a) => (
              <tr key={a.id} className="hover:bg-muted/30">
                <td className="px-3 py-1.5">
                  <Link
                    to="/accounts/$id"
                    params={{ id: a.id }}
                    className="entity-link font-semibold"
                  >
                    {a.name}
                  </Link>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{a.contact_name ?? "—"}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    {unreviewedAccountIds.has(a.id) && (
                      <span
                        className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                        title="A capture nobody has written up yet. It is in the review queue above."
                      >
                        Unreviewed
                      </span>
                    )}
                    {formAccountIds.has(a.id) && (
                      <span
                        className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                        title="Came in through the show's intake form"
                      >
                        Form
                      </span>
                    )}
                    <CapturedCell
                      badge={captured.get(a.id)?.badge ?? null}
                      photo={captured.get(a.id)?.photo ?? null}
                      audio={captured.get(a.id)?.audio ?? null}
                      onOpenPhoto={setLightbox}
                    />
                  </div>
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {a.assigned_rep ? (detail.repNames[a.assigned_rep] ?? "—") : "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                  {dayLabel(a.created_at)}
                </td>
                <td className="px-3 py-1.5">
                  <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">
                    {(a.stage ?? a.status ?? "—").replace(/_/g, " ")}
                  </span>
                </td>
                {canSeeMoney && (
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {a.estimated_annual_value != null ? showMoney(a.estimated_annual_value) : "—"}
                  </td>
                )}
                <td className="px-3 py-1.5 text-right">
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      disabled={app.writesDisabled}
                      onClick={() => unlink.mutate(a.id)}
                      title="Remove from this show"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <LeadPhotoLightbox media={lightbox} onClose={() => setLightbox(null)} />

      {linking && (
        <LinkAccountDialog
          tradeshowId={detail.show.id}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function LinkAccountDialog({
  tradeshowId,
  onClose,
  onLinked,
}: {
  tradeshowId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [term, setTerm] = React.useState("");
  const resultsQ = useQuery({
    queryKey: ["tradeshow-link-search", term],
    queryFn: () => searchAccountsForShow(term.trim()),
  });

  const link = useMutation({
    mutationFn: (accountId: string) => linkAccountToShow(accountId, tradeshowId),
    onSuccess: () => {
      toast.success("Account attributed to this show");
      onLinked();
    },
    onError: (e) => toastDbError(e, { action: "link account" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6">
      <div className="w-full max-w-lg rounded-xl border bg-card shadow-lg">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <h3 className="text-[14px] font-bold">Link an existing account</h3>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="p-4">
          <Input
            autoFocus
            placeholder="Search accounts…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="h-8"
          />
          <div className="mt-2 max-h-72 divide-y overflow-y-auto rounded-md border">
            {(resultsQ.data ?? []).length === 0 && (
              <p className="px-3 py-4 text-[12px] text-muted-foreground">No matches.</p>
            )}
            {(resultsQ.data ?? []).map((a) => (
              <button
                key={a.id}
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-hover"
                onClick={() => link.mutate(a.id)}
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{a.name}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground">
                    {[a.city, a.state].filter(Boolean).join(", ")}
                  </span>
                </span>
                {a.tradeshow_id && a.tradeshow_id !== tradeshowId && (
                  <span className="shrink-0 text-[11px] text-warning">already on another show</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function JobsPanel({
  detail,
  canSeeMoney,
}: {
  detail: Awaited<ReturnType<typeof fetchTradeshowDetail>>;
  canSeeMoney: boolean;
}) {
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-[14px] font-bold">
          Jobs from this show <span className="text-muted-foreground">({detail.jobs.length})</span>
        </h2>
      </header>
      <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">Job</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
              <th className="px-3 py-1.5 font-medium">Created</th>
              {canSeeMoney && <th className="px-3 py-1.5 text-right font-medium">Value</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {detail.jobs.length === 0 && (
              <tr>
                <td colSpan={canSeeMoney ? 4 : 3} className="px-3 py-6 text-muted-foreground">
                  No jobs attributed yet.
                </td>
              </tr>
            )}
            {detail.jobs.map((j) => (
              <tr key={j.id} className="hover:bg-muted/30">
                <td className="px-3 py-1.5">
                  <Link to="/jobs/$id" params={{ id: j.id }} className="entity-link font-semibold">
                    {j.job_number ?? j.name}
                  </Link>
                  {j.job_number && (
                    <div className="text-[11px] text-muted-foreground">{j.name}</div>
                  )}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">
                  {(j.status ?? "—").replace(/_/g, " ")}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                  {dayLabel(j.created_at)}
                </td>
                {canSeeMoney && (
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {j.value != null ? showMoney(j.value) : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function AttendeesPanel({
  detail,
  canManage,
  onChanged,
}: {
  detail: Awaited<ReturnType<typeof fetchTradeshowDetail>>;
  canManage: boolean;
  onChanged: () => void;
}) {
  const app = useAppContext();
  const [picked, setPicked] = React.useState<EntityOption | null>(null);

  const add = useMutation({
    mutationFn: (userId: string) =>
      addShowAttendee(detail.show.id, userId, null, app.userId ?? null),
    onSuccess: () => {
      setPicked(null);
      toast.success("Attendee added");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "add attendee" }),
  });

  const remove = useMutation({
    mutationFn: removeShowAttendee,
    onSuccess: () => onChanged(),
    onError: (e) => toastDbError(e, { action: "remove attendee" }),
  });

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-[14px] font-bold">
          Attendees <span className="text-muted-foreground">({detail.attendees.length})</span>
        </h2>
      </header>
      <div className="divide-y">
        {detail.attendees.length === 0 && (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">No one recorded yet.</p>
        )}
        {detail.attendees.map((a) => (
          <div key={a.id} className="flex items-center justify-between px-4 py-2 text-[13px]">
            <span className="min-w-0 truncate">
              {a.name}
              {a.role_note && (
                <span className="ml-2 text-[11px] text-muted-foreground">{a.role_note}</span>
              )}
            </span>
            {canManage && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                disabled={app.writesDisabled}
                onClick={() => remove.mutate(a.id)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="flex items-end gap-2 border-t p-3">
          <div className="min-w-0 flex-1">
            <EntityPicker
              kind="user"
              value={picked}
              onChange={setPicked}
              label="Add a rep"
              allowCreate={false}
              disabled={app.writesDisabled}
            />
          </div>
          <Button
            size="sm"
            className="h-8"
            disabled={!picked || app.writesDisabled}
            onClick={() => picked && add.mutate(picked.id)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function NotesPanel({
  detail,
  onChanged,
}: {
  detail: Awaited<ReturnType<typeof fetchTradeshowDetail>>;
  onChanged: () => void;
}) {
  const app = useAppContext();
  const [body, setBody] = React.useState("");

  const add = useMutation({
    mutationFn: () => addShowNote(detail.show.id, body.trim(), app.userId!),
    onSuccess: () => {
      setBody("");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "add note" }),
  });

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="border-b px-4 py-2.5">
        <h2 className="text-[14px] font-bold">Show timeline</h2>
      </header>
      <div className="space-y-2 p-3">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What happened at the show…"
          className="min-h-[64px] text-[13px]"
          disabled={app.writesDisabled}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-7"
            disabled={!body.trim() || app.writesDisabled || !app.userId}
            onClick={() => add.mutate()}
          >
            Add note
          </Button>
        </div>
      </div>
      <div className="divide-y border-t">
        {detail.show.notes && (
          <div className="px-4 py-2.5 text-[13px]">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Show notes
            </div>
            <p className="whitespace-pre-wrap">{detail.show.notes}</p>
          </div>
        )}
        {detail.notes.length === 0 && !detail.show.notes && (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">Nothing logged yet.</p>
        )}
        {detail.notes.map((n) => (
          <div key={n.id} className="px-4 py-2.5 text-[13px]">
            <div className="text-[11px] text-muted-foreground">
              {n.author ?? "Someone"} · {dayLabel(n.created_at)}
            </div>
            <p className="whitespace-pre-wrap">{n.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
