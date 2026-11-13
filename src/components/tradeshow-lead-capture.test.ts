/**
 * The booth screen has no steps.
 *
 * Mark: "It shouldn't have the skip, skip, skip, because when you're in a
 * tradeshow everything's rushed." And: "Can maybe just make it two large
 * buttons on top: Leave a voice note, and Capture a lead." These read the
 * sources and hold the shape to that — no DOM library in this repo, so the
 * wiring is asserted on the text, with each fragment cut out by a regex first.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const DIALOG = read("src/components/tradeshow-lead-capture.tsx");
const BAR = read("src/components/tradeshow-capture-bar.tsx");
const PAGE = read("src/routes/_authenticated/tradeshows.$id.tsx");
const REVIEW = read("src/components/tradeshow-review-queue.tsx");

/**
 * The code, with block and line comments stripped so prose cannot satisfy a
 * guard. A block comment starts at a line start, after whitespace or after a
 * JSX brace — never mid-token, or `accept="image/*"` would open one.
 */
const code = (src: string) =>
  src.replace(/(^|[\s{])\/\*[\s\S]*?\*\//g, "$1").replace(/^\s*\/\/.*$/gm, "");

describe("the capture dialog is one screen", () => {
  const body = code(DIALOG);

  it("has no step state, no stepper and no Skip", () => {
    expect(body).not.toMatch(/type Step\b/);
    expect(body).not.toMatch(/useState<Step>/);
    expect(body).not.toMatch(/\bSTEPS\b/);
    expect(body).not.toMatch(/initialStep/);
    expect(body).not.toMatch(/>\s*Skip\s*</);
    expect(body).not.toMatch(/>\s*Next\s*</);
  });

  it("puts the card camera, a voice note and the folded-away fields in one form", () => {
    const input = body.match(/<input[\s\S]*?\/>/)?.[0];
    expect(input).toContain('type="file"');
    expect(input).toContain('capture="environment"');
    expect(body).toMatch(/<CardPhotoControl\b/);
    expect(body).toMatch(/<VoiceNoteField\b[^>]*\bcompact\b/);
    const details = body.match(/aria-expanded=\{detailsOpen\}[\s\S]*?<\/button>/)?.[0];
    expect(details).toContain("Add details");
    expect(body).toMatch(/\{detailsOpen && \([\s\S]*?<DetailsFields\b/);
    for (const label of ["Their name", "Company", "Phone", "Email", "Anything else"]) {
      expect(body).toContain(`label="${label}"`);
    }
  });

  it("opens the camera from the caller's tap, not from an effect after mounting", () => {
    const handle = body.match(/useImperativeHandle\([\s\S]*?\[\],\s*\);/)?.[0];
    expect(handle).toContain("openCamera: () => inputRef.current?.click()");
    expect(body).not.toMatch(/useEffect\(\(\) => \{[^}]*inputRef\.current\?\.click/);
  });

  it("saves on the booth rule, with the card stored as the badge photo", () => {
    const verdict = body.match(/const verdict = validateBoothCapture\(\{[\s\S]*?\}\);/)?.[0];
    expect(verdict).toContain("hasPhoto: !!card");
    expect(verdict).toContain("hasAudio: !!audio");
    const payload = body.match(/buildLeadPayload\(\{[\s\S]*?\}\);/)?.[0];
    expect(payload).toContain("photo: null");
    expect(payload).toContain("badge: card");
    expect(payload).toContain("needsReview: verdict.needsReview");
    expect(body).toMatch(/captureTradeshowLead\(payload, blobs\)/);
  });

  it("has one Save, gated only on the verdict and on being allowed to write", () => {
    expect(body.match(/\{saving \? "Saving…" : "Save"\}/g)).toHaveLength(1);
    expect(body).toMatch(
      /const canSave = !verdict\.problem && !saving && !app\.writesDisabled && !!app\.userId;/,
    );
  });

  it("empties and stays open after Save, and Enter saves from a field", () => {
    const afterSave = body.match(/await captureTradeshowLead[\s\S]*?onSaved\(\);/)?.[0];
    expect(afterSave).toContain("setLastSaved({ name: leadAccountName(payload), queued })");
    expect(afterSave).toContain("clear();");
    expect(afterSave).not.toContain("onOpenChange(false)");
    expect(body).toMatch(
      /if \(e\.key !== "Enter" \|\| e\.shiftKey\) return;[\s\S]*?if \(canSave\) void save\(\);/,
    );
    expect(body).toMatch(/>\s*Done\s*</);
  });
});

/**
 * Mark, after scanning an MFO Summit badge that decoded to a full vCard:
 * "this gave me a contact card but it didnt let me add the lead once scanned,
 * there is no add lead button to save it."
 */
describe("a badge that decodes to a contact card is a lead", () => {
  const body = code(DIALOG);

  it("has a Scan badge control beside the camera and the voice note", () => {
    expect(body).toMatch(/<BadgeControl\b/);
    expect(body).toMatch(/<BadgeScanSheet\b[^>]*onScanned=\{applyBadge\}/);
    expect(body).toContain("Scan their badge");
  });

  it("prefills the fields from the badge, marks them, opens the details and leaves them editable", () => {
    const apply = body.match(/const applyBadge = React\.useCallback\([\s\S]*?\}, \[\]\);/)?.[0];
    expect(apply).toContain("parseBadgePayload(raw)");
    expect(apply).toContain("if (!badgeIsLead(parsed)) return;");
    // Through the one rule (`applyBadgeFields`): over an empty field or a
    // card-read one, never over what was typed — tested in tradeshow-card-read.test.ts.
    expect(apply).toContain("setFields((cur) => applyBadgeFields(cur, parsed.fields))");
    expect(apply).toContain("setDetailsOpen(true)");
    expect(body).toMatch(/\{source === "badge" \? "from badge" : "from card"\}/);
    expect(body).not.toMatch(/readOnly/);
  });

  it("counts the badge towards Save and stores the raw payload on the capture", () => {
    const verdict = body.match(/const verdict = validateBoothCapture\(\{[\s\S]*?\}\);/)?.[0];
    expect(verdict).toContain("hasBadge: !!badge");
    const payload = body.match(/buildLeadPayload\(\{[\s\S]*?\}\);/)?.[0];
    // The badge's raw payload, else the card's own QR code — never parsed here.
    expect(payload).toContain("badgeRaw: badgeRawToStore(badge?.raw ?? null, readSoFar)");
  });

  it("says what an attendee id is and where the details live", () => {
    expect(body).toContain("BADGE_ID_ONLY");
    const lib = code(read("src/lib/badge-payload.ts"));
    const text = lib.match(/BADGE_ID_ONLY =\s*"([^"]+)"/)?.[1];
    expect(text).toMatch(/^Badge ID only — .*registration vendor.*lead export\.$/);
    expect(code(REVIEW)).toMatch(/<BadgeChip raw=\{entry\.badgeRaw\} \/>/);
  });

  it("is opened prefilled by the page's own Scan badge, and only then", () => {
    const bar = code(BAR);
    const onScanned = bar.match(/onScanned=\{\(raw\) => \{[\s\S]*?\}\}/)?.[0];
    expect(onScanned).toMatch(
      /if \(badgeIsLead\(parseBadgePayload\(raw\)\)\) \{\s*captureRef\.current\?\.openWithBadge\(raw\);\s*setCapturing\(true\);/,
    );
    // An opaque id still rides on the next voice note.
    expect(onScanned).toMatch(/else \{\s*setBadgeRaw\(raw\);/);
    expect(bar).not.toContain("it goes on the next note");
  });
});

describe("the show page leads with two large buttons", () => {
  const bar = code(BAR);

  it("offers Leave a voice note and Capture a lead, side by side", () => {
    const grid = bar.match(/<div className="grid gap-3 sm:grid-cols-2">[\s\S]*?<\/div>\n\n/)?.[0];
    expect(grid).toContain("Leave a voice note");
    expect(grid).toContain("Capture a lead");
    expect(grid?.match(/min-h-\[84px\]/g)).toHaveLength(2);
  });

  it("fires the camera in the same tap that opens the dialog", () => {
    expect(bar).toMatch(
      /onClick=\{\(\) => \{\s*setCapturing\(true\);\s*captureRef\.current\?\.openCamera\(\);\s*\}\}/,
    );
  });

  it("keeps the voice note a one-gesture save that needs review", () => {
    expect(bar).toMatch(/onPointerDown=\{[\s\S]*?void start\(\);/);
    expect(bar).toMatch(/onPointerUp=\{[\s\S]*?void stopAndSave\(\);/);
    const payload = bar.match(/buildLeadPayload\(\{[\s\S]*?\}\);/)?.[0];
    expect(payload).toContain("needsReview: true");
    expect(payload).toContain("details: EMPTY_LEAD_DETAILS");
  });

  it("is what the page renders, with the old header buttons gone", () => {
    const page = code(PAGE);
    expect(page).toMatch(/<TradeshowCaptureBar show=\{d\.show\} onSaved=\{invalidate\} \/>/);
    expect(page).not.toMatch(/TradeshowLeadCapture/);
    expect(page).not.toMatch(/TradeshowQuickVoice/);
    expect(page).not.toMatch(/Type it in/);
    expect(page).not.toMatch(/setCapture\(/);
  });
});

describe("the review pass takes a card-only capture", () => {
  it("says what to do with a card that has no recording", () => {
    const row = code(REVIEW).match(/\{entry\.audio \? \([\s\S]*?No recording reached/)?.[0];
    expect(row).toContain("entry.badgePhoto || entry.photo");
    expect(row).toContain("Card photo only");
  });
});

/**
 * Mark: "also the scanner needs to be able to scan business cards as well
 * with qr codes and without." The card photo is read the moment it is taken,
 * and nothing about it holds Save up.
 */
describe("the card photo is read, and Save never waits for it", () => {
  const body = code(DIALOG);

  it("fires readCard on the photo as soon as it is prepared, fire-and-forget", () => {
    const pick = body.match(/const onPick = async[\s\S]*?\n  \};/)?.[0];
    expect(pick).toContain("const photo = await preparePhoto(f);");
    expect(pick).toContain("beginCardRead(photo);");
    const begin = body.match(/const beginCardRead = React\.useCallback\([\s\S]*?\}, \[\]\);/)?.[0];
    expect(begin).toContain('setCardRead({ status: "reading" })');
    expect(begin).toContain("inflightRef.current = startCardRead(photo.blob, {");
    // Not awaited anywhere: the handler returns with the promise in flight.
    expect(begin).not.toMatch(/await/);
    const lib = code(read("src/lib/tradeshow-card-read.ts"));
    const start = lib.match(/export function startCardRead\([\s\S]*?\n\}/)?.[0];
    expect(start).toMatch(
      /const promise = reader\(photo, \{ offline: opts\.offline \}\)\.catch\(\(\) => null\);/,
    );
    expect(start).not.toMatch(/await/);
    expect(start).toContain("void promise.then(");
    expect(lib).toMatch(/const reader = opts\.reader \?\? readCard;/);
  });

  it("puts the fields on the form through fillLeadFromCard, only into empties", () => {
    const begin = body.match(/const beginCardRead = React\.useCallback\([\s\S]*?\}, \[\]\);/)?.[0];
    expect(begin).toContain("setFields((cur) => applyCardRead(cur, read))");
    const lib = code(read("src/lib/tradeshow-card-read.ts"));
    const apply = lib.match(/export function applyCardRead\([\s\S]*?\n\}/)?.[0];
    expect(apply).toContain("fillLeadFromCard(state.details, read)");
  });

  it("gates Save on the verdict alone — a read in flight is not a reason to wait", () => {
    const canSave = body.match(/const canSave = [^;]*;/)?.[0];
    expect(canSave).toBe(
      "const canSave = !verdict.problem && !saving && !app.writesDisabled && !!app.userId;",
    );
    const save = body.match(/const save = async \(\) => \{[\s\S]*?\n  \};/)?.[0];
    expect(save).not.toMatch(/await (inflight|readCard|promise)/);
    // Save takes the handle and the result lands on the written lead later.
    expect(save).toContain("const inflight = inflightRef.current;");
    expect(save).toMatch(/if \(inflight && !queued\) \{\s*void inflight\.promise\.then/);
    expect(save).toContain("await applyLateCardRead(payload, read)");
  });

  it("shows the four states on the thumbnail and marks uncertain fields", () => {
    expect(body).toContain("{cardReadLabel(read)}");
    const lib = code(read("src/lib/tradeshow-card-read.ts"));
    const text = lib.match(/export const CARD_READ_TEXT = \{[\s\S]*?\} as const;/)?.[0];
    expect(text).toContain('reading: "Reading card…"');
    expect(text).toContain('pending: "Will read when online"');
    expect(text).toContain('failed: "Couldn\'t read — write it up after the show"');
    expect(body).toMatch(/>\s*check this\s*</);
    expect(body).toMatch(/uncertain=\{uncertain\.phone\}/);
  });

  it("reruns a pending read when the signal comes back", () => {
    expect(body).toMatch(/window\.addEventListener\("online", rerun\)/);
  });

  it("removes what the card filled when the photo is removed or retaken", () => {
    const clearCard = body.match(/const clearCard = \(\) => \{[\s\S]*?\n  \};/)?.[0];
    expect(clearCard).toContain('takeBackFields(cur, "card")');
    expect(clearCard).toContain("setCardRead(null)");
    expect(body).toMatch(/onClear=\{clearCard\}/);
  });
});

describe("one badge parser", () => {
  it("is badge-payload.ts, and nothing else in src/lib defines parseBadgePayload", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = resolve(process.cwd(), "src/lib");
    const defining = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /export function parseBadgePayload\(/.test(code(read(`src/lib/${f}`))));
    expect(defining).toEqual(["badge-payload.ts"]);
    expect(code(read("src/lib/business-card-reader.ts"))).toMatch(
      /import \{ parseBadgePayload \} from "@\/lib\/badge-payload";/,
    );
  });
});

describe("the review queue reads a card too", () => {
  const review = code(REVIEW);

  it("offers Read card on a row with a card photo and shows what it read", () => {
    expect(review).toMatch(
      /\{\(entry\.badgePhoto \|\| entry\.photo\) && <CardReadChip state=\{cardRead\} onRead=\{onReadCard\} \/>\}/,
    );
    const chip = review.match(/function CardReadChip\([\s\S]*?\n\}/)?.[0];
    expect(chip).toContain('"Not read"');
    expect(chip).toContain('"Reading…"');
    expect(chip).toMatch(/"Read again" : "Read card"/);
  });

  it("runs readCard on the stored photo with the badge as the QR half, into the open form's empties", () => {
    const fn = review.match(
      /const readCardFor = async \(entry: ReviewEntry\) => \{[\s\S]*?\n  \};/,
    )?.[0];
    expect(fn).toContain("const blob = await fetchLeadMediaBlob(path);");
    expect(fn).toContain("await readCard(blob, { qrRaw: entry.badgeRaw, offline })");
    expect(fn).toContain("setFields((cur) => fillLeadFromCard(cur, read).details)");
  });
});
