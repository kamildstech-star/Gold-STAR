// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Pager, usePaged } from "@/components/billing-costs/pager";

/**
 * Billing & Costs lists page 50 at a time over the WHOLE filtered list: a
 * filter change starts again at page 1, a shrinking list never strands the
 * reader on an empty page, and a jump turns to the page that holds the row.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let api: { setFilter: (f: number) => void; jump: (i: number) => void };

function List() {
  const [filter, setFilter] = useState(0);
  const rows = Array.from({ length: 120 - filter * 100 }, (_, i) => `r${i}`);
  const paged = usePaged(rows, String(filter));
  api = { setFilter, jump: paged.showIndex };
  return createElement(
    "div",
    null,
    createElement("ol", null, ...paged.rows.map((r) => createElement("li", { key: r }, r))),
    createElement(Pager, { paged, noun: "items", pending: 2 }),
  );
}

const $ = (sel: string) => host.querySelector(sel);
const pager = () => $("[data-pager]")?.textContent ?? "";
const click = (label: string) =>
  act(() => (host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click());

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(List)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Billing & Costs pages", () => {
  it("shows 50 a page with the range and the whole count", () => {
    expect(host.querySelectorAll("li")).toHaveLength(50);
    expect(pager()).toMatch(/1–50 of 120 items/);
    expect(pager()).toMatch(/Page 1 of 3/);
    click("Next page");
    click("Next page");
    expect(pager()).toMatch(/101–120 of 120 items/);
    expect(host.querySelectorAll("li")).toHaveLength(20);
    expect((host.querySelector('[aria-label="Next page"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says edits on other pages are kept while there are pages", () => {
    expect(pager()).toMatch(/edits on other pages are kept until you save or discard/);
  });

  it("starts again at page 1 when the filter changes, over the filtered list", () => {
    click("Next page");
    act(() => api.setFilter(1));
    expect(pager()).toMatch(/1–20 of 20 items/);
    expect($('[aria-label="Next page"]')).toBeNull();
  });

  it("turns to the page holding a row", () => {
    act(() => api.jump(77));
    expect(pager()).toMatch(/51–100 of 120/);
    expect(host.textContent).toContain("r77");
  });
});
