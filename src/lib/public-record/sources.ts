/**
 * Free public-record property basics for the chase card, before anyone claims
 * the incident.
 *
 * Mark, 14 Oct: "yes show the free public record basics before claim", and no
 * paid API fees. So this reads only free, keyless government sources, one per
 * area we work, by the incident's map point:
 *
 *   NYC (5 boroughs)  NYC Planning GeoSearch reverse (point -> BBL), then PLUTO
 *                     on NYC Open Data (owner of record, building class, units,
 *                     year built, assessed value) and ACRIS (last deed with a
 *                     price). An address search is the fallback with no point.
 *   New Jersey        NJOGIS "Parcels and MOD-IV Composite" (property class,
 *                     year built, last sale, net assessed value). OWNER_NAME is
 *                     in the service but blank statewide: it is redacted for
 *                     public web use under Daniel's Law. We say so on the card.
 *   NY outside NYC    NYS ITS "NYS_Tax_Parcels_Public" (Rockland and the other
 *                     counties that share their roll): owner of record,
 *                     property class, year built, assessed value. No sale data.
 *
 * Anything else: "No free public record for this area".
 *
 * Never phone or email: none of these sources carry them, the parsers read
 * named fields only, and the cache table has no column for them. Phone and
 * email stay behind the claim, on the paid quick-skip path.
 *
 * Pure (no fetch, no env) so the adapters are tested against recorded
 * responses in ./fixtures.
 */

export type PublicRecordSource = "nyc_pluto" | "nj_modiv" | "nys_parcels";

export interface PublicRecord {
  source: PublicRecordSource;
  /** What the card prints after "Public record —". */
  source_label: string;
  /** The data's own vintage: PLUTO version, NJ publish date, NYS roll year. */
  source_vintage: string | null;
  parcel_id: string | null;
  parcel_address: string | null;
  owner_name: string | null;
  /** The source has an owner field but publishes it blank (NJ, Daniel's Law). */
  owner_withheld: boolean;
  property_class: string | null;
  property_class_label: string | null;
  unit_count: number | null;
  year_built: number | null;
  /** YYYY-MM-DD */
  last_sale_date: string | null;
  last_sale_amount: number | null;
  assessed_value: number | null;
}

/* ------------------------------------------------------------------ */
/*  Outbound allowlist                                                  */
/* ------------------------------------------------------------------ */

const SOCRATA = "https://data.cityofnewyork.us/resource/";
export const PLUTO_URL = `${SOCRATA}64uk-42ks.json`;
export const ACRIS_LEGALS_URL = `${SOCRATA}8h5j-fqxa.json`;
export const ACRIS_MASTER_URL = `${SOCRATA}bnx9-e6tj.json`;
export const GEOSEARCH_REVERSE_URL = "https://geosearch.planninglabs.nyc/v2/reverse";
export const GEOSEARCH_SEARCH_URL = "https://geosearch.planninglabs.nyc/v2/search";
export const NJ_PARCELS_URL =
  "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query";
export const NYS_PARCELS_URL =
  "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/MapServer/1/query";

/**
 * Every address this feature may fetch, as exact origin + path. A host alone
 * is not enough: services2.arcgis.com serves every ArcGIS Online customer, so
 * the NJOGIS organisation and layer are pinned too.
 */
export const PUBLIC_RECORD_ENDPOINTS: readonly string[] = [
  PLUTO_URL,
  ACRIS_LEGALS_URL,
  ACRIS_MASTER_URL,
  GEOSEARCH_REVERSE_URL,
  GEOSEARCH_SEARCH_URL,
  NJ_PARCELS_URL,
  NYS_PARCELS_URL,
];

export function isAllowedPublicRecordUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return PUBLIC_RECORD_ENDPOINTS.includes(`${u.origin}${u.pathname}`);
}

/* ------------------------------------------------------------------ */
/*  Where a point is                                                    */
/* ------------------------------------------------------------------ */

type Box = { s: number; n: number; w: number; e: number };
const NYC_BOX: Box = { s: 40.47, n: 40.93, w: -74.27, e: -73.68 };
const NJ_BOX: Box = { s: 38.9, n: 41.37, w: -75.6, e: -73.88 };
const NYS_BOX: Box = { s: 40.48, n: 45.03, w: -79.77, e: -71.85 };
const inBox = (b: Box, lat: number, lon: number) =>
  lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;

/**
 * Which sources to try, in order, for a point. Boxes overlap at the borders
 * (Staten Island / Elizabeth, Rockland / Bergen); each source answers empty
 * outside its own area, so the first one that finds a parcel wins.
 */
export function sourcesForPoint(lat: number, lon: number): PublicRecordSource[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const out: PublicRecordSource[] = [];
  if (inBox(NYC_BOX, lat, lon)) out.push("nyc_pluto");
  const nj = inBox(NJ_BOX, lat, lon);
  const nys = inBox(NYS_BOX, lat, lon);
  // North of the NJ / NY line (High Point to the Hudson at Tappan) try New
  // York first, so a Rockland call usually costs one query, not two.
  if (nj && nys && lat > njNyBorderLat(lon)) out.push("nys_parcels", "nj_modiv");
  else {
    if (nj) out.push("nj_modiv");
    if (nys) out.push("nys_parcels");
  }
  return out;
}

/** The straight NJ / NY land border, (41.357, -74.694) to (41.0, -73.9). */
function njNyBorderLat(lon: number): number {
  return 41.357 + ((lon + 74.694) * (41.0 - 41.357)) / (74.694 - 73.9);
}

/* ------------------------------------------------------------------ */
/*  Small parsing helpers                                               */
/* ------------------------------------------------------------------ */

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function posInt(v: unknown, max = 100_000): number | null {
  const n = num(v);
  if (n === null) return null;
  const i = Math.round(n);
  return i > 0 && i <= max ? i : null;
}

function yearBuilt(v: unknown): number | null {
  const n = posInt(v, 9999);
  // PLUTO and MOD-IV use 0 for unknown; NYS has the odd 1700s farmhouse.
  return n !== null && n >= 1600 && n <= new Date().getUTCFullYear() + 1 ? n : null;
}

function money(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? Math.round(n) : null;
}

/** A sale price this small is a nominal-consideration deed ($1, $10), not a price. */
const NOMINAL_SALE = 100;

function arcgisFeatures(json: unknown): Record<string, unknown>[] | null {
  if (!json || typeof json !== "object") return null;
  const j = json as { error?: unknown; features?: unknown };
  if (j.error || !Array.isArray(j.features)) return null;
  return j.features
    .map((f) => (f && typeof f === "object" ? (f as { attributes?: unknown }).attributes : null))
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

export class PublicRecordParseError extends Error {}

/* ------------------------------------------------------------------ */
/*  NYC                                                                 */
/* ------------------------------------------------------------------ */

export function geosearchReverseUrl(lat: number, lon: number): string {
  const p = new URLSearchParams({
    "point.lat": lat.toFixed(6),
    "point.lon": lon.toFixed(6),
    size: "1",
  });
  return `${GEOSEARCH_REVERSE_URL}?${p}`;
}

export function geosearchSearchUrl(text: string): string {
  const p = new URLSearchParams({ text: text.slice(0, 200), size: "1" });
  return `${GEOSEARCH_SEARCH_URL}?${p}`;
}

export interface GeosearchHit {
  bbl: string;
  lat: number | null;
  lon: number | null;
  /** km from the query point (reverse only). */
  distance_km: number | null;
  confidence: number | null;
  postal_code: string | null;
  label: string | null;
}

/** The first NYC PAD feature with a 10-digit BBL, or null. */
export function parseGeosearch(json: unknown): GeosearchHit | null {
  const features = (json as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) throw new PublicRecordParseError("GeoSearch: no features array");
  for (const f of features) {
    const props = (f as { properties?: Record<string, unknown> })?.properties;
    const pad = (props?.addendum as { pad?: { bbl?: unknown } } | undefined)?.pad;
    const bbl = str(pad?.bbl);
    if (!props || !bbl || !/^[1-5]\d{9}$/.test(bbl)) continue;
    const coords = (f as { geometry?: { coordinates?: unknown } }).geometry?.coordinates;
    const [lon, lat] = Array.isArray(coords) ? coords.map(num) : [null, null];
    return {
      bbl,
      lat: lat ?? null,
      lon: lon ?? null,
      distance_km: num(props.distance),
      confidence: num(props.confidence),
      postal_code: str(props.postalcode, 10),
      label: str(props.label),
    };
  }
  return null;
}

const PLUTO_FIELDS = [
  "bbl",
  "address",
  "borough",
  "ownername",
  "bldgclass",
  "unitsres",
  "unitstotal",
  "yearbuilt",
  "assesstot",
  "version",
];

export function plutoUrl(bbl: string): string {
  if (!/^[1-5]\d{9}$/.test(bbl)) throw new PublicRecordParseError("Not a BBL");
  const p = new URLSearchParams({
    $select: PLUTO_FIELDS.join(","),
    $where: `bbl=${bbl}`,
    $limit: "1",
  });
  return `${PLUTO_URL}?${p}`;
}

/** NYC Department of Finance building class, by its first letter. */
const NYC_CLASS: Record<string, string> = {
  A: "One-family dwelling",
  B: "Two-family dwelling",
  C: "Walk-up apartments",
  D: "Elevator apartments",
  E: "Warehouse",
  F: "Factory / industrial",
  G: "Garage / gas station",
  H: "Hotel",
  I: "Hospital / health",
  J: "Theatre",
  K: "Store building",
  L: "Loft",
  M: "Religious facility",
  N: "Asylum / home",
  O: "Office",
  P: "Public assembly",
  Q: "Recreation",
  R: "Condominium",
  S: "Mixed residential and store",
  T: "Transportation facility",
  U: "Utility",
  V: "Vacant land",
  W: "Educational",
  Y: "Government",
  Z: "Miscellaneous",
};

export function nycClassLabel(code: string | null): string | null {
  if (!code) return null;
  return NYC_CLASS[code.charAt(0).toUpperCase()] ?? null;
}

const BORO_NAME: Record<string, string> = {
  MN: "Manhattan",
  BX: "Bronx",
  BK: "Brooklyn",
  QN: "Queens",
  SI: "Staten Island",
};

export function parsePluto(
  json: unknown,
): Omit<PublicRecord, "last_sale_date" | "last_sale_amount"> | null {
  if (!Array.isArray(json)) throw new PublicRecordParseError("PLUTO: not an array");
  const row = json[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const bblRaw = str(row.bbl);
  const bbl = bblRaw ? (bblRaw.split(".")[0] ?? null) : null;
  const cls = str(row.bldgclass, 4);
  const version = str(row.version, 20);
  const boro = str(row.borough, 4);
  const address = str(row.address);
  return {
    source: "nyc_pluto",
    source_label: version ? `NYC PLUTO ${version}` : "NYC PLUTO",
    source_vintage: version,
    parcel_id: bbl ? `BBL ${bbl}` : null,
    parcel_address: address
      ? `${address}${boro && BORO_NAME[boro] ? `, ${BORO_NAME[boro]}` : ""}`
      : null,
    owner_name: str(row.ownername),
    owner_withheld: false,
    property_class: cls,
    property_class_label: nycClassLabel(cls),
    unit_count: posInt(row.unitstotal) ?? posInt(row.unitsres),
    year_built: yearBuilt(row.yearbuilt),
    assessed_value: money(row.assesstot),
  };
}

/** Borough / block / lot from a BBL, the way ACRIS keys its legals. */
export function splitBbl(bbl: string): { borough: number; block: number; lot: number } | null {
  if (!/^[1-5]\d{9}$/.test(bbl)) return null;
  return {
    borough: Number(bbl.slice(0, 1)),
    block: Number(bbl.slice(1, 6)),
    lot: Number(bbl.slice(6)),
  };
}

export function acrisLegalsUrl(bbl: string): string | null {
  const b = splitBbl(bbl);
  if (!b) return null;
  const p = new URLSearchParams({
    $select: "document_id",
    $where: `borough=${b.borough} AND block=${b.block} AND lot=${b.lot}`,
    $order: "document_id DESC",
    $limit: "200",
  });
  return `${ACRIS_LEGALS_URL}?${p}`;
}

export function parseAcrisLegals(json: unknown): string[] {
  if (!Array.isArray(json)) throw new PublicRecordParseError("ACRIS legals: not an array");
  const ids = new Set<string>();
  for (const r of json) {
    const id = str((r as { document_id?: unknown })?.document_id, 20);
    if (id && /^[A-Z0-9]{1,20}$/.test(id)) ids.add(id);
  }
  return [...ids];
}

/** Deed types that convey the property; mortgages and satisfactions are not sales. */
const DEED_TYPES = ["DEED", "DEEDO", "DEEDP", "DEED, RC", "DEED, LE", "CONDEED"];

export function acrisMasterUrl(documentIds: string[]): string | null {
  const ids = documentIds.filter((id) => /^[A-Z0-9]{1,20}$/.test(id)).slice(0, 200);
  if (!ids.length) return null;
  const types = DEED_TYPES.map((t) => `'${t}'`).join(",");
  const p = new URLSearchParams({
    $select: "document_id,doc_type,document_date,document_amt",
    $where: `doc_type in (${types}) AND document_amt > ${NOMINAL_SALE} AND document_id in (${ids
      .map((id) => `'${id}'`)
      .join(",")})`,
    $order: "document_date DESC",
    $limit: "1",
  });
  return `${ACRIS_MASTER_URL}?${p}`;
}

export function parseAcrisMaster(json: unknown): {
  last_sale_date: string | null;
  last_sale_amount: number | null;
} {
  if (!Array.isArray(json)) throw new PublicRecordParseError("ACRIS master: not an array");
  const row = json[0] as Record<string, unknown> | undefined;
  const amount = row ? money(row.document_amt) : null;
  const date = row ? str(row.document_date, 30) : null;
  return {
    last_sale_date: date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null,
    last_sale_amount: amount !== null && amount > NOMINAL_SALE ? amount : null,
  };
}

/* ------------------------------------------------------------------ */
/*  ArcGIS point queries (NJ, NYS)                                      */
/* ------------------------------------------------------------------ */

function pointQuery(base: string, lat: number, lon: number, fields: string[]): string {
  const p = new URLSearchParams({
    geometry: `${lon.toFixed(6)},${lat.toFixed(6)}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: fields.join(","),
    returnGeometry: "false",
    resultRecordCount: "5",
    f: "json",
  });
  return `${base}?${p}`;
}

const NJ_FIELDS = [
  "PAMS_PIN",
  "COUNTY",
  "MUN_NAME",
  "PROP_LOC",
  "OWNER_NAME",
  "PROP_CLASS",
  "YR_CONSTR",
  "SALE_PRICE",
  "DEED_DATE",
  "NET_VALUE",
  "DWELL",
  "COMM_DWELL",
  "PCL_PBDATE",
];

export const njParcelUrl = (lat: number, lon: number) =>
  pointQuery(NJ_PARCELS_URL, lat, lon, NJ_FIELDS);

/** NJ MOD-IV property class (N.J.A.C. 18:12-2.2). */
const NJ_CLASS: Record<string, string> = {
  "1": "Vacant land",
  "2": "Residential (1-4 family)",
  "3A": "Farm (regular)",
  "3B": "Farm (qualified)",
  "4A": "Commercial",
  "4B": "Industrial",
  "4C": "Apartment",
  "5A": "Railroad",
  "5B": "Railroad",
  "6A": "Telephone (personal property)",
  "6B": "Petroleum refinery",
  "15A": "Public school",
  "15B": "Other school",
  "15C": "Public property",
  "15D": "Church / charitable",
  "15E": "Cemetery",
  "15F": "Other exempt",
};

export function njClassLabel(code: string | null): string | null {
  return code ? (NJ_CLASS[code.toUpperCase()] ?? null) : null;
}

/** MOD-IV DEED_DATE is YYMMDD. */
export function njDeedDate(raw: unknown, now = new Date()): string | null {
  const t = str(raw, 8);
  if (!t || !/^\d{6}$/.test(t)) return null;
  const yy = Number(t.slice(0, 2));
  const mm = Number(t.slice(2, 4));
  const dd = Number(t.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const nowYy = now.getUTCFullYear() % 100;
  const year = yy <= nowYy ? 2000 + yy : 1900 + yy;
  return `${year}-${t.slice(2, 4)}-${t.slice(4, 6)}`;
}

function epochDate(v: unknown): string | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function parseNjParcels(json: unknown, now = new Date()): PublicRecord | null {
  const rows = arcgisFeatures(json);
  if (!rows) throw new PublicRecordParseError("NJ parcels: not a feature set");
  const a = rows[0];
  if (!a) return null;
  const cls = str(a.PROP_CLASS, 4);
  const owner = str(a.OWNER_NAME);
  const price = money(a.SALE_PRICE);
  const published = epochDate(a.PCL_PBDATE);
  const loc = str(a.PROP_LOC);
  const mun = str(a.MUN_NAME);
  const units =
    cls?.toUpperCase() === "4C" ? posInt(a.COMM_DWELL) : cls === "2" ? posInt(a.DWELL, 4) : null;
  return {
    source: "nj_modiv",
    source_label: "NJ MOD-IV parcels",
    source_vintage: published,
    parcel_id: str(a.PAMS_PIN, 40),
    parcel_address: loc ? `${loc}${mun ? `, ${mun}` : ""}` : null,
    owner_name: owner,
    owner_withheld: !owner,
    property_class: cls,
    property_class_label: njClassLabel(cls),
    unit_count: units,
    year_built: yearBuilt(a.YR_CONSTR),
    last_sale_date: njDeedDate(a.DEED_DATE, now),
    last_sale_amount: price !== null && price > NOMINAL_SALE ? price : null,
    assessed_value: money(a.NET_VALUE),
  };
}

const NYS_FIELDS = [
  "COUNTY_NAME",
  "MUNI_NAME",
  "PRINT_KEY",
  "PARCEL_ADDR",
  "PROP_CLASS",
  "TOTAL_AV",
  "YR_BLT",
  "ROLL_YR",
  "PRIMARY_OWNER",
];

export const nysParcelUrl = (lat: number, lon: number) =>
  pointQuery(NYS_PARCELS_URL, lat, lon, NYS_FIELDS);

/** NYS ORPTS property class codes most seen on a fire call; the rest by hundred. */
const NYS_CLASS: Record<string, string> = {
  "210": "One-family residence",
  "215": "One-family with apartment",
  "220": "Two-family residence",
  "230": "Three-family residence",
  "240": "Rural residence",
  "250": "Estate",
  "260": "Seasonal residence",
  "270": "Mobile home",
  "280": "Multiple residences",
  "281": "Multiple residences",
  "283": "Residence with commercial use",
  "411": "Apartments",
  "481": "Attached row building",
  "482": "Detached row building",
  "483": "Converted residence",
  "484": "One-story small structure",
};
const NYS_CLASS_GROUP: Record<string, string> = {
  "1": "Agricultural",
  "2": "Residential",
  "3": "Vacant land",
  "4": "Commercial",
  "5": "Recreation / entertainment",
  "6": "Community services",
  "7": "Industrial",
  "8": "Public services",
  "9": "Wild / forest / park",
};

export function nysClassLabel(code: string | null): string | null {
  if (!code) return null;
  const base = code.slice(0, 3);
  return NYS_CLASS[base] ?? NYS_CLASS_GROUP[code.charAt(0)] ?? null;
}

export function parseNysParcels(json: unknown): PublicRecord | null {
  const rows = arcgisFeatures(json);
  if (!rows) throw new PublicRecordParseError("NYS parcels: not a feature set");
  const a = rows[0];
  if (!a) return null;
  const county = str(a.COUNTY_NAME, 40);
  const cls = str(a.PROP_CLASS, 10);
  const roll = posInt(a.ROLL_YR, 9999);
  const addr = str(a.PARCEL_ADDR);
  const muni = str(a.MUNI_NAME);
  return {
    source: "nys_parcels",
    source_label: county ? `NYS tax parcels (${county} County)` : "NYS tax parcels",
    source_vintage: roll ? `${roll} roll` : null,
    parcel_id: str(a.PRINT_KEY, 40),
    parcel_address: addr ? `${addr}${muni ? `, ${muni}` : ""}` : null,
    owner_name: str(a.PRIMARY_OWNER),
    owner_withheld: false,
    property_class: cls,
    property_class_label: nysClassLabel(cls),
    unit_count: null,
    year_built: yearBuilt(a.YR_BLT),
    last_sale_date: null,
    last_sale_amount: null,
    assessed_value: money(a.TOTAL_AV),
  };
}
