import { createFileRoute, redirect, type SearchSchemaInput } from "@tanstack/react-router";

import { FieldCamera } from "@/components/field-camera/field-camera";

/**
 * The Field Camera: a full-screen, in-app camera that stamps time, date and
 * address on every shot and files it into a job's album through the photo
 * queue. Opened from a job's Pictures tab (`?job=`) or from a room on the
 * Rooms tab (`?job=&room=`).
 *
 * David, 20 Oct: no standalone camera. The sidebar entry is gone, and the
 * bare URL (no job — a bookmark, an old link) goes to Pictures, where every
 * job's photos are taken. Nothing here is deleted: remove the redirect and
 * restore the sidebar item (app-shell.tsx) to bring it back.
 */
type CameraSearch = { job?: string; room?: string; folder?: string };

const id = (v: unknown) =>
  typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : undefined;

export const Route = createFileRoute("/_authenticated/camera")({
  head: () => ({
    meta: [{ title: "Camera · Recovery Hub" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): CameraSearch => ({
    job: id(raw.job),
    room: id(raw.room),
    folder: id(raw.folder),
  }),
  beforeLoad: ({ search }) => {
    if (!search.job)
      throw redirect({ to: "/projects", search: { f: "all", q: "" }, replace: true });
  },
  component: CameraPage,
});

function CameraPage() {
  const search = Route.useSearch();
  return (
    <FieldCamera
      // A new job from a deep link starts a fresh screen rather than
      // inheriting the last job's folder and tag.
      key={search.job ?? "none"}
      initialJobId={search.job}
      initialRoomId={search.room}
      initialFolderId={search.folder}
    />
  );
}
