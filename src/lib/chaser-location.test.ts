import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { eventLocationLabel } from "@/lib/dispatch";

/**
 * Chaser location: granted once, then silent.
 *
 * Melly, 17 Sep: "I don't want them to know that they're being tracked... they
 * don't need to toggle on location every time." He accepted on the call that
 * they grant it when they first get the app.
 *
 * THE BOUNDARY, which no web app can move: the OS shows a location permission
 * prompt ONCE. Everything after that single grant is silent and automatic, and
 * that is what these tests hold in place.
 *
 * Most of this was already built — the priming screen, the never-throwing
 * position helper, lat/lon on every chase event. The two things that were not:
 * a GPS poll running behind the cockpit, and a supervisor screen that stored
 * coordinates and never read them back.
 */

const COCKPIT = readFileSync("src/routes/_authenticated/chase.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const DISPATCH = readFileSync("src/lib/dispatch.ts", "utf8").replace(/\r\n/g, "\n");
const PERMS = readFileSync("src/lib/device-permissions.ts", "utf8").replace(/\r\n/g, "\n");

describe("the prompt happens once, during setup", () => {
  it("primes with an explainer before the browser is ever asked", () => {
    // A cold system dialog is how a chaser learns they are "being tracked".
    expect(PERMS).toContain("We never fire a browser permission prompt cold");
    expect(COCKPIT).toContain("if (!perms.loading && !perms.primed) setExplainerOpen(true)");
  });

  it("remembers the answer per user and device, so it is not asked again", () => {
    expect(PERMS).toContain("primed: boolean");
    expect(PERMS).toContain("deviceId()");
  });

  it("has no location toggle in the chaser's own screens", () => {
    // "They don't need to toggle on location every time." Nothing in the
    // cockpit switches location on or off; the OS grant is the only control.
    expect(COCKPIT).not.toMatch(/toggle[A-Za-z]*Location|locationEnabled|setTrackingOn/);
  });
});

describe("capture rides on the work, not on a timer", () => {
  it("no longer polls GPS on an interval while the cockpit is open", () => {
    /*
     * It used to read the position every two minutes with
     * enableHighAccuracy for as long as the screen was open — the
     * battery-hungriest thing a phone can be asked to do, and pointless: a
     * chaser in a parked truck is not moving, and one who is reads their
     * position again the moment they look at the screen.
     */
    const block = COCKPIT.slice(
      COCKPIT.indexOf("const [myPos, setMyPos]"),
      COCKPIT.indexOf("const goOnDuty"),
    );
    expect(block).not.toContain("setInterval");
    expect(block).toContain('document.addEventListener("visibilitychange"');
  });

  it("stamps a fix on the actions that already write events", () => {
    // Going on duty, off duty, and the outcome sheets each take their own
    // reading; that is what fills lat/lon on incident_events.
    expect(COCKPIT).toContain("const pos = await getCurrentPosition();");
    expect(COCKPIT).toContain("started_lat: pos?.lat ?? null");
    expect(COCKPIT).toContain("lat: pos?.lat ?? null");
  });

  it("reuses a recent fix rather than waking the GPS each time", () => {
    const helper = readFileSync("src/lib/incidents.ts", "utf8").replace(/\r\n/g, "\n");
    const fn = helper.slice(helper.indexOf("export function getCurrentPosition"));
    expect(fn).toContain("maximumAge: 30_000");
  });
});

describe("a chaser is never blocked by location", () => {
  it("returns null instead of throwing when permission is refused", () => {
    const helper = readFileSync("src/lib/incidents.ts", "utf8").replace(/\r\n/g, "\n");
    const fn = helper.slice(
      helper.indexOf("export function getCurrentPosition"),
      helper.indexOf("/** Duration in mm:ss"),
    );
    // Both the error callback and the timeout resolve, never reject.
    expect(fn).toContain("finish(null)");
    expect(fn).not.toContain("reject(");
  });

  it("writes the event with null coordinates rather than refusing to write", () => {
    expect(COCKPIT).toContain("lat: pos?.lat ?? null");
    expect(COCKPIT).toContain("lon: pos?.lon ?? null");
  });
});

describe("the gap is visible to supervisors, not to the chaser", () => {
  it("reads the coordinates back into the dispatch log", () => {
    // Stored since 20260812173002 and never selected, so the one screen a
    // supervisor watches chasers on could not show where anything happened.
    expect(DISPATCH).toContain(
      '.select("id,incident_id,event_type,actor_id,payload,occurred_at,lat,lon")',
    );
  });

  it("says 'No location' out loud instead of leaving a blank", () => {
    // A blank reads as a rendering slip. Which chasers are reporting position
    // is exactly the thing being looked at.
    expect(eventLocationLabel({ lat: null, lon: null })).toBe("No location");
    expect(eventLocationLabel({ lat: 40.6, lon: null })).toBe("No location");
    expect(eventLocationLabel({ lat: null, lon: -73.9 })).toBe("No location");
  });

  it("shows a real fix to five decimal places", () => {
    expect(eventLocationLabel({ lat: 40.712776, lon: -74.005974 })).toBe("40.71278, -74.00597");
  });

  it("does not raise a banner at the chaser when location alone is denied", () => {
    /*
     * A warning telling a chaser their location is blocked, with steps to
     * switch it back on, is the app asking again by other means — and their
     * work is unaffected either way. Notifications are different and stay
     * flagged: a chaser who gets no alerts cannot do the job.
     */
    const banner = readFileSync("src/components/chase/device-permissions.tsx", "utf8")
      .replace(/\r\n/g, "\n")
      .slice(0);
    const fn = banner.slice(banner.indexOf("export function PermissionDeniedBanner"));
    expect(fn).toContain('if (notifications !== "denied") return null;');
    expect(fn).not.toContain('if (location !== "denied" && notifications !== "denied")');
  });
});
