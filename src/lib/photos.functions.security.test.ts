import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

// Exercise the real validators/handlers and Storage SDK; only the framework
// transport, authenticated context and outgoing HTTP are replaced.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: unknown) => unknown) => async (args: { data: unknown; context: unknown }) =>
          fn({ ...args, data: validate(args.data) }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
const state = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return state.admin;
  },
}));

import { createPhotoUploadUrls, finalizePhoto, signVariantUrl } from "./photos.functions";

const project = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const photo = "01K00000000000000000000000";
const requests: string[] = [];
const rpc = vi.fn();
const from = vi.fn();
const context = { userId: "caller", supabase: { rpc, from } };
const invoke = (fn: unknown, data: unknown) =>
  (fn as (args: unknown) => Promise<unknown>)({ data, context });

beforeEach(() => {
  requests.length = 0;
  from.mockReset();
  rpc.mockReset().mockImplementation(async (_name, args) => ({
    data: args._project_id === project,
    error: null,
  }));
  state.admin = createClient("https://storage.example", "test-service-role", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input) => {
        // Native fetch normalizes dot segments before sending the request.
        const url = new Request(input).url;
        requests.push(url);
        return Response.json({
          url: "/object/upload/sign/result?token=test",
          signedURL: "/object/sign/result?token=test",
        });
      },
    },
  });
});

describe("photo signing project boundary", () => {
  it.each([
    `${project}/../${other}/orig/private.jpg`,
    `${project}/%2e%2e/${other}/orig/private.jpg`,
    `${project}/..\\${other}\\orig\\private.jpg`,
    `${project}/../../documents/private.pdf`,
  ])("rejects a read path that normalizes outside the authorized project: %s", async (path) => {
    await expect(invoke(signVariantUrl, { path })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each([
    "../../private/secret-photo",
    "..\\..\\private\\secret-photo",
    "%2e%2e/secret-photo-id",
  ])("rejects upload path syntax in a client photo ID: %s", async (photoId) => {
    await expect(
      invoke(createPhotoUploadUrls, { projectId: project, photoId, ext: "jpg" }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("rejects traversal IDs during finalization before any database write", async () => {
    await expect(
      invoke(finalizePhoto, {
        projectId: project,
        photoId: "../../private/secret-photo",
        ext: "jpg",
        mime: "image/jpeg",
        sizeBytes: 1,
        width: 1,
        height: 1,
        capturedAt: null,
        exifLat: null,
        exifLon: null,
        exifRaw: {},
        displayWidth: 1,
        displayHeight: 1,
        displayBytes: 1,
        thumbWidth: 1,
        thumbHeight: 1,
        thumbBytes: 1,
      }),
    ).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });

  it("still signs a canonical path in a readable project", async () => {
    await invoke(signVariantUrl, { path: `${project}/display/${photo}.webp` });
    expect(requests).toEqual([
      `https://storage.example/storage/v1/object/sign/project-photos/${project}/display/${photo}.webp`,
    ]);
  });

  it("still creates all three upload URLs for a ULID", async () => {
    await invoke(createPhotoUploadUrls, { projectId: project, photoId: photo, ext: "JPG" });
    expect(requests).toHaveLength(3);
    expect(requests.every((url) => url.includes(`/project-photos/${project}/`))).toBe(true);
  });

  /*
   * Mark's 182nd photo: "Last error: The resource already exists". Signing a
   * key that exists is refused, and that refusal has to come back as "this
   * object is stored" — read from the real storage client's error, in both
   * shapes Storage has used for it, not from the sentence alone.
   */
  describe("a key an earlier attempt already stored", () => {
    const answerOrigWith = (status: number, body: Record<string, string>) => {
      state.admin = createClient("https://storage.example", "test-service-role", {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input) => {
            const url = new Request(input).url;
            requests.push(url);
            if (url.includes("/orig/")) return Response.json(body, { status });
            return Response.json({ url: "/object/upload/sign/result?token=test" });
          },
        },
      });
    };

    it.each([
      [
        "HTTP 400 with 409 in the body",
        400,
        { statusCode: "409", error: "Duplicate", message: "The resource already exists" },
      ],
      [
        "a real HTTP 409 with a service code",
        409,
        { statusCode: "409", code: "KeyAlreadyExists", message: "The resource already exists" },
      ],
    ])("comes back as alreadyStored, not an error: %s", async (_label, status, body) => {
      answerOrigWith(status, body);
      const out = (await invoke(createPhotoUploadUrls, {
        projectId: project,
        photoId: photo,
        ext: "jpg",
      })) as Record<string, { alreadyStored: boolean; signedUrl: string | null }>;

      expect(out.original).toMatchObject({ alreadyStored: true, signedUrl: null });
      expect(out.display!.alreadyStored).toBe(false);
      expect(out.display!.signedUrl).toContain("token=test");
      expect(out.thumb!.alreadyStored).toBe(false);
    });

    it("never asks for an upsert URL that could overwrite the stored original", async () => {
      const headers: Record<string, string>[] = [];
      state.admin = createClient("https://storage.example", "test-service-role", {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input, init) => {
            headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
            const url = new Request(input).url;
            if (url.includes("/orig/")) {
              return Response.json(
                { statusCode: "409", error: "Duplicate", message: "The resource already exists" },
                { status: 400 },
              );
            }
            return Response.json({ url: "/object/upload/sign/result?token=test" });
          },
        },
      });
      await invoke(createPhotoUploadUrls, { projectId: project, photoId: photo, ext: "jpg" });
      expect(headers).toHaveLength(3);
      expect(headers.some((h) => "x-upsert" in h)).toBe(false);
    });

    it("still throws on a refusal that is not a duplicate", async () => {
      answerOrigWith(403, { statusCode: "403", error: "Unauthorized", message: "Access denied" });
      await expect(
        invoke(createPhotoUploadUrls, { projectId: project, photoId: photo, ext: "jpg" }),
      ).rejects.toThrow("Access denied");
    });
  });

  it("refuses a canonical path in another project", async () => {
    await expect(
      invoke(signVariantUrl, { path: `${other}/display/${photo}.webp` }),
    ).rejects.toThrow("Not authorized");
    expect(requests).toEqual([]);
  });
});
