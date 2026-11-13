import { useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

/** Where a run of uploads is: `done` of `total`, and the file going up now. */
export type UploadProgress = { done: number; total: number; current: string | null };

/**
 * A file drag, not a document tile being dragged onto a folder (those carry
 * `text/document-id` and no files).
 */
function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * FE2, 28 Oct: drop files here or click to browse — several at once. The
 * Upload button in the header stays as it was; this is the bigger target.
 * Progress is counted per file (storage uploads report no byte progress).
 */
export function DocumentDropzone({
  onFiles,
  disabled,
  progress,
  className,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  progress: UploadProgress | null;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const busy = !!progress;
  const off = disabled || busy;

  return (
    <div
      role="button"
      tabIndex={off ? -1 : 0}
      aria-disabled={off}
      aria-label="Drop files here or click to choose files to upload"
      data-document-dropzone
      onClick={() => !off && input.current?.click()}
      onKeyDown={(e) => {
        if (off || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        input.current?.click();
      }}
      onDragOver={(e) => {
        if (off || !isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (off || !isFileDrag(e)) return;
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-4 text-center text-[13px] transition-colors",
        over ? "border-primary bg-primary/5" : "border-border",
        off ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:border-primary/60",
        className,
      )}
    >
      {busy ? (
        <div className="w-full max-w-sm space-y-1.5" aria-live="polite">
          <p className="text-foreground">
            Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}
            {progress.current ? ` — ${progress.current}` : ""}
          </p>
          <Progress value={(progress.done / Math.max(progress.total, 1)) * 100} />
        </div>
      ) : (
        <>
          <UploadCloud className="size-5 text-muted-foreground" />
          <p className="text-foreground">
            Drop files here, or <span className="font-medium text-primary">browse</span>
          </p>
          <p className="text-xs text-muted-foreground">Several at once is fine.</p>
        </>
      )}
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        disabled={off}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}
