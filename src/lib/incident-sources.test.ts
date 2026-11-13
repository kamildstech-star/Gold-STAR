import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  incidentReviewNote,
  incidentSourceLabel,
  incidentSourceLinks,
  isFireFeedSource,
} from "./incident-sources";

describe("incidentSourceLinks — the fire feed's reports, made safe for a card", () => {
  it("reads every report, oldest first", () => {
    const links = incidentSourceLinks({
      source_links: [
        {
          kind: "google_news",
          url: "https://news.google.com/rss/articles/abc",
          title: "Two-alarm fire displaces family",
          publisher: "Asbury Park Press",
          published_at: "2026-10-11T19:00:00.000Z",
        },
        {
          kind: "rss",
          url: "https://fire.example.gov/incidents/1",
          title: "Working fire, 412 Pine St",
          publisher: "Example FD",
          published_at: null,
        },
      ],
    });
    expect(links).toEqual([
      {
        kind: "google_news",
        url: "https://news.google.com/rss/articles/abc",
        title: "Two-alarm fire displaces family",
        publisher: "Asbury Park Press",
        publishedAt: "2026-10-11T19:00:00.000Z",
      },
      {
        kind: "rss",
        url: "https://fire.example.gov/incidents/1",
        title: "Working fire, 412 Pine St",
        publisher: "Example FD",
        publishedAt: null,
      },
    ]);
  });

  it("never turns a javascript: or data: value into a link", () => {
    const [a, b] = incidentSourceLinks({
      source_links: [
        { url: "javascript:alert(1)", title: "Click me" },
        { url: "data:text/html,<b>x</b>", title: "Or me" },
      ],
    });
    expect(a!.url).toBeNull();
    expect(b!.url).toBeNull();
  });

  it("before the migration, or for a BNN row, there is nothing to show", () => {
    expect(incidentSourceLinks({})).toEqual([]);
    expect(incidentSourceLinks({ source_links: [] })).toEqual([]);
    expect(incidentSourceLinks({ source_links: "not an array" })).toEqual([]);
    expect(incidentSourceLinks(null)).toEqual([]);
    expect(incidentSourceLinks({ source_links: [null, 3, { kind: "x" }] })).toEqual([]);
  });

  it("caps how many it shows", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      title: `Report ${i}`,
      url: `https://a.example/${i}`,
    }));
    expect(incidentSourceLinks({ source_links: many }, 2)).toHaveLength(2);
  });
});

describe("labels and the review note", () => {
  it("names the sources the way the deck says them", () => {
    expect(incidentSourceLabel("google_news")).toBe("Google News");
    expect(incidentSourceLabel("public_page")).toBe("911 incident page");
    expect(incidentSourceLabel("bnn")).toBe("BNN");
    expect(incidentSourceLabel("partner_x")).toBe("partner_x");
    expect(isFireFeedSource("rss")).toBe(true);
    expect(isFireFeedSource("scanner")).toBe(false);
  });

  it("shows the review reason only when the lead was marked for review", () => {
    expect(
      incidentReviewNote({
        needs_review: true,
        review_reason: "Town only — the report gave no street address",
      }),
    ).toBe("Town only — the report gave no street address");
    expect(incidentReviewNote({ needs_review: true })).toBe("Marked for review");
    expect(incidentReviewNote({ needs_review: false, review_reason: "x" })).toBeNull();
    expect(incidentReviewNote({})).toBeNull();
  });
});

describe("the chase cards show it", () => {
  const SOURCE = readFileSync("src/routes/_authenticated/chase.index.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("the new-alert card and the accepted card both render IncidentSources", () => {
    const alert = SOURCE.match(
      /\{detail && <div className="mt-1 text-xs text-muted-foreground">\{detail\}<\/div>\}\s*<IncidentSources incident=\{incident\} \/>/,
    );
    expect(alert).not.toBeNull();
    const accepted = SOURCE.match(
      /function AcceptedIncidentCard[\s\S]*?<IncidentSources incident=\{incident\} \/>/,
    );
    expect(accepted).not.toBeNull();
  });
});
