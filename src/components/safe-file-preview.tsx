import { useState } from "react";

/** Force a download even when the signed storage URL is on another origin. */
export async function downloadPreviewFile(url: string, name: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Download failed. Try opening the file link below.");
  const bytes = await response.arrayBuffer();
  const href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Uploaded documents never get an unrestricted browsing context. */
export function SafeFilePreview({
  url,
  mime,
  name,
}: {
  url: string;
  mime: string | null;
  name: string;
}) {
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const type = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (
    ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(type)
  ) {
    return <img src={url} alt={name} className="size-full object-contain" />;
  }
  if (type === "application/pdf") {
    return (
      <div className="flex size-full flex-col">
        <div className="shrink-0 border-b p-2 text-xs">
          Preview blank?{" "}
          <button
            type="button"
            className="underline"
            disabled={downloading}
            onClick={async () => {
              setDownloading(true);
              setDownloadError("");
              try {
                await downloadPreviewFile(url, name);
              } catch {
                setDownloadError("Download failed. Try opening the file link below.");
              } finally {
                setDownloading(false);
              }
            }}
          >
            {downloading ? "Downloading…" : "Download PDF"}
          </button>
          {downloadError && <p role="alert">{downloadError}</p>}
        </div>
        <iframe
          src={url}
          title={name}
          sandbox=""
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1"
        />
      </div>
    );
  }
  return (
    <p className="p-3 text-sm text-muted-foreground">
      This file type cannot be previewed safely. Use the file link to open it separately.
    </p>
  );
}
