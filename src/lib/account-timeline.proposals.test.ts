import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { proposalEntries, type EntityChip } from "./account-timeline";

/**
 * A proposal on the account timeline: one line per thing that happened to it,
 * filed with the documents, the way a document's "sent" and "signed" already
 * appear — and never an amount, the same money rule the invoice lines keep.
 */

const org: EntityChip = {
  kind: "org",
  id: "acc-1",
  label: "Flatbush Co-op",
  to: "/accounts/acc-1",
};
const people = new Map([
  ["u-rita", "Rita Rep"],
  ["u-manny", "Manny"],
]);
const base = {
  id: "p1",
  title: "Annual water mitigation agreement",
  document_id: null as string | null,
  created_at: "2026-10-01T15:00:00.000Z",
  created_by: "u-rita",
  sent_at: null as string | null,
  sent_by: null as string | null,
  signed_at: null as string | null,
  declined_at: null as string | null,
  declined_reason: null as string | null,
  expired_at: null as string | null,
};

describe("proposal lines on the timeline", () => {
  it("a draft is one line: created, by whom", () => {
    const out = proposalEntries(base, people, org);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "proposal-created:p1",
      kind: "document",
      at: base.created_at,
      title: "Proposal created — Annual water mitigation agreement",
      subtitle: "Rita Rep",
      source: "Web App",
      chips: [org],
    });
  });

  it("sent for e-signature, then signed on the link", () => {
    const out = proposalEntries(
      {
        ...base,
        document_id: "d1",
        sent_at: "2026-10-02T15:00:00.000Z",
        sent_by: "u-manny",
        signed_at: "2026-10-03T15:00:00.000Z",
      },
      people,
      org,
    );
    expect(out.map((e) => e.title)).toEqual([
      "Proposal created — Annual water mitigation agreement",
      "Proposal sent — Annual water mitigation agreement",
      "Proposal signed — Annual water mitigation agreement",
    ]);
    expect(out[1]).toMatchObject({ subtitle: "Manny", body: "Sent for e-signature" });
    expect(out[2]).toMatchObject({
      source: "E-signature",
      done: true,
      at: "2026-10-03T15:00:00.000Z",
    });
  });

  it("declined carries the reason; expired says so", () => {
    const declined = proposalEntries(
      {
        ...base,
        sent_at: "2026-10-02T15:00:00.000Z",
        declined_at: "2026-10-04T15:00:00.000Z",
        declined_reason: "Went with a cheaper vendor",
      },
      people,
      org,
    ).at(-1)!;
    expect(declined).toMatchObject({
      title: "Proposal declined — Annual water mitigation agreement",
      body: "Went with a cheaper vendor",
    });
    const expired = proposalEntries(
      { ...base, sent_at: "2026-10-02T15:00:00.000Z", expired_at: "2026-11-02T15:00:00.000Z" },
      people,
      org,
    ).at(-1)!;
    expect(expired.title).toBe("Proposal expired — Annual water mitigation agreement");
  });

  it("never prints an amount", () => {
    const out = proposalEntries(
      { ...base, sent_at: "2026-10-02T15:00:00.000Z", signed_at: "2026-10-03T15:00:00.000Z" },
      people,
      org,
    );
    for (const e of out) expect(`${e.title} ${e.body ?? ""}`).not.toMatch(/\$/);
  });
});

describe("the feed reads proposals and does not say a proposal's document twice", () => {
  const SOURCE = readFileSync(new URL("./account-timeline.ts", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("reads account_proposals for the account, with no money columns", () => {
    const read = SOURCE.slice(SOURCE.indexOf('.from("account_proposals")'));
    const select = read.slice(0, read.indexOf(".limit("));
    expect(select).toContain('.eq("account_id", accountId)');
    expect(select).not.toMatch(/total|subtotal|unit_price/);
  });

  it("skips the signing document's own sent/signed lines", () => {
    const docs = SOURCE.slice(SOURCE.indexOf("/* ---- documents sent and signed ---- */"));
    expect(docs.slice(0, 200)).toContain("if (proposalDocs.has(d.id as string)) continue;");
  });
});
