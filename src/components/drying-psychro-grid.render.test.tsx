// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { DryingReading } from "@/lib/drying-log";

import { DryingPsychroGrid } from "./drying-psychro-grid";

/**
 * 11 Nov (client): every room has its own Inside °F / %RH pair, and each room
 * opens and closes like an accordion, closed by default.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

const reading = (over: Partial<DryingReading>): DryingReading =>
  ({
    id: Math.random().toString(36).slice(2),
    job_id: "j1",
    point: "interior",
    reading_date: "2026-11-09",
    temperature_f: 72,
    relative_humidity: 50,
    room_id: null,
    source: "manual",
    captured_at: "2026-11-09T10:00:00Z",
    ...over,
  }) as DryingReading;

async function mount(roomNames: Map<string, string>, readings: DryingReading[] = []) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(DryingPsychroGrid, {
        dates: ["2026-11-08", "2026-11-09"],
        readings,
        roomNames,
        selectedDate: "2026-11-09",
        today: "2026-11-09",
        onPickDate: () => {},
        onSave: async () => {},
        writesDisabled: false,
        writesReason: null,
      }),
    );
  });
  return host;
}

const rowLabels = (el: HTMLElement) =>
  [...el.querySelectorAll("tbody tr > th[scope='row']")].map((t) => t.textContent);

describe("the drying grid's rooms", () => {
  it("lists each room closed, with no inside rows until one is opened", async () => {
    const el = await mount(
      new Map([
        ["r1", "Kitchen"],
        ["r2", "Bedroom"],
      ]),
      [reading({ room_id: "r1" })],
    );
    const heads = [...el.querySelectorAll("[data-grid-room] button")];
    expect(heads.map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(heads[0].textContent).toContain("Kitchen");
    expect(heads[0].textContent).toContain("1d");
    expect(rowLabels(el)).not.toContain("Inside °F");
    // Outside stays open.
    expect(rowLabels(el)).toContain("Outside °F");

    await act(async () => {
      (heads[0] as HTMLButtonElement).click();
    });
    expect(heads[0].getAttribute("aria-expanded")).toBe("true");
    expect(rowLabels(el).filter((l) => l === "Inside °F")).toHaveLength(1);
    const kitchen = el.querySelector<HTMLInputElement>(
      "input[aria-label='Kitchen Inside °F, 11/9']",
    );
    expect(kitchen?.value).toBe("72");

    await act(async () => {
      (heads[0] as HTMLButtonElement).click();
    });
    expect(rowLabels(el)).not.toContain("Inside °F");
  });

  it("shows the one inside pair open on a job with no rooms", async () => {
    const el = await mount(new Map());
    expect(el.querySelector("[data-grid-room]")).toBeNull();
    expect(rowLabels(el)).toContain("Inside °F");
  });
});
