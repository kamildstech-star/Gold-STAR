import * as React from "react";
import { Mic, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { VoiceRecorder } from "@/lib/voice";
import { formatDuration } from "@/lib/chat";
import type { CapturedAudio } from "@/lib/tradeshow-capture";
import { cn } from "@/lib/utils";

/**
 * Tap-to-record voice note with playback and re-record. The recorder itself
 * is the chat module's `VoiceRecorder` (MediaRecorder plus a precomputed
 * waveform); this is the tablet-sized control around it, with buttons a thumb
 * can hit on a show floor.
 */
export function VoiceNoteField({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  value: CapturedAudio | null;
  onChange: (v: CapturedAudio | null) => void;
  disabled?: boolean;
  /**
   * A one-line resting state, for a screen that has a camera control above
   * it and a Save button below and has to fit a phone without scrolling.
   */
  compact?: boolean;
}) {
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [stopping, setStopping] = React.useState(false);
  const recorderRef = React.useRef<VoiceRecorder | null>(null);
  const tickRef = React.useRef<number | null>(null);

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
    try {
      recorderRef.current = new VoiceRecorder();
      await recorderRef.current.start();
      setRecording(true);
      setElapsed(0);
      tickRef.current = window.setInterval(() => {
        setElapsed(recorderRef.current?.elapsedSec() ?? 0);
      }, 200);
    } catch (e) {
      toast.error(`Cannot record: ${(e as Error).message}`);
    }
  };

  const stop = async () => {
    if (!recorderRef.current) return;
    setStopping(true);
    try {
      const res = await recorderRef.current.stop();
      if (res && res.blob.size > 0) {
        onChange({
          blob: res.blob,
          mime: res.mime || "audio/webm",
          durationSec: res.durationSec,
          peaks: res.peaks,
        });
      }
    } finally {
      clearTick();
      setRecording(false);
      setElapsed(0);
      setStopping(false);
    }
  };

  const cancel = () => {
    recorderRef.current?.cancel();
    clearTick();
    setRecording(false);
    setElapsed(0);
  };

  if (recording) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-destructive">
          <span className="size-3 animate-pulse rounded-full bg-destructive" />
          Recording · {formatDuration(elapsed)}
        </div>
        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-14 px-5 text-[15px]"
            onClick={cancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="h-14 px-8 text-[15px]"
            disabled={stopping}
            onClick={() => void stop()}
          >
            <Square className="mr-2 size-5" /> {stopping ? "Saving…" : "Stop"}
          </Button>
        </div>
      </div>
    );
  }

  if (value) {
    return (
      <RecordedPreview
        value={value}
        disabled={disabled}
        onRerecord={() => void start()}
        onClear={() => onChange(null)}
      />
    );
  }

  if (compact) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => void start()}
        className={cn(
          "flex min-h-[64px] w-full items-center gap-3 rounded-xl border-2 border-dashed px-4 py-2 text-left",
          "hover:border-primary hover:bg-primary/5 disabled:opacity-50",
        )}
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Mic className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold">Leave a voice note</span>
          <span className="block text-[12px] text-muted-foreground">
            Who they are, what they need, what you promised.
          </span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void start()}
      className={cn(
        "flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center",
        "hover:border-primary hover:bg-primary/5 disabled:opacity-50",
      )}
    >
      <span className="grid size-16 place-items-center rounded-full bg-primary text-primary-foreground">
        <Mic className="size-8" />
      </span>
      <span className="text-[15px] font-semibold">Tap to record a voice note</span>
      <span className="text-[12px] text-muted-foreground">
        Who they are, what they need, what you promised. Talk, don&apos;t type.
      </span>
    </button>
  );
}

function RecordedPreview({
  value,
  disabled,
  onRerecord,
  onClear,
}: {
  value: CapturedAudio;
  disabled?: boolean;
  onRerecord: () => void;
  onClear: () => void;
}) {
  const url = React.useMemo(() => URL.createObjectURL(value.blob), [value.blob]);
  React.useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <VoiceNotePlayer src={url} peaks={value.peaks} durationSec={value.durationSec} />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-11"
          disabled={disabled}
          onClick={onClear}
        >
          <Trash2 className="mr-1.5 size-4" /> Remove
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={disabled}
          onClick={onRerecord}
        >
          <RotateCcw className="mr-1.5 size-4" /> Re-record
        </Button>
      </div>
    </div>
  );
}

/**
 * What a caller can do to a player it does not own. The review queue needs it:
 * the space bar there has to reach the note being written up, and the note is
 * rendered several components away from the key handler.
 */
export type VoiceNotePlayerHandle = {
  toggle: () => void;
  play: () => void;
  pause: () => void;
};

/**
 * Waveform player. Same shape as the chat bubble's, without the bubble: takes
 * a URL rather than a chat attachment, so a signed storage URL or a local
 * object URL both work.
 */
export const VoiceNotePlayer = React.forwardRef<
  VoiceNotePlayerHandle,
  {
    src: string | null | undefined;
    peaks: number[];
    durationSec: number;
    className?: string;
    /** Start as soon as a source arrives — the review pass opens a note playing. */
    autoPlay?: boolean;
  }
>(function VoiceNotePlayer({ src, peaks, durationSec, className, autoPlay }, ref) {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [rate, setRate] = React.useState(1);
  const [progress, setProgress] = React.useState(0);

  const toggle = React.useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.playbackRate = rate;
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [rate]);

  React.useImperativeHandle(
    ref,
    () => ({
      toggle,
      play: () => {
        const el = audioRef.current;
        if (!el) return;
        el.playbackRate = rate;
        void el.play().catch(() => {});
      },
      pause: () => audioRef.current?.pause(),
    }),
    [toggle, rate],
  );

  // A browser that refuses autoplay without a gesture just leaves it paused;
  // the play button is right there, so this is a convenience, not a mechanism.
  React.useEffect(() => {
    if (!autoPlay || !src) return;
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = rate;
    void el.play().catch(() => {});
    // Only when the source changes: re-running on a speed change would restart
    // a note the reviewer is halfway through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, src]);

  React.useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onT = () => setProgress(el.currentTime / (durationSec || el.duration || 1));
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    const onP = () => setPlaying(true);
    const onPa = () => setPlaying(false);
    el.addEventListener("timeupdate", onT);
    el.addEventListener("ended", onEnd);
    el.addEventListener("play", onP);
    el.addEventListener("pause", onPa);
    return () => {
      el.removeEventListener("timeupdate", onT);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("play", onP);
      el.removeEventListener("pause", onPa);
    };
  }, [durationSec, src]);

  const bars = peaks.length
    ? peaks
    : Array.from({ length: 30 }, (_, i) => 0.2 + Math.abs(Math.sin(i)) * 0.5);

  return (
    <div className={cn("flex items-center gap-2 rounded-full bg-muted/50 px-2 py-1.5", className)}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-9 shrink-0"
        disabled={!src}
        onClick={toggle}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>
      <div className="flex h-8 min-w-0 flex-1 items-center gap-[2px]">
        {bars.map((p, i) => (
          <span
            key={i}
            className={cn(
              "w-[2px] rounded-full",
              peaks.length && i / bars.length < progress ? "bg-primary" : "bg-primary/30",
            )}
            style={{ height: Math.max(3, p * 22) }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => setRate((r) => (r === 1 ? 1.5 : r === 1.5 ? 2 : 1))}
        className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
      >
        {rate}×
      </button>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {formatDuration(durationSec)}
      </span>
      {src && <audio ref={audioRef} src={src} preload="metadata" />}
    </div>
  );
});
