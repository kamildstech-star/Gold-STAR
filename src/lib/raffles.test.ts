import { describe, expect, it } from "vitest";

import {
  eligibleEntries,
  isRaffleOpen,
  raffleDraftProblem,
  rafflePhase,
  rafflesCsv,
  splitFullName,
  totalPrizeValue,
  type RaffleDetail,
  type RaffleEntry,
  type RaffleWinner,
} from "./raffles";

const entry = (id: string, extra: Partial<RaffleEntry> = {}): RaffleEntry => ({
  id,
  raffle_id: "r",
  first_name: "Pat",
  last_name: id,
  email: `${id}@example.com`,
  phone: null,
  company: null,
  job_title: null,
  industry: null,
  consent_marketing: false,
  disqualified_at: null,
  disqualified_reason: null,
  created_at: "2026-11-12T15:00:00Z",
  ...extra,
});

const winner = (entry_id: string, status: RaffleWinner["status"] = "drawn"): RaffleWinner => ({
  id: `w-${entry_id}`,
  raffle_id: "r",
  prize_id: "p1",
  entry_id,
  pool_size: 3,
  drawn_at: "2026-11-14T20:00:00Z",
  drawn_by: null,
  status,
  notified_at: null,
  claimed_at: null,
  forfeited_at: null,
  forfeit_reason: null,
});

describe("splitFullName", () => {
  it("takes the first word as first name and keeps the rest", () => {
    expect(splitFullName("  Pat  van der Berg ")).toEqual({
      first_name: "Pat",
      last_name: "van der Berg",
    });
    expect(splitFullName("Cher")).toEqual({ first_name: "Cher", last_name: "" });
  });
});

describe("raffles", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");

  it("is open only while the status is open and the closing time is ahead", () => {
    expect(isRaffleOpen({ status: "open", closes_at: null }, now)).toBe(true);
    expect(isRaffleOpen({ status: "open", closes_at: "2026-11-13T11:00:00Z" }, now)).toBe(false);
    expect(isRaffleOpen({ status: "closed", closes_at: null }, now)).toBe(false);
  });

  it("says drawn once a winner exists, whatever the status", () => {
    expect(rafflePhase({ status: "open", closes_at: null }, 1, now)).toBe("drawn");
    expect(rafflePhase({ status: "open", closes_at: "2026-11-13T11:00:00Z" }, 0, now)).toBe(
      "closed",
    );
  });

  it("keeps winners (even forfeited) and the disqualified out of the hat", () => {
    const entries = [entry("a"), entry("b", { disqualified_at: "x" }), entry("c"), entry("d")];
    const left = eligibleEntries(entries, [winner("a"), winner("c", "forfeited")]);
    expect(left.map((e) => e.id)).toEqual(["d"]);
  });

  it("totals prize value by quantity", () => {
    expect(
      totalPrizeValue([
        {
          id: "1",
          raffle_id: "r",
          position: 1,
          name: "Cooler",
          description: null,
          value: 300,
          quantity: 1,
        },
        {
          id: "2",
          raffle_id: "r",
          position: 2,
          name: "Card",
          description: null,
          value: 50,
          quantity: 3,
        },
      ]),
    ).toBe(450);
  });

  it("needs a title and a prize", () => {
    const base = {
      title: "Draw",
      headline: "",
      description: "",
      terms: "",
      closes_at: null,
      ask_phone: true,
      require_phone: false,
      ask_company: true,
      max_entries: "",
      prizes: [{ name: "", description: "", value: "", quantity: "1" }],
    };
    expect(raffleDraftProblem(base)).toMatch(/prize/);
    expect(raffleDraftProblem({ ...base, title: " " })).toMatch(/title/);
    const withPrize = { ...base, prizes: [{ ...base.prizes[0], name: "Cooler" }] };
    expect(raffleDraftProblem(withPrize)).toBeNull();
    expect(raffleDraftProblem({ ...withPrize, max_entries: "250" })).toBeNull();
    expect(raffleDraftProblem({ ...withPrize, max_entries: "0" })).toMatch(/Max entries/);
    expect(raffleDraftProblem({ ...withPrize, max_entries: "abc" })).toMatch(/Max entries/);
  });

  it("exports CSV with formulas neutralised and commas quoted", () => {
    const detail: RaffleDetail = {
      raffle: {} as RaffleDetail["raffle"],
      show: { id: "s", name: "Expo", city: null, state: null },
      prizes: [
        {
          id: "p1",
          raffle_id: "r",
          position: 1,
          name: "Cooler",
          description: null,
          value: null,
          quantity: 1,
        },
      ],
      entries: [entry("a", { company: '=HYPERLINK("x")', job_title: "Owner, CEO" })],
      winners: [winner("a", "claimed")],
    };
    const [, row] = rafflesCsv(detail).split("\r\n");
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain(`"Owner, CEO"`);
    expect(row).toContain("Winner,Cooler,Claimed");
  });
});
