import { describe, expect, it } from "vitest";

import {
  CONTACT_ACCOUNT_FIELDS,
  collapsedCardFieldKeys,
  contactFieldValue,
  expandedContactFields,
  fieldsNotShown,
  type ContactField,
  type ContactFieldLabels,
} from "@/lib/contact-fields";

/**
 * Mark: "whatever doesnt show from here in th4e small card on the prospect
 * view should have an expand button that will show that extra info but by
 * default should be collapsed."
 *
 * The interesting failure is not "did we get Title, Position and Gift policy
 * right today" — it is whether the next field added to the full panel finds
 * its own way under the chevron. So the subtraction is tested in its general
 * form as well as on the real list.
 */

const LABELS: ContactFieldLabels = {
  position: { building_super: "Building super / manager" },
  role: { decision_maker: "Decision maker" },
  giftPolicy: { approval_required: "Pre-approval required", unknown: "Policy unknown" },
};

/** The contact from Mark's screenshots. */
const BETHANY = {
  full_name: "Bethany Kozlow",
  title: "VP Property Services",
  position_key: null,
  email: "bethany.kozlow@example-demo.invalid",
  phone: "(555) 951-6099",
  decision_role: "decision_maker",
  gift_policy: "approval_required",
};

describe("what the compact contact card has to hide", () => {
  it("expands exactly the full panel's fields minus the card's own", () => {
    // Everything filled in, so nothing is dropped for being empty and the
    // result is the plain difference of the two lists.
    const complete = { ...BETHANY, position_key: "building_super" };
    expect(expandedContactFields(complete, LABELS).map((f) => f.key)).toEqual(
      fieldsNotShown(CONTACT_ACCOUNT_FIELDS, collapsedCardFieldKeys(complete)).map((f) => f.key),
    );
  });

  it("puts the custom title and Gift policy behind the chevron, and nothing the card shows", () => {
    const labels = expandedContactFields(BETHANY, LABELS).map((f) => f.label);
    expect(labels).toEqual(["Custom title (optional)", "Gift policy"]);
    // What the collapsed card prints must never be repeated underneath —
    // including both halves of the name, which it prints as one line.
    expect(labels).not.toContain("First name");
    expect(labels).not.toContain("Last name");
    expect(labels).not.toContain("Email");
    expect(labels).not.toContain("Phone");
    // Decision role left the ACCOUNT section for the Relationship one, so it
    // is not in the mirrored list at all.
    expect(labels).not.toContain("Decision role");
  });

  it("derives the name pair from full_name until the columns exist", () => {
    // Before 20260913120000 the card still has to show a name.
    const legacy = { ...BETHANY, first_name: null, last_name: null };
    expect(contactFieldValue(legacy, "first_name", LABELS)).toBe("Bethany");
    expect(contactFieldValue(legacy, "last_name", LABELS)).toBe("Kozlow");
    // And the stored columns win once they are there.
    const migrated = { ...BETHANY, first_name: "Beth", last_name: "Kozlow-Smith" };
    expect(contactFieldValue(migrated, "first_name", LABELS)).toBe("Beth");
    expect(contactFieldValue(migrated, "last_name", LABELS)).toBe("Kozlow-Smith");
  });

  it("shows the stored position rather than its key", () => {
    const c = { ...BETHANY, position_key: "building_super" };
    const position = expandedContactFields(c, LABELS).find((f) => f.key === "position_key");
    expect(position?.value).toBe("Building super / manager");
  });

  it("does not go stale when the full panel gains a field", () => {
    // The whole point of deriving. A field nobody here has heard of still
    // comes out of the subtraction, because nothing hard-lists the answer.
    const grown: ContactField[] = [
      ...CONTACT_ACCOUNT_FIELDS,
      { key: "invoice_note" as never, label: "Invoice note" },
    ];
    const keys = fieldsNotShown(grown, collapsedCardFieldKeys(BETHANY)).map((f) => f.label);
    expect(keys).toContain("Invoice note");
  });

  it("counts the title as shown when the card fell back to it", () => {
    // contactRoleLabel prints the decision role, else the title. With no role
    // the card is already showing the title, so the drawer must not repeat it.
    const noRole = { ...BETHANY, decision_role: null };
    expect(collapsedCardFieldKeys(noRole)).toContain("title");
    expect(expandedContactFields(noRole, LABELS).map((f) => f.label)).not.toContain("Title");
  });

  it("omits fields with nothing in them rather than printing 'not set'", () => {
    // Deliberate: the full panel keeps a "Position not set" row because that
    // row is how you set it. This card is read-only, so an expander full of
    // blanks would waste the click.
    const bare = {
      full_name: "",
      title: null,
      position_key: null,
      email: null,
      phone: null,
      decision_role: null,
      gift_policy: "unknown",
    };
    expect(expandedContactFields(bare, LABELS)).toEqual([]);
  });
});
