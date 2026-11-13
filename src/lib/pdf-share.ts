/** Share the actual PDF file without uploading it or exposing a private URL. */
export async function sharePdfFile(
  bytes: Uint8Array,
  filename: string,
  title: string,
): Promise<"shared" | "cancelled" | "unsupported"> {
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare) {
    return "unsupported";
  }
  const file = new File(
    [bytes.slice().buffer as ArrayBuffer],
    filename.endsWith(".pdf") ? filename : `${filename}.pdf`,
    {
      type: "application/pdf",
    },
  );
  const files = [file];
  if (!navigator.canShare({ files })) return "unsupported";
  try {
    await navigator.share({ files, title });
    return "shared";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return "cancelled";
    throw error;
  }
}
