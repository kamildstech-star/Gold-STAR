/**
 * The mode strip under the shutter: Reports · Video · Photo · Clock ·
 * Checklist. Which modes exist and where each goes is in
 * src/lib/field-camera/modes.ts; this is only the strip.
 */
import { Clock, ClipboardCheck, Camera, FileText, Video } from "lucide-react";

import { CAMERA_MODES, type CameraMode } from "@/lib/field-camera/modes";

const ICON: Record<CameraMode, typeof Camera> = {
  reports: FileText,
  video: Video,
  photo: Camera,
  clock: Clock,
  checklist: ClipboardCheck,
};

export function CameraModeTabs({
  jobId,
  onSelect,
}: {
  jobId: string | null;
  onSelect: (mode: CameraMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Camera modes"
      className="flex items-center justify-center gap-1"
    >
      {CAMERA_MODES.map((m) => {
        const Icon = ICON[m.id];
        const active = m.id === "photo";
        const disabled = !!m.comingSoon || (m.needsJob && !jobId);
        const title = m.comingSoon ?? (m.needsJob && !jobId ? "Pick a job first" : undefined);
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={disabled || undefined}
            data-mode={m.id}
            title={title}
            disabled={disabled}
            onClick={() => !active && !disabled && onSelect(m.id)}
            className={`flex min-h-11 min-w-14 flex-col items-center justify-center gap-0.5 rounded-full px-2 text-[11px] font-medium transition ${
              active
                ? "bg-white/20 text-[#F5B301]"
                : disabled
                  ? "text-white/35"
                  : "text-white/85 active:bg-white/10"
            }`}
          >
            <Icon className="size-4" aria-hidden />
            <span>{m.label}</span>
            {m.comingSoon && <span className="sr-only"> (coming soon)</span>}
          </button>
        );
      })}
    </div>
  );
}
