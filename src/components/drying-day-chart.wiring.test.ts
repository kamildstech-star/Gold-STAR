import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 2026-10-06, on the drying log's Days card: "shrink this to 2/3 size
 * and have the last 1/3 show a line graph, one line color for each reading."
 *
 * The series, colours, gaps and ranges are pure and tested in
 * src/lib/drying-day-chart.test.ts. What has to hold HERE is the wiring: the
 * card splits two thirds / one third only where there is room and stacks
 * otherwise, the chart is fed the squares' own tiles, and each line is drawn
 * broken at a gap with a dot on every reading.
 *
 * Fragments are extracted with a regex before asserting, never the whole file,
 * so an explanatory comment can neither satisfy nor break a check. Line
 * endings are normalised because git checks this repo out CRLF on Windows.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const LOG = read("src/components/job-drying-log.tsx");
const CHART = read("src/components/drying-day-chart.tsx");

const classesOf = (m: RegExpMatchArray | null) => {
  expect(m).not.toBeNull();
  return m![1]!.split(/\s+/);
};

describe("the Days card: squares two thirds, chart one third", () => {
  it("is its own container, so the split follows the card's width, not the screen's", () => {
    const card = classesOf(
      LOG.match(
        // The heading shares a row with the Grid / Day by day toggle, one div deeper.
        /<div className="(@container [^"]*rounded-md border p-3)">\s*<div[^>]*>\s*(?:<div[^>]*>\s*)?<p[^>]*>Days</,
      ),
    );
    expect(card).toContain("@container");
  });

  it("splits into thirds only from @3xl, and stacks below that", () => {
    const split = classesOf(
      LOG.match(/<div className="(grid gap-3 [^"]*)">\s*<div className="@container/),
    );
    expect(split).toContain("@3xl:grid-cols-3");
    // No bare grid-cols-*: under @3xl it is one column, the chart under the squares.
    expect(split.filter((c) => /^grid-cols-/.test(c))).toEqual([]);
  });

  it("gives the squares two of the three columns and the chart the third", () => {
    const squares = classesOf(
      LOG.match(/<div className="(@container [^"]*@3xl:col-span-2[^"]*)">/),
    );
    expect(squares).toContain("min-w-0");
    // The tile grid lives inside the squares' column.
    const col = LOG.slice(LOG.indexOf('@3xl:col-span-2"'));
    expect(col.indexOf("tiles.map((t) => (")).toBeLessThan(col.indexOf("<DryingDayChart"));
    const chartCol = LOG.match(/<div className="([^"]*)">\s*<DryingDayChart tiles=\{tiles\} \/>/);
    expect(classesOf(chartCol)).toContain("min-w-0");
  });

  it("feeds the chart the same tiles the squares are drawn from", () => {
    expect(LOG.match(/<DryingDayChart tiles=\{tiles\} \/>/g)).toHaveLength(1);
    expect(CHART).toMatch(/buildDryingChartRows\(tiles\)/);
  });
});

describe("the chart draws gaps as gaps", () => {
  const line = CHART.match(/<Line\s[\s\S]*?\/>\n/)?.[0] ?? "";

  it("never bridges a missing day", () => {
    expect(line).toContain("connectNulls={false}");
  });

  it("puts a dot on every reading, so one between two gaps still shows", () => {
    expect(line).toMatch(/\bdot=\{\{\s*r:/);
  });

  it("draws each series in its own color and dash from the series table", () => {
    expect(line).toContain("stroke={s.color}");
    expect(line).toMatch(/strokeDasharray=\{s\.dashed \? "[\d. ]+" : undefined\}/);
    expect(line).toContain("dataKey={s.key}");
  });

  it("ranges the y axis from the tested panelAxis, not the library's default", () => {
    expect(CHART).toMatch(/<YAxis\s+domain=\{axis\.domain\}\s+ticks=\{axis\.ticks\}/);
    expect(CHART).toMatch(/const axis = panelAxis\(rows, panel\)/);
  });

  it("has no second y axis: degrees and RH are separate panels", () => {
    expect(CHART.match(/<YAxis\b/g)).toHaveLength(1);
    expect(CHART).not.toMatch(/yAxisId|orientation="right"/);
  });

  it("gives the exact figures with units in the tooltip, through formatChartFigure", () => {
    const readout = CHART.match(/function DayReadout[\s\S]*?\n}\n/)![0];
    expect(readout).toContain("formatChartFigure(row[key], s.unit)");
    for (const key of ["outTemp", "inTemp", "outRh", "inRh", "outDew", "inDew", "affectedDew"]) {
      expect(readout).toContain(`cell("${key}")`);
    }
  });
});
