import { describe, expect, it } from "vitest";

import {
  personPrimaryLabel,
  personSearchValue,
  personSecondaryLabel,
  type PickablePersonLabel,
} from "@/lib/person-picker";

const person: PickablePersonLabel & { user_id: string } = {
  user_id: "user-1",
  full_name: "Ernie Technician",
  email: "ernie@example.com",
  roles: ["crew"],
};

describe("PersonPicker labels", () => {
  it("makes both name and email searchable", () => {
    expect(personSearchValue(person)).toBe("Ernie Technician ernie@example.com");
  });

  it("shows email alongside the role so duplicate names remain distinguishable", () => {
    expect(personPrimaryLabel(person)).toBe("Ernie Technician");
    expect(personSecondaryLabel(person)).toContain("ernie@example.com");
    expect(personSecondaryLabel(person)).toContain("Crew");
  });

  it("uses email as the primary label when a profile has no name", () => {
    expect(personPrimaryLabel({ ...person, full_name: null })).toBe("ernie@example.com");
  });
});
