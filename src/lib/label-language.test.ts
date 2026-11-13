import { describe, expect, it } from "vitest";

import { ALL_ROLES } from "./roles";
import { ES, dictionarySize, translate } from "./i18n";
import {
  LABEL_LANGUAGES,
  LABEL_LANGUAGE_LABEL,
  SPANISH_DEFAULT_ROLES,
  bi,
  defaultLabelLanguage,
  parseLabelLanguage,
  resolveLabelLanguage,
} from "./label-language";

describe("the language switch", () => {
  it("offers exactly two languages, each named in itself", () => {
    expect([...LABEL_LANGUAGES]).toEqual(["en", "es"]);
    expect(LABEL_LANGUAGE_LABEL).toEqual({ en: "English", es: "Español" });
  });

  it("gives crew and field technicians Español, everyone else English", () => {
    expect(defaultLabelLanguage("crew")).toBe("es");
    expect(defaultLabelLanguage("field")).toBe("es");
    for (const r of ["admin", "owner", "dev", "office", "location_manager", "regional"] as const) {
      expect(defaultLabelLanguage(r)).toBe("en");
    }
    expect(defaultLabelLanguage("field_chaser")).toBe("en");
    expect(defaultLabelLanguage(null)).toBe("en");
  });

  it("names only real roles as Spanish defaults", () => {
    for (const r of SPANISH_DEFAULT_ROLES) expect(ALL_ROLES).toContain(r);
  });

  it("an explicit choice beats the role default, both ways", () => {
    expect(resolveLabelLanguage("en", "crew")).toBe("en");
    expect(resolveLabelLanguage("es", "admin")).toBe("es");
  });

  it("reads the old English + Español value as Español, and English only as English", () => {
    expect(parseLabelLanguage("en_es")).toBe("es");
    expect(resolveLabelLanguage("en_es", "admin")).toBe("es");
    expect(parseLabelLanguage("en")).toBe("en");
  });

  it("an unknown stored value falls back to the role default", () => {
    expect(parseLabelLanguage("fr")).toBeNull();
    expect(resolveLabelLanguage("fr", "crew")).toBe("es");
    expect(resolveLabelLanguage(null, "admin")).toBe("en");
  });
});

describe("one language at a time", () => {
  it("bi prints the Spanish alone in Español — never stacked", () => {
    expect(bi("es", "Close", "Cerrar")).toBe("Cerrar");
    expect(bi("es", "Close", "Cerrar")).not.toContain("·");
  });

  it("bi prints the English alone in English", () => {
    expect(bi("en", "Close", "Cerrar")).toBe("Close");
  });

  it("bi falls back to English when the Spanish is missing", () => {
    expect(bi("es", "Close", "")).toBe("Close");
    expect(bi("es", "Close", null)).toBe("Close");
  });
});

describe("the dictionary", () => {
  it("translates a known string in Español and leaves English alone", () => {
    expect(translate("es", "Save")).toBe("Guardar");
    expect(translate("en", "Save")).toBe("Save");
  });

  it("falls back to the English — never blank, never a key — when a string is missing", () => {
    expect(translate("es", "A string nobody has translated")).toBe(
      "A string nobody has translated",
    );
  });

  it("fills placeholders in both languages", () => {
    expect(translate("en", "{n} people", { n: 3 })).toBe("3 people");
  });

  it("has no empty translations and no stacked English · Español entries", () => {
    for (const [en, es] of Object.entries(ES)) {
      expect(es.trim(), en).not.toBe("");
      expect(es, en).not.toContain(" · ");
    }
    expect(dictionarySize()).toBeGreaterThan(250);
  });

  it("covers a crew screen and an office screen", () => {
    // Crew: the write-ups panel.
    expect(translate("es", "Work done")).toBe("Trabajo realizado");
    expect(translate("es", "Visit date")).toBe("Fecha de visita");
    // Office: the job page's tabs.
    expect(translate("es", "Drying log")).toBe("Registro de secado");
    expect(translate("es", "Billing")).toBe("Facturación");
  });
});
