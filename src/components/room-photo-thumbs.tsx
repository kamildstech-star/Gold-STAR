/**
 * A room shows its photos (David, 27 Oct): the newest few pictures filed in
 * the room's album folder, on the room's row of the Rooms tab. The Pictures
 * tab already labels every photo with its room — this is the other way round.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { signedPhotoUrl } from "@/lib/job-photos";
import { listRoomPhotoThumbs, type RoomPhotoThumb } from "@/lib/room-photos";

export function RoomPhotoThumbs({ folderId, roomName }: { folderId: string; roomName: string }) {
  const q = useQuery({
    queryKey: ["room-photo-thumbs", folderId],
    queryFn: () => listRoomPhotoThumbs(folderId),
  });
  const thumbs = q.data ?? [];
  if (!thumbs.length) return null;
  return (
    <div
      className="flex gap-1.5 overflow-x-auto"
      data-room-photos
      aria-label={`Photos of ${roomName}`}
    >
      {thumbs.map((t) => (
        <Thumb key={t.id} thumb={t} roomName={roomName} />
      ))}
    </div>
  );
}

function Thumb({ thumb, roomName }: { thumb: RoomPhotoThumb; roomName: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void signedPhotoUrl(thumb.bucket, thumb.path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [thumb.bucket, thumb.path]);
  return (
    <div className="size-12 shrink-0 overflow-hidden rounded-sm bg-muted">
      {url ? <img src={url} alt={`${roomName} photo`} className="size-full object-cover" /> : null}
    </div>
  );
}
