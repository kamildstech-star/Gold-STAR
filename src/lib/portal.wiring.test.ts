import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level checks on the few app-side pieces the portal's security leans
 * on. The database is the boundary (see client-portal-security.test.ts);
 * these keep the app from quietly working around it.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const FNS = read("src/lib/portal.functions.ts");

describe("portal wiring", () => {
  it("portal pages live outside the staff layout, in their own shell", () => {
    const portalRoutes = readdirSync("src/routes").filter((f) => f.startsWith("portal"));
    expect(portalRoutes.length).toBeGreaterThanOrEqual(6);
    expect(readdirSync("src/routes/_authenticated").some((f) => f.startsWith("portal"))).toBe(
      false,
    );
    const layout = read("src/routes/portal.tsx");
    expect(layout.match(/<PortalShell>/)).not.toBeNull();
    expect(layout).not.toMatch(/AppShell|AppContextProvider/);
  });

  it("every customer page requires a customer session", () => {
    for (const f of [
      "portal.index.tsx",
      "portal.jobs.$jobId.tsx",
      "portal.invoices.$invoiceId.tsx",
    ]) {
      expect(read(`src/routes/${f}`).match(/beforeLoad: requirePortalCustomer/), f).not.toBeNull();
    }
  });

  it("the staff layout sends a customer session away before anything mounts", () => {
    const guard = read("src/routes/_authenticated/route.tsx").match(
      /if \(isPortalUser\(data\.user\)\) \{\s*throw redirect\(\{ to: "\/portal" \}\);/,
    );
    expect(guard).not.toBeNull();
  });

  it("every staff server function refuses a customer token", () => {
    const v = read("src/integrations/supabase/validate-session.ts");
    expect(v.match(/claimRole === "portal_customer"\) \{\s*throw new Error/)).not.toBeNull();
  });

  it("signs only the rows the customer's own check returned, for five minutes", () => {
    const handler = FNS.match(/export const portalSignedUrls[\s\S]*$/)![0];
    // The check runs on a client carrying the customer's token, not the service key.
    expect(handler).toMatch(/const asCustomer = createClient\(url, key/);
    expect(handler).toMatch(/await asCustomer\.rpc\("portal_file_refs"/);
    // What is signed is derived from that result and nothing else.
    expect(handler).toMatch(/list\.map\(\(r\) => r\.path\)/);
    expect(handler).toMatch(/PORTAL_SIGNED_URL_SECONDS/);
    expect(handler).not.toMatch(/data\.ids\.map\([^)]*path/);
  });

  it("takes a photo's ULID id, and still only a uuid for a document", () => {
    // photos.id is text (a ULID). The check used to require a uuid for both
    // kinds, so no real photo could ever be signed.
    const validator = FNS.match(/export const portalSignedUrls[\s\S]*?\.handler\(/)![0];
    expect(validator).toMatch(/const ulid = \/\^\[0-9A-HJKMNP-TV-Z\]\{26\}\$\/i;/);
    expect(validator).toContain('uuid.test(id) || (kind === "photo" && ulid.test(id))');
  });

  it("a created sign-in without the customer role is deleted, never handed out", () => {
    const accept = FNS.match(/export const acceptPortalInvite[\s\S]*?\n {2}\}\);/)![0];
    expect(accept).toMatch(/role: PORTAL_ROLE/);
    expect(accept).toMatch(
      /if \(made\.user\.role !== PORTAL_ROLE\) \{\s*await db\.auth\.admin\.deleteUser\(userId\);/,
    );
  });

  it("there is no customer self-registration anywhere in the portal", () => {
    for (const f of readdirSync("src/routes").filter((x) => x.startsWith("portal"))) {
      expect(read(`src/routes/${f}`), f).not.toMatch(/auth\.signUp|signInWithOtp|signInWithOAuth/);
    }
  });
});
