// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark, 7 Oct 2026, on the drying log's Inside card: "add a way to add a room
 * from here too." Drives the real picker and the real form; the Radix select
 * and dialog are swapped for plain elements, because what is under test is
 * what a pick does, not how a listbox opens in jsdom.
 *
 * No DOM testing library, per the brief: `react-dom/client` and `act`.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/select", () => {
  const Pick = createContext<(v: string) => void>(() => {});
  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: ReactNode;
      onValueChange: (v: string) => void;
    }) => createElement(Pick.Provider, { value: onValueChange }, children),
    SelectTrigger: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) =>
      createElement("div", { role: "listbox" }, children),
    SelectSeparator: () => createElement("hr"),
    SelectItem: function Item({ children, value }: { children: ReactNode; value: string }) {
      const pick = useContext(Pick);
      return createElement(
        "div",
        { role: "option", "data-value": value, onClick: () => pick(value) },
        children,
      );
    },
  };
});
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? createElement("div", { role: "dialog" }, children) : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
  };
});

import { DryingRoomSelect } from "./drying-room-select";
import { ADD_ROOM, UNIT_ANY, type RoomChoice } from "@/lib/drying-room-picker";
import type { JobRoom } from "@/lib/job-rooms";

const room = (id: string, name: string, unit: string | null = null): JobRoom => ({
  id,
  job_id: "job-1",
  unit,
  name,
  floor: null,
  length_ft: null,
  width_ft: null,
  height_ft: null,
  affected_materials: [],
  notes: null,
  sort_order: 0,
  flooring: null,
  extra_sf: 0,
});

const kitchen = room("room-kitchen", "Kitchen");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function mount(props: {
  canAddRoom: boolean;
  choice?: RoomChoice;
  onChoose?: (c: RoomChoice) => void;
  onAddRoom?: (f: unknown) => Promise<JobRoom | null>;
}) {
  const onChoose = props.onChoose ?? vi.fn();
  const onAddRoom = props.onAddRoom ?? vi.fn(async () => null);
  act(() => {
    root.render(
      createElement(DryingRoomSelect, {
        id: "room-1",
        rooms: [kitchen],
        choice: props.choice ?? { unit: UNIT_ANY, roomId: kitchen.id },
        onChoose,
        canAddRoom: props.canAddRoom,
        unitAvailable: true,
        onAddRoom,
      }),
    );
  });
  return { onChoose, onAddRoom };
}

const option = (value: string) =>
  container.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);

function pickAdd() {
  act(() => option(ADD_ROOM)!.click());
  act(() => vi.runAllTimers());
}

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
function typeInto(input: HTMLInputElement, text: string) {
  act(() => {
    setNativeValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

describe("+ Add room in the drying log's room picker", () => {
  it("is offered to someone who may manage the job, at the foot of the list", () => {
    mount({ canAddRoom: true });
    const values = [...container.querySelectorAll('[role="option"]')].map((o) =>
      o.getAttribute("data-value"),
    );
    expect(values).toEqual(["none", kitchen.id, ADD_ROOM]);
    expect(option(ADD_ROOM)!.textContent).toContain("Add room");
  });

  it("is not offered to anyone else, who still picks the rooms there are", () => {
    mount({ canAddRoom: false });
    expect(option(ADD_ROOM)).toBeNull();
    expect(option(kitchen.id)).not.toBeNull();
    expect(container.textContent).not.toContain("Add room");
  });

  it("opens the form with the name box focused, without changing the reading's room", () => {
    const { onChoose } = mount({ canAddRoom: true });
    pickAdd();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    const name = container.querySelector<HTMLInputElement>("#add-room-name")!;
    expect(document.activeElement).toBe(name);
    expect(name.required).toBe(true);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("saves through the add path it is given and selects the new room", async () => {
    const closet = room("room-closet", "Closet", "4B");
    const onAddRoom = vi.fn(async () => closet);
    const { onChoose } = mount({ canAddRoom: true, onAddRoom });
    pickAdd();
    typeInto(container.querySelector<HTMLInputElement>("#add-room-name")!, "Closet");
    typeInto(container.querySelector<HTMLInputElement>("#add-room-unit")!, "4B");
    typeInto(container.querySelector<HTMLInputElement>("#add-room-floor")!, "2nd");
    await act(async () => {
      button("Save room")!.click();
    });

    expect(onAddRoom).toHaveBeenCalledWith({ name: "Closet", unit: "4B", floor: "2nd" });
    // The unit follows the room, as for any room picked off the list.
    expect(onChoose).toHaveBeenCalledWith({ unit: "u:4b", roomId: closet.id });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps the form, and the selection, when the add is refused", async () => {
    const onAddRoom = vi.fn(async () => null);
    const { onChoose } = mount({ canAddRoom: true, onAddRoom });
    pickAdd();
    typeInto(container.querySelector<HTMLInputElement>("#add-room-name")!, "Kitchen");
    await act(async () => {
      button("Save room")!.click();
    });
    expect(onAddRoom).toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#add-room-name")!.value).toBe("Kitchen");
  });

  it("returns to the picker unchanged on Cancel", () => {
    const onAddRoom = vi.fn(async () => null);
    const { onChoose } = mount({ canAddRoom: true, onAddRoom });
    pickAdd();
    typeInto(container.querySelector<HTMLInputElement>("#add-room-name")!, "Laundry");
    act(() => button("Cancel")!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(onAddRoom).not.toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("will not save without a name", () => {
    mount({ canAddRoom: true });
    pickAdd();
    expect(button("Save room")!.disabled).toBe(true);
  });
});
