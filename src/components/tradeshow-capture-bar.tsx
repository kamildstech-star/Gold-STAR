/**
 * The two buttons at the top of a show — the whole booth interface.
 *
 * Mark, after seeing the four-step lead wizard: "he wants to be able to just
 * dump info into a section and press save. It shouldn't have the skip, skip,
 * skip, because when you're in a tradeshow everything's rushed." Then: "Can
 * maybe just make it two large buttons on top: Leave a voice note, and
 * Capture a lead."
 *
 * So that is what this is. They sit on the show page itself, not behind a
 * dialog, because a tap saved is a tap saved.
 *
 *  - **Leave a voice note** is the one-gesture path Mark described first:
 *    "when I'll talk to somebody, I'll scan their badge or whatever it is,
 *    I'll send myself a voice note like 'you know Mark from Falcon Marketing
 *    blah blah, this is what he does', and then when I'm done the show I'll go
 *    over all my voice notes. That way I'm not sitting there at a show typing
 *    in." Hold, talk, let go. It saves a lead with the recording attached and
 *    nothing else; the button is back to resting before the upload finishes.
 *    Under `MIN_NOTE_MS` the recording is thrown away and said so — a booth
 *    full of accidental empty leads is worse than a missed one.
 *
 *  - **Capture a lead** opens the camera on a business card and the one-screen
 *    dialog (`tradeshow-lead-capture.tsx`) behind it: card photo, optional
 *    voice note, optional typed fields, Save.
 *
 * Both land in "Leads & accounts from this show" marked unreviewed, and the
 * review queue is where they get a name. Both go through the offline queue,
 * so a hall with no signal holds them on the phone.
 *
 * The badge scan is the small control underneath, and what it does depends
 * on what the badge said. Mark scanned an MFO Summit badge, got a full
 * contact card, and the page told him it would ride on the next note: "this
 * gave me a contact card but it didnt let me add the lead once scanned, there
 * is no add lead button to save it." So a badge that decodes to a contact
 * card opens Capture a lead with the fields filled in and Save live. A badge
 * that decodes to an attendee id — the ARRA one read "H3NHH2Q4M5H" — still
 * rides along with the next voice note, verbatim, for the reviewer.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Barcode, Camera, Loader2, Mic, X } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { BadgeScanSheet } from "@/components/badge-scan-sheet";
import {
  TradeshowLeadCapture,
  type TradeshowLeadCaptureHandle,
} from "@/components/tradeshow-lead-capture";
import { Button } from "@/components/ui/button";
import { badgeIsLead, parseBadgePayload } from "@/lib/badge-payload";
import { formatDuration } from "@/lib/chat";
import { toastDbError } from "@/lib/db-errors";
import { useOptionList } from "@/lib/option-lists";
import { fetchPipelines, fetchStages, resolvePipeline } from "@/lib/pipeline";
import {
  EMPTY_LEAD_DETAILS,
  buildLeadPayload,
  captureTradeshowLead,
  findTradeshowLeadSourceId,
  pickCaptureStage,
} from "@/lib/tradeshow-capture";
import type { Tradeshow } from "@/lib/tradeshows";
import { cn } from "@/lib/utils";
import { VoiceRecorder } from "@/lib/voice";

/** Below this a press is a fumble, not a note. */
const MIN_NOTE_MS = 700;

export function TradeshowCaptureBar({ show, onSaved }: { show: Tradeshow; onSaved: () => void }) {
  const app = useAppContext();
  const [capturing, setCapturing] = React.useState(false);
  const captureRef = React.useRef<TradeshowLeadCaptureHandle | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [saving, setSaving] = React.useState(0);
  const [captured, setCaptured] = React.useState(0);
  const [badgeRaw, setBadgeRaw] = React.useState<string | null>(null);
  const [scanning, setScanning] = React.useState(false);

  const recorderRef = React.useRef<VoiceRecorder | null>(null);
  const startedAtRef = React.useRef<number>(0);
  const capturedAtRef = React.useRef<string>("");
  const tickRef = React.useRef<number | null>(null);
  /** Guards a pointerup that arrives before start() has resolved. */
  const startingRef = React.useRef(false);

  const locationId =
    show.location_id ?? app.currentLocationId ?? app.memberships[0]?.location_id ?? null;
  const disabled = app.writesDisabled || !app.userId || !locationId;

  const sources = useOptionList("lead_source");
  const leadSourceId = findTradeshowLeadSourceId(sources.options);
  // Warmed on mount, not on press: at a booth the first note must not wait on
  // two round trips to find out which column the board puts it in.
  const stageQ = useQuery({
    queryKey: ["tradeshow-capture-stage", locationId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const pipelines = await fetchPipelines("account");
      const pipeline = resolvePipeline(pipelines, locationId);
      if (!pipeline) return { pipelineId: null, stageId: null };
      const stages = await fetchStages(pipeline.id);
      return { pipelineId: pipeline.id, stageId: pickCaptureStage(stages)?.id ?? null };
    },
  });

  const clearTick = () => {
    if (tickRef.current) window.clearInterval(tickRef.current);
    tickRef.current = null;
  };
  React.useEffect(
    () => () => {
      clearTick();
      recorderRef.current?.cancel();
    },
    [],
  );

  const start = async () => {
    if (recording || startingRef.current || disabled) return;
    startingRef.current = true;
    try {
      const rec = new VoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      capturedAtRef.current = new Date().toISOString();
      setRecording(true);
      setElapsed(0);
      tickRef.current = window.setInterval(
        () => setElapsed(recorderRef.current?.elapsedSec() ?? 0),
        200,
      );
    } catch (e) {
      toast.error(`Cannot record: ${(e as Error).message}`);
    } finally {
      startingRef.current = false;
    }
  };

  const stopAndSave = async () => {
    const rec = recorderRef.current;
    if (!rec || !recording) return;
    const heldMs = Date.now() - startedAtRef.current;
    const capturedAt = capturedAtRef.current;
    const badge = badgeRaw;

    // The button is free again here, before the upload — that is the point.
    clearTick();
    recorderRef.current = null;
    setRecording(false);
    setElapsed(0);

    if (heldMs < MIN_NOTE_MS) {
      rec.cancel();
      toast.info("Too short to be a note — hold the button while you talk.");
      return;
    }

    setSaving((n) => n + 1);
    try {
      const res = await rec.stop();
      if (!res || res.blob.size === 0) {
        toast.error("Nothing was recorded — check the microphone.");
        return;
      }
      if (!app.userId || !locationId) return;
      const { payload, blobs } = buildLeadPayload({
        tradeshowId: show.id,
        tradeshowName: show.name,
        locationId,
        userId: app.userId,
        details: EMPTY_LEAD_DETAILS,
        photo: null,
        audio: {
          blob: res.blob,
          mime: res.mime || "audio/webm",
          durationSec: res.durationSec,
          peaks: res.peaks,
        },
        leadSourceId,
        stageId: stageQ.data?.stageId ?? null,
        pipelineId: stageQ.data?.pipelineId ?? null,
        capturedAt,
        needsReview: true,
        badgeRaw: badge,
      });
      const { queued } = await captureTradeshowLead(payload, blobs);
      setCaptured((n) => n + 1);
      setBadgeRaw(null);
      toast.success(
        queued
          ? "Held on this tablet — it will upload when there is signal."
          : "Voice note saved. Write it up after the show.",
      );
      onSaved();
    } catch (e) {
      toastDbError(e, { action: "save the voice note" });
    } finally {
      setSaving((n) => n - 1);
    }
  };

  const cancelHold = () => {
    if (!recording) return;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    clearTick();
    setRecording(false);
    setElapsed(0);
  };

  return (
    <section
      className={cn(
        "rounded-xl border bg-card p-3 shadow-sm sm:p-4",
        recording && "border-destructive/50 bg-destructive/5",
      )}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={disabled}
          // Pointer events cover finger, pen and mouse with one path, and
          // setPointerCapture keeps the release ours even if the thumb slides
          // off the button — which on a phone held in one hand, it does.
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            void start();
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
            void stopAndSave();
          }}
          onPointerCancel={cancelHold}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              void start();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              void stopAndSave();
            }
          }}
          className={cn(
            "flex min-h-[84px] select-none touch-none flex-col items-center justify-center gap-1 rounded-xl px-4 text-center",
            "text-[17px] font-bold transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            recording
              ? "bg-destructive text-destructive-foreground"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
            disabled && "opacity-50",
          )}
        >
          {recording ? (
            <>
              <span className="flex items-center gap-2">
                <span className="size-4 animate-pulse rounded-full bg-current" />
                Recording · {formatDuration(elapsed)}
              </span>
              <span className="text-[12px] font-medium opacity-90">Let go to save</span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-2">
                <Mic className="size-6" /> Leave a voice note
              </span>
              <span className="text-[12px] font-medium opacity-80">Hold and talk</span>
            </>
          )}
        </button>

        <button
          type="button"
          disabled={disabled || recording}
          // Open the dialog and fire the camera in the same tap: a file input
          // only opens on a user gesture, and by the time the dialog has
          // mounted that gesture may be gone.
          onClick={() => {
            setCapturing(true);
            captureRef.current?.openCamera();
          }}
          className={cn(
            "flex min-h-[84px] flex-col items-center justify-center gap-1 rounded-xl border-2 border-primary px-4 text-center",
            "text-[17px] font-bold text-primary transition-colors hover:bg-primary/5",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            (disabled || recording) && "opacity-50",
          )}
        >
          <span className="flex items-center gap-2">
            <Camera className="size-6" /> Capture a lead
          </span>
          <span className="text-[12px] font-medium text-muted-foreground">
            Card photo, voice note, save
          </span>
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <p className="min-w-0 flex-1">
          {recording ? (
            "Who they are, what they do, what you promised."
          ) : badgeRaw ? (
            <>
              Badge ID <span className="font-mono text-foreground">{badgeRaw}</span> — it goes on
              the next voice note. The registration vendor holds the details.
            </>
          ) : (
            "Both save a lead on this show for you to write up afterwards."
          )}
        </p>
        <span className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant={badgeRaw ? "secondary" : "ghost"}
            size="sm"
            className="h-8"
            disabled={disabled || recording}
            onClick={() => setScanning(true)}
          >
            <Barcode className="mr-1.5 size-4" />
            {badgeRaw ? "Badge attached" : "Scan badge"}
          </Button>
          {badgeRaw && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setBadgeRaw(null)}
              title={badgeRaw}
              aria-label="Clear badge"
            >
              <X className="size-4" />
            </Button>
          )}
        </span>
      </div>

      {(captured > 0 || saving > 0) && (
        <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {saving > 0 && (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span>Saving {saving}…</span>
            </>
          )}
          {captured > 0 && (
            <span>
              {captured} voice note{captured === 1 ? "" : "s"} captured this sitting.
            </span>
          )}
        </p>
      )}

      <TradeshowLeadCapture
        ref={captureRef}
        open={capturing}
        onOpenChange={setCapturing}
        show={show}
        onSaved={onSaved}
      />
      <BadgeScanSheet
        open={scanning}
        onOpenChange={setScanning}
        onScanned={(raw) => {
          if (badgeIsLead(parseBadgePayload(raw))) {
            captureRef.current?.openWithBadge(raw);
            setCapturing(true);
          } else {
            setBadgeRaw(raw);
          }
        }}
      />
    </section>
  );
}
