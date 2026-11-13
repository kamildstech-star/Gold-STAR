// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { Input } from "./input";

/*
 * FE5, 28 Oct: `<Input type="date">` shows MM/DD/YYYY whatever the
 * computer's region, and callers still get ISO from e.target.value.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(el: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("<Input type=date>", () => {
  it("draws a text box reading MM/DD/YYYY, not a native date box", () => {
    const { host, unmount } = mount(
      createElement(Input, { type: "date", value: "2026-10-28", onChange: () => {} }),
    );
    const box = host.querySelector("input[data-date-input]") as HTMLInputElement;
    expect(box.type).toBe("text");
    expect(box.value).toBe("10/28/2026");
    expect(host.querySelector('input[type="date"]')).toBeNull();
    unmount();
  });

  it("hands back ISO once a whole date is typed, nothing before", () => {
    const seen: string[] = [];
    function Harness() {
      const [v, setV] = useState("");
      return createElement(Input, {
        type: "date",
        value: v,
        onChange: (e) => {
          seen.push(e.target.value);
          setV(e.target.value);
        },
      });
    }
    const { host, unmount } = mount(createElement(Harness));
    const box = host.querySelector("input[data-date-input]") as HTMLInputElement;
    type(box, "1028");
    expect(seen).toEqual([]);
    expect(box.value).toBe("10/28");
    type(box, "10282026");
    expect(seen).toEqual(["2026-10-28"]);
    expect(box.value).toBe("10/28/2026");
    type(box, "");
    expect(seen).toEqual(["2026-10-28", ""]);
    unmount();
  });

  it("an uncontrolled box saved on blur gets ISO", () => {
    const onBlur = vi.fn();
    const { host, unmount } = mount(
      createElement(Input, { type: "date", defaultValue: "2026-01-02", onBlur }),
    );
    const box = host.querySelector("input[data-date-input]") as HTMLInputElement;
    expect(box.value).toBe("01/02/2026");
    type(box, "03/04/26");
    act(() => {
      box.focus();
      box.blur();
    });
    expect(onBlur).toHaveBeenCalled();
    expect(onBlur.mock.calls.at(-1)![0].target.value).toBe("2026-03-04");
    expect(box.value).toBe("03/04/2026");
    unmount();
  });

  it("datetime-local: MM/DD/YYYY plus a time, ISO out", () => {
    const onChange = vi.fn();
    const { host, unmount } = mount(
      createElement(Input, { type: "datetime-local", value: "2026-10-28T14:05", onChange }),
    );
    const box = host.querySelector("input[data-date-input]") as HTMLInputElement;
    const time = host.querySelector('input[type="time"]') as HTMLInputElement;
    expect(box.value).toBe("10/28/2026");
    expect(time.value).toBe("14:05");
    type(time, "09:30");
    expect(onChange.mock.calls.at(-1)![0].target.value).toBe("2026-10-28T09:30");
    unmount();
  });
});
