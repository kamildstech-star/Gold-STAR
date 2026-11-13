/**
 * The Field Camera's modes: Reports · Video · Photo · Clock · Checklist, as
 * in the reference design.
 *
 * Only Photo is a camera mode. The others are doors into screens the app
 * already has, deliberately — a second time clock or a second checklist
 * engine inside the camera would be two places to keep right:
 *
 *   Reports   → the job's Documents tab, where the AI report panel lives
 *   Clock     → the Time clock page (clock in/out is per office, not per job)
 *   Checklist → the job's Tasks tab, where the job checklists are
 *   Video     → not yet: the photo pipeline stores stills only (it encodes
 *               image variants on the phone), so a clip would have nowhere to
 *               go. Shown, disabled, so nobody hunts for it.
 */
export type CameraMode = "reports" | "video" | "photo" | "clock" | "checklist";

export type ModeDef = {
  id: CameraMode;
  label: string;
  /** Needs a selected job to go anywhere. */
  needsJob: boolean;
  /** Not available yet; rendered disabled with a reason. */
  comingSoon?: string;
};

export const CAMERA_MODES: readonly ModeDef[] = [
  { id: "reports", label: "Reports", needsJob: true },
  {
    id: "video",
    label: "Video",
    needsJob: false,
    comingSoon: "Video is coming soon — job albums hold photos only for now.",
  },
  { id: "photo", label: "Photo", needsJob: false },
  { id: "clock", label: "Clock", needsJob: false },
  { id: "checklist", label: "Checklist", needsJob: true },
];

/** Where a non-photo mode goes: a path plus, for a job, the tab to open on. */
export function modeDestination(
  mode: CameraMode,
  jobId: string | null,
): { to: "/timeclock" } | { to: "/jobs/$id"; jobId: string; tab: "documents" | "tasks" } | null {
  if (mode === "clock") return { to: "/timeclock" };
  if (!jobId) return null;
  if (mode === "reports") return { to: "/jobs/$id", jobId, tab: "documents" };
  if (mode === "checklist") return { to: "/jobs/$id", jobId, tab: "tasks" };
  return null;
}
