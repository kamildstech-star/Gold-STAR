import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../supabase/migrations/20260908055847_claim_new_lead_atomic.sql", import.meta.url),
  "utf8",
);

describe("claim_new_lead migration", () => {
  it("owns identity and authorization inside the security-definer function", () => {
    expect(sql).toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/claimant uuid := auth\.uid\(\)/i);
    expect(sql).toMatch(/p\.is_active IS TRUE/i);
    expect(sql).toMatch(/p\.approval_status = 'approved'/i);
    expect(sql).toMatch(/public\.can_view_location\(claimant, a\.location_id\)/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.claim_new_lead\(uuid\) FROM PUBLIC, anon/i);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_new_lead\(uuid\) TO authenticated/i,
    );
    expect(sql).toMatch(/SET search_path = ''/i);
  });

  it("makes the first-writer-wins constraints part of one update", () => {
    const update = sql.match(
      /UPDATE public\.accounts[\s\S]+?RETURNING a\.id INTO claimed_id/i,
    )?.[0];
    expect(update).toBeTruthy();
    expect(update).toMatch(/a\.status = 'prospect'/i);
    expect(update).toMatch(/a\.archived_at IS NULL/i);
    expect(update).toMatch(/a\.assigned_rep IS NULL/i);
    expect(update).toMatch(/SET assigned_rep = claimant/i);
  });
});
