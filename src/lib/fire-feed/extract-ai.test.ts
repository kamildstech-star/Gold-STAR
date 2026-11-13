import { afterEach, describe, expect, it, vi } from "vitest";

import { extractByRules } from "./extract";
import {
  AI_BATCH_SIZE,
  AI_MAX_CALLS_PER_RUN,
  buildFireReadPrompt,
  mergeAiWithRules,
  parseFireReadReply,
} from "./extract-ai";
import { extractAll } from "./extract-ai.server";
import type { RawItem, WatchArea } from "./types";

vi.mock("@/lib/ai.server", () => ({
  complete: async () => {
    throw new Error("the real gateway must not be called from a test");
  },
}));

const AREAS: WatchArea[] = [
  {
    id: "lkw",
    label: "Lakewood, NJ",
    locality: "Lakewood",
    county: null,
    state: "NJ",
    postal_codes: [],
    center_lat: null,
    center_lon: null,
    radius_miles: 15,
    active: true,
  },
];

const item = (title: string, text = ""): RawItem => ({
  key: title,
  sourceKind: "google_news",
  sourceId: "s",
  title,
  url: null,
  publisher: null,
  publishedAt: null,
  text,
  areaId: "lkw",
});

afterEach(() => vi.unstubAllEnvs());

describe("the prompt", () => {
  it("numbers the items, names the watched towns and nothing else", () => {
    const p = buildFireReadPrompt([item("Blaze guts home", "On Pine St.")], ["Lakewood, NJ"]);
    expect(p).toContain("Towns being watched: Lakewood, NJ.");
    expect(p).toContain("[0]\nTitle: Blaze guts home\nText: On Pine St.");
  });
});

describe("parsing the reply — untrusted data", () => {
  it("reads the items object, a bare array, and a fenced reply", () => {
    const entry = { i: 0, category: "structure", occupancy: "residential" };
    expect(parseFireReadReply(JSON.stringify({ items: [entry] }), 1).get(0)?.category).toBe(
      "structure",
    );
    expect(parseFireReadReply(JSON.stringify([entry]), 1).get(0)?.occupancy).toBe("residential");
    expect(
      parseFireReadReply("```json\n" + JSON.stringify({ items: [entry] }) + "\n```", 1).size,
    ).toBe(1);
  });

  it("drops what is not JSON, out-of-range indexes and repeats; coerces unknown values to safe ones", () => {
    expect(parseFireReadReply("I think item 0 is a fire", 1).size).toBe(0);
    const m = parseFireReadReply(
      JSON.stringify({
        items: [
          { i: 5, category: "structure" },
          { i: 0, category: "volcano", state: "New Jersey" },
          { i: 0, category: "structure" },
        ],
      }),
      2,
    );
    expect(m.size).toBe(1);
    expect(m.get(0)?.category).toBe("not_fire");
    expect(m.get(0)?.state).toBeNull();
  });
});

describe("merging the model with the rules", () => {
  const i = item("House fire in Lakewood", "Flames were seen at 412 Pine Street late Sunday.");
  const rules = extractByRules(i, AREAS);

  it("keeps an address whose house number the item printed", () => {
    const ex = mergeAiWithRules(
      i,
      {
        i: 0,
        category: "structure",
        occupancy: "residential",
        street_address: "412 Pine Street",
        locality: "Lakewood",
        state: "NJ",
        alarm_level: "two-alarm",
      },
      rules,
    );
    expect(ex).toMatchObject({
      method: "ai",
      category: "structure",
      address: "412 Pine Street",
      alarmLevel: "2nd alarm",
      buildingType: "Single-family home",
    });
  });

  it("refuses an address the model made up, and keeps the rules' one instead", () => {
    const ex = mergeAiWithRules(
      i,
      { i: 0, category: "structure", street_address: "12 Main Street" },
      rules,
    );
    expect(ex.address).toBe(rules.address);
    expect(ex.address).not.toBe("12 Main Street");
  });

  it("the model can say 'not a fire' and that wins", () => {
    expect(mergeAiWithRules(i, { i: 0, category: "not_fire" }, rules).category).toBe("not_fire");
  });

  it("keeps the chase rules' words in the building type", () => {
    const ex = mergeAiWithRules(
      i,
      {
        i: 0,
        category: "structure",
        occupancy: "multi_family",
        building_type: "garden apartments",
      },
      rules,
    );
    expect(ex.buildingType).toBe("Multi-family (garden apartments)");
  });
});

describe("extractAll", () => {
  const items = [
    item("Blaze guts Lakewood home", "At 412 Pine Street."),
    item("Ocean County festival returns"),
  ];

  it("rules only when the model is switched off", async () => {
    const out = await extractAll(items, AREAS, { useAi: false });
    expect(out.aiCalls).toBe(0);
    expect(out.extractions.every((e) => e.method === "rules")).toBe(true);
  });

  it("says so when the key is missing", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    const out = await extractAll(items, AREAS, { useAi: true });
    expect(out.aiError).toMatch(/LOVABLE_API_KEY/);
    expect(out.extractions.every((e) => e.method === "rules")).toBe(true);
  });

  it("sends only possible fires to the model, and uses its reading", async () => {
    const seen: string[] = [];
    const out = await extractAll(items, AREAS, {
      useAi: true,
      completer: async (_s, user) => {
        seen.push(user);
        return JSON.stringify({
          items: [
            {
              i: 0,
              category: "structure",
              occupancy: "residential",
              street_address: "412 Pine Street",
              locality: "Lakewood",
              state: "NJ",
            },
          ],
        });
      },
    });
    expect(out.aiCalls).toBe(1);
    expect(seen[0]).toContain("Blaze guts Lakewood home");
    expect(seen[0]).not.toContain("festival");
    expect(out.extractions[0]!.method).toBe("ai");
    expect(out.extractions[1]!.method).toBe("rules");
  });

  it("a gateway failure costs the model reading, never the run", async () => {
    const out = await extractAll(items, AREAS, {
      useAi: true,
      completer: async () => {
        throw new Error("AI rate limit reached. Try again in a moment.");
      },
    });
    expect(out.aiError).toBe("AI rate limit reached. Try again in a moment.");
    expect(out.extractions[0]!.method).toBe("rules");
  });

  it("spends a bounded number of calls on a burst", async () => {
    const many = Array.from({ length: AI_BATCH_SIZE * (AI_MAX_CALLS_PER_RUN + 2) }, (_, k) =>
      item(`House fire number ${k} in Lakewood`),
    );
    let calls = 0;
    const out = await extractAll(many, AREAS, {
      useAi: true,
      completer: async () => {
        calls += 1;
        return "{}";
      },
    });
    expect(calls).toBe(AI_MAX_CALLS_PER_RUN);
    expect(out.aiError).toMatch(/capped/);
  });
});
