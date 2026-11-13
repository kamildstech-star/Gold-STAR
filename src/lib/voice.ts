/**
 * In-browser voice-note recorder. Uses MediaRecorder for capture and the
 * Web Audio API to precompute a waveform so playback can render peaks
 * without decoding the file every time.
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, { mimeType: mime });
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.startedAt = Date.now();
    this.rec.start();
  }

  elapsedSec(): number {
    if (!this.startedAt) return 0;
    return (Date.now() - this.startedAt) / 1000;
  }

  async stop(): Promise<{
    blob: Blob;
    durationSec: number;
    mime: string;
    peaks: number[];
  } | null> {
    if (!this.rec) return null;
    const rec = this.rec;
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    await stopped;
    this.stream?.getTracks().forEach((t) => t.stop());
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    const durationSec = (Date.now() - this.startedAt) / 1000;
    const peaks = await computeWaveform(blob);
    this.rec = null;
    this.stream = null;
    return { blob, durationSec, mime: rec.mimeType, peaks };
  }

  cancel(): void {
    try {
      this.rec?.stop();
    } catch {
      /* noop */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.rec = null;
    this.stream = null;
  }
}

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export async function computeWaveform(blob: Blob, bins = 60): Promise<number[]> {
  try {
    const ab = await blob.arrayBuffer();
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const buffer = await ctx.decodeAudioData(ab.slice(0));
    const data = buffer.getChannelData(0);
    const block = Math.floor(data.length / bins);
    const peaks: number[] = [];
    for (let i = 0; i < bins; i++) {
      const start = i * block;
      const end = Math.min(start + block, data.length);
      let max = 0;
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    await ctx.close();
    const m = Math.max(...peaks, 0.01);
    return peaks.map((p) => Math.max(0.05, p / m));
  } catch {
    return [];
  }
}
