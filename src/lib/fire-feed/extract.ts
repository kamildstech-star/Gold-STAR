/**
 * Reading a fire out of a headline, without a model.
 *
 * This is the floor, not the ceiling: when the AI gateway is configured the
 * model reads each item first (extract-ai.ts) and these rules fill whatever
 * it left blank. When the gateway is down, out of credits or switched off,
 * these rules are the whole answer, so they are written to be conservative.
 * A missed lead costs a chaser one fire; a false one costs a chaser a drive,
 * and enough of them teach the deck to be ignored.
 *
 * So an item becomes a STRUCTURE fire only on positive evidence — a fire
 * event ("house fire", "blaze", "2-alarm", "fire broke out") AND a building
 * ("home", "apartment", "restaurant") — and anything that merely contains
 * the word fire is refused with a reason. The three Google News samples
 * pulled for Lakewood, Haverstraw and Toms River on 11 Oct 2026 are the test
 * fixtures: most of what a "fire" query returns is "opens fire", "Fire
 * Official", festivals and arson trials.
 *
 * It also reads 911 CAD lines ("STRUCTURE FIRE at 12 MAIN ST ROC"), the shape
 * county incident pages use, so a public page and a news story go through
 * the same rules.
 */
import type { RawItem, WatchArea } from "./types";

export type FireCategory = "structure" | "brush" | "vehicle" | "other_fire" | "not_fire";
export type Occupancy = "residential" | "multi_family" | "commercial";

export interface Extraction {
  /** The source's own fields, label/value, stored with the ledger row (not read by the pipeline). */
  sourceDetails?: [string, string][];
  category: FireCategory;
  occupancy: Occupancy | null;
  /** Street line ("12 Main Street"); never a town on its own. */
  address: string | null;
  /** "Main Street & Oak Avenue", when that is all the report gives. */
  crossStreets: string | null;
  /** True when `address` came from "the 100 block of …", not a real number. */
  blockLevel: boolean;
  locality: string | null;
  state: string | null;
  /** In the chase deck's words: "2nd alarm", "all hands". */
  alarmLevel: string | null;
  injuries: boolean;
  fatalities: boolean;
  displaced: boolean;
  /** What the chase rules read (incident_rule): contains multi / commercial / … */
  buildingType: string | null;
  /** A story about a past fire: charges, a trial, a cause found, a fundraiser. */
  followUp: boolean;
  method: "ai" | "rules";
}

/* ------------------------------------------------------------------ */
/*  Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** "Fire" used about guns, jobs, people and politics. Removed before anything else is read. */
const NOT_A_FIRE: RegExp[] = [
  /\b(open(s|ed|ing)?|exchang\w*|return(s|ed)?|trad\w*|hold(s|ing)?|cease)[ -]fire\b/gi,
  /\bfir(e|es|ed|ing) (shots?|rounds?|a gun|a weapon|at (police|officers?|deputies|troopers|him|her|them|a car|a vehicle))\b/gi,
  /\b(gun|rifle|cross|friendly|rapid|sniper)[ -]?fire\b/gi,
  /\bfired (from|by|after|over|for|as)\b/gi,
  /\bunder fire\b/gi,
  /\bfire ?(official|chief|commissioner|marshal'?s office (said|says)|inspector|district (vote|budget|election)|company (parade|drill)|prevention week|sale|works|fireworks|pit|place|arms?|power|wall|fly|flies|truck show|hydrant)\b/gi,
  /\bfire ?(department|dept\.?|company|house|fighters?|fighter) (union|contract|budget|hires?|hiring|honou?rs?|honou?red|parade|open house|fundraiser|chili|pancake|breakfast|carnival|recruit\w*|training|drill|anniversary|festival|celebrat\w*)\b/gi,
  // "is on fire" is sport and slang; "caught fire" is a fire and stays.
  /\b(is|are|was|were|be|been) on fire\b/gi,
];

/** A fire actually happened. */
const FIRE_EVENT: RegExp[] = [
  /\b(house|home|structure|structural|building|apartment|residential|commercial|garage|basement|attic|kitchen|condo|duplex|townhouse|warehouse|restaurant|church|barn|business|store|motel|hotel|dwelling)[ -]fires?\b/i,
  /\bblaze[sd]?\b/i,
  /\b(catch(es|ing)?|caught) fire\b/i,
  /\b(\d|one|two|three|four|five|six|first|second|third|fourth|fifth|sixth|2nd|3rd|4th|5th|6th)[ -]alarm\b/i,
  /\ball[ -]hands\b/i,
  /\bfires? (broke out|erupt\w*|rip\w*|tore|tears|gut\w*|destroy\w*|damag\w*|engulf\w*|spread\w*|burn\w*|swept|sweeps|displac\w*|kill\w*|injur\w*|claim\w*|forc\w*|leaves?|left|heavily|at|in|on)\b/i,
  /\b(fire|flames) (at|in|inside) (a|an|the|his|her|their)\b/i,
  /\b(engulfed|gutted|burned|burnt|went up) (in flames|down|out)?\b/i,
  /\bfirefighters? (battl\w*|respond\w*|fought|fight\w*|extinguish\w*|knock\w* down|rescu\w*|called|contain\w*|work\w*|douse\w*)\b/i,
  /\b(smoke|flames) (pour\w*|show\w*|seen|visible|billow\w*)\b/i,
  /\b(structure|working|residential|commercial|house|dwelling|building) fire\b/i,
  /^\s*(structure|working|residential|commercial|house|dwelling|building|brush|vehicle|car|auto|grass|outside|dumpster|trash|rubbish|mulch|chimney|appliance|electrical)[ -]?fire\b/i,
  /\bfire[ -]?(residential|commercial|structure|working|dwelling|building|alarm)?\b.*\bat \d/i,
];

const BRUSH =
  /\b(brush|grass|mulch|forest|woods|field|marsh|vegetation|leaf|leaves|landfill)[ -]?(fire|blaze)s?\b|\bwild ?fires?\b/i;
const VEHICLE =
  /\b(car|vehicle|auto|automobile|truck|tractor[ -]trailer|bus|suv|van|boat|vessel|yacht|motorcycle|rv|camper|ev)[ -]?(fire|blaze|caught|burst|engulfed)\b|\b(car|vehicle|truck|bus|boat|vessel|yacht)s? (catch(es)?|caught) fire\b|\b(fire|blaze)\b[^.]{0,30}\b(car|vehicle|truck|bus|boat|vessel)\b/i;
const OTHER =
  /\b(dumpster|trash|rubbish|garbage|transformer|utility pole|pole|manhole|outside|outdoor|grill)[ -]?(fire|blaze)s?\b|\b(bonfire|campfire)s?\b/i;

const MULTI =
  /\b(apartments?|apt\.? building|condos?|condominiums?|multi[ -]?family|two[ -]family|three[ -]family|duplex|triplex|townhouses?|townhomes?|tenements?|row ?homes?|\d+ (residential |apartment )?units|apartment complex|housing complex|garden apartments|high[ -]rise|mixed[ -]use)\b/i;
const COMMERCIAL =
  /\b(business(es)?|restaurant|store|shop|warehouse|factory|plant|office|church|synagogue|mosque|school|yeshiva|commercial|strip mall|mall|motel|hotel|deli|bakery|bar|pizzeria|diner|auto (body|repair)|gas station|supermarket|market|salon|daycare|nursing home|industrial|retail)\b/i;
const RESIDENTIAL =
  /\b(home|homes|house|houses|residence|residential|dwelling|single[ -]family|bungalow|ranch|cape|colonial|cottage|mansion|family of|garage|basement|attic|bedroom)\b/i;

const FOLLOW_UP =
  /\b(charged|accused|suspect|prosecutors?|arrested|arrest|indicted|indictment|sentenced|pleads?|pleaded|convicted|guilty|trial|lawsuit|sues?|sued|anniversary|years? ago|months? ago|last (week|month|year)|cause (of|was|determined)|ruled (accidental|arson)|fundraiser|gofundme|rebuild\w*|memorial|vigil|reopen\w*|honou?red|award)\b/i;

/** "No injuries were reported" is the opposite of an injury. */
const NO_INJURY =
  /\b(no (one|injuries|injury|civilians?)( was| were)?( reported| hurt| injured)?|no reported injuries|without injury|nobody (was )?(hurt|injured))\b/gi;
const INJURY =
  /\b(injur\w*|hurt|hospitali[sz]ed|treated (for|at)|smoke inhalation|burns? to|critical condition|transported)\b/i;
const FATAL =
  /\b(killed|kills|dead|died|dies|fatal\w*|death|deaths|bodies|body (was )?found|perish\w*)\b/i;
const DISPLACED =
  /\b(displac\w*|homeless|red cross|left (a family|families|residents|them) without|forced from|uninhabitable|condemned)\b/i;

/* ------------------------------------------------------------------ */
/*  Addresses                                                           */
/* ------------------------------------------------------------------ */

const STREET_TYPES =
  "Street|St|Avenue|Ave|Av|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Boulevard|Blvd|Way|Terrace|Ter|Terr|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Route|Rte|Rt|Turnpike|Tpke|Square|Sq|Trail|Trl|Pike|Plaza|Path|Row|Walk|Loop|Crescent|Cres|Close|Run|Pass|Point|Pt|Hill|Heights|Hts";

/** A street name: up to four words before the street type, each word letters/digits. */
const STREET_NAME = `(?:(?:North|South|East|West|N|S|E|W)\\.?\\s+)?(?:[A-Za-z0-9][A-Za-z0-9'.-]*\\s+){0,3}?[A-Za-z0-9][A-Za-z0-9'.-]*\\s+(?:${STREET_TYPES})\\b\\.?`;

const HOUSE_NUMBER_ADDRESS = new RegExp(
  `\\b(\\d{1,6}[A-Za-z]?(?:-\\d{1,4})?)\\s+(${STREET_NAME})`,
  "i",
);
const BLOCK_ADDRESS = new RegExp(`\\b(\\d{1,6})\\s+block\\s+of\\s+(${STREET_NAME})`, "i");
/**
 * Cross streets are only trusted in Title Case, so "an apartment building at
 * Cedar Avenue" cannot become a street name.
 */
const CAP_STREET = `(?:(?:North|South|East|West|N|S|E|W)\\.?\\s+)?(?:[A-Z0-9][A-Za-z0-9'.-]*\\s+){0,2}?[A-Z0-9][A-Za-z0-9'.-]*\\s+(?:${STREET_TYPES})\\b\\.?`;
const CROSS_STREETS = new RegExp(`\\b(${CAP_STREET})\\s+(?:and|&|at)\\s+(${CAP_STREET})`);
/** "Route 9", "Rt. 70" have no street type after the name. */
const ROUTE_ADDRESS =
  /\b(\d{1,6})\s+((?:State |US |U\.S\. |County )?(?:Route|Rte\.?|Rt\.?|Highway|Hwy\.?)\s+\d{1,4}[A-Z]?)\b/i;

/** CAD shorthand: "STRUCTURE FIRE at 266 MOULSON ST ROC". */
const CAD_LINE =
  /^\s*([A-Z0-9 /&,()'-]{3,80}?)\s+at\s+(\d{1,6}[A-Z]?\s+[A-Z0-9 '-]+?)(?:\s+[A-Z]{3})?\s*$/;

function tidyStreet(s: string): string {
  const cleaned = s
    .replace(/\s+/g, " ")
    .replace(/[.,]+$/, "")
    .trim();
  // CAD lines arrive in capitals; a chaser reads "266 Moulson St".
  if (cleaned === cleaned.toUpperCase()) {
    return cleaned.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }
  return cleaned;
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                              */
/* ------------------------------------------------------------------ */

const ORDINAL: Record<string, string> = {
  "1": "1st",
  one: "1st",
  first: "1st",
  "1st": "1st",
  "2": "2nd",
  two: "2nd",
  second: "2nd",
  "2nd": "2nd",
  "3": "3rd",
  three: "3rd",
  third: "3rd",
  "3rd": "3rd",
  "4": "4th",
  four: "4th",
  fourth: "4th",
  "4th": "4th",
  "5": "5th",
  five: "5th",
  fifth: "5th",
  "5th": "5th",
  "6": "6th",
  six: "6th",
  sixth: "6th",
  "6th": "6th",
};

/** "two-alarm" → "2nd alarm", the spelling the chase deck's labels and incident_rule() read. */
export function alarmLevelOf(text: string): string | null {
  if (/\ball[ -]hands\b/i.test(text)) return "all hands";
  const m =
    /\b(\d|one|two|three|four|five|six|first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th)[ -]alarm\b/i.exec(
      text,
    );
  if (!m) return null;
  const ord = ORDINAL[m[1]!.toLowerCase()];
  return ord ? `${ord} alarm` : null;
}

export function addressOf(text: string): {
  address: string | null;
  crossStreets: string | null;
  blockLevel: boolean;
} {
  const block = BLOCK_ADDRESS.exec(text);
  if (block)
    return { address: tidyStreet(`${block[1]} ${block[2]}`), crossStreets: null, blockLevel: true };
  // A CAD line is a whole title; the extractor joins title and text with ". ".
  const cad = CAD_LINE.exec(text.split(". ")[0]!.trim());
  if (cad) return { address: tidyStreet(cad[2]!), crossStreets: null, blockLevel: false };
  const house = HOUSE_NUMBER_ADDRESS.exec(text);
  if (house) {
    const number = house[1]!;
    // "2 alarm", "3 people", years and counts are not house numbers; the
    // street-type requirement already refuses most, this refuses "2026 Main
    // Street Festival" style dates at the start of a headline.
    if (!/^(19|20)\d\d$/.test(number) || /\b(st|street|ave|avenue|rd|road)\b/i.test(house[2]!)) {
      return {
        address: tidyStreet(`${number} ${house[2]}`),
        crossStreets: null,
        blockLevel: false,
      };
    }
  }
  const route = ROUTE_ADDRESS.exec(text);
  if (route)
    return {
      address: tidyStreet(`${route[1]} ${route[2]}`),
      crossStreets: null,
      blockLevel: false,
    };
  const cross = CROSS_STREETS.exec(text);
  if (cross) {
    return {
      address: null,
      crossStreets: `${tidyStreet(cross[1]!)} & ${tidyStreet(cross[2]!)}`,
      blockLevel: false,
    };
  }
  return { address: null, crossStreets: null, blockLevel: false };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TOWN = "([A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,2})";
const NOT_A_TOWN =
  /^(The|A|An|This|That|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|January|February|March|April|May|June|July|August|September|October|November|December|Route|County|Township|Police|Fire|Officials?)$/;

/**
 * A town the text names that is not a watch area: "…at 88 Main St., Toms
 * River, was…" or "…an apartment building in Haverstraw." Title Case only,
 * and never a weekday, a month or a county, so "in Ocean County" or "on
 * Sunday" are not towns. Only used when no watch area is named; the area
 * check after geocoding decides whether the town counts.
 */
export function townNamedIn(text: string): string | null {
  const patterns = [
    new RegExp(
      `\\d{1,6}[A-Za-z]?\\s+[^,.;]{2,60}?\\b(?:${STREET_TYPES})\\b\\.?,\\s+${TOWN}(?=,|\\.|;|\\s+(?:on|at|early|late|was|were|in|N\\.?J|NJ|NY|N\\.Y))`,
    ),
    new RegExp(
      `\\b(?:in|of)\\s+${TOWN}(?=[,.;]|\\s+(?:on|at|early|late|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|$))`,
    ),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const town = m?.[1];
    if (town && !NOT_A_TOWN.test(town.split(/[ -]/)[0]!) && !/\bCounty$/.test(town)) return town;
  }
  return null;
}

/**
 * Which watch area the text names, by town first, then county. The area a
 * query was run for is only a hint: a Lakewood search returns Toms River
 * stories, and those belong to Toms River's area or to nobody.
 */
export function mentionedArea(text: string, areas: readonly WatchArea[]): WatchArea | null {
  for (const a of areas) {
    if (a.locality && new RegExp(`\\b${escapeRe(a.locality)}\\b`, "i").test(text)) return a;
  }
  for (const a of areas) {
    if (
      a.county &&
      new RegExp(`\\b${escapeRe(a.county.replace(/\s+county$/i, ""))}\\s+County\\b`, "i").test(text)
    ) {
      return a;
    }
  }
  return null;
}

function buildingTypeOf(occupancy: Occupancy | null, text: string): string | null {
  if (occupancy === "multi_family") {
    const what = MULTI.exec(text)?.[0]?.toLowerCase();
    return what ? `Multi-family (${what})` : "Multi-family";
  }
  if (occupancy === "commercial") {
    const what = COMMERCIAL.exec(text)?.[0]?.toLowerCase();
    return what && what !== "commercial" ? `Commercial (${what})` : "Commercial";
  }
  if (occupancy === "residential") return "Single-family home";
  return null;
}

/** Strip every "fire" that is about guns, jobs or politics, so it cannot count. */
export function withoutFalseFires(text: string): string {
  let s = text;
  for (const re of NOT_A_FIRE) s = s.replace(re, " ");
  return s;
}

/* ------------------------------------------------------------------ */
/*  The extractor                                                       */
/* ------------------------------------------------------------------ */

/**
 * Rules-only extraction. `areas` lets it name the town; the item's own
 * structured columns (a 911 table) win over anything read from prose.
 */
export function extractByRules(item: RawItem, areas: readonly WatchArea[]): Extraction {
  const structuredType = item.structured?.incidentType ?? "";
  const prose = [structuredType, item.title, item.text].filter(Boolean).join(". ");
  const cleaned = withoutFalseFires(prose);

  const isEvent = FIRE_EVENT.some((re) => re.test(cleaned));
  let category: FireCategory;
  if (!isEvent && !/\bfire\b/i.test(structuredType)) {
    category = "not_fire";
  } else {
    // The type a 911 center typed is the best evidence there is.
    const typeText = structuredType || cleaned;
    const hasBuilding =
      MULTI.test(typeText) || COMMERCIAL.test(typeText) || RESIDENTIAL.test(typeText);
    const saysStructure =
      /\b(structure|structural|working|dwelling|building|residential|commercial|house|home|apartment|kitchen|basement|attic|garage|bedroom|chimney|dryer|condo|duplex|townhouse|restaurant|warehouse|church|store)[ -]?fire\b|\bfire[ -]?(residential|commercial|structure|dwelling|building)\b/i.test(
        typeText,
      );
    // A brush or vehicle fire is named as one ("brush fire", "car fire"); a
    // building mentioned beside it ("units", "near homes") does not make it a
    // house fire. Only an explicit structure word outranks those.
    if (saysStructure) {
      category = "structure";
    } else if (BRUSH.test(typeText)) {
      category = "brush";
    } else if (VEHICLE.test(typeText)) {
      category = "vehicle";
    } else if (OTHER.test(typeText)) {
      category = "other_fire";
    } else if (hasBuilding) {
      category = "structure";
    } else {
      category = "other_fire";
    }
  }

  let occupancy: Occupancy | null = null;
  if (category === "structure") {
    if (MULTI.test(cleaned)) occupancy = "multi_family";
    else if (COMMERCIAL.test(cleaned) && !RESIDENTIAL.test(item.title)) occupancy = "commercial";
    else if (RESIDENTIAL.test(cleaned)) occupancy = "residential";
  }

  const fromStructured = item.structured?.address?.trim() || null;
  const crossFromStructured = item.structured?.crossStreet?.trim() || null;
  const found = fromStructured
    ? { address: tidyStreet(fromStructured), crossStreets: null, blockLevel: false }
    : crossFromStructured
      ? { address: null, crossStreets: tidyStreet(crossFromStructured), blockLevel: false }
      : addressOf(`${item.title}. ${item.text}`);

  const area = mentionedArea(prose, areas);
  const structuredTown = item.structured?.locality?.trim();
  const locality =
    (structuredTown ? tidyStreet(structuredTown) : null) ||
    area?.locality ||
    townNamedIn(`${item.title}. ${item.text}`) ||
    null;

  // A page's own alarm column: Houston prints a bare number (0, 1, 2…);
  // only a second alarm or more is worth saying.
  const pageAlarm = item.structured?.alarmLevel?.trim() || null;
  const alarmFromPage = pageAlarm
    ? /^\d$/.test(pageAlarm)
      ? Number(pageAlarm) >= 2
        ? alarmLevelOf(`${pageAlarm}-alarm`)
        : null
      : (alarmLevelOf(pageAlarm) ?? alarmLevelOf(`${pageAlarm} alarm`))
    : null;

  return {
    category,
    occupancy,
    address: found.address,
    crossStreets: found.crossStreets,
    blockLevel: found.blockLevel,
    locality,
    state: area?.state ?? null,
    alarmLevel: alarmFromPage ?? alarmLevelOf(cleaned),
    injuries: INJURY.test(cleaned.replace(NO_INJURY, " ")),
    fatalities: FATAL.test(cleaned),
    displaced: DISPLACED.test(cleaned),
    buildingType: buildingTypeOf(occupancy, cleaned),
    followUp: FOLLOW_UP.test(item.title),
    method: "rules",
  };
}

/** Cheap gate in front of the model: an item with no fire word at all is not worth a credit. */
export function mightBeAFire(item: RawItem): boolean {
  const s = withoutFalseFires(`${item.structured?.incidentType ?? ""} ${item.title} ${item.text}`);
  return /\b(fire|fires|blaze|blazes|flames|burn\w*|alarm|smoke|firefighters?)\b/i.test(s);
}
