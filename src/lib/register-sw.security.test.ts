import { describe, expect, it, vi } from "vitest";
import { retirePrivatePageCaches } from "./register-sw";

describe("retiring private responses cached by older workers", () => {
  it("removes document API entries and navigation HTML but preserves static assets", async () => {
    const requests = [
      new Request("https://app.test/api/documents/private/file"),
      new Request("https://app.test/assets/app.js"),
      new Request("https://app.test/logo.png"),
    ];
    const entries = new Set(requests);
    const cache = {
      keys: async () => requests,
      delete: vi.fn(async (request: Request) => entries.delete(request)),
    };
    const storage = {
      delete: vi.fn().mockResolvedValue(true),
      has: vi.fn().mockResolvedValue(true),
      open: vi.fn().mockResolvedValue(cache),
    };
    await retirePrivatePageCaches(storage as unknown as CacheStorage);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith("html-nav");
    expect(cache.delete).toHaveBeenCalledExactlyOnceWith(requests[0]);
    expect([...entries]).toEqual(requests.slice(1));
  });
  it("does not create a cache on a fresh installation", async () => {
    const storage = {
      delete: vi.fn().mockResolvedValue(false),
      has: vi.fn().mockResolvedValue(false),
      open: vi.fn(),
    };
    await retirePrivatePageCaches(storage as unknown as CacheStorage);
    expect(storage.open).not.toHaveBeenCalled();
  });
});
