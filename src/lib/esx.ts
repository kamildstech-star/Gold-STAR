// Reading a Xactimate .esx estimate in the browser.
//
// An ESX is a ZIP, and the estimate lives in the member named XACTDOC.ZIPXML —
// which, in files Xactimate itself wrote, is not XML yet but an Xceed
// compressed stream (see `unwrappings` below). Third-party writers put plain
// XACTDOC.XML there instead. The Sketch geometry is proprietary and stays out
// of reach; the estimate is not, and the estimate is the reason anyone opens
// the file: which line items the carrier's estimator wrote, at what quantity
// and price, against which claim.
//
// Nothing here trusts one reading of the archive. Members, unwrappings and
// text encodings are all tried in order until one produces a document we can
// recognise, and when none does the failure carries what was actually found so
// the next report is a diagnosis rather than "it doesn't work".
//
// Xactware publish no schema, and element and attribute names move between
// Xactimate versions. So nothing below walks a fixed path. Every field is
// matched against a set of candidate names, case- and separator-insensitively,
// and every match records where it came from so the viewer can show what it
// actually read. A field we cannot find stays null and renders as unread —
// never as a zero, and never as a blank cell that reads like a real value.

import { inflateSync, unzipSync, unzlibSync } from "fflate";

export type EsxLineItem = {
  code: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  total: number | null;
  /** Nearest room/area ancestor, when the file groups its items that way. */
  area: string | null;
};

export type EsxSummary = {
  /** Which ZIP member the XML came from, so a surprise is visible not silent. */
  member: string;
  /** Everything else in the archive — the sketch and photos we cannot render. */
  otherMembers: string[];
  claimNumber: string | null;
  policyNumber: string | null;
  typeOfLoss: string | null;
  dateOfLoss: string | null;
  dateCompleted: string | null;
  estimateName: string | null;
  insuredName: string | null;
  carrier: string | null;
  adjuster: string | null;
  propertyAddress: string | null;
  areas: string[];
  items: EsxLineItem[];
  /** Totals exactly as the file states them. Null means the file stated none. */
  totals: {
    rcv: number | null;
    acv: number | null;
    deductible: number | null;
    netClaim: number | null;
    tax: number | null;
  };
  /** Sum of the line items we parsed. Never shown as the file's own total. */
  itemsSubtotal: number | null;
  /** field → the ELEMENT@attribute (or ELEMENT/child) the value came from. */
  readFrom: Record<string, string>;
};

/**
 * What was in the archive when we could not read it. This is the whole value of
 * a failure: without it a report is "it doesn't work", and with it the member
 * names, their sizes and the first bytes of the one we tried hardest say which
 * of the assumptions above the file broke.
 */
export type EsxDiagnostics = {
  /** Every member with its uncompressed size, largest first. */
  members: { name: string; bytes: number }[];
  /** The member we treated as the estimate. */
  chosen: string | null;
  /** Its opening bytes, escaped — never raw bytes into the DOM. */
  chosenHead: string | null;
  /** member · unwrapping · encoding, in the order they were attempted. */
  tried: string[];
};

export type EsxResult =
  { ok: true; summary: EsxSummary } | { ok: false; reason: string; diagnostics?: EsxDiagnostics };

/** Past this an ESX is a photo dump, and unzipping it would freeze the tab. */
export const MAX_ESX_BYTES = 64 * 1024 * 1024;
export const MAX_ESX_XML_BYTES = 8 * 1024 * 1024;
const MAX_ESX_MEMBERS = 1024;
class EsxSizeError extends Error {}
const ESX_SIZE_REASON = "This ESX expands beyond the browser preview limit.";

/* ------------------------------------------------------------------ */
/* Name matching                                                       */
/* ------------------------------------------------------------------ */

/** `Type_Of_Loss`, `TypeOfLoss` and `typeofloss` are all the same field. */
function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function tagOf(el: Element): string {
  return el.localName || el.tagName;
}

/**
 * `children` and `parentElement` are DOM4 conveniences that XML documents do
 * not always carry. Everything below walks childNodes / parentNode instead so
 * the parser behaves the same wherever the document came from.
 */
function childElements(el: Element): Element[] {
  const out: Element[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

function parentElement(el: Element): Element | null {
  const p = el.parentNode;
  return p && p.nodeType === 1 ? (p as Element) : null;
}

type Hit = { via: string; value: string };

function attrHit(el: Element, names: string[]): Hit | null {
  for (const a of Array.from(el.attributes)) {
    if (!names.includes(norm(a.name))) continue;
    const v = a.value.trim();
    if (v) return { via: `${tagOf(el)}@${a.name}`, value: v };
  }
  return null;
}

function childHit(el: Element, names: string[]): Hit | null {
  for (const c of childElements(el)) {
    if (!names.includes(norm(tagOf(c))) || childElements(c).length) continue;
    const v = (c.textContent ?? "").trim();
    if (v) return { via: `${tagOf(el)}/${tagOf(c)}`, value: v };
  }
  return null;
}

/** Some versions carry a field as an attribute, others as a child element. */
function fieldOn(el: Element, names: string[]): Hit | null {
  return attrHit(el, names) ?? childHit(el, names);
}

/**
 * Preferred tags are tried first; the whole-document sweep afterwards is what
 * survives a version that moved the field. `global: false` turns the sweep off
 * for aliases too generic to trust loose — `Name` would match anything.
 */
function findField(
  els: Element[],
  aliases: string[],
  preferTags: string[],
  global = true,
): Hit | null {
  const names = aliases.map(norm);
  const prefer = preferTags.map(norm);
  for (const el of els) {
    if (!prefer.includes(norm(tagOf(el)))) continue;
    const hit = fieldOn(el, names);
    if (hit) return hit;
  }
  if (!global) return null;
  for (const el of els) {
    const hit = fieldOn(el, names);
    if (hit) return hit;
  }
  return null;
}

function toNum(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[$\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Archive                                                             */
/* ------------------------------------------------------------------ */

/**
 * Candidates, best first — a list rather than one guess, because "the largest
 * XML is the estimate" is only usually true and an archive whose XACTDOC we
 * cannot unwrap may still carry a readable export beside it. The caller walks
 * the whole list.
 */
function pickXmlMembers(files: Record<string, Uint8Array>): string[] {
  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  const bySize = (a: string, b: string) => files[b].length - files[a].length;
  const base = (n: string) => norm(n.split(/[\\/]/).pop() ?? "");
  const named = names.filter((n) => base(n) === "XACTDOCZIPXML" || base(n) === "XACTDOCXML");
  const rest = names.filter((n) => !named.includes(n) && /\.(zipxml|xml)$/i.test(n));
  return [...named.sort(bySize), ...rest.sort(bySize)];
}

/**
 * `.ZIPXML` is named for what it is rather than what it contains: Xactimate
 * writes the estimate there as an Xceed compressed stream — one bit-packed
 * header byte (low bit encrypted, high nibble the method: 0 deflate, 1 store,
 * 2 BWT, 3 deflate64, 4 BZip2, 5 LZMA), the method's own bytes, then a 4-byte
 * Adler32. Documented at
 * xceed.com/documentation/xceed-zip-for-activex/XceedCompressionFileFormat.html.
 *
 * Only deflate and store are attempted: the other three would each be a new
 * dependency and an encrypted stream is not ours to open. Whatever we cannot
 * unwrap reaches the diagnostics, never a blank screen.
 */
/**
 * What the stream's own header byte claims its compression is.
 *
 * Xceed's table is 0 deflate, 1 store, 2 BWT, 3 deflate64, 4 BZip2, 5 LZMA.
 * We can do deflate and store; the rest would each need a decompressor we do
 * not carry. When nothing parses, naming the method turns "it does not work"
 * into a decision about one dependency - so it is worth reading both nibbles
 * and saying what each would mean.
 */
const XCEED_METHODS = ["deflate", "store", "BWT", "deflate64", "BZip2", "LZMA"];

function unreadableMethod(bytes: Uint8Array | undefined): string | null {
  if (!bytes?.length) return null;
  const named = [bytes[0] >> 4, bytes[0] & 0x0f]
    .map((n) => XCEED_METHODS[n])
    .filter((m): m is string => !!m && m !== "deflate" && m !== "store");
  return named.length ? named[0] : null;
}

function unwrappings(bytes: Uint8Array): { via: string; bytes: Uint8Array }[] {
  const out = [{ via: "as stored", bytes }];
  const attempt = (via: string, fn: () => Uint8Array) => {
    try {
      const b = fn();
      if (b.length > MAX_ESX_XML_BYTES) throw new EsxSizeError(ESX_SIZE_REASON);
      if (b.length) out.push({ via, bytes: b });
    } catch (error) {
      if (error instanceof EsxSizeError) throw error;
      // A decompressor that rejects these bytes has told us its format is wrong.
    }
  };
  if (bytes.length > 5) {
    /*
     * Xceed documents the header as one packed byte - an encrypted flag, three
     * reserved bits and a four-bit method - but not which end each field sits
     * at, and a real file has settled nothing: LEVITTOWN's header is 0x04,
     * which is method 0 (deflate) read high and method 4 (BZip2) read low.
     * Both readings are tried, and so is every decompressor regardless of what
     * the nibble claims, because a wrong guess about bit order should cost an
     * attempt rather than the whole file.
     */
    const body = bytes.subarray(1, bytes.length - 4);
    attempt("Xceed deflate stream", () =>
      inflateSync(body, { out: new Uint8Array(MAX_ESX_XML_BYTES + 1) }),
    );
    attempt("Xceed stored stream", () => body);
  }
  attempt("zlib stream", () => unzlibSync(bytes, { out: new Uint8Array(MAX_ESX_XML_BYTES + 1) }));
  attempt("raw deflate stream", () =>
    inflateSync(bytes, { out: new Uint8Array(MAX_ESX_XML_BYTES + 1) }),
  );
  return out;
}

/**
 * TextDecoder will not guess, and a .NET writer emitting UTF-16 without a BOM
 * is common enough that the resulting mojibake is a likely reason a real file
 * fails where a hand-built fixture passes. Every plausible reading is offered;
 * the caller keeps whichever one actually parses.
 */
function decodings(bytes: Uint8Array): { via: string; text: string }[] {
  const utf16 = (le: boolean) => new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return [{ via: "UTF-16LE BOM", text: utf16(true) }];
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return [{ via: "UTF-16BE BOM", text: utf16(false) }];

  const out = [{ via: "UTF-8", text: new TextDecoder("utf-8").decode(bytes) }];
  // ASCII markup held as UTF-16 puts a NUL beside every character; which side
  // it falls on is the byte order.
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < Math.min(bytes.length, 64); i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) evenNul++;
    else oddNul++;
  }
  if (oddNul > evenNul) out.push({ via: "UTF-16LE sniffed", text: utf16(true) });
  else if (evenNul > oddNul) out.push({ via: "UTF-16BE sniffed", text: utf16(false) });
  return out;
}

/** A stray BOM or leading whitespace is enough to make DOMParser refuse. */
function parseXml(text: string): Document | null {
  const start = text.indexOf("<");
  if (start < 0) return null;
  try {
    const doc = new DOMParser().parseFromString(text.slice(start), "application/xml");
    if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Opening bytes of an unreadable member, escaped so they are safe as text. */
function previewText(bytes: Uint8Array, count = 100): string {
  let out = "";
  for (let i = 0; i < Math.min(bytes.length, count); i++) {
    const b = bytes[i];
    out +=
      b >= 0x20 && b < 0x7f
        ? String.fromCharCode(b)
        : `\\x${b.toString(16).padStart(2, "0").toUpperCase()}`;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Field vocabulary — the only place candidate names are written down   */
/* ------------------------------------------------------------------ */

// PROJECT_INFO, ADM and COVERAGE_LOSS are names seen in real XACTDOC documents
// rather than guesses; see the file header for where that came from.
const CLAIM_TAGS = [
  "CLAIMINFO",
  "CLAIM_INFO",
  "CLAIM",
  "ADMINFO",
  "ADM",
  "XACTNET_INFO",
  "PROJECT",
  "PROJECT_INFO",
  "COVERAGE_LOSS",
];
const ADDRESS_TAGS = ["ADDRESS", "LOSSADDRESS", "LOSS_ADDRESS", "PROPERTY", "LOCATION"];
const PARTY_TAGS = ["PARTY", "CONTACT", "PERSON", "COMPANY", "INSURED", "ADJUSTER"];
const AREA_TAGS = ["ROOM", "AREA", "GROUP", "SECTION", "ELEVATION"];
const ITEM_TAGS = ["LINEITEM", "LINE_ITEM", "ITEM", "LI", "ESTIMATELINE", "LINE"];
const TOTAL_TAGS = ["SUMMARY", "TOTALS", "TOTAL", "COVERAGESUMMARY", "COVERAGE", "GRANDTOTAL"];

const ITEM_DESC = ["DESC", "DESCRIPTION", "ACTIVITYDESC", "LINEDESC", "ITEMDESC", "NOTE"];
const ITEM_CODE = ["CODE", "ITEMCODE", "LINEITEMCODE", "SEL", "SELECTOR", "ACT"];
const ITEM_QTY = ["QUANTITY", "QTY", "CALCQTY", "CALCULATEDQTY"];
const ITEM_UNIT = ["UNIT", "UOM", "UNITOFMEASURE", "UNITS"];
const ITEM_PRICE = ["UNITPRICE", "PRICE", "UNITCOST", "RATE"];
const ITEM_TOTAL = ["TOTAL", "TOTALPRICE", "EXTPRICE", "EXTENDEDPRICE", "LINETOTAL", "RCV", "ACV"];

/**
 * The property address is assembled rather than read whole: the parts are
 * consistently named across versions in a way the joined string is not.
 */
function readAddress(els: Element[]): Hit | null {
  const prefer = ADDRESS_TAGS.map(norm);
  for (const el of els) {
    if (!prefer.includes(norm(tagOf(el)))) continue;
    const street = fieldOn(el, ["ADDRESS1", "ADDRESS", "STREET", "STREET1", "LINE1"].map(norm));
    if (!street) continue;
    const parts = [
      street.value,
      fieldOn(el, ["ADDRESS2", "STREET2", "LINE2"].map(norm))?.value,
      fieldOn(el, ["CITY", "TOWN"].map(norm))?.value,
      [
        fieldOn(el, ["STATE", "PROVINCE", "REGION"].map(norm))?.value,
        fieldOn(el, ["ZIP", "ZIPCODE", "POSTAL", "POSTALCODE"].map(norm))?.value,
      ]
        .filter(Boolean)
        .join(" "),
    ].filter((p) => p && p.trim());
    return { via: street.via, value: parts.join(", ") };
  }
  return null;
}

/** `<PARTY Type="Insured" Name="…"/>` is the shape; the labels vary, so match loosely. */
function readParty(els: Element[], wanted: string[]): Hit | null {
  const tags = PARTY_TAGS.map(norm);
  const kinds = wanted.map(norm);
  const nameKeys = ["NAME", "FULLNAME", "COMPANYNAME", "CONTACTNAME", "DISPLAYNAME"].map(norm);
  for (const el of els) {
    const tag = norm(tagOf(el));
    if (!tags.includes(tag)) continue;
    const kind = fieldOn(el, ["TYPE", "PARTYTYPE", "ROLE", "KIND"].map(norm))?.value;
    const matches =
      kinds.includes(tag) || (kind ? kinds.some((k) => norm(kind).includes(k)) : false);
    if (!matches) continue;
    const name = fieldOn(el, nameKeys);
    if (name) return name;
    const first = fieldOn(el, ["FIRSTNAME", "GIVENNAME"].map(norm))?.value;
    const last = fieldOn(el, ["LASTNAME", "SURNAME"].map(norm))?.value;
    if (first || last)
      return {
        via: `${tagOf(el)}@FirstName/LastName`,
        value: [first, last].filter(Boolean).join(" "),
      };
  }
  return null;
}

function nearestAncestorName(el: Element, tags: string[]): string | null {
  const want = tags.map(norm);
  let cur: Element | null = parentElement(el);
  let guard = 0;
  while (cur && guard++ < 40) {
    if (want.includes(norm(tagOf(cur)))) {
      const name = fieldOn(cur, ["NAME", "DESC", "DESCRIPTION", "LABEL"].map(norm));
      if (name) return name.value;
    }
    cur = parentElement(cur);
  }
  return null;
}

/**
 * An `<ITEM>` element appears in ESX files for things that are not line items.
 * Requiring both an identity (code or description) and a number keeps price
 * lists, drop-down options and metadata out of the estimate table.
 */
function readItem(el: Element): EsxLineItem | null {
  const desc = fieldOn(el, ITEM_DESC.map(norm))?.value ?? null;
  const cat = fieldOn(el, ["CAT", "CATEGORY"].map(norm))?.value ?? null;
  const sel = fieldOn(el, ITEM_CODE.map(norm))?.value ?? null;
  const code = cat && sel ? `${cat} ${sel}` : (sel ?? cat);
  const quantity = toNum(fieldOn(el, ITEM_QTY.map(norm))?.value);
  const unitPrice = toNum(fieldOn(el, ITEM_PRICE.map(norm))?.value);
  const total = toNum(fieldOn(el, ITEM_TOTAL.map(norm))?.value);
  if (!desc && !code) return null;
  if (quantity == null && unitPrice == null && total == null) return null;
  return {
    code,
    description: desc,
    quantity,
    unit: fieldOn(el, ITEM_UNIT.map(norm))?.value ?? null,
    unitPrice,
    total,
    area: nearestAncestorName(el, AREA_TAGS),
  };
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/** Null when the document parsed but holds nothing we recognise as an estimate. */
function readSummary(doc: Document, member: string, members: string[]): EsxSummary | null {
  // The root element carries fields in some versions, and getElementsByTagName
  // never returns the element it was called on.
  const els = [doc.documentElement, ...Array.from(doc.documentElement.getElementsByTagName("*"))];
  const readFrom: Record<string, string> = {};
  const take = (key: string, hit: Hit | null): string | null => {
    if (!hit) return null;
    readFrom[key] = hit.via;
    return hit.value;
  };

  const items: EsxLineItem[] = [];
  const itemTags = ITEM_TAGS.map(norm);
  const areaTags = AREA_TAGS.map(norm);
  const areas = new Set<string>();
  for (const el of els) {
    const tag = norm(tagOf(el));
    if (areaTags.includes(tag)) {
      const name = fieldOn(el, ["NAME", "DESC", "DESCRIPTION", "LABEL"].map(norm))?.value;
      if (name) areas.add(name);
    }
    if (!itemTags.includes(tag)) continue;
    const item = readItem(el);
    if (item) {
      if (!readFrom.items) readFrom.items = tagOf(el);
      items.push(item);
    }
  }

  const claimNumber = take(
    "claimNumber",
    findField(els, ["ClaimNumber", "ClaimNum", "ClaimID", "Claim"], CLAIM_TAGS),
  );
  const policyNumber = take(
    "policyNumber",
    findField(els, ["PolicyNumber", "PolicyNum", "PolicyID"], CLAIM_TAGS),
  );

  const summary: EsxSummary = {
    member,
    otherMembers: members.filter((n) => n !== member),
    claimNumber,
    policyNumber,
    typeOfLoss: take(
      "typeOfLoss",
      findField(els, ["TypeOfLoss", "LossType", "CauseOfLoss", "PerilType"], CLAIM_TAGS),
    ),
    dateOfLoss: take(
      "dateOfLoss",
      findField(els, ["DateOfLoss", "LossDate", "DtLoss"], CLAIM_TAGS),
    ),
    dateCompleted: take(
      "dateCompleted",
      findField(els, ["DateCompleted", "CompletedDate", "DateEntered", "EstimateDate"], CLAIM_TAGS),
    ),
    // `Name` is far too generic to sweep the whole document for.
    estimateName: take(
      "estimateName",
      findField(els, ["EstimateName", "ProjectName", "Name"], ["ESTIMATE", "PROJECT"], false),
    ),
    insuredName: take("insuredName", readParty(els, ["Insured", "PolicyHolder", "Owner"])),
    carrier: take("carrier", readParty(els, ["Carrier", "Insurance", "Insurer", "Company"])),
    adjuster: take("adjuster", readParty(els, ["Adjuster", "Estimator", "Examiner"])),
    propertyAddress: take("propertyAddress", readAddress(els)),
    areas: Array.from(areas),
    items,
    totals: {
      rcv: toNum(
        take("totals.rcv", findField(els, ["RCV", "ReplacementCost", "TotalRCV"], TOTAL_TAGS)),
      ),
      acv: toNum(
        take("totals.acv", findField(els, ["ACV", "ActualCashValue", "TotalACV"], TOTAL_TAGS)),
      ),
      deductible: toNum(
        take("totals.deductible", findField(els, ["Deductible", "DeductibleAmount"], TOTAL_TAGS)),
      ),
      netClaim: toNum(
        take(
          "totals.netClaim",
          findField(els, ["NetClaim", "NetClaimAmount", "AmountPayable"], TOTAL_TAGS),
        ),
      ),
      tax: toNum(take("totals.tax", findField(els, ["Tax", "SalesTax", "TotalTax"], TOTAL_TAGS))),
    },
    itemsSubtotal: items.some((i) => i.total != null)
      ? items.reduce((sum, i) => sum + (i.total ?? 0), 0)
      : null,
    readFrom,
  };

  // Nothing identifying and nothing priced means we read the wrong document,
  // or a version whose vocabulary we do not know. Hand back nothing rather than
  // an empty table; the caller moves on to the next candidate.
  if (!items.length && !claimNumber && !policyNumber && !summary.insuredName) return null;
  return summary;
}

/** Enough attempts to exhaust a real archive, few enough to bound a bad one. */
const MAX_ATTEMPTS = 32;

export function parseEsxBytes(buffer: ArrayBuffer): EsxResult {
  if (buffer.byteLength > MAX_ESX_BYTES) {
    return { ok: false, reason: "This ESX is too large to open in the browser." };
  }

  let files: Record<string, Uint8Array>;
  try {
    let expanded = 0;
    let count = 0;
    files = unzipSync(new Uint8Array(buffer), {
      filter: (member) => {
        expanded += member.originalSize;
        if (
          ++count > MAX_ESX_MEMBERS ||
          expanded > MAX_ESX_BYTES ||
          member.originalSize > MAX_ESX_XML_BYTES
        ) {
          throw new EsxSizeError(ESX_SIZE_REASON);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof EsxSizeError) return { ok: false, reason: ESX_SIZE_REASON };
    // Not a ZIP, or a compression method fflate does not implement.
    return { ok: false, reason: "This file is not a readable ESX archive." };
  }

  const members = Object.keys(files).filter((n) => !n.endsWith("/"));
  const candidates = pickXmlMembers(files);
  const diagnostics: EsxDiagnostics = {
    members: members
      .map((name) => ({ name, bytes: files[name].length }))
      .sort((a, b) => b.bytes - a.bytes),
    chosen: candidates[0] ?? null,
    chosenHead: candidates.length ? previewText(files[candidates[0]]) : null,
    tried: [],
  };
  if (!candidates.length) {
    return { ok: false, reason: "This ESX contains no estimate XML.", diagnostics };
  }

  let parsedOne = false;
  for (const member of candidates) {
    if (diagnostics.tried.length >= MAX_ATTEMPTS) break;
    let variants: ReturnType<typeof unwrappings>;
    try {
      variants = unwrappings(files[member]);
    } catch (error) {
      if (error instanceof EsxSizeError) return { ok: false, reason: ESX_SIZE_REASON };
      throw error;
    }
    for (const unwrapped of variants) {
      if (diagnostics.tried.length >= MAX_ATTEMPTS) break;
      for (const decoded of decodings(unwrapped.bytes)) {
        if (diagnostics.tried.length >= MAX_ATTEMPTS) break;
        diagnostics.tried.push(`${member} · ${unwrapped.via} · ${decoded.via}`);
        const doc = parseXml(decoded.text);
        if (!doc) continue;
        parsedOne = true;
        const summary = readSummary(doc, member, members);
        if (summary) return { ok: true, summary };
      }
    }
  }

  const claimed = parsedOne ? null : unreadableMethod(files[members[0]]);
  return {
    ok: false,
    reason: parsedOne
      ? "This ESX could not be read — no estimate data was recognized."
      : claimed
        ? `The estimate inside this ESX is ${claimed}-compressed, which this app cannot decompress.`
        : "The estimate XML inside this ESX could not be parsed.",
    diagnostics,
  };
}

export async function fetchEsx(url: string, signal?: AbortSignal): Promise<EsxResult> {
  let buffer: ArrayBuffer;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return { ok: false, reason: `Could not download this ESX (${res.status}).` };
    if (Number(res.headers.get("content-length")) > MAX_ESX_BYTES) {
      await res.body?.cancel();
      return { ok: false, reason: ESX_SIZE_REASON };
    }
    if (!res.body) return { ok: false, reason: "This ESX has no content." };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ESX_BYTES) {
          await reader.cancel();
          return { ok: false, reason: ESX_SIZE_REASON };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffer = bytes.buffer;
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return { ok: false, reason: "Canceled." };
    return { ok: false, reason: "Could not download this ESX." };
  }
  return parseEsxBytes(buffer);
}
