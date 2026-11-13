import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Aperture, Camera, ImagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Take a photo of the room you are standing in, from its row on the Rooms tab.
 *
 * The standalone Field Capture package kept room photos in a bucket of its
 * own. Here they go where every other photo of the job goes — the job album,
 * filed in the room's folder — because that is what the Pictures tab, the
 * claim package and the report PDFs read. A photo in a side bucket would be
 * evidence nobody else could find.
 *
 * Camera opens the rear camera straight away (`capture="environment"`);
 * the second button picks from the library, several at once. The files are
 * handed to the tab, which queues them through the same upload path the
 * Pictures tab uses.
 */
export function RoomPhotoButtons({
  roomName,
  count,
  disabled,
  onFiles,
  fieldCamera,
}: {
  roomName: string;
  /** Photos already in the room's folder, when known. */
  count: number | null;
  disabled: boolean;
  onFiles: (files: File[]) => Promise<void>;
  /**
   * Open the in-app Field Camera on this job with this room's folder chosen,
   * for stamped (Verified) shots. Absent: the button is not shown.
   */
  fieldCamera?: { jobId: string; roomId: string };
}) {
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const take = async (list: FileList | null, input: HTMLInputElement | null) => {
    // Copied before the input is reset: clearing `value` empties the FileList.
    const files = Array.from(list ?? []);
    if (input) input.value = "";
    if (!files.length) return;
    setBusy(true);
    try {
      await onFiles(files);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex shrink-0 items-center gap-1">
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void take(e.target.files, e.target)}
      />
      <input
        ref={library}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        className="hidden"
        onChange={(e) => void take(e.target.files, e.target)}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-11 sm:h-7"
        disabled={disabled || busy}
        aria-label={`Take a photo of ${roomName}`}
        onClick={() => camera.current?.click()}
      >
        <Camera className="size-3.5" />
        {count ? <span className="tabular-nums">{count}</span> : <span>Photo</span>}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-11 sm:size-7"
        disabled={disabled || busy}
        aria-label={`Add photos of ${roomName} from the library`}
        onClick={() => library.current?.click()}
      >
        <ImagePlus className="size-3.5" />
      </Button>
      {fieldCamera && !disabled && (
        <Button size="icon" variant="ghost" className="size-11 sm:size-7" asChild>
          <Link
            to="/camera"
            search={{ job: fieldCamera.jobId, room: fieldCamera.roomId }}
            aria-label={`Open the field camera for ${roomName}`}
            title="Field camera — stamped, verified photos"
          >
            <Aperture className="size-3.5" />
          </Link>
        </Button>
      )}
    </span>
  );
}
