/**
 * What a scanned code said, and whether it is already a lead.
 *
 * Mark scanned two real badges. The MFO Summit one decoded to a full vCard —
 * name, company, email, phone — and the page said "Badge attached … it goes
 * on the next note". His words: "this gave me a contact card but it didnt
 * let me add the lead once scanned, there is no add lead button to save it."
 * The ARRA / PowWow one decoded to "H3NHH2Q4M5H", an attendee id that means
 * nothing without the organiser's export.
 *
 * Both happen in the field, so this tells them apart. Only the open standards
 * are parsed — vCard 2.1 / 3.0 / 4.0 and MECARD — because their meaning is
 * public. A URL is recognised as one and kept. Everything else is opaque:
 * stored verbatim and never guessed at, for the reason the scan sheet gives —
 * a vendor's private format decoded wrong puts invented names on real leads.
 *
 * This is the one parser for every code the booth sees: the badge scanner's
 * live read and the QR code printed on a business card both come through
 * here (`business-card-reader.ts` runs the result through the card
 * normalisers). A card's vCard carries more than a badge's — a title, a
 * website, an address — so those are read too; a badge just leaves them
 * blank.
 */

export type BadgeFields = {
  name: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  website: string;
  address: string;
};

export type BadgePayload =
  | { kind: "vcard" | "mecard"; fields: BadgeFields }
  | { kind: "url" | "opaque"; fields?: undefined };

const EMPTY: BadgeFields = {
  name: "",
  company: "",
  title: "",
  email: "",
  phone: "",
  website: "",
  address: "",
};

/**
 * What an opaque badge is told to the rep and the reviewer. The id is the
 * key to a list only the organiser has, and saying so is the difference
 * between an empty row and a next step.
 */
export const BADGE_ID_ONLY =
  "Badge ID only — this show's registration vendor holds the details; ask the organiser for the lead export.";

export function parseBadgePayload(raw: string): BadgePayload {
  const text = (raw ?? "").replace(/^\uFEFF/, "").trim();
  if (!text) return { kind: "opaque" };
  if (/^BEGIN:VCARD/i.test(text)) return { kind: "vcard", fields: parseVCard(text) };
  if (/^MECARD:/i.test(text)) return { kind: "mecard", fields: parseMeCard(text) };
  if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return { kind: "url" };
  return { kind: "opaque" };
}

/** True when the scan carried enough to be a lead by itself: somebody to call. */
export function badgeIsLead(p: BadgePayload): p is Extract<BadgePayload, { fields: BadgeFields }> {
  return !!p.fields && !!(p.fields.name || p.fields.company);
}

/** One line for a chip: "Elly Lesser · Fairmont Insurance Brokers". */
export function badgeSummary(f: BadgeFields): string {
  return [f.name, f.company].filter(Boolean).join(" · ") || f.email || f.phone || "Contact card";
}

/* ------------------------------------------------------------------ */
/* vCard                                                               */
/* ------------------------------------------------------------------ */

type Prop = { name: string; params: string[]; value: string };

/**
 * The property names a break is assumed before when the payload arrived on
 * one line. A scanner hands a vCard over with its line breaks; a payload
 * pasted into a chat lost them, and the one Mark sent is exactly that:
 * "BEGIN:VCARD VERSION:3.0 N;CHARSET=utf-8:Lesser;Elly;;; FN;…".
 */
const VCARD_PROPS = [
  "BEGIN",
  "END",
  "VERSION",
  "N",
  "FN",
  "ORG",
  "TITLE",
  "ROLE",
  "EMAIL",
  "TEL",
  "URL",
  "ADR",
  "NOTE",
  "NICKNAME",
  "LABEL",
  "PHOTO",
  "REV",
  "UID",
  "X-[A-Z0-9-]+",
  "ITEM\\d+\\.[A-Z-]+",
].join("|");

const ONE_LINE_SPLIT = new RegExp(`\\s+(?=(?:${VCARD_PROPS})[;:])`, "i");

/**
 * RFC 6350 line folding: a line that starts with a space or tab continues
 * the one before. Both CRLF and bare LF are seen from scanners; a payload
 * with no line breaks at all is split at the property names instead.
 */
function unfold(text: string): string[] {
  const normalised = text.replace(/\r\n?/g, "\n");
  const lines = normalised.includes("\n")
    ? normalised.replace(/\n[ \t]/g, "").split("\n")
    : normalised.split(ONE_LINE_SPLIT);
  return lines.map((l) => l.trim()).filter(Boolean);
}

function parseLine(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const parts = head.split(";");
  // "item1.EMAIL" — an Apple-style group prefix carries no meaning here.
  const name = parts[0]!
    .replace(/^[^.]+\./, "")
    .trim()
    .toUpperCase();
  const params = parts.slice(1).map((p) => p.trim().toUpperCase());
  let value = line.slice(colon + 1);
  if (params.some((p) => /QUOTED-PRINTABLE/.test(p))) value = decodeQuotedPrintable(value);
  return { name, params, value };
}

/** vCard 2.1's `=E9` escaping, decoded as UTF-8 with Latin-1 as the fallback. */
function decodeQuotedPrintable(v: string): string {
  const bytes: number[] = [];
  const cleaned = v.replace(/=\r?\n/g, "");
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return String.fromCharCode(...bytes);
  }
}

/** vCard text escaping: `\,` `\;` `\n` `\\`. */
function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/** Split on unescaped semicolons — the structured N, ORG and ADR values. */
function splitStructured(v: string): string[] {
  return v.split(/(?<!\\);/).map(unescapeText);
}

function cleanPhone(v: string): string {
  return v.replace(/^tel:/i, "").replace(/\\/g, "").trim();
}

/** A "pref" parameter on any of several spellings: `PREF`, `PREF=1`, `TYPE=PREF`. */
function isPreferred(params: string[]): boolean {
  return params.some((p) => p === "PREF" || /^PREF=/.test(p) || /TYPE=.*\bPREF\b/.test(p));
}

/** True when any TYPE (bare, `TYPE=`, or `TYPE=a,b`) names one of these. */
function hasType(params: string[], ...types: string[]): boolean {
  return params.some((p) => {
    const list = p.replace(/^TYPE=/, "").split(",");
    return types.some((t) => list.includes(t));
  });
}

/**
 * Pick the phone the rep should dial. A card's vCard often lists the main
 * switchboard first and the person's cell second, and the cell is the lead;
 * a badge's usually has one number. So: a cell, else the one marked
 * preferred, else a work line, else anything that is not a fax or a pager,
 * else the first. A fax is never the answer.
 */
function pickTel(tels: Prop[]): string {
  const voice = tels.filter((t) => !hasType(t.params, "FAX", "PAGER"));
  const pick =
    voice.find((t) => hasType(t.params, "CELL", "MOBILE")) ??
    voice.find((t) => isPreferred(t.params)) ??
    voice.find((t) => hasType(t.params, "WORK")) ??
    voice[0] ??
    tels[0];
  return pick ? cleanPhone(pick.value) : "";
}

/** The email marked preferred, else the first. */
function pickEmail(emails: Prop[]): string {
  const pick = emails.find((e) => isPreferred(e.params)) ?? emails[0];
  return pick ? unescapeText(pick.value) : "";
}

/** ADR is `PO box;extended;street;city;region;postcode;country` — one line of it. */
function formatAddress(value: string): string {
  const [po = "", ext = "", street = "", city = "", region = "", zip = "", country = ""] =
    splitStructured(value);
  const line1 = [po, ext, street].filter(Boolean).join(", ");
  const line2 = [city, region].filter(Boolean).join(", ");
  const line3 = [zip, country].filter(Boolean).join(" ");
  return [line1, [line2, line3].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function parseVCard(text: string): BadgeFields {
  const f = { ...EMPTY };
  let fn = "";
  let n = "";
  let title = "";
  let role = "";
  const emails: Prop[] = [];
  const tels: Prop[] = [];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case "FN":
        if (!fn) fn = unescapeText(p.value);
        break;
      case "N": {
        if (n) break;
        const [family = "", given = "", additional = ""] = splitStructured(p.value);
        n = [given, additional, family].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        break;
      }
      case "ORG":
        // "Company;Department" — the company is the first part; a unit is
        // not a company name and would file the lead under "Acme Claims".
        if (!f.company) f.company = splitStructured(p.value)[0]?.trim() ?? "";
        break;
      case "TITLE":
        if (!title) title = unescapeText(p.value);
        break;
      case "ROLE":
        // ROLE is the looser cousin of TITLE; it stands in only when TITLE is absent.
        if (!role) role = unescapeText(p.value);
        break;
      case "EMAIL":
        if (unescapeText(p.value)) emails.push(p);
        break;
      case "TEL":
        if (cleanPhone(p.value)) tels.push(p);
        break;
      case "URL":
        if (!f.website) f.website = p.value.trim();
        break;
      case "ADR":
        if (!f.address) f.address = formatAddress(p.value);
        break;
      default:
        break;
    }
  }
  f.name = (fn || n).trim();
  f.title = title || role;
  f.email = pickEmail(emails);
  f.phone = pickTel(tels);
  return f;
}

/* ------------------------------------------------------------------ */
/* MECARD                                                              */
/* ------------------------------------------------------------------ */

/**
 * `MECARD:N:Lesser,Elly;ORG:Fairmont;TEL:+17189060452;EMAIL:e@f.com;;`
 * Fields end at an unescaped semicolon; `\;` `\:` `\,` `\\` are literals; N
 * is "Last,First".
 */
function parseMeCard(text: string): BadgeFields {
  const f = { ...EMPTY };
  const body = text.replace(/^MECARD:/i, "");
  const fields = body.split(/(?<!\\);/);
  const unescape = (v: string) => v.replace(/\\([;:\\,])/g, "$1").trim();
  for (const field of fields) {
    const colon = field.indexOf(":");
    if (colon <= 0) continue;
    const key = field.slice(0, colon).trim().toUpperCase();
    const value = field.slice(colon + 1);
    switch (key) {
      case "N": {
        if (f.name) break;
        const [last = "", first = ""] = value.split(",").map(unescape);
        f.name = [first, last].filter(Boolean).join(" ").trim();
        break;
      }
      case "ORG":
        if (!f.company) f.company = unescape(value);
        break;
      case "TITLE":
        if (!f.title) f.title = unescape(value);
        break;
      case "EMAIL":
        if (!f.email) f.email = unescape(value);
        break;
      case "TEL":
      case "TEL-AV":
        if (!f.phone) f.phone = cleanPhone(unescape(value));
        break;
      case "URL":
        if (!f.website) f.website = unescape(value);
        break;
      case "ADR":
        if (!f.address) f.address = unescape(value).replace(/,\s*/g, ", ");
        break;
      default:
        break;
    }
  }
  return f;
}
