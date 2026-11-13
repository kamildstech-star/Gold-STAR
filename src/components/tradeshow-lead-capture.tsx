/**
 * "Capture a lead" — the booth screen.
 *
 * This used to be a four-step wizard (badge, photo, voice note, details) with
 * a Skip on every step. Mark, looking at it: "This is good, but he wants to be
 * able to just dump info into a section and press save. It shouldn't have the
 * skip, skip, skip, because when you're in a tradeshow everything's rushed."
 * And on what the capture actually is: "So can take a picture of a business
 * card, and leave a voice note, Then it goes into Leads & accounts from this
 * show for review."
 *
 * So: one screen. The camera is first — the page button that opens this also
 * fires the camera in the same tap, so on a phone the viewfinder is up before
 * the dialog has finished animating in. Under it, a badge scan and an optional
 * voice note. The typed fields are folded away under "Add details" for anyone
 * who wants them; nothing asks for them. One Save, live as soon as there is a
 * card photo, a badge or a recording, and the lead lands in the show's list
 * flagged for the review pass to read the card, play the note and fill the
 * fields in.
 *
 * The badge is the one capture that can fill the fields itself. Mark scanned
 * an MFO Summit badge and got a full contact card back, and the page only
 * said it would ride on the next voice note: "this gave me a contact card but
 * it didnt let me add the lead once scanned, there is no add lead button to
 * save it." So a badge that decodes to a vCard or MECARD prefills name,
 * company, email and phone — marked as from the badge, editable — opens the
 * details so he sees what came in, and Save is live. A badge that decodes to
 * an attendee id is kept verbatim and says so; nothing is guessed from it.
 *
 * The card photo is read too. Mark: "also the scanner needs to be able to
 * scan business cards as well with qr codes and without." The moment the
 * photo is taken, `readCard` runs on it — a QR code on the device, the
 * printed text through the model — and the fields it finds land in the
 * details the same way a badge's do, marked "from card", with a "check this"
 * on any the reader was unsure of. It is fire-and-forget: the thumbnail says
 * "Reading card…" and Save is live the whole time. A rep who saves first
 * still gets the read — it is written onto the lead when it arrives
 * (`applyLateCardRead`), or read again from the review queue. Offline, the
 * photo says "Will read when online" and the read reruns when the signal
 * comes back; a refused read says so and the photo stays on the lead for the
 * review pass. Who wins when a badge and the card both supply a field is
 * decided in `tradeshow-card-read.ts`: typed, then badge, then card.
 *
 * After Save the screen empties and stays open: the next person is already
 * standing there. "Done" is how you leave.
 *
 * The voice note is not transcribed. The recording is attached to the lead
 * as it is, for a person to go over later — see `tradeshow-review.ts`.
 * Saving goes through the offline queue, so a hall with no signal holds the
 * capture on the phone.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Barcode,
  Camera,
  Check,
  ChevronDown,
  CloudOff,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { BadgeScanSheet } from "@/components/badge-scan-sheet";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VoiceNoteField } from "@/components/voice-note-field";
import {
  BADGE_ID_ONLY,
  badgeIsLead,
  badgeSummary,
  parseBadgePayload,
  type BadgePayload,
} from "@/lib/badge-payload";
import { toastDbError } from "@/lib/db-errors";
import { useOptionList } from "@/lib/option-lists";
import { fetchPipelines, fetchStages, resolvePipeline } from "@/lib/pipeline";
import {
  applyBadgeFields,
  applyCardRead,
  badgeRawToStore,
  cardReadLabel,
  cardReadSummary,
  editDetails,
  startCardRead,
  takeBackFields,
  type CardReadState,
  type FieldFlags,
  type FieldSource,
  type FieldState,
  type FilledBy,
  type InflightRead,
} from "@/lib/tradeshow-card-read";
import {
  EMPTY_LEAD_DETAILS,
  applyLateCardRead,
  buildLeadPayload,
  captureTradeshowLead,
  findTradeshowLeadSourceId,
  leadAccountName,
  pickCaptureStage,
  preparePhoto,
  validateBoothCapture,
  type CapturedAudio,
  type CapturedPhoto,
  type LeadDetails,
} from "@/lib/tradeshow-capture";
import type { Tradeshow } from "@/lib/tradeshows";
import { cn } from "@/lib/utils";

export type TradeshowLeadCaptureHandle = {
  /**
   * Fire the camera. Must be called from inside the user's tap — a file input
   * only opens on a user gesture — which is why the page button calls this
   * synchronously alongside opening the dialog rather than the dialog trying
   * to do it from an effect after it mounts.
   */
  openCamera: () => void;
  /**
   * Open with a badge already scanned — the page's standalone Scan badge
   * hands a decoded contact card here instead of parking it on the next
   * voice note. Call it just before setting `open`; the badge is applied
   * once the screen has reset for the new lead.
   */
  openWithBadge: (raw: string) => void;
};

/** What a scan left on the screen. */
type ScannedBadge = { raw: string; parsed: BadgePayload };

const EMPTY_FIELDS: FieldState = { details: EMPTY_LEAD_DETAILS, filledBy: {}, uncertain: {} };

export const TradeshowLeadCapture = React.forwardRef<
  TradeshowLeadCaptureHandle,
  {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    show: Tradeshow;
    onSaved: () => void;
  }
>(function TradeshowLeadCapture({ open, onOpenChange, show, onSaved }, ref) {
  const app = useAppContext();
  const [card, setCard] = React.useState<CapturedPhoto | null>(null);
  const [cardBusy, setCardBusy] = React.useState(false);
  const [cardRead, setCardRead] = React.useState<CardReadState | null>(null);
  const [audio, setAudio] = React.useState<CapturedAudio | null>(null);
  const [fields, setFields] = React.useState<FieldState>(EMPTY_FIELDS);
  const [badge, setBadge] = React.useState<ScannedBadge | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [lastSaved, setLastSaved] = React.useState<{ name: string; queued: boolean } | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const pendingBadgeRef = React.useRef<string | null>(null);
  const inflightRef = React.useRef<InflightRead | null>(null);
  const readSeq = React.useRef(0);
  const details = fields.details;

  const locationId =
    show.location_id ?? app.currentLocationId ?? app.memberships[0]?.location_id ?? null;

  const clear = React.useCallback(() => {
    // A read still in flight belongs to the lead just saved (Save took it)
    // or to a photo that is gone; either way it must not land on this screen.
    readSeq.current += 1;
    inflightRef.current = null;
    setCard(null);
    setCardRead(null);
    setAudio(null);
    setBadge(null);
    setFields(EMPTY_FIELDS);
    setDetailsOpen(false);
    setSaving(false);
  }, []);

  /**
   * A decoded contact card goes straight into the fields, over whatever is
   * still empty and over what the card read put there — never over something
   * the rep has typed — and the details open so he sees what came in. An
   * opaque badge is kept and said so.
   */
  const applyBadge = React.useCallback((raw: string) => {
    const parsed = parseBadgePayload(raw);
    setBadge({ raw, parsed });
    if (!badgeIsLead(parsed)) return;
    setFields((cur) => applyBadgeFields(cur, parsed.fields));
    setDetailsOpen(true);
  }, []);

  /**
   * Read the card. Fire-and-forget: the state goes to "reading" and the
   * screen carries on. The result is applied only if this is still the
   * photo it was read from — a retake, a removal or a Save each move the
   * sequence on, and a stale result is dropped (Save keeps its own handle on
   * the promise, below). Offline, the QR half still runs and its fields land;
   * the printed text waits for the signal.
   */
  const beginCardRead = React.useCallback((photo: CapturedPhoto) => {
    const seq = ++readSeq.current;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    setCardRead({ status: "reading" });
    inflightRef.current = startCardRead(photo.blob, {
      offline,
      stillWanted: () => seq === readSeq.current,
      onOutcome: (outcome, read) => {
        inflightRef.current = null;
        setCardRead(outcome);
        if (read && (outcome.status === "read" || outcome.status === "pending")) {
          setFields((cur) => applyCardRead(cur, read));
          if (cardReadSummary(read)) setDetailsOpen(true);
        }
      },
    });
  }, []);

  // "Will read when online" means it: the signal coming back reruns the read
  // on the photo that is still here. One that was saved meanwhile is the
  // review queue's to read.
  React.useEffect(() => {
    if (!card || cardRead?.status !== "pending" || typeof window === "undefined") return;
    const photo = card;
    const rerun = () => beginCardRead(photo);
    window.addEventListener("online", rerun);
    return () => window.removeEventListener("online", rerun);
  }, [card, cardRead?.status, beginCardRead]);

  React.useEffect(() => {
    if (open) {
      clear();
      setLastSaved(null);
      if (pendingBadgeRef.current) {
        applyBadge(pendingBadgeRef.current);
        pendingBadgeRef.current = null;
      }
    }
  }, [open, clear, applyBadge]);

  React.useImperativeHandle(
    ref,
    () => ({
      openCamera: () => inputRef.current?.click(),
      openWithBadge: (raw) => {
        pendingBadgeRef.current = raw;
      },
    }),
    [],
  );

  const clearBadge = () => {
    setBadge(null);
    // Take back only what the badge put in; anything he typed over it stays.
    setFields((cur) => takeBackFields(cur, "badge"));
  };

  const clearCard = () => {
    readSeq.current += 1;
    inflightRef.current = null;
    setCard(null);
    setCardRead(null);
    setFields((cur) => takeBackFields(cur, "card"));
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setCardBusy(true);
    try {
      const photo = await preparePhoto(f);
      setCard(photo);
      // A retake replaces the read as well as the picture.
      setFields((cur) => takeBackFields(cur, "card"));
      beginCardRead(photo);
    } finally {
      setCardBusy(false);
    }
  };

  // Where the lead lands and what it is tagged as. Both are best-effort: a
  // lead with no stage is still a lead, and the show is stamped on it either way.
  const sources = useOptionList("lead_source");
  const leadSourceId = findTradeshowLeadSourceId(sources.options);
  const stageQ = useQuery({
    queryKey: ["tradeshow-capture-stage", locationId],
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const pipelines = await fetchPipelines("account");
      const pipeline = resolvePipeline(pipelines, locationId);
      if (!pipeline) return { pipelineId: null, stageId: null };
      const stages = await fetchStages(pipeline.id);
      return { pipelineId: pipeline.id, stageId: pickCaptureStage(stages)?.id ?? null };
    },
  });

  const verdict = validateBoothCapture({
    details,
    hasPhoto: !!card,
    hasAudio: !!audio,
    hasBadge: !!badge,
  });
  const canSave = !verdict.problem && !saving && !app.writesDisabled && !!app.userId;

  const save = async () => {
    if (verdict.problem) {
      toast.error(verdict.problem);
      return;
    }
    if (!app.userId) return;
    if (!locationId) {
      toast.error("This show has no office and neither do you — pick an office on the show first.");
      return;
    }
    setSaving(true);
    // A read still in flight is not waited for. Save takes the handle; the
    // result is written onto the lead when it lands (`applyLateCardRead`),
    // or, for a lead the queue is holding, read again from the review pass.
    const inflight = inflightRef.current;
    const readSoFar = cardRead && "read" in cardRead ? cardRead.read : null;
    try {
      const { payload, blobs } = buildLeadPayload({
        tradeshowId: show.id,
        tradeshowName: show.name,
        locationId,
        userId: app.userId,
        details,
        photo: null,
        badge: card,
        audio,
        leadSourceId,
        stageId: stageQ.data?.stageId ?? null,
        pipelineId: stageQ.data?.pipelineId ?? null,
        needsReview: verdict.needsReview,
        badgeRaw: badgeRawToStore(badge?.raw ?? null, readSoFar),
      });
      const { queued } = await captureTradeshowLead(payload, blobs);
      setLastSaved({ name: leadAccountName(payload), queued });
      clear();
      onSaved();
      if (inflight && !queued) {
        void inflight.promise.then(async (read) => {
          if (!read || read.source === "none") return;
          try {
            const filled = await applyLateCardRead(payload, read);
            if (filled.length > 0) {
              toast.success(`Card read — ${cardReadSummary(read)} added to the lead`);
              onSaved();
            }
          } catch (err) {
            toastDbError(err, { action: "add the card's details to the lead" });
          }
        });
      }
    } catch (e) {
      toastDbError(e, { action: "save the lead" });
      setSaving(false);
    }
  };

  /**
   * Enter saves from any typed field, the way it does on the review queue.
   * The notes box keeps Enter for a new line and wants Ctrl/Cmd with it.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") return;
    if (tag === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (canSave) void save();
  };

  return (
    <>
      {/*
       * Outside the Dialog so it exists before the dialog does: the page's
       * "Capture a lead" tap clicks it through `openCamera` in the same
       * gesture. `capture="environment"` is the back camera — the one you
       * point at a card. A desktop browser ignores it and offers a file picker.
       */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => void onPick(e)}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[95dvh] w-[calc(100vw-1.5rem)] max-w-xl flex-col gap-0 overflow-hidden p-0"
          onKeyDown={onKeyDown}
        >
          <DialogHeader className="border-b px-4 py-3 text-left">
            <DialogTitle className="text-[17px]">Capture a lead · {show.name}</DialogTitle>
            <DialogDescription className="text-[12px]">
              A card photo, a badge scan, a voice note — any of them. Fill the details in after the
              show.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
            <CardPhotoControl
              value={card}
              read={cardRead}
              busy={cardBusy}
              disabled={saving}
              onRetake={() => inputRef.current?.click()}
              onClear={clearCard}
            />

            <BadgeControl
              value={badge}
              disabled={saving}
              onScan={() => setScanning(true)}
              onClear={clearBadge}
            />

            <VoiceNoteField value={audio} onChange={setAudio} disabled={saving} compact />

            <div className="rounded-xl border">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[14px] font-semibold"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((v) => !v)}
              >
                Add details <span className="font-normal text-muted-foreground">(optional)</span>
                <ChevronDown
                  className={cn("size-4 transition-transform", detailsOpen && "rotate-180")}
                />
              </button>
              {detailsOpen && (
                <div className="border-t px-4 py-3">
                  <DetailsFields
                    value={details}
                    onChange={(next) => setFields((cur) => editDetails(cur, next))}
                    disabled={saving}
                    filledBy={fields.filledBy}
                    uncertain={fields.uncertain}
                  />
                </div>
              )}
            </div>

            <p
              className={cn(
                "text-[12px]",
                verdict.problem ? "text-muted-foreground" : "text-success",
              )}
            >
              {verdict.problem ??
                (verdict.needsReview
                  ? "Ready to save. It goes into the show's leads for review."
                  : "That is enough to save.")}
            </p>
          </div>

          <footer className="flex items-center justify-between gap-2 border-t bg-card px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                className="h-12 px-4 text-[15px]"
                disabled={saving}
                onClick={() => onOpenChange(false)}
              >
                Done
              </Button>
              {lastSaved && <SavedChip result={lastSaved} />}
            </div>
            <Button
              className="h-12 shrink-0 px-6 text-[15px]"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 className="mr-2 size-5 animate-spin" />
              ) : (
                <Check className="mr-2 size-5" />
              )}
              {saving ? "Saving…" : "Save"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>
      <BadgeScanSheet open={scanning} onOpenChange={setScanning} onScanned={applyBadge} />
    </>
  );
});

/* ------------------------------------------------------------------ */

function BadgeControl({
  value,
  disabled,
  onScan,
  onClear,
}: {
  value: ScannedBadge | null;
  disabled?: boolean;
  onScan: () => void;
  onClear: () => void;
}) {
  if (value) {
    const lead = badgeIsLead(value.parsed) ? value.parsed.fields : null;
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted">
          <Barcode className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">
            {lead ? badgeSummary(lead) : "Badge scanned"}
          </div>
          <div className="text-[12px] text-muted-foreground">
            {lead ? (
              "From the badge — details filled in below."
            ) : value.parsed.kind === "url" ? (
              <span className="break-all">{value.raw}</span>
            ) : (
              <>
                <span className="font-mono text-foreground">{value.raw}</span> · {BADGE_ID_ONLY}
              </>
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10"
          disabled={disabled}
          onClick={onClear}
          title="Remove badge"
          aria-label="Remove badge"
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onScan}
      className={cn(
        "flex min-h-[64px] w-full items-center gap-3 rounded-xl border-2 border-dashed px-4 py-2 text-left",
        "hover:border-primary hover:bg-primary/5 disabled:opacity-50",
      )}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        <Barcode className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">Scan their badge</span>
        <span className="block text-[12px] text-muted-foreground">
          A badge with a contact card on it fills the lead in for you.
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */

function CardPhotoControl({
  value,
  read,
  busy,
  disabled,
  onRetake,
  onClear,
}: {
  value: CapturedPhoto | null;
  read: CardReadState | null;
  busy: boolean;
  disabled?: boolean;
  onRetake: () => void;
  onClear: () => void;
}) {
  const previewUrl = React.useMemo(() => (value ? URL.createObjectURL(value.blob) : null), [value]);
  React.useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (value && previewUrl) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card p-2">
        <img
          src={previewUrl}
          alt="Business card or badge"
          className="h-16 w-24 shrink-0 rounded-lg border bg-muted object-cover"
        />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">Card photo</div>
          <div
            className={cn(
              "flex items-center gap-1.5 text-[12px] text-muted-foreground",
              read?.status === "failed" && "text-warning",
            )}
            aria-live="polite"
          >
            {read?.status === "reading" && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
            {read?.status === "pending" && <CloudOff className="size-3.5 shrink-0" />}
            {read?.status === "failed" && <AlertTriangle className="size-3.5 shrink-0" />}
            <span className="min-w-0">{cardReadLabel(read)}</span>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-10"
          disabled={busy || disabled}
          onClick={onRetake}
          title="Retake"
        >
          <RotateCcw className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-10"
          disabled={disabled}
          onClick={onClear}
          title="Remove photo"
          aria-label="Remove photo"
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={onRetake}
      className={cn(
        "flex min-h-[64px] w-full items-center gap-3 rounded-xl border-2 border-dashed px-4 py-2 text-left",
        "hover:border-primary hover:bg-primary/5 disabled:opacity-50",
      )}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        {busy ? <Loader2 className="size-5 animate-spin" /> : <Camera className="size-5" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">Photograph their business card</span>
        <span className="block text-[12px] text-muted-foreground">
          Or their badge. Back camera; nothing to type.
        </span>
      </span>
    </button>
  );
}

function DetailsFields({
  value,
  onChange,
  disabled,
  filledBy,
  uncertain,
}: {
  value: LeadDetails;
  onChange: (v: LeadDetails) => void;
  disabled?: boolean;
  filledBy: FilledBy;
  uncertain: FieldFlags;
}) {
  const set =
    (k: keyof LeadDetails) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({ ...value, [k]: e.target.value });
  // A field the badge or the card filled is tinted the same way and says
  // which, and stays editable — the scan is a head start, not the last word.
  // One the reader was unsure of gets a warning edge on top.
  const fieldClass = (k: keyof LeadDetails) =>
    cn(
      "h-12 text-[16px]",
      filledBy[k] && "border-primary/50 bg-primary/5",
      uncertain[k] && "border-warning/70",
    );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Their name" source={filledBy.name} uncertain={uncertain.name}>
          <Input
            autoFocus
            className={fieldClass("name")}
            value={value.name}
            onChange={set("name")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="Company" source={filledBy.company} uncertain={uncertain.company}>
          <Input
            className={fieldClass("company")}
            value={value.company}
            onChange={set("company")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="Phone" source={filledBy.phone} uncertain={uncertain.phone}>
          <Input
            className={fieldClass("phone")}
            type="tel"
            inputMode="tel"
            value={value.phone}
            onChange={set("phone")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
        <Field label="Email" source={filledBy.email} uncertain={uncertain.email}>
          <Input
            className={fieldClass("email")}
            type="email"
            inputMode="email"
            value={value.email}
            onChange={set("email")}
            disabled={disabled}
            autoComplete="off"
          />
        </Field>
      </div>
      <Field label="Anything else" source={filledBy.notes}>
        <Textarea
          className={cn(
            "min-h-[60px] text-[15px]",
            filledBy.notes && "border-primary/50 bg-primary/5",
          )}
          value={value.notes}
          onChange={set("notes")}
          disabled={disabled}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  source,
  uncertain,
  children,
}: {
  label: string;
  /** Who put the value there, when it was not typed. */
  source?: FieldSource;
  /** The reader was not sure of this one. */
  uncertain?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-1.5 text-[12px]">
        {label}
        {source && (
          <span className="rounded bg-primary/10 px-1 py-px text-[10px] font-medium text-primary">
            {source === "badge" ? "from badge" : "from card"}
          </span>
        )}
        {uncertain && (
          <span
            className="rounded bg-warning/15 px-1 py-px text-[10px] font-medium text-warning"
            title="The reader was not sure of this one. Glance at the card."
          >
            check this
          </span>
        )}
      </Label>
      {children}
    </div>
  );
}

/**
 * The confirmation, sized so it does not get in the way of the next capture.
 * Queued is said plainly: "held on this phone" is not "saved", and a rep in a
 * dead hall needs to know which one happened.
 */
function SavedChip({ result }: { result: { name: string; queued: boolean } }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium",
        result.queued ? "bg-warning/15 text-warning" : "bg-success/15 text-success",
      )}
      title={
        result.queued
          ? "No signal here. It is held on this phone and uploads on its own when the connection is back."
          : "Filed against this show."
      }
    >
      {result.queued ? (
        <CloudOff className="size-3.5 shrink-0" />
      ) : (
        <Check className="size-3.5 shrink-0" />
      )}
      <span className="truncate">
        {result.queued ? "Held on this phone" : "Saved"} — {result.name}
      </span>
    </span>
  );
}
