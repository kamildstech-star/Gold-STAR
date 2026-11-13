/**
 * Scope of work suggested from a room's own data and photos (David, 27 Oct).
 *
 * Reads with the caller's own session (RLS applies), so it can only see a room
 * and photos the caller could open. Suggests lines; never writes them — the
 * office adds what it agrees with on the Rooms tab.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ROOM_SCOPE_SYSTEM, parseScopeSuggestions, roomScopeContext } from "@/lib/room-photos";

const input = z.object({ room_id: z.string().uuid() });

export const suggestRoomScope = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data, context }): Promise<{ lines: string[] }> => {
    const db = context.supabase;
    const { data: room, error } = await db
      .from("job_rooms")
      .select("*")
      .eq("id", data.room_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!room) throw new Error("Room not found.");

    const { data: job } = await db.from("jobs").select("*").eq("id", room.job_id).maybeSingle();

    const { data: folders } = await db.from("photo_folders").select("id").eq("room_id", room.id);
    const folderIds = (folders ?? []).map((f) => f.id);
    let photos: { caption: string | null; tags: string[] }[] = [];
    if (folderIds.length) {
      const { data: rows } = await db
        .from("photos")
        .select("id")
        .in("folder_id", folderIds)
        .is("deleted_at", null)
        .limit(40);
      const ids = (rows ?? []).map((r) => r.id);
      if (ids.length) {
        const [{ data: comments }, { data: tagged }] = await Promise.all([
          db
            .from("photo_comments")
            .select("photo_id,body,created_at")
            .in("photo_id", ids)
            .is("deleted_at", null)
            .order("created_at", { ascending: true }),
          db.from("photo_tags").select("photo_id,tag_id").in("photo_id", ids),
        ]);
        const tagIds = [...new Set((tagged ?? []).map((t) => t.tag_id))];
        const { data: tagRows } = tagIds.length
          ? await db.from("tags").select("id,name").in("id", tagIds)
          : { data: [] as { id: string; name: string }[] };
        const tagName = new Map((tagRows ?? []).map((t) => [t.id, t.name]));
        const caption = new Map<string, string>();
        for (const c of comments ?? [])
          if (!caption.has(c.photo_id)) caption.set(c.photo_id, c.body);
        photos = ids.map((id) => ({
          caption: caption.get(id) ?? null,
          tags: (tagged ?? [])
            .filter((t) => t.photo_id === id)
            .map((t) => tagName.get(t.tag_id))
            .filter((n): n is string => !!n),
        }));
      }
    }

    const j = (job ?? {}) as Record<string, unknown>;
    const ctx = roomScopeContext({
      room: room as never,
      photos,
      waterCategory: (j["water_category"] as number | null) ?? null,
      waterClass: (j["water_class"] as number | null) ?? null,
    });

    const { complete } = await import("./ai.server");
    const { untrusted, UNTRUSTED_PREAMBLE } = await import("./assistant-scope.server");
    const reply = await complete(
      `${ROOM_SCOPE_SYSTEM}\n${UNTRUSTED_PREAMBLE}`,
      `ROOM DATA:\n${untrusted(ctx)}`,
      true,
      "general",
      { feature: "room_scope" },
    );
    return { lines: parseScopeSuggestions(reply, ctx.existing_scope) };
  });
