import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 2026-09-09: "there is no way to edit a contact, fix this."
 *
 * Not quite true, which is why it took looking: Title, Email and Phone were
 * editable. But the NAME was not, so a misspelling on the record everyone reads
 * was permanent, and neither of the two fields that decide where somebody sits
 * in their company could be touched from the contact itself.
 *
 * Position matters twice over. It was readable here and settable only on the
 * hierarchy panel, and the live data shows what that cost: 26 of 87 contacts
 * have a position and not one has a manager, so the org chart draws a flat
 * list.
 */
const SOURCE = readFileSync("src/components/contact-drawer.tsx", "utf8");

/** The markup of one DrawerField, by the label it carries. */
function field(label: string): string {
  const at = SOURCE.indexOf(`label="${label}"`);
  expect(at, `no field labeled ${label}`).toBeGreaterThan(-1);
  const open = SOURCE.lastIndexOf("<DrawerField", at);
  const close = SOURCE.indexOf("/>", at);
  return SOURCE.slice(open, close);
}

describe("what can be changed on a contact", () => {
  // "Name" became the pair (20260913120000) and "Title" became the secondary
  // "Custom title (optional)" under Position; Decision role moved to the
  // Relationship section. All six are still editable, which is what this
  // file was written to protect.
  for (const label of [
    "First name",
    "Last name",
    "Custom title (optional)",
    "Email",
    "Phone",
    "Position",
    "Decision role",
  ]) {
    it(`lets somebody change ${label}`, () => {
      const f = field(label);
      expect(f).toContain("onSave");
      // readOnly anywhere in the field defeats the point of the onSave.
      expect(f).not.toContain("readOnly");
    });
  }

  it("offers a fixed list for the two fields that are not free text", () => {
    // A mistyped position is worse than none, because it looks recorded.
    expect(field("Position")).toContain("options=");
    expect(field("Decision role")).toContain("options=");
  });

  it("says what Position and Title are for, since the names do not", () => {
    // Three fields used to sit side by side with nothing to tell them apart.
    expect(field("Position")).toContain("hint=");
    expect(field("Custom title (optional)")).toContain("hint=");
  });

  it("keeps Decision role out of the employer block and in Relationship", () => {
    // It is what this person is to US in a sale, not a fact about their job,
    // and the Relationship section is the one that collapses for non-sellers.
    const account = SOURCE.match(/<DrawerSection title="ACCOUNT">([\s\S]*?)<\/DrawerSection>/);
    expect(account, "no ACCOUNT section").toBeTruthy();
    expect(account![1]).not.toContain('label="Decision role"');
    const relationship = SOURCE.match(
      /<DrawerSection title="Relationship">([\s\S]*?)<\/DrawerSection>/,
    );
    expect(relationship, "no Relationship section").toBeTruthy();
    expect(relationship![1]).toContain('label="Decision role"');
  });

  it("reads the columns it now writes", () => {
    // Editing a field the query never selected shows an empty box that
    // silently overwrites whatever was there. The column list is a constant
    // now, because the read falls back to a pre-pair list on an unmigrated
    // database and both have to carry the rest.
    const columns = SOURCE.match(/const CONTACT_COLUMNS =\s*\n?\s*"([^"]+)"/);
    expect(columns, "no column list found").toBeTruthy();
    for (const col of ["position_key", "decision_role", "full_name", "first_name", "last_name"]) {
      expect(columns![1], col).toContain(col);
    }
  });

  it("still works on a database without the name pair", () => {
    // first_name/last_name arrive with 20260913120000. Naming a column
    // PostgREST does not know fails the whole read, so both the read and the
    // write fall back rather than leaving the drawer blank.
    expect(SOURCE).toContain("CONTACT_COLUMNS_LEGACY");
    expect(SOURCE).toContain("isMissingSchema");
    const legacy = SOURCE.match(/const CONTACT_COLUMNS_LEGACY =\s*\n?\s*"([^"]+)"/);
    expect(legacy, "no legacy column list").toBeTruthy();
    expect(legacy![1]).not.toContain("first_name");
    expect(legacy![1]).toContain("full_name");
  });

  it("refuses to blank the name", () => {
    // Every other field has a sensible empty value. A nameless contact is
    // unfindable, so the save is refused rather than written — and it is the
    // COMPOSED name that is tested, so clearing one box while the other holds
    // a name is a legitimate edit.
    expect(field("First name")).toContain("A contact needs a name.");
    expect(field("Last name")).toContain("A contact needs a name.");
    expect(SOURCE).toContain("personNameWrite(");
  });

  it("always writes the composed full_name beside the pair", () => {
    // full_name is NOT NULL and is what every other screen reads. A save that
    // moved the pair without recomposing it would leave the app showing the
    // old name everywhere but this drawer.
    for (const label of ["First name", "Last name"]) {
      expect(field(label), label).toContain("personNameWrite(");
    }
  });
});
