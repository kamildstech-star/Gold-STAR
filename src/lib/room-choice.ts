import { roomLabel, type JobRoom } from "@/lib/job-rooms";

/**
 * A scope on an estimate or invoice names its room as text — `room_name` is a
 * free column, and stays one. That is deliberate: an estimate is often written
 * before anyone has recorded rooms, a Xactimate import names areas its own
 * way, and "Lobby", "Stairwell" and "2nd floor hallway" are real places on a
 * commercial loss that nobody would list as a room. What the picker does is
 * offer the job's real rooms first and store the same label the Rooms tab
 * prints, so a scope and a photo folder and a moisture reading for the same
 * bedroom all say "Unit 4B · Bedroom".
 *
 * A value already stored that matches no room is not thrown away: it is shown
 * as it is, marked as off the list, and left until someone re-points it.
 */
export type RoomChoice =
  | { kind: "none" }
  | { kind: "room"; roomId: string; label: string }
  | { kind: "custom"; label: string };

const fold = (s: string) => s.trim().toLowerCase();

/** Which option a stored `room_name` selects — a room, nothing, or off-list text. */
export function resolveRoomChoice(
  value: string | null | undefined,
  rooms: Pick<JobRoom, "id" | "unit" | "name">[],
): RoomChoice {
  const text = (value ?? "").trim();
  if (!text) return { kind: "none" };
  // Only the printed label counts. "Kitchen" is not "Unit 4B · Kitchen" even
  // when there is one kitchen on the job today — there will be two tomorrow.
  const match = rooms.find((r) => fold(roomLabel(r)) === fold(text));
  if (match) return { kind: "room", roomId: match.id, label: roomLabel(match) };
  return { kind: "custom", label: text };
}

/** The `room_name` to store for a room picked from the list. */
export function roomChoiceLabel(
  roomId: string,
  rooms: Pick<JobRoom, "id" | "unit" | "name">[],
): string | null {
  const room = rooms.find((r) => r.id === roomId);
  return room ? roomLabel(room) : null;
}
