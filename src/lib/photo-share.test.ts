/**
 * The share link's promise, tested at the level it is made.
 *
 * "Anything that would show on the picture should be a checkbox to remove it in
 * case we don't want that person seeing it." The failure mode these tests exist
 * to catch is the plausible one: a field hidden by the component that renders
 * it, sitting in plain text in the response body of a page anyone with the link
 * can open. So every assertion below serialises the whole payload and looks for
 * the secret in the bytes, not just in the property it was meant to leave from.
 */
import { describe, expect, it } from "vitest";

import {
  PHOTO_SHARE_DEFAULTS,
  PHOTO_SHARE_OPTIONS,
  countOriginalCarriers,
  normalizePhotoShareOptions,
  photoShareGroups,
  redactSharePhoto,
  type PhotoShareOptions,
  type SharePhotoSource,
} from "./photo-share";

const URLS = { thumbUrl: "/t", fullUrl: "/f" };

const SOURCE: SharePhotoSource = {
  id: "01HZZ",
  carrier: "re_encoded",
  takenAt: "2026-08-14T09:31:00.000Z",
  lat: 40.7128,
  lon: -74.006,
  room: "Primary bathroom",
  caption: "Owner says the leak ran for a week before anyone called",
  tags: ["Category 3", "Carrier dispute"],
  uploader: "Danny Ruiz",
  album: "Chaser scene album",
  markup: {
    strokes: [{ color: "#FACC15", width: 0.006, points: [[0.1, 0.2] as [number, number]] }],
    texts: [{ x: 0.5, y: 0.5, text: "mold behind vanity", color: "#FACC15", size: 0.055 }],
  },
};

const ALL_ON: PhotoShareOptions = Object.fromEntries(
  PHOTO_SHARE_OPTIONS.map((o) => [o.key, true]),
) as PhotoShareOptions;

/** Every fact on a source photo, and the string that proves it travelled. */
const SECRETS: { key: keyof PhotoShareOptions; needle: string }[] = [
  { key: "taken_at", needle: "2026-08-14" },
  { key: "location", needle: "40.7128" },
  { key: "room", needle: "Primary bathroom" },
  { key: "caption", needle: "the leak ran for a week" },
  { key: "tags", needle: "Carrier dispute" },
  { key: "uploader", needle: "Danny Ruiz" },
  { key: "album", needle: "Chaser scene album" },
  { key: "markup_text", needle: "mold behind vanity" },
];

describe("defaults", () => {
  it("hides everything except the way to phone us", () => {
    const on = PHOTO_SHARE_OPTIONS.filter((o) => o.default).map((o) => o.key);
    expect(on).toEqual(["contact"]);
  });

  it("shows nothing about the photographs at all by default", () => {
    const out = redactSharePhoto(SOURCE, PHOTO_SHARE_DEFAULTS, URLS);
    const wire = JSON.stringify(out);
    for (const { needle } of SECRETS) expect(wire).not.toContain(needle);
  });
});

describe("redaction removes the value, not just the render", () => {
  it.each(SECRETS)("$key off keeps $needle out of the payload", ({ key, needle }) => {
    const opts = { ...ALL_ON, [key]: false };
    const wire = JSON.stringify(redactSharePhoto(SOURCE, normalizePhotoShareOptions(opts), URLS));
    expect(wire).not.toContain(needle);
  });

  it.each(SECRETS)("$key on lets $needle through", ({ needle }) => {
    const wire = JSON.stringify(redactSharePhoto(SOURCE, ALL_ON, URLS));
    expect(wire).toContain(needle);
  });

  it("nulls the field rather than leaving a stale one", () => {
    const out = redactSharePhoto(SOURCE, PHOTO_SHARE_DEFAULTS, URLS);
    expect(out.takenAt).toBeNull();
    expect(out.location).toBeNull();
    expect(out.room).toBeNull();
    expect(out.caption).toBeNull();
    expect(out.uploader).toBeNull();
    expect(out.album).toBeNull();
    expect(out.markup).toBeNull();
    expect(out.tags).toEqual([]);
  });

  it("still sends the picture itself with every switch off", () => {
    const out = redactSharePhoto(SOURCE, PHOTO_SHARE_DEFAULTS, URLS);
    expect(out.thumbUrl).toBe("/t");
    expect(out.fullUrl).toBe("/f");
  });
});

describe("markup", () => {
  it("draws the arrows without the words when only the labels are off", () => {
    const out = redactSharePhoto(SOURCE, { ...ALL_ON, markup_text: false }, URLS);
    expect(out.markup?.strokes).toHaveLength(1);
    expect(out.markup?.texts).toEqual([]);
  });

  it("sends no markup object at all when markup is off", () => {
    const out = redactSharePhoto(SOURCE, { ...ALL_ON, markup: false }, URLS);
    // Not `{strokes:[],texts:[]}` — an empty overlay would itself tell the
    // recipient that markup exists on this photo and was withheld.
    expect(out.markup).toBeNull();
  });

  it("sends no markup object when only labels existed and labels are off", () => {
    const textOnly: SharePhotoSource = {
      ...SOURCE,
      markup: { strokes: [], texts: SOURCE.markup!.texts },
    };
    const out = redactSharePhoto(textOnly, { ...ALL_ON, markup_text: false }, URLS);
    expect(out.markup).toBeNull();
  });
});

describe("normalizePhotoShareOptions", () => {
  it("forces a dependent option off when its parent is off", () => {
    const out = normalizePhotoShareOptions({ markup: false, markup_text: true });
    expect(out.markup_text).toBe(false);
  });

  it("ignores keys it does not know and non-booleans", () => {
    const out = normalizePhotoShareOptions({ caption: "yes", nonsense: true });
    expect(out.caption).toBe(false);
    expect(Object.keys(out).sort()).toEqual(PHOTO_SHARE_OPTIONS.map((o) => o.key).sort());
  });

  it("treats a missing column as the defaults", () => {
    expect(normalizePhotoShareOptions(null)).toEqual(PHOTO_SHARE_DEFAULTS);
    expect(normalizePhotoShareOptions(undefined)).toEqual(PHOTO_SHARE_DEFAULTS);
  });
});

describe("countOriginalCarriers", () => {
  it("counts documents and album photos that have no re-encoded variant", () => {
    expect(
      countOriginalCarriers([
        { source: "album", displayPath: "a/display.webp" },
        { source: "album", displayPath: null },
        { source: "document", displayPath: "d/scan.jpg" },
      ]),
    ).toBe(2);
  });
});

describe("photoShareGroups", () => {
  it("puts consecutive photos from one room under one heading", () => {
    const p = (id: string, room: string | null) =>
      redactSharePhoto({ ...SOURCE, id, room }, { ...ALL_ON }, URLS);
    const groups = photoShareGroups([p("1", "Kitchen"), p("2", "Kitchen"), p("3", "Hall")]);
    expect(groups.map((g) => [g.room, g.photos.length])).toEqual([
      ["Kitchen", 2],
      ["Hall", 1],
    ]);
  });

  it("makes one unnamed group when the room is hidden", () => {
    const p = (id: string) => redactSharePhoto({ ...SOURCE, id }, PHOTO_SHARE_DEFAULTS, URLS);
    const groups = photoShareGroups([p("1"), p("2")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.room).toBeNull();
  });
});
