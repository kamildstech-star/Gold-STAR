import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const TASKS = read("src/lib/account-tasks.ts");
const FULL = read("src/routes/_authenticated/accounts.$id.tsx");
const SNAPSHOT = read("src/components/account-snapshot.tsx");

describe("account snapshot wiring", () => {
  it("leads the account page, with Proposals only for a client", () => {
    // Melly, 6 Nov: "you're not gonna need proposals here" — on a prospect.
    expect(FULL).toMatch(
      /<AccountSnapshot\s+accountId=\{id\}[\s\S]{0,120}showProposals=\{isClient\}/,
    );
  });

  it("refreshes whenever the page records a change", () => {
    expect(FULL).toContain("useRefreshAccountActivity(id)");
    expect(TASKS).toContain("accountSnapshotKey(accountId)");
  });

  it("counts a touch the way the health clock does", () => {
    // An unanswered outbound email is an attempt, not contact; unset counts.
    expect(SNAPSHOT).toContain("counts_toward_cadence.is.null,counts_toward_cadence.eq.true");
  });

  it("shares the proposals and buildings cards' queries rather than reading twice", () => {
    expect(SNAPSHOT).toContain('queryKey: ["account-proposals", accountId]');
    expect(SNAPSHOT).toContain('queryKey: ["account-properties", accountId]');
  });
});
