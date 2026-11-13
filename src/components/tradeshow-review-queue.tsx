/**
 * The post-show review pass: going over the voice notes and card photos.
 *
 * The other half of how Mark works a show. At the booth he photographs a card
 * or talks, and moves on; afterwards he sits down with a laptop and turns each
 * capture into a lead.
 * So this is built for a keyboard and a pair of headphones, not for a thumb:
 * space plays and pauses the note in hand, typing goes straight into the
 * fields beside it, and Enter saves and drops him onto the next one without
 * the page moving under him.
 *
 * Oldest first, because that is the order he met people in and the notes refer
 * to each other ("the guy before this one"). Skipping is a step past, never a
 * removal — a skipped note comes back round at the end of the queue, and an
 * unreviewed capture stays here indefinitely.
 *
 * A card photo can be read here too. The booth screen reads it the moment it
 * is taken, but a read that was offline, refused, or still in flight when the
 * lead was queued has nothing to land on until now; "Read card" runs
 * `readCard` on the stored photo and puts what it finds into the empty
 * fields of the open form. It is the second of the two routes the reader's
 * contract names, and the one that always works: the photo is on the lead.
 * The read lives in this sitting only — Save writes the fields, so there is
 * nothing to store.
 */
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Barcode, Check, ChevronRight, Loader2, ScanText, SkipForward } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VoiceNotePlayer, type VoiceNotePlayerHandle } from "@/components/voice-note-field";
import { BADGE_ID_ONLY, badgeIsLead, badgeSummary, parseBadgePayload } from "@/lib/badge-payload";
import { fillLeadFromCard, readCard } from "@/lib/business-card-reader";
import { toastDbError } from "@/lib/db-errors";
import { useOptionList } from "@/lib/option-lists";
import {
  CARD_READ_TEXT,
  cardReadOutcome,
  cardReadSummary,
  type CardReadState,
} from "@/lib/tradeshow-card-read";
import {
  fetchLeadMediaBlob,
  mediaByAccount,
  useLeadMediaUrl,
  waveformPeaks,
} from "@/lib/tradeshow-capture";
import {
  EMPTY_REVIEW_FIELDS,
  buildReviewQueue,
  pickNextForReview,
  reviewProgress,
  saveReviewedCapture,
  validateReviewFields,
  type CaptureStateRow,
  type ReviewEntry,
  type ReviewFields,
} from "@/lib/tradeshow-review";
import type { TradeshowDetail } from "@/lib/tradeshows";
import { cn } from "@/lib/utils";

const timeLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      });
};

export function TradeshowReviewQueue({
  detail,
  states,
  available,
  onChanged,
}: {
  detail: TradeshowDetail;
  states: CaptureStateRow[];
  /** False when the capture table is not in this database yet. */
  available: boolean;
  onChanged: () => void;
}) {
  const app = useAppContext();
  const sources = useOptionList("lead_source");

  const media = React.useMemo(() => mediaByAccount(detail.media), [detail.media]);
  const entries = React.useMemo(
    () => buildReviewQueue({ accounts: detail.accounts, states, media }),
    [detail.accounts, states, media],
  );
  const progress = reviewProgress(entries);

  const [openId, setOpenId] = React.useState<string | null>(null);
  const [skipped, setSkipped] = React.useState<ReadonlySet<string>>(() => new Set());
  const [fields, setFields] = React.useState<ReviewFields>(EMPTY_REVIEW_FIELDS);
  const [cardReads, setCardReads] = React.useState<ReadonlyMap<string, CardReadState>>(
    () => new Map(),
  );
  const playerRef = React.useRef<VoiceNotePlayerHandle | null>(null);
  // Which form is open when a read lands, not when it was started: he may
  // have opened the row (or moved on) while the model was looking.
  const openIdRef = React.useRef<string | null>(null);
  openIdRef.current = openId;

  const open = entries.find((e) => e.accountId === openId) ?? null;

  const openEntry = React.useCallback(
    (entry: ReviewEntry | null) => {
      setOpenId(entry?.accountId ?? null);
      let next: ReviewFields = entry
        ? { ...EMPTY_REVIEW_FIELDS, ...entry.prefill, leadSourceId: null }
        : EMPTY_REVIEW_FIELDS;
      // A card already read this sitting fills whatever the account is
      // still missing, the same way the badge does in the prefill.
      const read = entry ? cardReads.get(entry.accountId) : undefined;
      if (read && read.status === "read") next = fillLeadFromCard(next, read.read).details;
      setFields(next);
    },
    [cardReads],
  );

  /**
   * Read the stored card photo. The badge's raw payload rides along as the
   * QR half when there is one, so the photo is not searched for a code it
   * already gave up at the booth. What comes back goes into the open form's
   * empty fields; a form opened later gets it from `openEntry`.
   */
  const readCardFor = async (entry: ReviewEntry) => {
    const path = entry.badgePhoto?.storage_path ?? entry.photo?.storage_path;
    if (!path) return;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    setCardReads((m) => new Map(m).set(entry.accountId, { status: "reading" }));
    let outcome: CardReadState;
    try {
      const blob = await fetchLeadMediaBlob(path);
      const read = await readCard(blob, { qrRaw: entry.badgeRaw, offline });
      outcome = cardReadOutcome(read, { offline });
    } catch {
      outcome = { status: "failed", read: null };
    }
    setCardReads((m) => new Map(m).set(entry.accountId, outcome));
    if (outcome.status === "read") {
      const read = outcome.read;
      if (openIdRef.current === entry.accountId) {
        setFields((cur) => fillLeadFromCard(cur, read).details);
      }
      const summary = cardReadSummary(read);
      toast.success(summary ? `Card read — ${summary}` : "Nothing readable on that card.");
    } else if (outcome.status === "failed") {
      toast.error(CARD_READ_TEXT.failed);
    }
  };

  // A capture that is saved elsewhere (another tab, a queue drain) must not
  // leave a stale form open against it.
  React.useEffect(() => {
    if (openId && !entries.some((e) => e.accountId === openId && e.needsReview)) {
      setOpenId(null);
    }
  }, [entries, openId]);

  const save = useMutation({
    mutationFn: async (entry: ReviewEntry) => {
      const problem = validateReviewFields(fields);
      if (problem) throw new Error(problem);
      if (!app.userId) throw new Error("Sign in first.");
      const locationId =
        detail.show.location_id ?? app.currentLocationId ?? app.memberships[0]?.location_id ?? null;
      if (!locationId) throw new Error("This show has no office.");
      await saveReviewedCapture({
        accountId: entry.accountId,
        locationId,
        userId: app.userId,
        fields,
        contactId: entry.contactId,
      });
      return entry;
    },
    onSuccess: (entry) => {
      playerRef.current?.pause();
      toast.success(`${fields.company.trim() || fields.name.trim()} written up`);
      // Advance from the local list rather than waiting for the refetch: the
      // point of "Save and next" is that the next note is already playing.
      const advanced = entries.map((e) =>
        e.accountId === entry.accountId ? { ...e, needsReview: false } : e,
      );
      openEntry(pickNextForReview(advanced, { after: entry.accountId, skipped }));
      onChanged();
    },
    onError: (e) =>
      e instanceof Error && !("code" in e)
        ? toast.error(e.message)
        : toastDbError(e, { action: "save the lead" }),
  });

  const skip = (entry: ReviewEntry) => {
    const next = new Set(skipped);
    next.add(entry.accountId);
    setSkipped(next);
    playerRef.current?.pause();
    openEntry(pickNextForReview(entries, { after: entry.accountId, skipped: next }));
  };

  /**
   * Space plays and pauses, Enter saves — but only where they are not already
   * doing a job. Space inside a text field is a space; Enter inside the notes
   * box is a new line, so that one wants the modifier.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    // A control the key already means something on keeps its own meaning:
    // stealing Enter from a focused Skip button would save instead of skip,
    // which is the opposite of what the finger asked for.
    const ownsTheKey = tag === "BUTTON" || tag === "A" || tag === "SELECT";

    // Ctrl/Cmd+Space reaches the player from anywhere, including mid-sentence
    // in a field — which is where the cursor actually is while he types a note
    // up, so a bare Space there has to stay a space.
    if (e.key === " " && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      playerRef.current?.toggle();
      return;
    }
    if (ownsTheKey) return;

    if (e.key === " " && !typing) {
      e.preventDefault();
      playerRef.current?.toggle();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (tag === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      if (!save.isPending) save.mutate(open);
    }
  };

  if (!available) {
    return (
      <section className="rounded-xl border bg-card px-4 py-3 text-[13px] shadow-sm">
        <h2 className="text-[14px] font-bold">Capture review</h2>
        <p className="mt-1 text-muted-foreground">
          The review queue needs a database update that has not been applied here yet. Captures are
          still saved as leads on this show in the meantime — nothing is lost, it just cannot be
          listed as unreviewed until then.
        </p>
      </section>
    );
  }

  if (entries.length === 0) return null;

  const pending = entries.filter((e) => e.needsReview);

  return (
    <section
      className="rounded-xl border bg-card shadow-sm"
      onKeyDown={onKeyDown}
      aria-label="Capture review queue"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div>
          <h2 className="text-[14px] font-bold">
            Capture review <span className="text-muted-foreground">({progress.label})</span>
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Oldest first. Space plays (Ctrl/Cmd+Space while typing), Enter saves and opens the next.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-success transition-all"
              style={{
                width: `${progress.total ? (progress.reviewed / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          {pending.length > 0 && (
            <Button
              size="sm"
              className="h-8"
              disabled={app.writesDisabled}
              onClick={() => openEntry(pickNextForReview(entries, { skipped }))}
            >
              {open ? "Jump to next" : "Start reviewing"} <ChevronRight className="ml-1 size-4" />
            </Button>
          )}
        </div>
      </header>

      {pending.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted-foreground">
          Every capture on this show has been written up.
        </p>
      ) : (
        <ul className="divide-y">
          {pending.map((entry) => (
            <li
              key={entry.accountId}
              className={cn(open?.accountId === entry.accountId && "bg-muted/30")}
            >
              <ReviewRow
                entry={entry}
                open={open?.accountId === entry.accountId}
                skipped={skipped.has(entry.accountId)}
                playerRef={open?.accountId === entry.accountId ? playerRef : undefined}
                cardRead={cardReads.get(entry.accountId) ?? null}
                onReadCard={app.writesDisabled ? undefined : () => void readCardFor(entry)}
                onOpen={() => openEntry(entry)}
              />
              {open?.accountId === entry.accountId && (
                <div className="border-t bg-card px-4 py-3">
                  <ReviewFieldsForm
                    fields={fields}
                    onChange={setFields}
                    sources={sources.options}
                    disabled={save.isPending}
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-10"
                      disabled={save.isPending}
                      onClick={() => skip(entry)}
                    >
                      <SkipForward className="mr-1.5 size-4" /> Skip for now
                    </Button>
                    <div className="flex items-center gap-2">
                      <span className="hidden text-[11px] text-muted-foreground sm:inline">
                        Enter saves
                      </span>
                      <Button
                        type="button"
                        className="h-10 px-6"
                        disabled={save.isPending || app.writesDisabled}
                        onClick={() => save.mutate(entry)}
                      >
                        {save.isPending ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Check className="mr-2 size-4" />
                        )}
                        Save and next
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ReviewRow({
  entry,
  open,
  skipped,
  playerRef,
  cardRead,
  onReadCard,
  onOpen,
}: {
  entry: ReviewEntry;
  open: boolean;
  skipped: boolean;
  playerRef?: React.MutableRefObject<VoiceNotePlayerHandle | null>;
  cardRead: CardReadState | null;
  onReadCard?: () => void;
  onOpen: () => void;
}) {
  const audioQ = useLeadMediaUrl(entry.audio?.storage_path ?? null);
  const photoQ = useLeadMediaUrl(
    entry.photo ? (entry.photo.thumb_path ?? entry.photo.storage_path) : null,
  );
  const badgeQ = useLeadMediaUrl(entry.badgePhoto?.storage_path ?? null);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-[9rem] flex-col items-start text-left"
        aria-expanded={open}
      >
        <span className="text-[13px] font-semibold">{timeLabel(entry.capturedAt)}</span>
        <span className="text-[11px] text-muted-foreground">
          {open ? "Open" : skipped ? "Skipped — come back to it" : "Not written up"}
        </span>
      </button>

      <PhotoChip url={photoQ.data} title="Photo taken with them" />
      <PhotoChip url={badgeQ.data} title="Badge or business card" />

      {entry.audio ? (
        <VoiceNotePlayer
          ref={playerRef}
          src={audioQ.data ?? null}
          peaks={waveformPeaks(entry.audio)}
          durationSec={Number(entry.audio.duration_seconds ?? 0)}
          autoPlay={open}
          className="min-w-[14rem] flex-1"
        />
      ) : entry.badgePhoto || entry.photo ? (
        <span className="flex-1 text-[12px] text-muted-foreground">
          Card photo only — open it and read the details off.
        </span>
      ) : (
        <span className="flex-1 text-[12px] text-muted-foreground">
          No recording reached the server for this one — the capture is still here so it is not
          lost.
        </span>
      )}

      {entry.badgeRaw && <BadgeChip raw={entry.badgeRaw} />}

      {(entry.badgePhoto || entry.photo) && <CardReadChip state={cardRead} onRead={onReadCard} />}

      {!open && (
        <Button size="sm" variant="outline" className="h-8" onClick={onOpen}>
          Write it up
        </Button>
      )}
    </div>
  );
}

/**
 * A decoded contact card reads as the person; an attendee id says what it is
 * and where the details actually live, so an empty row is not a mystery.
 */
function BadgeChip({ raw }: { raw: string }) {
  const parsed = parseBadgePayload(raw);
  if (badgeIsLead(parsed)) {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary"
        title="From the badge. The fields below start from it."
      >
        <Barcode className="size-3.5 shrink-0" />
        <span className="truncate">{badgeSummary(parsed.fields)}</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px]"
      title={`Exactly what the badge encoded: ${raw}`}
    >
      <Barcode className="size-3.5 shrink-0" />
      <span className="truncate">
        <span className="font-mono">{raw}</span>
        <span className="text-muted-foreground"> · {BADGE_ID_ONLY}</span>
      </span>
    </span>
  );
}

/**
 * What the card photo has been read as — this sitting — and the button to
 * (re)read it. "Not read" is the honest default: the booth read, if there
 * was one, has already landed on the account and shows in the prefill; what
 * this chip tracks is a read started here.
 */
function CardReadChip({ state, onRead }: { state: CardReadState | null; onRead?: () => void }) {
  const reading = state?.status === "reading";
  const summary = state && "read" in state ? cardReadSummary(state.read) : "";
  const label = !state
    ? "Not read"
    : state.status === "reading"
      ? "Reading…"
      : state.status === "failed"
        ? CARD_READ_TEXT.failed
        : state.status === "pending"
          ? CARD_READ_TEXT.pending
          : summary || "Nothing readable on it";
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px]",
          state?.status === "read" && summary
            ? "bg-primary/10 font-medium text-primary"
            : "bg-muted",
          state?.status === "failed" && "text-warning",
        )}
        title={
          state?.status === "read"
            ? "Read off the card photo. The fields start from it."
            : undefined
        }
      >
        {reading ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <ScanText className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </span>
      {onRead && (
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-[12px]"
          disabled={reading}
          onClick={onRead}
          title="Read the name, company, phone and email off the card photo"
        >
          {state && state.status !== "reading" ? "Read again" : "Read card"}
        </Button>
      )}
    </span>
  );
}

function PhotoChip({ url, title }: { url: string | undefined; title: string }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" title={title}>
      <img
        src={url}
        alt={title}
        loading="lazy"
        className="size-11 shrink-0 rounded-md border object-cover"
      />
    </a>
  );
}

function ReviewFieldsForm({
  fields,
  onChange,
  sources,
  disabled,
}: {
  fields: ReviewFields;
  onChange: (v: ReviewFields) => void;
  sources: { id: string; label: string }[];
  disabled?: boolean;
}) {
  const set =
    (k: keyof ReviewFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({ ...fields, [k]: e.target.value });
  const problem = validateReviewFields(fields);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Their name">
          <Input
            autoFocus
            className="h-11 text-[15px]"
            value={fields.name}
            onChange={set("name")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="Company">
          <Input
            className="h-11 text-[15px]"
            value={fields.company}
            onChange={set("company")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="Phone">
          <Input
            className="h-11 text-[15px]"
            type="tel"
            inputMode="tel"
            value={fields.phone}
            onChange={set("phone")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="Email">
          <Input
            className="h-11 text-[15px]"
            type="email"
            inputMode="email"
            value={fields.email}
            onChange={set("email")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="Lead source">
          <select
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-[15px]"
            value={fields.leadSourceId ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ ...fields, leadSourceId: e.target.value || null })}
          >
            <option value="">Leave as captured (Tradeshow)</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes — what he said, in writing">
        <Textarea
          className="min-h-[76px] text-[15px]"
          value={fields.notes}
          onChange={set("notes")}
          disabled={disabled}
          placeholder="Shift+Enter or Ctrl+Enter here; plain Enter saves."
        />
      </Field>
      <p className={cn("text-[12px]", problem ? "text-muted-foreground" : "text-success")}>
        {problem ?? "Enough to save. Enter saves and opens the next note."}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[12px]">{label}</Label>
      {children}
    </div>
  );
}
