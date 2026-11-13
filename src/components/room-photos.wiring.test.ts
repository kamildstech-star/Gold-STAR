// Room photos from the Rooms tab, into the job album — part 3 of field
// capture. Mark: "yes build field capture into the rooms tab."
//
// The package kept room photos in a bucket of its own. These assertions pin
// that a photo taken from a room goes through the album's own upload queue,
// into that room's folder, where the Pictures tab, claim packages and report
// PDFs already read. No DOM testing library here, so each check pulls one
// fragment out of the source and asserts on that alone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const pick = (src: string, re: RegExp) => re.exec(src)?.[0] ?? "";

const TAB = read("src/components/job-rooms-tab.tsx");
const PHOTOS = read("src/components/job-photos.tsx");
const BUTTONS = read("src/components/room-photo-buttons.tsx");
const PAGE = read("src/routes/_authenticated/jobs.$id.tsx");
const QUEUE = read("src/lib/photos.ts");

describe("a photo taken from a room", () => {
  const TAKE = pick(
    TAB,
    /const takePhotos = async \(r: JobRoom, files: File\[\]\) => \{[\s\S]*?\n {2}\};\n/,
  );
  const FOLDER = pick(TAB, /const roomFolder = async \(roomId: string\)[\s\S]*?\n {2}\};\n/);
  const FOLDERS_Q = pick(TAB, /const foldersQ = useQuery\(\{[\s\S]*?\n {2}\}\);\n/);
  const QUEUE_FN = pick(PHOTOS, /export async function queueJobPhotoFiles\([\s\S]*?\n}\n/);

  it("found every fragment it is about", () => {
    for (const f of [TAKE, FOLDER, FOLDERS_Q, QUEUE_FN]) expect(f).not.toBe("");
  });

  it("goes through the album's own upload queue, with the room's folder", () => {
    expect(TAKE).toContain("await queueJobPhotoFiles(job, app.userId, files, {");
    expect(TAKE).toMatch(/\{\s*folderId,/);
    // No side bucket, no direct upload from the tab.
    expect(TAB).not.toMatch(/\.storage\s*\.from\(/);
    expect(TAB).not.toContain("field-capture");
  });

  it("hands the folder to the photo queue, which files the photo once it uploads", () => {
    expect(QUEUE_FN).toContain("folderId: hooks.folderId ?? null,");
    const filing = pick(QUEUE, /if \(item\.folderId\) \{[\s\S]*?\}/);
    expect(filing).toContain(".update({ folder_id: item.folderId");
  });

  it("knows each room's folder from the album, cached for a basement", () => {
    expect(FOLDERS_Q).toContain('.from("photo_folders")');
    expect(FOLDERS_Q).toContain('.eq("project_id", projectId!)');
    expect(FOLDERS_Q).toContain('.not("room_id", "is", null)');
  });

  it("makes a missing folder with the one folder sync, and only with a signal", () => {
    expect(FOLDER).toContain("folderByRoom.get(roomId)");
    expect(FOLDER).toContain("!navigator.onLine) return null;");
    expect(FOLDER).toContain("await followFolders();");
  });

  it("says where the photos went when the room has no folder", () => {
    expect(TAKE).toMatch(/if \(!folderId\) \{\s*toast\.warning\(`These photos go to All photos/);
  });

  it("tells the page to re-read the album when they land, and shows each room's count", () => {
    const tab = pick(PAGE, /<JobRoomsTab[\s\S]*?\/>/);
    expect(tab).toContain("photoCountByFolder={jobPhotos.tally?.byFolder ?? null}");
    expect(tab).toContain("onPhotosLanded={() => void jobPhotos.reload()}");
    expect(TAKE).toContain("onLanded: () => onPhotosLanded?.()");
  });
});

describe("the room camera buttons", () => {
  it("open the rear camera straight away, and the library for several at once", () => {
    const inputs = [...BUTTONS.matchAll(/<input[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain('capture="environment"');
    expect(inputs[1]).toContain("multiple");
  });

  it("copy the files before resetting the input, which empties the list", () => {
    const take = pick(BUTTONS, /const take = async[\s\S]*?\n {2}\};\n/);
    expect(take.indexOf("Array.from(list ?? [])")).toBeLessThan(take.indexOf('input.value = ""'));
  });

  it("are thumb-sized on a phone", () => {
    expect(BUTTONS).toContain('className="h-11 sm:h-7"');
    expect(BUTTONS).toContain('className="size-11 sm:size-7"');
  });
});
