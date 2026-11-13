import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  clientPinDetails,
  contactTitle,
  dealPinDetails,
  jobPinDetails,
  officePinDetails,
  parsePinId,
  stopPinDetails,
  visitPinDetails,
  type PinDetailRow,
} from "./map-pin-details";
import { pinGlyphDataUri, pinGlyphSvg } from "./map-pin-glyphs";
import { clusterSplitsOnZoom, clusterPoints, filterToViewport } from "./map-viewport";
import { pinLabel } from "../routes/_authenticated/routes.index";
import type { MapJob } from "./map-jobs";
import type { PlannableStop, Visit } from "./visits";

/**
 * Mark: "make the circles clickable to see details" — and then, with a
 * Pipedrive map, "it should show the current stage in the pipeline and who
 * the salesman is." The first half here is the derivation: which lines a pin
 * of each kind puts on its card. The second half is the wiring in the Routes
 * page and the map, read from source (there is no DOM library in this repo).
 */

const stop = (over: Partial<PlannableStop> = {}): PlannableStop => ({
  id: "acc-1",
  name: "IB YBI Coverage",
  address: "1310 48th St, Brooklyn, NY 11219",
  street: "1310 48th St",
  city: "Brooklyn",
  state: "NY",
  postal_code: "11219",
  area: "11219",
  last_in_person_at: null,
  kind: "prospect",
  stage_id: "st-2",
  stage_key: "active_outreach",
  stage_name: "Active Outreach",
  stage_order: 2,
  value: 12000,
  stage_color: "#7A5AF8",
  health_name: null,
  health_color: null,
  owner_id: "rep-1",
  owner_name: "Alex Brown",
  contact_name: "Yossi Burger",
  email: "yosef@example.com",
  phone: "718-555-0100",
  ...over,
});

const row = (rows: PinDetailRow[], label: string) => rows.find((r) => r.label === label);

describe("a deal pin", () => {
  it("leads with contact · company as the link to the account, then stage and salesman", () => {
    const d = dealPinDetails(stop());
    expect(d.kind).toBe("deal");
    expect(d.title).toBe("Yossi Burger · IB YBI Coverage");
    expect(d.target).toEqual({ kind: "account", id: "acc-1" });
    expect(d.rows.map((r) => r.label)).toEqual([
      "Stage",
      "Salesman",
      "Email",
      "Phone",
      "Last visit",
    ]);
    expect(row(d.rows, "Stage")).toMatchObject({ value: "Active Outreach", dot: "#7A5AF8" });
    expect(row(d.rows, "Salesman")).toMatchObject({ value: "Alex Brown", avatar: true });
    expect(row(d.rows, "Email")).toMatchObject({ href: "mailto:yosef@example.com" });
    expect(row(d.rows, "Phone")).toMatchObject({ href: "tel:718-555-0100" });
    expect(d.address).toBe("1310 48th St, Brooklyn, NY 11219");
    expect(d.directionsTo).toBe(d.address);
  });

  it("is plannable — Add to route targets the account", () => {
    expect(dealPinDetails(stop()).stopId).toBe("acc-1");
  });

  it("says 'never visited' in the warning tone, and the date otherwise", () => {
    expect(row(dealPinDetails(stop()).rows, "Last visit")).toMatchObject({
      value: "never visited",
      tone: "warning",
    });
    expect(
      row(dealPinDetails(stop({ last_in_person_at: "2026-09-01T14:00:00Z" })).rows, "Last visit"),
    ).toMatchObject({ value: "2026-09-01" });
  });

  it("falls back to the company alone and 'Unassigned' when there is no contact or rep", () => {
    const d = dealPinDetails(
      stop({ contact_name: null, owner_name: null, owner_id: null, email: null, phone: null }),
    );
    expect(d.title).toBe("IB YBI Coverage");
    expect(row(d.rows, "Salesman")).toMatchObject({ value: "Unassigned", avatar: false });
    expect(row(d.rows, "Email")).toBeUndefined();
    expect(row(d.rows, "Phone")).toBeUndefined();
  });
});

describe("a client pin", () => {
  it("shows the health band in place of the stage, and never-visited reads plain", () => {
    const c = clientPinDetails(
      stop({ kind: "client", stage_name: null, health_name: "Healthy", health_color: "#1E9E6A" }),
    );
    expect(c.kind).toBe("client");
    expect(c.rows.map((r) => r.label)).toEqual([
      "Health",
      "Salesman",
      "Email",
      "Phone",
      "Last visit",
    ]);
    expect(row(c.rows, "Health")).toMatchObject({ value: "Healthy", dot: "#1E9E6A" });
    expect(row(c.rows, "Last visit")).toMatchObject({ value: "never visited" });
    expect(row(c.rows, "Last visit")!.tone).toBeUndefined();
    expect(c.stopId).toBe("acc-1");
  });

  it("has no band row when none was set by hand", () => {
    const c = clientPinDetails(stop({ kind: "client", health_name: null }));
    expect(row(c.rows, "Health")).toBeUndefined();
  });

  it("is what a stop resolves to when it is not a prospect", () => {
    expect(stopPinDetails(stop({ kind: "prospect" })).kind).toBe("deal");
    expect(stopPinDetails(stop({ kind: "client" })).kind).toBe("client");
  });
});

const job = (over: Partial<MapJob> = {}): MapJob => ({
  id: "job-1",
  job_number: "GS-1042",
  address: "22 Ocean Pkwy, Brooklyn, NY 11218",
  lat: 40.64,
  lon: -73.97,
  status: "in_progress",
  open: true,
  loss_type: "water",
  account_id: "acc-9",
  account_name: "Ocean Pkwy Condos",
  owner_name: "Alex Brown",
  pm_name: "Dana Reyes",
  ...over,
});

describe("a job pin", () => {
  it("links the number and address to the job, then status, customer, salesman, PM and loss", () => {
    const j = jobPinDetails(job());
    expect(j.kind).toBe("job");
    expect(j.kindLabel).toBe("Open job");
    expect(j.title).toBe("#GS-1042 · 22 Ocean Pkwy, Brooklyn, NY 11218");
    expect(j.target).toEqual({ kind: "job", id: "job-1" });
    expect(j.rows.map((r) => r.label)).toEqual(["Status", "Customer", "Salesman", "PM", "Loss"]);
    expect(row(j.rows, "Status")).toMatchObject({ value: "In progress" });
    expect(row(j.rows, "Status")!.pill).toBeTruthy();
    expect(row(j.rows, "Customer")).toMatchObject({
      value: "Ocean Pkwy Condos",
      to: { kind: "account", id: "acc-9" },
    });
    expect(row(j.rows, "PM")).toMatchObject({ value: "Dana Reyes", avatar: true });
    expect(row(j.rows, "Loss")).toMatchObject({ value: "Water" });
  });

  it("is not a route stop — the planner plans around accounts", () => {
    expect(jobPinDetails(job()).stopId).toBeNull();
  });

  it("reads as a closed job and drops the lines it has nothing for", () => {
    const j = jobPinDetails(
      job({ status: "paid", open: false, pm_name: null, loss_type: null, account_name: null }),
    );
    expect(j.kindLabel).toBe("Closed job");
    expect(j.rows.map((r) => r.label)).toEqual(["Status", "Salesman"]);
    expect(row(j.rows, "Status")).toMatchObject({ value: "Paid" });
  });
});

const visit = (over: Partial<Visit> = {}): Visit => ({
  id: "tp-1",
  occurred_at: "2026-09-12T18:15:00Z",
  type: "meeting_in_person",
  lat: 40.63,
  lon: -73.96,
  place_label: "1310 48th St",
  account_id: "acc-1",
  account_name: "IB YBI Coverage",
  created_by: "rep-1",
  notes: "Met the super; wants a quote for the boiler room.",
  ...over,
});

describe("a past-visit pin", () => {
  it("says who, when, what kind and what they wrote down", () => {
    const v = visitPinDetails(visit(), "Alex Brown", { plannable: true });
    expect(v.kind).toBe("visit");
    expect(v.title).toBe("IB YBI Coverage");
    expect(v.target).toEqual({ kind: "account", id: "acc-1" });
    expect(v.rows.map((r) => r.label)).toEqual(["Who", "When", "Type", "Notes"]);
    expect(row(v.rows, "Who")).toMatchObject({ value: "Alex Brown", avatar: true });
    expect(row(v.rows, "When")!.value).toMatch(/Sep 12, 2026/);
    expect(row(v.rows, "Type")).toMatchObject({ value: "In-person meeting" });
    expect(row(v.rows, "Notes")!.value).toContain("boiler room");
  });

  it("can add its account to the route only when the planner knows that account", () => {
    expect(visitPinDetails(visit(), "Alex", { plannable: true }).stopId).toBe("acc-1");
    expect(visitPinDetails(visit(), "Alex", { plannable: false }).stopId).toBeNull();
    expect(
      visitPinDetails(visit({ account_id: null }), "Alex", { plannable: true }).stopId,
    ).toBeNull();
  });

  it("navigates to the coordinates when the visit has no place label", () => {
    const v = visitPinDetails(visit({ place_label: null, notes: null }), null, {
      plannable: false,
    });
    expect(v.directionsTo).toBe("40.63,-73.96");
    expect(row(v.rows, "Who")).toMatchObject({ value: "Unknown" });
    expect(row(v.rows, "Notes")).toBeUndefined();
  });
});

describe("an office pin", () => {
  it("is name, phone and address with nothing to add to a route", () => {
    const o = officePinDetails({
      id: "loc-1",
      name: "Brooklyn",
      address: "500 Flatbush Ave, Brooklyn, NY",
      phone: "718-555-0199",
    });
    expect(o.kind).toBe("office");
    expect(o.title).toBe("Brooklyn");
    expect(o.target).toBeNull();
    expect(o.rows).toEqual([{ label: "Phone", value: "718-555-0199", href: "tel:718-555-0199" }]);
    expect(o.address).toBe("500 Flatbush Ave, Brooklyn, NY");
    expect(o.directionsTo).toBe(o.address);
    expect(o.stopId).toBeNull();
  });
});

describe("pin ids", () => {
  it("decode every id the Routes map hands a click, visits being the bare id", () => {
    expect(parsePinId("stop:acc-1")).toEqual({ kind: "stop", id: "acc-1" });
    expect(parsePinId("job:job-1")).toEqual({ kind: "job", id: "job-1" });
    expect(parsePinId("office-loc-1")).toEqual({ kind: "office", id: "loc-1" });
    expect(parsePinId("cluster:12:34")).toEqual({ kind: "cluster", id: "cluster:12:34" });
    expect(parsePinId("tp-1")).toEqual({ kind: "visit", id: "tp-1" });
  });
  it("puts the person before the company", () => {
    expect(contactTitle("Yossi Burger", "IB YBI")).toBe("Yossi Burger · IB YBI");
    expect(contactTitle(null, "IB YBI")).toBe("IB YBI");
  });
});

/* ---------------------------------------------------- a cluster that cannot split
 * Mark: "tapping pins dont work to add them as a staop". Three accounts
 * geocoded to one building are one grey pin at every zoom, and a tap that
 * only zooms goes nowhere. */
describe("clusterSplitsOnZoom", () => {
  const spread = [
    { id: "a", lat: 40.73, lon: -74.0 },
    { id: "b", lat: 40.7302, lon: -74.0002 },
    { id: "c", lat: 40.7304, lon: -74.0004 },
  ];
  const sameSpot = [
    { id: "a", lat: 40.73, lon: -74.0 },
    { id: "b", lat: 40.73, lon: -74.0 },
    { id: "c", lat: 40.73, lon: -74.0 },
  ];

  it("says yes for neighbors that separate once zoomed in", () => {
    const [c] = clusterPoints(spread, 10);
    expect(c!.count).toBe(3);
    expect(clusterSplitsOnZoom(c!, 10)).toBe(true);
  });

  it("says no for accounts at one address — the pin opens as a list instead", () => {
    const [c] = clusterPoints(sameSpot, 10);
    expect(c!.count).toBe(3);
    expect(clusterSplitsOnZoom(c!, 10)).toBe(false);
  });

  it("says no when the map is already as close as it goes", () => {
    const [c] = clusterPoints(spread, 10);
    expect(clusterSplitsOnZoom(c!, 18)).toBe(false);
  });

  it("is never true for a single pin", () => {
    const [c] = clusterPoints([spread[0]!], 10);
    expect(clusterSplitsOnZoom(c!, 10)).toBe(false);
  });
});

/* ---------------------------------------------------------------- glyphs
 * Mark: "add little logos to each one to indicate what it is, and a hammer
 * for jobs for example". */
describe("pin glyphs", () => {
  it("draws the circle in the pin's color with the glyph inside", () => {
    const svg = pinGlyphSvg({ glyph: "job", color: "#C2410C", radius: 9 });
    expect(svg).toContain('width="18" height="18"');
    expect(svg).toContain('fill="#C2410C"');
    // The hammer's head, from lucide.
    expect(svg).toContain("m18 15 4-4");
    expect(svg).toContain('stroke="#FFFFFF"');
  });

  it("draws a closed job hollow: white fill, the color as ring and ink", () => {
    const svg = pinGlyphSvg({ glyph: "job", color: "#C2410C", radius: 9, hollow: true });
    expect(svg).toContain('fill="#FFFFFF" stroke="#C2410C"');
    expect(svg).toContain('stroke="#C2410C" stroke-width="2.6"');
  });

  it("has a distinct picture for every kind", () => {
    const kinds = ["deal", "client", "job", "visit", "office"] as const;
    const svgs = kinds.map((glyph) => pinGlyphSvg({ glyph, color: "#000", radius: 9 }));
    expect(new Set(svgs).size).toBe(kinds.length);
  });

  it("hands Google a data URI and reuses it for the same spec", () => {
    const a = pinGlyphDataUri({ glyph: "deal", color: "#7A5AF8", radius: 11 });
    const b = pinGlyphDataUri({ glyph: "deal", color: "#7A5AF8", radius: 11 });
    expect(a.startsWith("data:image/svg+xml")).toBe(true);
    expect(a).toBe(b);
  });
});

/* ---------------------------------------------------------------- wiring */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PAGE = read("src/routes/_authenticated/routes.index.tsx");
const MAP = read("src/components/live-map.tsx");
const CARD = read("src/components/routes/map-pin-card.tsx");

/** The `onSelect` callback in the Routes page. */
function onSelectBody(): string {
  const m = PAGE.match(/const onSelect = React\.useCallback\(([\s\S]*?)\n  \);/);
  expect(m, "onSelect not found").not.toBeNull();
  return m![1]!;
}

describe("Routes map wiring", () => {
  it("a marker click reaches the page: the map wires it to onSelect", () => {
    expect(
      MAP.match(/marker\.addListener\("click", \(\) => selectRef\.current\?\.\(p\.id\)\)/),
    ).not.toBeNull();
    expect(PAGE.match(/<LiveMap[\s\S]*?onSelect=\{onSelect\}/)).not.toBeNull();
  });

  it("a pin click opens the card rather than adding blind", () => {
    const body = onSelectBody();
    expect(body).toContain("setOpenPin((cur) => (cur === id ? null : id))");
    expect(body).not.toContain("toggleStop(");
    expect(PAGE.match(/<LiveMap[\s\S]*?callout=\{callout\}/)).not.toBeNull();
  });

  it("a cluster still zooms when zooming can split it, and lists otherwise", () => {
    const body = onSelectBody();
    expect(body).toContain("if (clusterSplitsOnZoom(c, zoom))");
    expect(body).toContain("zoom: zoomIntoCluster(zoom)");
    expect(PAGE).toContain("<MapClusterCard items={items} picked={picked} onRoute={toggleStop} />");
  });

  it("Add to route is still there: in the card, the cluster list and the rows", () => {
    expect(PAGE.match(/<MapPinCard[\s\S]*?onRoute=\{toggleStop\}/)).not.toBeNull();
    expect(PAGE).toContain("onClick={() => toggleStop(s.id)}");
    expect(CARD).toContain("Add to route");
    expect(CARD.match(/onClick=\{\(\) => onRoute\(details\.stopId!\)\}/)).not.toBeNull();
  });

  it("a non-stop pin gives feedback instead of silence", () => {
    expect(CARD).toContain("An office is not a route stop.");
  });

  it("Escape and a tap on the map close the card; the × hands the close back", () => {
    expect(PAGE).toContain('if (e.key === "Escape") setOpenPin(null);');
    expect(PAGE.match(/<LiveMap[\s\S]*?onMapClick=\{closeCard\}/)).not.toBeNull();
    expect(PAGE.match(/<LiveMap[\s\S]*?onCalloutClose=\{closeCard\}/)).not.toBeNull();
    expect(MAP).toContain('addListener("closeclick", () => calloutCloseRef.current?.())');
  });

  it("uses Google's InfoWindow, one for the life of the map", () => {
    expect(MAP).toContain("new google.maps.InfoWindow({ maxWidth: 320 })");
    expect(MAP).toContain("createPortal(callout.content, calloutEl)");
  });

  it("every pin kind wears its glyph and the legend matches", () => {
    expect(PAGE).toContain('glyph: "office"');
    expect(PAGE).toContain('glyph: "visit"');
    expect(PAGE).toContain('glyph: "job"');
    expect(PAGE).toContain('glyph: s.kind === "prospect" ? "deal" : "client"');
    for (const kind of ["office", "deal", "client", "job", "visit"]) {
      expect(PAGE).toContain(`<LegendPin kind="${kind}"`);
    }
    expect(CARD.match(/PIN_KIND_ICON[^}]*\{[^}]*job: Hammer/)).not.toBeNull();
  });
});

describe("Routes map layers", () => {
  const chips = () => {
    const m = PAGE.match(/const LAYER_CHIPS = \[([\s\S]*?)\] as const;/);
    expect(m, "LAYER_CHIPS not found").not.toBeNull();
    return m![1]!;
  };

  it("has a chip for every kind, offices included, each saying what it is", () => {
    const c = chips();
    for (const key of ["offices", "prospect", "client", "visits", "jobsOpen", "jobsClosed"]) {
      // The chip: [key, label, colour, hollow, "Label: what it is"].
      expect(
        c.match(new RegExp(`\\[\\s*"${key}",[\\s\\S]*?"[^"]+: [^"]+",?\\s*\\]`)),
      ).not.toBeNull();
    }
    expect(c).toContain('"Offices: Gold Star locations"');
    expect(PAGE).toContain("title={title}");
    expect(PAGE).toContain("aria-label={title}");
  });

  it("office pins obey their chip", () => {
    expect(PAGE).toContain("...(layers.offices ? offices : NO_OFFICES).map(");
  });

  it("closed jobs are off by default and not fetched until switched on", () => {
    const state = PAGE.match(/const \[layers, setLayers\] = React\.useState\(\{[\s\S]*?\}\);/)![0];
    expect(state).toContain("jobsOpen: true");
    expect(state).toContain("jobsClosed: false");
    expect(state).toContain("offices: true");
    const closed = PAGE.match(/const closedJobsQ = useQuery\(\{[\s\S]*?\}\);/)![0];
    expect(closed).toContain("enabled: layers.jobsClosed");
    expect(closed).toContain('fetchMapJobs({ which: "closed"');
    const open = PAGE.match(/const openJobsQ = useQuery\(\{[\s\S]*?\}\);/)![0];
    expect(open).not.toContain("enabled:");
  });

  it("draws an open job green and filled, a closed job red and hollow", () => {
    /*
     * Melly, 17 Sep: "It can be open as green and closed as red." They used to
     * be one brick colour told apart by fill alone.
     *
     * The fill/ring cue is kept ON TOP of the colour, not replaced by it:
     * red-green is the common form of colour blindness and open vs closed is
     * the one thing here a rep must not misread.
     */
    const m = PAGE.match(/id: `job:\$\{p\.id\}`,[\s\S]*?glyph: "job",/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("color: p.open ? COLOR_JOB_OPEN : COLOR_JOB_CLOSED");
    expect(m![0]).toContain("hollow: !p.open");
  });

  it("gives the two job layers the colors their pins use", () => {
    const chips = PAGE.match(/const LAYER_CHIPS = \[[\s\S]*?\] as const;/)![0];
    expect(chips).toContain("COLOR_JOB_OPEN");
    expect(chips).toContain("COLOR_JOB_CLOSED");
    // A legend that disagrees with the map is worse than no legend.
    expect(chips).not.toMatch(/COLOR_JOB[,\s]/);
  });
});

/**
 * Melly's three map refinements, 17 Sep.
 *
 * (a) "you visit people, not companies... you know Mellie who works at 318
 *     Troy Avenue instead of the gold star office."
 * (b) clicking a pin opens the person/deal record.
 * (c) "unless I scroll it doesn't populate."
 *
 * (a) and (b) were already true of the callout CARD — dealPinDetails leads
 * with "contact · company" and targets the account, and the tests at the top
 * of this file have pinned that since it was built. What was not true was the
 * pin's own label, and the first paint.
 */
describe("a pin names the person first", () => {
  it("leads with the contact, then the company, then the address", () => {
    expect(pinLabel("Mellie Klein", "Gold Star Office", "318 Troy Avenue")).toBe(
      "Mellie Klein · Gold Star Office · 318 Troy Avenue",
    );
  });

  it("falls back to the company rather than inventing a contact", () => {
    expect(pinLabel(null, "Gold Star Office", "318 Troy Avenue")).toBe(
      "Gold Star Office · 318 Troy Avenue",
    );
    expect(pinLabel("   ", "Gold Star Office", null)).toBe("Gold Star Office");
  });

  it("drops the address when there is none", () => {
    expect(pinLabel("Mellie Klein", "Gold Star Office", null)).toBe(
      "Mellie Klein · Gold Star Office",
    );
  });

  it("is what the map marker actually uses", () => {
    // The card read this way and the pin did not, so hover and card disagreed
    // about what the pin was.
    const marker = PAGE.match(/id: `stop:\$\{s\.id\}`,[\s\S]*?glyph:/)![0];
    expect(marker).toContain("label: pinLabel(s.contact_name, s.name, s.address)");
  });
});

describe("the first paint shows its pins", () => {
  const MAP = readFileSync("src/components/live-map.tsx", "utf8").replace(/\r\n/g, "\n");

  it("treats a zero-area viewport as no viewport", () => {
    /*
     * Google fires `idle` the moment it is constructed. If the container has
     * not been laid out, the bounds come back with all four corners equal —
     * and filtering the pins to that box removed every one of them until a pan
     * produced real bounds. Null is what the caller already reads as "map not
     * ready, keep everything".
     */
    const fn = MAP.match(/function viewportOf\(map: google\.maps\.Map\)[\s\S]*?\n}/)![0];
    expect(fn).toContain("if (ne.lat() === sw.lat() || ne.lng() === sw.lng()) return null;");
  });

  it("keeps every pin while the viewport is unknown", () => {
    // The behaviour the guard above relies on.
    const pts = [
      { id: "a", lat: 40.6, lon: -73.9 },
      { id: "b", lat: 41.2, lon: -74.4 },
    ];
    expect(filterToViewport(pts, null)).toHaveLength(2);
  });

  it("re-reads the bounds when the container is finally sized", () => {
    // `idle` fires once at construction and then only on a pan or zoom, so a
    // map that was zero-sized then had no second chance without this.
    expect(MAP).toContain("new ResizeObserver(() => emitViewport())");
    expect(MAP).toContain("resizeRef.current?.disconnect()");
  });
});
