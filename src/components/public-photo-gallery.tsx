import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ImageOff, MapPin, X } from "lucide-react";

import { MapsLink } from "@/components/maps-link";
import { MarkupOverlay } from "@/components/photo-markup-overlay";
import { photoShareGroups, type PublicPhotoView, type SharedPhoto } from "@/lib/photo-share";

/**
 * The photographs, as the person holding the link sees them.
 *
 * Mobile first because this is opened from a text message, standing in a
 * kitchen. Two columns on a phone; the page itself never scrolls sideways, so
 * every tile is a square that crops rather than a row that overflows.
 *
 * Nothing here decides what is visible. Every field on a `SharedPhoto` is
 * already everything the link permits — a caption that is off arrived as null,
 * not as text this component chose not to draw.
 */
export function PublicPhotoGallery({ view }: { view: PublicPhotoView }) {
  const [open, setOpen] = useState<number | null>(null);
  const groups = photoShareGroups(view.photos);

  return (
    <div className="space-y-4">
      {view.missing > 0 && (
        <p className="rounded-sm border border-warning/50 bg-warning/10 p-2 text-xs">
          {view.missing} photo{view.missing === 1 ? "" : "s"} on this link could not be loaded, so{" "}
          {view.missing === 1 ? "it is" : "they are"} not shown below. This is a fault at our end,
          not a gap in the work.
        </p>
      )}

      {groups.map((g, gi) => (
        <section key={`${g.room ?? "all"}-${gi}`} className="space-y-2">
          {g.room && <h2 className="text-sm font-semibold">{g.room}</h2>}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
            {g.photos.map((p) => (
              <button
                key={p.id}
                type="button"
                className="group relative aspect-square min-w-0 overflow-hidden rounded-sm border bg-muted"
                onClick={() => setOpen(view.photos.indexOf(p))}
              >
                <Thumb photo={p} />
              </button>
            ))}
          </div>
        </section>
      ))}

      {open != null && view.photos[open] && (
        <Lightbox
          photos={view.photos}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** A tile that failed to load says so; a blank square reads as a missing photo. */
function Thumb({ photo }: { photo: SharedPhoto }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-[10px] text-muted-foreground">
        <ImageOff className="size-4" />
        Could not load
      </span>
    );
  }
  return (
    <img
      src={photo.thumbUrl}
      alt={photo.caption ?? "Job photograph"}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function Lightbox({
  photos,
  index,
  onIndex,
  onClose,
}: {
  photos: SharedPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const photo = photos[index]!;
  const [aspect, setAspect] = useState(4 / 3);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [photo.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length, onIndex, onClose]);

  const meta = [
    photo.takenAt ? new Date(photo.takenAt).toLocaleString("en-US") : null,
    photo.room,
    photo.album,
    photo.uploader,
  ].filter((v): v is string => !!v);

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-black/95">
      <div className="flex items-center gap-2 p-2 text-xs text-white/80">
        <span className="tabular-nums">
          {index + 1} / {photos.length}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-sm p-2 hover:bg-white/10"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {failed ? (
          <p className="max-w-xs text-center text-sm text-white/70">
            This photograph could not be loaded. Please try again in a moment.
          </p>
        ) : (
          <div className="relative max-h-full">
            <img
              src={photo.fullUrl}
              alt={photo.caption ?? "Job photograph"}
              className="max-h-[70vh] w-auto max-w-full object-contain"
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalHeight > 0) setAspect(el.naturalWidth / el.naturalHeight);
              }}
              onError={() => setFailed(true)}
            />
            {photo.markup && <MarkupOverlay doc={photo.markup} aspect={aspect} />}
          </div>
        )}

        {index > 0 && (
          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => onIndex(index - 1)}
            className="absolute left-1 rounded-full bg-black/50 p-3 text-white"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => onIndex(index + 1)}
            className="absolute right-1 rounded-full bg-black/50 p-3 text-white"
          >
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>

      <div className="max-h-[30vh] shrink-0 space-y-1.5 overflow-y-auto p-3 text-sm text-white">
        {photo.caption && <p className="whitespace-pre-wrap">{photo.caption}</p>}
        {meta.length > 0 && <p className="text-xs text-white/70">{meta.join(" · ")}</p>}
        {photo.tags.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {photo.tags.map((t) => (
              <span key={t} className="rounded-sm bg-white/15 px-1.5 py-0.5 text-[11px]">
                {t}
              </span>
            ))}
          </p>
        )}
        {/* Only here when the sender allowed it. A view-only link has no
            downloadUrl at all, so there is nothing for this to draw. */}
        {photo.downloadUrl && (
          <a
            className="inline-flex items-center gap-1 text-xs underline"
            href={photo.downloadUrl}
            download
          >
            <Download className="size-3.5" />
            Download full-resolution original
          </a>
        )}
        {photo.location && (
          <MapsLink
            className="inline-flex items-center gap-1 text-xs underline"
            query={photo.location}
          >
            <MapPin className="size-3.5" />
            {photo.location.lat.toFixed(5)}, {photo.location.lon.toFixed(5)}
          </MapsLink>
        )}
      </div>
    </div>
  );
}
