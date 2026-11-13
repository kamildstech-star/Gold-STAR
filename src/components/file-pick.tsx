import { useEffect, useState } from "react";
import { Camera, Paperclip } from "lucide-react";

/**
 * A file control sized for a thumb. The input is hidden rather than styled: the
 * button a browser draws for `<input type="file">` cannot be made 44px tall and
 * its wording is the OS's, not ours.
 *
 * Born in the Billing tab's payment dialog and moved here when the field work
 * ticket's "Upload paper" needed the same thing: a raw file input there gave a
 * crew member a small native control and no way to go straight to the camera.
 */
export function FilePick({
  label,
  accept,
  capture,
  onPick,
}: {
  label: string;
  accept: string;
  capture?: "environment";
  onPick: (file: File) => void;
}) {
  // focus-within, because the element that takes focus is the hidden input.
  return (
    <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-sm border bg-card px-3 text-sm focus-within:ring-2 focus-within:ring-ring hover:bg-accent sm:h-9">
      {capture ? <Camera className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
      {label}
      <input
        type="file"
        accept={accept}
        capture={capture}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // Cleared so that removing a file and picking the same one again
          // still fires a change event.
          e.target.value = "";
        }}
      />
    </label>
  );
}

/**
 * Whether a camera-only control means anything here. `capture` sends a phone
 * straight to the camera but takes the photo library away, and a desktop
 * ignores it outright — so "Take a photo" is offered beside "Choose a file"
 * on a touch screen and not at all elsewhere. Read after mount; the server
 * has no pointer.
 */
export function useHandheld(): boolean {
  const [handheld, setHandheld] = useState(false);
  useEffect(() => {
    setHandheld(window.matchMedia?.("(pointer: coarse)").matches ?? false);
  }, []);
  return handheld;
}
