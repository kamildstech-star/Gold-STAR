import { describe, expect, it } from "vitest";

import {
  INTAKE_PHOTO_MAX_COUNT,
  isIntakePhotoPath,
  parseIntakePhotos,
  photoExtension,
  sanitizeIntakePhotos,
  standaloneFormProblem,
} from "./intake-form";

const REQ = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const FILE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const complete = {
  site_address: "12 Maple Ave, Lakewood, NJ 08701",
  customer_name: "Pat Example",
  customer_phone: "732 555 0100",
  customer_email: "pat@example.com",
};

describe("standaloneFormProblem", () => {
  it("accepts the four required fields", () => {
    expect(standaloneFormProblem(complete)).toBeNull();
  });

  it("names the first missing field, in form order", () => {
    expect(standaloneFormProblem({ ...complete, site_address: "  " })).toMatch(/address/);
    expect(standaloneFormProblem({ ...complete, customer_name: null })).toMatch(/name/);
    expect(standaloneFormProblem({ ...complete, customer_phone: "" })).toMatch(/phone/);
    expect(standaloneFormProblem({ ...complete, customer_email: "" })).toMatch(/email/);
  });

  it("ignores everything that is no longer on the form", () => {
    expect(standaloneFormProblem({ ...complete, notes: null, loss_type_id: null })).toBeNull();
  });
});

describe("photo paths", () => {
  it("accepts a path under the request and refuses another request's", () => {
    expect(isIntakePhotoPath(`${REQ}/${FILE}.jpg`, REQ)).toBe(true);
    expect(isIntakePhotoPath(`${OTHER}/${FILE}.jpg`, REQ)).toBe(false);
  });

  it("refuses anything that is not <request>/<uuid>.<ext>", () => {
    expect(isIntakePhotoPath(`${REQ}/../${FILE}.jpg`, REQ)).toBe(false);
    expect(isIntakePhotoPath(`${REQ}/${FILE}`, REQ)).toBe(false);
    expect(isIntakePhotoPath(`${REQ}/sub/${FILE}.jpg`, REQ)).toBe(false);
  });

  it("derives an extension from the mime type first, then the name", () => {
    expect(photoExtension("IMG_1.HEIC", "image/heic")).toBe("heic");
    expect(photoExtension("photo.PNG", "application/octet-stream")).toBe("png");
    expect(photoExtension("photo", "")).toBe("jpg");
  });
});

describe("parseIntakePhotos / sanitizeIntakePhotos", () => {
  it("keeps well-formed entries and drops junk", () => {
    const parsed = parseIntakePhotos([
      { path: `${REQ}/${FILE}.jpg`, name: "a.jpg", mime: "image/jpeg", size: 10 },
      { path: "not/a/path", name: "b.jpg" },
      "string",
      null,
    ]);
    expect(parsed).toEqual([
      { path: `${REQ}/${FILE}.jpg`, name: "a.jpg", mime: "image/jpeg", size: 10 },
    ]);
  });

  it("caps the count", () => {
    const many = Array.from({ length: INTAKE_PHOTO_MAX_COUNT + 5 }, () => ({
      path: `${REQ}/${FILE}.jpg`,
      name: "a.jpg",
      mime: "image/jpeg",
      size: 1,
    }));
    expect(parseIntakePhotos(many)).toHaveLength(INTAKE_PHOTO_MAX_COUNT);
  });

  it("only lets a submission claim photos uploaded under its own request", () => {
    const list = sanitizeIntakePhotos(
      [
        { path: `${REQ}/${FILE}.jpg`, name: "mine.jpg", mime: "image/jpeg", size: 10 },
        { path: `${OTHER}/${FILE}.jpg`, name: "theirs.jpg", mime: "image/jpeg", size: 10 },
        { path: `${REQ}/${FILE}.png`, name: "huge.png", mime: "image/png", size: 99_000_000 },
      ],
      REQ,
    );
    expect(list.map((p) => p.name)).toEqual(["mine.jpg"]);
  });

  it("is empty for a non-array", () => {
    expect(parseIntakePhotos(null)).toEqual([]);
    expect(parseIntakePhotos({})).toEqual([]);
  });
});
