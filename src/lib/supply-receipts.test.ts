import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseReceiptModelOutput,
  receiptAlertBody,
  receiptDate,
  receiptTotal,
} from "@/lib/supply-receipts";

/**
 * Photographing a receipt from the till.
 *
 * David, 17 Sep: "if somebody goes into Home Depot and just buys an item off
 * the shelf, they should be able to take a picture of the receipt and upload
 * it to the system. Now, if the system can read the receipt, that'll be great
 * — what supplies were purchased and how many and the date and all that. But
 * if not, at the very minimum it should send an alert to somebody — to be
 * determined — that a receipt was uploaded by so-and-so."
 *
 * THE ORDER OF THOSE TWO SENTENCES IS THE DESIGN, and it is what these tests
 * hold: the alert is the product, the parse is the bonus, and every failure
 * path still ends with a stored picture and somebody told.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20260918180000_supply_receipts.sql",
  "utf8",
).replace(/\r\n/g, "\n");

describe("reading what the model returned", () => {
  const good = JSON.stringify({
    supplier: "Home Depot",
    purchased_on: "2026-09-17",
    total: 48.72,
    lines: [
      { label: "Contractor bags", quantity: 2, unit_price: 19.99, total: 39.98 },
      { label: "Duct tape", quantity: 1, unit_price: 8.74, total: 8.74 },
    ],
  });

  it("takes the supplier, the date, the total and the lines", () => {
    const d = parseReceiptModelOutput(good)!;
    expect(d.supplier).toBe("Home Depot");
    expect(d.purchasedOn).toBe("2026-09-17");
    expect(d.total).toBe(48.72);
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0]).toMatchObject({ label: "Contractor bags", quantity: 2, unitPrice: 19.99 });
  });

  it("finds the object in a reply wrapped in prose or a fence", () => {
    expect(parseReceiptModelOutput("Here you go:\n```json\n" + good + "\n```")).not.toBeNull();
  });

  it("strips currency out of a money field rather than dropping it", () => {
    const d = parseReceiptModelOutput('{"supplier":"X","total":"$12.99","lines":[]}')!;
    expect(d.total).toBe(12.99);
  });

  it("drops a line with no name — the model pads when it is unsure", () => {
    const d = parseReceiptModelOutput(
      '{"supplier":"X","lines":[{"label":"Tape","total":3},{"label":"","total":9}]}',
    )!;
    expect(d.lines).toHaveLength(1);
  });

  it("returns nothing for a reply that is not JSON at all", () => {
    expect(parseReceiptModelOutput("I cannot read this photo.")).toBeNull();
    expect(parseReceiptModelOutput("")).toBeNull();
  });

  it("returns nothing when the model read nothing, so the screen can say so", () => {
    // An empty form that looks broken is worse than an honest "couldn't read".
    expect(
      parseReceiptModelOutput('{"supplier":null,"purchased_on":null,"total":null,"lines":[]}'),
    ).toBeNull();
  });
});

describe("the date", () => {
  it("takes a real calendar day", () => {
    expect(receiptDate("2026-09-17")).toBe("2026-09-17");
  });

  it("drops anything it cannot be sure of", () => {
    /*
     * A wrong date on a spending entry is worse than an empty one: nobody goes
     * back to check a field that looks filled in. So a till's own format, a
     * half-date or an impossible day are all null rather than guesses.
     */
    for (const bad of ["17/09/2026", "Sep 17 2026", "2026-13-40", "", null, 20260917]) {
      expect(receiptDate(bad)).toBeNull();
    }
  });
});

describe("the total", () => {
  it("uses the printed total when there is one", () => {
    expect(receiptTotal({ supplier: null, purchasedOn: null, total: 48.72, lines: [] })).toBe(
      48.72,
    );
  });

  it("adds the lines up when the total was not readable", () => {
    expect(
      receiptTotal({
        supplier: null,
        purchasedOn: null,
        total: null,
        lines: [
          { label: "a", quantity: null, unitPrice: null, total: 10 },
          { label: "b", quantity: null, unitPrice: null, total: 2.5 },
        ],
      }),
    ).toBe(12.5);
  });

  it("is null rather than zero when there is nothing to add", () => {
    // Zero is a claim about the money. Null is the truth: we do not know.
    expect(
      receiptTotal({
        supplier: null,
        purchasedOn: null,
        total: null,
        lines: [{ label: "a", quantity: null, unitPrice: null, total: null }],
      }),
    ).toBeNull();
  });
});

describe("the alert, which is the part that always happens", () => {
  it("names who uploaded it and what was read", () => {
    expect(
      receiptAlertBody({
        uploaderName: "Danny Ruiz",
        draft: { supplier: "Home Depot", purchasedOn: null, total: 48.72, lines: [] },
      }),
    ).toBe("Danny Ruiz uploaded a receipt — Home Depot, $48.72. Check it and approve it.");
  });

  it("still names who uploaded it when nothing could be read", () => {
    // This is David's minimum, and it is the case that must never go quiet.
    const body = receiptAlertBody({ uploaderName: "Danny Ruiz", draft: null });
    expect(body).toContain("Danny Ruiz uploaded a receipt");
    expect(body).toContain("could not be read");
  });
});

describe("the upload order", () => {
  const LIB = readFileSync("src/lib/supply-receipts.ts", "utf8").replace(/\r\n/g, "\n");
  const PANEL = readFileSync("src/components/supply-receipt-panel.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("alerts before anything is asked to read the picture", () => {
    /*
     * The alert is the product and the parse is the bonus, so it cannot be
     * conditional on a read succeeding. uploadSupplyReceipt stores, inserts
     * and alerts; the panel only then attempts a read.
     */
    const fn = LIB.slice(LIB.indexOf("export async function uploadSupplyReceipt"));
    expect(fn.slice(0, fn.indexOf("return data"))).toContain("alertReceiptReviewer");
    const upload = PANEL.slice(PANEL.indexOf("const upload = useMutation"));
    // `read(...)` is the bound server fn; readSupplyReceipt itself appears only
    // in the import at the top of the file, outside this slice.
    expect(upload.indexOf("uploadSupplyReceipt")).toBeLessThan(upload.indexOf("read({ data:"));
  });

  it("never lets a failed read cost the receipt", () => {
    const upload = PANEL.slice(PANEL.indexOf("const upload = useMutation"));
    expect(upload).toContain("} catch (err) {");
    expect(upload).toContain("readable: false");
  });

  it("falls back to the office's managers when nobody is named", () => {
    // "To be determined" must not mean silence.
    const fn = LIB.slice(LIB.indexOf("export async function alertReceiptReviewer"));
    expect(fn).toContain('.eq("role", "manager")');
  });

  it("never notifies the person who uploaded it", () => {
    const fn = LIB.slice(LIB.indexOf("export async function alertReceiptReviewer"));
    expect(fn).toContain("userIds.filter((id) => id !== input.uploaderId)");
  });

  it("writes spending only through the approval, never from the upload or the browser", () => {
    // "Presented for a human to confirm, never auto-committed silently" — and
    // since Mark's 5 Oct ask, that human is an approver who is not the
    // uploader, decided in the database. The panel no longer writes
    // supply_purchases at all: the old Confirm called recordPurchase from the
    // browser for whoever could see the row.
    const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("recordPurchase");
    expect(code).not.toContain("markReceiptReviewed");
    const approve = code.match(/const approve = useMutation\(\{[\s\S]*?onSuccess/)![0];
    expect(approve).toContain("validateApprovalForm(form, today)");
    expect(approve).toContain("approveReceipt({");
    // The upload lives in useReceiptUpload, shared by every doorway — none of
    // them can approve on upload.
    const start = code.indexOf("const upload = useMutation");
    const end = code.indexOf("function ReceiptCameraButton");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(code.slice(start, end)).not.toMatch(/approveReceipt|supply_purchases/);
  });
});

describe("the migration", () => {
  it("keeps the picture and who uploaded it", () => {
    expect(MIGRATION).toContain("storage_bucket text NOT NULL");
    expect(MIGRATION).toContain("uploaded_by uuid");
  });

  it("lets a job be optional, because a shelf purchase belongs to none yet", () => {
    expect(MIGRATION).toMatch(/job_id uuid REFERENCES public\.jobs\(id\) ON DELETE SET NULL/);
  });

  it("lets any signed-in person upload, and gates reading everyone's on money", () => {
    expect(MIGRATION).toContain("WITH CHECK (uploaded_by = auth.uid())");
    expect(MIGRATION).toContain("public.can_view_finance(auth.uid())");
  });

  it("seeds the reviewer setting unset, so it can be chosen in Admin", () => {
    expect(MIGRATION).toContain("'supply_receipt_reviewer'");
    expect(MIGRATION).toContain("ON CONFLICT (key) DO NOTHING");
  });
});
