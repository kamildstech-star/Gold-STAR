/**
 * Two real badges, as Mark scanned them, plus the shapes the standards allow.
 * The rule under test: open formats are read, everything else is kept as-is
 * and never guessed at.
 *
 * This is also the business-card QR parser (the card reader's stand-in
 * parser was folded in here), so the card shapes are covered too: a payload
 * pasted onto one line, a title, a website, an address, and the choice of
 * phone when the card lists a switchboard, a cell and a fax.
 */
import { describe, expect, it } from "vitest";

import {
  badgeIsLead,
  badgeSummary,
  parseBadgePayload,
  type BadgeFields,
} from "@/lib/badge-payload";

const fields = (partial: Partial<BadgeFields>): BadgeFields => ({
  name: "",
  company: "",
  title: "",
  email: "",
  phone: "",
  website: "",
  address: "",
  ...partial,
});

/** MFO Summit — verbatim, as it was pasted: the line breaks collapsed to spaces. */
const MFO_SUMMIT_ONE_LINE =
  "BEGIN:VCARD VERSION:3.0 N;CHARSET=utf-8:Lesser;Elly;;; FN;CHARSET=utf-8:Elly Lesser ORG;CHARSET=utf-8:Fairmont Insurance Brokers EMAIL;INTERNET:elesser@fairmontins.com TEL;WORK,VOICE:+1 718-906-0452 ADR;WORK;POSTAL;CHARSET=utf-8:;;;;;; END:VCARD";

/** The same card as the scanner hands it over: the properties line-separated. */
const MFO_SUMMIT = MFO_SUMMIT_ONE_LINE.replace(
  / (?=(?:N|FN|ORG|EMAIL|TEL|ADR|END|VERSION)[;:])/g,
  "\r\n",
);

const MFO_SUMMIT_FIELDS = fields({
  name: "Elly Lesser",
  company: "Fairmont Insurance Brokers",
  email: "elesser@fairmontins.com",
  phone: "+1 718-906-0452",
});

/** ARRA / PowWow Events — an attendee id. */
const POWWOW = "H3NHH2Q4M5H";

describe("the two badges Mark scanned", () => {
  it("reads the MFO Summit vCard into a lead", () => {
    const p = parseBadgePayload(MFO_SUMMIT);
    expect(p).toEqual({ kind: "vcard", fields: MFO_SUMMIT_FIELDS });
    expect(badgeIsLead(p)).toBe(true);
    expect(badgeSummary(p.fields!)).toBe("Elly Lesser · Fairmont Insurance Brokers");
  });

  it("reads the same card pasted onto one line, exactly as Mark sent it", () => {
    expect(parseBadgePayload(MFO_SUMMIT_ONE_LINE)).toEqual({
      kind: "vcard",
      fields: MFO_SUMMIT_FIELDS,
    });
  });

  it("keeps the PowWow attendee id opaque, with no fields invented", () => {
    const p = parseBadgePayload(POWWOW);
    expect(p).toEqual({ kind: "opaque" });
    expect(badgeIsLead(p)).toBe(false);
  });
});

describe("vCard shapes", () => {
  it("reads a 2.1 card with quoted-printable and no FN, building the name from N", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Ren=C3=A9e;Zo=C3=AB;;;",
      "ORG:Harbor Point",
      "TEL;WORK;VOICE:555-0100",
      "EMAIL;PREF;INTERNET:zoe@hp.com",
      "END:VCARD",
    ].join("\r\n");
    expect(parseBadgePayload(raw)).toEqual({
      kind: "vcard",
      fields: fields({
        name: "Zoë Renée",
        company: "Harbor Point",
        email: "zoe@hp.com",
        phone: "555-0100",
      }),
    });
  });

  it("puts a middle name from N between the given and family names", () => {
    const p = parseBadgePayload("BEGIN:VCARD\nVERSION:3.0\nN:Lesser;Elly;Rose;;\nEND:VCARD");
    expect(p.fields?.name).toBe("Elly Rose Lesser");
  });

  it("reads a 4.0 card with tel: URIs, TYPE parameters and a preferred number", () => {
    const raw = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Dana Ortiz",
      "N:Ortiz;Dana;;;",
      "ORG:Harbor Point;Claims",
      "TEL;VALUE=uri;TYPE=home:tel:+1-555-0199",
      "TEL;VALUE=uri;TYPE=work,voice;PREF=1:tel:+1-555-0100",
      "EMAIL;TYPE=work:dana@hp.com",
      "END:VCARD",
    ].join("\n");
    const p = parseBadgePayload(raw);
    expect(p.fields).toEqual(
      fields({
        name: "Dana Ortiz",
        // The company, not "Harbour Point Claims": a department is not a name.
        company: "Harbor Point",
        email: "dana@hp.com",
        phone: "+1-555-0100",
      }),
    );
  });

  it("prefers a cell over the switchboard, and never a fax", () => {
    const p = parseBadgePayload(
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Elly Lesser",
        "TEL;TYPE=FAX:+1 718 000 0000",
        "TEL;TYPE=WORK,VOICE:+1 718 906 0452",
        "TEL;TYPE=CELL:+1 917 555 0100",
        "END:VCARD",
      ].join("\n"),
    );
    expect(p.fields?.phone).toBe("+1 917 555 0100");
  });

  it("takes a fax only when it is the only number on the card", () => {
    const p = parseBadgePayload(
      "BEGIN:VCARD\nVERSION:3.0\nFN:Elly Lesser\nTEL;TYPE=FAX:+1 718 000 0000\nEND:VCARD",
    );
    expect(p.fields?.phone).toBe("+1 718 000 0000");
  });

  it("reads the title, the website and a structured address off a card", () => {
    const p = parseBadgePayload(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Elly Lesser",
        "ORG:Fairmont Insurance Brokers;Commercial Lines",
        "TITLE:Account Executive",
        "URL:https://fairmontins.com",
        "ADR;TYPE=WORK:;;1 Main St\\, Suite 4;Brooklyn;NY;11201;USA",
        "END:VCARD",
      ].join("\n"),
    );
    expect(p.fields).toEqual(
      fields({
        name: "Elly Lesser",
        company: "Fairmont Insurance Brokers",
        title: "Account Executive",
        website: "https://fairmontins.com",
        address: "1 Main St, Suite 4, Brooklyn, NY 11201 USA",
      }),
    );
  });

  it("leaves an empty ADR — the MFO badge has one — as no address", () => {
    expect(parseBadgePayload(MFO_SUMMIT).fields?.address).toBe("");
  });

  it("takes ROLE for the title only when there is no TITLE", () => {
    const p = parseBadgePayload(
      "BEGIN:VCARD\nFN:E L\nROLE:Adjuster\nTITLE:Senior Adjuster\nEND:VCARD",
    );
    expect(p.fields?.title).toBe("Senior Adjuster");
    expect(parseBadgePayload("BEGIN:VCARD\nFN:E L\nROLE:Adjuster\nEND:VCARD").fields?.title).toBe(
      "Adjuster",
    );
  });

  it("unfolds continued lines and unescapes commas", () => {
    const raw =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Elly Lesser\r\nORG:Fairmont Insurance\r\n  Brokers\\, Inc.\r\nEND:VCARD";
    expect(parseBadgePayload(raw).fields?.company).toBe("Fairmont Insurance Brokers, Inc.");
  });

  it("decodes a quoted-printable FN and unfolds under it", () => {
    const p = parseBadgePayload(
      [
        "BEGIN:VCARD",
        "VERSION:2.1",
        "FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Ren=C3=A9e L=C3=A9ger",
        "ORG:Fairmont Insurance",
        "  Brokers",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(p.fields?.name).toBe("Renée Léger");
    expect(p.fields?.company).toBe("Fairmont Insurance Brokers");
  });

  it("is a card but not a lead when nothing names a person or company", () => {
    const p = parseBadgePayload("BEGIN:VCARD\nVERSION:3.0\nTEL:555-0100\nEND:VCARD");
    expect(p.kind).toBe("vcard");
    expect(p.fields).toEqual(fields({ phone: "555-0100" }));
    expect(badgeIsLead(p)).toBe(false);
  });

  it("ignores Apple item groups and a leading BOM", () => {
    const raw =
      "\uFEFFBEGIN:VCARD\nVERSION:3.0\nFN:Mark Falcon\nitem1.EMAIL;type=INTERNET:m@falcon.com\nEND:VCARD";
    expect(parseBadgePayload(raw).fields?.email).toBe("m@falcon.com");
  });

  it("reads Apple's item-grouped, type=pref email over an earlier one", () => {
    const p = parseBadgePayload(
      "BEGIN:VCARD\nVERSION:3.0\nFN:E L\nEMAIL:old@l.com\nitem1.EMAIL;type=INTERNET;type=pref:e@l.com\nitem1.X-ABLabel:Work\nEND:VCARD",
    );
    expect(p.fields?.email).toBe("e@l.com");
  });
});

describe("MECARD", () => {
  it("reads name as Last,First and the rest as labeled", () => {
    const p = parseBadgePayload(
      "MECARD:N:Lesser,Elly;ORG:Fairmont Insurance Brokers;TEL:+17189060452;EMAIL:elesser@fairmontins.com;;",
    );
    expect(p).toEqual({
      kind: "mecard",
      fields: fields({
        name: "Elly Lesser",
        company: "Fairmont Insurance Brokers",
        email: "elesser@fairmontins.com",
        phone: "+17189060452",
      }),
    });
  });

  it("reads a card's URL and address too", () => {
    const p = parseBadgePayload(
      "MECARD:N:Lesser,Elly;ORG:Fairmont Insurance Brokers;TEL:+17189060452;EMAIL:elesser@fairmontins.com;URL:fairmontins.com;ADR:1 Main St,Brooklyn,NY;;",
    );
    expect(p.fields?.website).toBe("fairmontins.com");
    expect(p.fields?.address).toBe("1 Main St, Brooklyn, NY");
  });

  it("honors escaped separators", () => {
    const p = parseBadgePayload("MECARD:N:Smith,Jo;ORG:Acme\\; Sons;;");
    expect(p.fields?.company).toBe("Acme; Sons");
  });
});

describe("everything else", () => {
  it("names a URL as one and keeps it", () => {
    expect(parseBadgePayload("https://reg.example.com/a/H3NHH2Q4M5H")).toEqual({ kind: "url" });
    expect(parseBadgePayload("www.example.com/x")).toEqual({ kind: "url" });
  });

  it("calls garbage, numbers, vendor blobs and empty strings opaque", () => {
    expect(parseBadgePayload("ATT-99123")).toEqual({ kind: "opaque" });
    expect(parseBadgePayload("ATTENDEE|88213|LESSER|ELLY|FAIRMONT")).toEqual({ kind: "opaque" });
    expect(parseBadgePayload("\x00\x01\xff")).toEqual({ kind: "opaque" });
    expect(parseBadgePayload("   ")).toEqual({ kind: "opaque" });
    expect(parseBadgePayload("BEGIN:VCAR")).toEqual({ kind: "opaque" });
  });
});
