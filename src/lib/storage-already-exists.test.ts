import { describe, expect, it } from "vitest";

import { isAlreadyExistsResponse, isStorageAlreadyExists } from "@/lib/storage-already-exists";

describe("isStorageAlreadyExists", () => {
  it("reads every shape Storage has used for a duplicate key", () => {
    // storage-js StorageApiError against an older server: HTTP 400, real code in the body.
    expect(isStorageAlreadyExists({ status: 400, statusCode: "409", message: "x" })).toBe(true);
    // ...and against a newer one: a real 409.
    expect(isStorageAlreadyExists({ status: 409, statusCode: "409" })).toBe(true);
    expect(isStorageAlreadyExists({ code: "KeyAlreadyExists" })).toBe(true);
    expect(isStorageAlreadyExists({ code: "ResourceAlreadyExists" })).toBe(true);
    expect(isStorageAlreadyExists({ error: "Duplicate" })).toBe(true);
    expect(isStorageAlreadyExists(new Error("The resource already exists"))).toBe(true);
  });

  it("reads Mark's photo from nothing but the message the queue kept", () => {
    expect(
      isStorageAlreadyExists("Gave up after 8 attempts. Last error: The resource already exists"),
    ).toBe(true);
  });

  it("is not fooled by other failures, including Postgres's 'duplicate key'", () => {
    expect(isStorageAlreadyExists(null)).toBe(false);
    expect(isStorageAlreadyExists(undefined)).toBe(false);
    expect(isStorageAlreadyExists({ status: 403, statusCode: "403", message: "denied" })).toBe(
      false,
    );
    expect(
      isStorageAlreadyExists(
        new Error('duplicate key value violates unique constraint "photos_pkey"'),
      ),
    ).toBe(false);
    expect(isStorageAlreadyExists("Upload failed — no connection.")).toBe(false);
  });
});

describe("isAlreadyExistsResponse", () => {
  it("reads a raw PUT answer", () => {
    expect(isAlreadyExistsResponse(409, "")).toBe(true);
    expect(
      isAlreadyExistsResponse(
        400,
        JSON.stringify({
          statusCode: "409",
          error: "Duplicate",
          message: "The resource already exists",
        }),
      ),
    ).toBe(true);
    expect(
      isAlreadyExistsResponse(400, JSON.stringify({ statusCode: "400", message: "bad" })),
    ).toBe(false);
    expect(isAlreadyExistsResponse(500, "<html>gateway</html>")).toBe(false);
  });
});
