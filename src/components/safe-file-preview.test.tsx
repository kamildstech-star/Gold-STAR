import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeFilePreview } from "./safe-file-preview";

describe("uploaded file previews", () => {
  it.each([
    "text/html",
    "image/svg+xml",
    "application/xhtml+xml",
    null,
    "application/octet-stream",
  ])("does not embed %s", (mime) => {
    const html = renderToStaticMarkup(
      <SafeFilePreview url="https://storage.example/file" mime={mime} name="file.pdf" />,
    );
    expect(html).not.toMatch(/<(iframe|object|embed|img)\b/);
    expect(html).toContain("cannot be previewed safely");
  });
  it("sandboxes PDF previews even if upload metadata is spoofed", () => {
    const html = renderToStaticMarkup(
      <SafeFilePreview url="https://storage.example/file" mime="application/pdf" name="file.pdf" />,
    );
    expect(html).toContain('sandbox=""');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("Download PDF");
    expect(html).toContain("Preview blank?");
  });
  it("renders raster images as images", () => {
    expect(
      renderToStaticMarkup(
        <SafeFilePreview url="https://storage.example/file" mime="image/png" name="photo" />,
      ),
    ).toContain("<img");
  });
});
