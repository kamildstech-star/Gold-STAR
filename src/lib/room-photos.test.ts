/**
 * Rooms and pictures talk to each other, and the scope suggestion is written
 * from the room's own data and photos (David, 27 Oct).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { parseScopeSuggestions, roomScopeContext } from "./room-photos";

const room = {
  name: "Kitchen",
  unit: null,
  floor: "1",
  length_ft: 12,
  width_ft: 10,
  height_ft: 8,
  flooring: "Vinyl plank",
  affected_materials: ["Drywall", "Baseboard"],
  notes: "Remove baseboards",
};

describe("roomScopeContext", () => {
  it("carries the room's recorded facts and its photos' captions and tags", () => {
    const ctx = roomScopeContext({
      room,
      photos: [{ caption: "Wet drywall behind sink", tags: ["Water damage"] }],
      waterCategory: 2,
      waterClass: 2,
    });
    expect(ctx).toMatchObject({
      room: "Kitchen",
      dimensions_ft: "12 × 10 × 8",
      affected_materials: ["Drywall", "Baseboard"],
      existing_scope: ["Remove baseboards"],
      photos: [{ caption: "Wet drywall behind sink", tags: ["Water damage"] }],
      water_category: 2,
    });
  });
});

describe("parseScopeSuggestions", () => {
  it("returns new lines only, de-bulleted and capped", () => {
    const reply = JSON.stringify({
      lines: [
        "- Flood cut drywall 2 ft",
        "Remove baseboards",
        "flood cut drywall 2 ft",
        "Set 1 dehumidifier",
      ],
    });
    expect(parseScopeSuggestions(reply, ["Remove baseboards"])).toEqual([
      "Flood cut drywall 2 ft",
      "Set 1 dehumidifier",
    ]);
  });

  it("reads JSON wrapped in prose, and nothing from garbage", () => {
    expect(parseScopeSuggestions('Here: {"lines":["Remove cabinets"]}', [])).toEqual([
      "Remove cabinets",
    ]);
    expect(parseScopeSuggestions("not json", [])).toEqual([]);
  });
});

describe("wiring", () => {
  it("each room on the Rooms tab shows its photos and can suggest scope from them", () => {
    const tab = readFileSync("src/components/job-rooms-tab.tsx", "utf8");
    expect(tab).toMatch(/<RoomPhotoThumbs folderId=\{folderByRoom\.get\(r\.id\)!\}/);
    expect(tab).toMatch(
      /onSuggest=\{async \(\) => \(await suggestScope\(\{ data: \{ room_id: r\.id \} \}\)\)\.lines\}/,
    );
  });

  it("the suggestion reads with the caller's session and never writes", () => {
    const fn = readFileSync("src/lib/room-scope.functions.ts", "utf8");
    expect(fn).toContain("requireSupabaseAuth");
    expect(fn).not.toMatch(/supabaseAdmin|\.insert\(|\.update\(|\.upsert\(/);
  });

  it("a photo still shows its room in the viewer", () => {
    const photos = readFileSync("src/components/job-photos.tsx", "utf8");
    expect(photos).toContain('{photo.room && <Badge variant="outline">{photo.room}</Badge>}');
  });
});
