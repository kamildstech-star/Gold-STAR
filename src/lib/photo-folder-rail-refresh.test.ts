import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The add-folder option that was missing early in David's 22 Sep session and
 * there by the end of it. The rail only renders once the job has an album, and
 * whether it had one was checked when the Pictures tab mounted and never again.
 */
const SRC = readFileSync("src/components/job-photos.tsx", "utf8").replace(/\r\n/g, "\n");

describe("the folder rail appears as soon as the first upload creates the album", () => {
  const accept = SRC.match(/const accept = useCallback\([\s\S]*?\n {2}\);/)![0];

  it("re-checks the folders right after the album is ensured", () => {
    // The upload path is shared with the General-tab strip now; the album is
    // ensured there and announced through onAlbum, which the tab answers.
    const queue = SRC.match(/async function queueJobPhotoFiles\([\s\S]*?\n}\n/)![0];
    const ensured = queue.indexOf("const projectId = await ensureJobAlbum(job, userId);");
    const announced = queue.indexOf("hooks.onAlbum?.(projectId);");
    const firstEnqueue = queue.indexOf("await enqueuePhoto(");
    expect(ensured).toBeGreaterThan(-1);
    expect(announced).toBeGreaterThan(ensured);
    expect(firstEnqueue).toBeGreaterThan(announced);
    expect(accept).toContain("await queueJobPhotoFiles(job, app.userId, files, {");
    expect(accept).toContain("if (rail?.albumId !== projectId) void refreshFolders();");
  });

  it("lists what it reads in the callback's dependencies", () => {
    expect(accept).toContain("[job, app.userId, reload, rail?.albumId, refreshFolders]");
  });

  it("still gates the rail on the album, so the message it replaces is the right one", () => {
    expect(SRC).toContain("rail.albumId == null ?");
  });
});
