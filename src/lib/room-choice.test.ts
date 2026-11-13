import { describe, expect, it } from "vitest";

import { resolveRoomChoice, roomChoiceLabel } from "./room-choice";

const rooms = [
  { id: "k", unit: null, name: "Kitchen" },
  { id: "b4", unit: "4B", name: "Bedroom" },
  { id: "b5", unit: "5A", name: "Bedroom" },
];

describe("resolveRoomChoice", () => {
  it("is nothing for a blank value", () => {
    expect(resolveRoomChoice(null, rooms)).toEqual({ kind: "none" });
    expect(resolveRoomChoice("   ", rooms)).toEqual({ kind: "none" });
  });

  it("finds a room by the label the Rooms tab prints, ignoring case", () => {
    expect(resolveRoomChoice("kitchen", rooms)).toEqual({
      kind: "room",
      roomId: "k",
      label: "Kitchen",
    });
    expect(resolveRoomChoice("unit 4b · bedroom", rooms)).toEqual({
      kind: "room",
      roomId: "b4",
      label: "Unit 4B · Bedroom",
    });
  });

  it("does not guess a unit for a bare room name", () => {
    expect(resolveRoomChoice("Bedroom", rooms)).toEqual({ kind: "custom", label: "Bedroom" });
  });

  it("keeps an off-list value as typed", () => {
    expect(resolveRoomChoice(" Lobby ", rooms)).toEqual({ kind: "custom", label: "Lobby" });
    expect(resolveRoomChoice("Lobby", [])).toEqual({ kind: "custom", label: "Lobby" });
  });
});

describe("roomChoiceLabel", () => {
  it("stores the printed label, unit first", () => {
    expect(roomChoiceLabel("b4", rooms)).toBe("Unit 4B · Bedroom");
    expect(roomChoiceLabel("k", rooms)).toBe("Kitchen");
  });

  it("stores nothing for a room that is not on the job", () => {
    expect(roomChoiceLabel("nope", rooms)).toBeNull();
  });
});
