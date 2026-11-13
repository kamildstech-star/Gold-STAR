import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatDateTimeUS, formatDateUS } from "./date-format";

describe("formatDateUS", () => {
  it("renders MM/DD/YYYY", () => {
    expect(formatDateUS("2026-10-25")).toBe("10/25/2026");
    expect(formatDateUS("2026-03-04")).toBe("03/04/2026");
  });

  it("keeps a bare date column on its own day", () => {
    expect(formatDateUS("2026-09-01")).toBe("09/01/2026");
  });

  it("falls back on empty or bad input", () => {
    expect(formatDateUS(null)).toBe("—");
    expect(formatDateUS("", "")).toBe("");
    expect(formatDateUS("not a date")).toBe("—");
  });

  it("formats timestamps month-first", () => {
    expect(formatDateTimeUS("2026-10-25T15:04:00Z", "—", "UTC")).toBe("10/25/2026, 3:04 PM");
  });
});

/*
 * Guard: a date formatted in the viewer's locale is how the Jobs list showed
 * 25/10/2026 on a UK-set machine. No source file may format a date without
 * naming the US locale.
 */
const root = path.resolve(__dirname, "..");
const files: string[] = [];
(function walk(d: string) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
  }
})(root);

describe("no locale-default or day-first date formatting", () => {
  it("never uses en-GB, DD/MM, or a bare toLocaleDateString()", () => {
    const bad: string[] = [];
    for (const f of files) {
      const s = fs.readFileSync(f, "utf8");
      if (/"en-GB"|DD\/MM|dd\/MM|\.toLocaleDateString\(\)|\.toLocaleDateString\(undefined/.test(s))
        bad.push(path.relative(root, f));
    }
    expect(bad).toEqual([]);
  });
});

/*
 * FE5, 28 Oct: a native `<input type="date">` draws its box in the
 * operating system's regional order — the T&M bill's From/To read day-first
 * on a UK-set machine. Every date and date-time box goes through `<Input>`
 * (which hands those types to DateInput) or DateInput itself; a raw
 * `<input type="date">` or `type="datetime-local"` anywhere else fails here.
 */
describe("no native date inputs", () => {
  const tsx = files.filter((f) => f.endsWith(".tsx"));

  it("only DateInput may draw a date box", () => {
    const bad: string[] = [];
    for (const f of tsx) {
      const s = fs.readFileSync(f, "utf8");
      for (const m of s.matchAll(/<input\b/g)) {
        const tag = s.slice(m.index, m.index + 400).split("/>")[0]!;
        if (/\btype=(?:"(?:date|datetime-local)"|\{[^}]*"(?:date|datetime-local)")/.test(tag)) {
          bad.push(`${path.relative(root, f)}:${s.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("<Input> hands date and datetime-local to DateInput", () => {
    const input = fs.readFileSync(path.join(root, "components/ui/input.tsx"), "utf8");
    expect(input).toMatch(
      /if \(type === "date" \|\| type === "datetime-local"\) \{\s*return \(?\s*<DateInput/,
    );
  });

  it("DateInput never renders a native date box itself", () => {
    const di = fs.readFileSync(path.join(root, "components/ui/date-input.tsx"), "utf8");
    expect(di).not.toMatch(/type="(date|datetime-local)"/);
    expect(di).toContain('placeholder={placeholder ?? "MM/DD/YYYY"}');
  });
});
