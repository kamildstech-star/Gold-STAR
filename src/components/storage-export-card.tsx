// TODO(remove after cutover): temporary, for moving Storage off Lovable Cloud.
// Delete with the rest of the storage manifest (see src/lib/storage-export.ts).
/**
 * The Owner's one button for the storage move: press it once, save the CSV,
 * hand it to the copy script. Shown to owners only, but the server function
 * is the gate — an admin who found the function would still be refused.
 *
 * The CSV holds a live link to every file for 24 hours, so it is never kept
 * in the query cache or on the page: it goes straight to a download and only
 * the per-bucket counts stay on screen, for checking against storage.objects.
 */
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { HardDriveDownload } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CSV_MIME, exportFilename, saveFile } from "@/lib/export-table";
import type { BucketTotals } from "@/lib/storage-export";
import { exportStorageManifest } from "@/lib/storage-export.functions";

export const STORAGE_EXPORT_LABEL =
  "Export storage file list (for moving to a new server) — links expire in 24 hours";

type Done = {
  totals: BucketTotals[];
  totalObjects: number;
  totalBytes: number;
  expiresAt: string;
  filename: string;
};

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StorageExportCard() {
  const app = useAppContext();
  const run = useServerFn(exportStorageManifest);
  const [done, setDone] = useState<Done | null>(null);
  const [pending, setPending] = useState(false);

  // Not a useMutation on purpose: the mutation cache would hold the CSV — a
  // link to every file — after the download. Here it lives only in this call.
  async function exportList() {
    setPending(true);
    try {
      const result = await run();
      const filename = exportFilename("storage-manifest", "csv");
      saveFile(filename, result.csv, CSV_MIME);
      setDone({
        totals: result.totals,
        totalObjects: result.totalObjects,
        totalBytes: result.totalBytes,
        expiresAt: result.expiresAt,
        filename,
      });
      toast.success(`Saved ${filename}: ${result.totalObjects} files.`);
    } catch (e) {
      toast.error("Storage export failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPending(false);
    }
  }

  if (!app.roles.includes("owner")) return null;

  const unsigned = done?.totals.reduce((n, t) => n + t.unsigned, 0) ?? 0;

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div>
          <h2 className="display-heavy text-[15px] uppercase tracking-[0.05em]">
            Moving to a new server
          </h2>
          <p className="text-sm text-muted-foreground">
            A list of every stored photo and document, each with a download link, for copying the
            files to the new server. Anyone holding the file can download everything in it until the
            links expire — keep it on your own computer and delete it after the copy.
          </p>
        </div>
        <Button
          variant="outline"
          className="h-auto whitespace-normal text-left"
          disabled={pending || app.isImpersonating}
          onClick={() => void exportList()}
        >
          <HardDriveDownload className="size-4 shrink-0" />
          {pending ? "Listing files…" : STORAGE_EXPORT_LABEL}
        </Button>
        {app.isImpersonating && (
          <p className="text-xs text-muted-foreground">Exports are disabled while View As is on.</p>
        )}

        {done && (
          <div className="space-y-2">
            <p className="text-sm">
              Saved <span className="font-medium">{done.filename}</span>: {done.totalObjects} files,{" "}
              {megabytes(done.totalBytes)}. Links expire{" "}
              {new Date(done.expiresAt).toLocaleString("en-US")}.
            </p>
            {unsigned > 0 && (
              <p className="text-sm text-destructive">
                {unsigned} file{unsigned === 1 ? "" : "s"} could not be given a link — their rows
                have an empty signed_url.
              </p>
            )}
            <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Bucket</th>
                    <th className="px-3 py-2 text-right">Files</th>
                    <th className="px-3 py-2 text-right">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {done.totals.map((t) => (
                    <tr key={t.bucket} className="border-b last:border-0">
                      <td className="px-3 py-1.5 font-mono text-xs">{t.bucket}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{t.objects}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{megabytes(t.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
