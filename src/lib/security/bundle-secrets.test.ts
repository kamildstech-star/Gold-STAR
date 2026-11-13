import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bundleSecretScan, findBundleSecrets } from "@/lib/security/bundle-secret-plugin";
import { scanForSecrets, secretContext } from "@/lib/security/bundle-secrets";

/**
 * Proof the build refuses a secret: fake secrets are PLANTED in a bundle and
 * the scanner and the plugin must catch every one — while the public anon key,
 * a deliberately exposed VITE_ value and ordinary code pass.
 *
 * Every "secret" here is built at test time from harmless parts, so no string
 * in this file is itself a credential.
 */
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) =>
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${"s".repeat(43)}`;
const SERVICE_ROLE_JWT = jwt({
  iss: "supabase",
  ref: "abcdefghijklmnop",
  role: "service_role",
  iat: 1,
});
const ANON_JWT = jwt({ iss: "supabase", ref: "abcdefghijklmnop", role: "anon", iat: 1 });
const planted = {
  serviceRole: SERVICE_ROLE_JWT,
  sbSecret: "sb_" + "secret_" + "Z".repeat(32),
  privateKey: "-----BEGIN " + "PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----",
  aws: "AKIA" + "Q".repeat(16),
  stripe: "sk_" + "live_" + "9".repeat(24),
  github: "ghp_" + "a".repeat(36),
  anthropic: "sk-" + "ant-" + "b".repeat(40),
  google: "AIza" + "c".repeat(35),
};

describe("the scanner finds planted secrets", () => {
  it.each(Object.entries(planted))("%s", (_name, secret) => {
    const found = scanForSecrets(`const x = ${JSON.stringify(secret)};`, "chunk.js");
    expect(found.length).toBeGreaterThan(0);
    // It never prints the secret back.
    expect(found[0]!.sample).not.toContain(secret.slice(8));
  });

  it("a known secret name assigned a literal", () => {
    const found = scanForSecrets(`env={CRON_SECRET:"cron-value-0123456789"}`, "chunk.js");
    expect(found.map((f) => f.rule)).toContain("CRON_SECRET assigned a literal");
  });

  it("the exact value of a server secret present at build time", () => {
    const ctx = secretContext({ RESEND_API_KEY: "value-that-is-secret-42" });
    const found = scanForSecrets(`a="value-that-is-secret-42"`, "chunk.js", ctx);
    expect(found.map((f) => f.rule)).toContain("the value of RESEND_API_KEY");
  });
});

describe("the scanner passes what is public by design", () => {
  it("the anon JWT, a VITE_-exposed Google browser key, and ordinary code", () => {
    const ctx = secretContext({
      VITE_SUPABASE_PUBLISHABLE_KEY: ANON_JWT,
      SUPABASE_PUBLISHABLE_KEY: ANON_JWT, // the same public key, server-side
      VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY: planted.google,
    });
    const code = `createClient(url, ${JSON.stringify(ANON_JWT)}); load(${JSON.stringify(
      planted.google,
    )}); const label = "CRON_SECRET"; const re_x = 1;`;
    expect(scanForSecrets(code, "chunk.js", ctx)).toEqual([]);
  });
});

describe("the build plugin", () => {
  const plugin = bundleSecretScan() as unknown as {
    apply: string;
    generateBundle: (this: unknown, o: unknown, b: unknown) => void;
  };
  const run = (consumer: "client" | "server", code: string) =>
    plugin.generateBundle.call(
      {
        environment: { name: consumer === "client" ? "client" : "ssr", config: { consumer } },
        error: (msg: string) => {
          throw new Error(msg);
        },
      },
      {},
      { "assets/index.js": { type: "chunk", fileName: "assets/index.js", code } },
    );

  it("runs only on build", () => {
    expect(plugin.apply).toBe("build");
  });

  it("FAILS the client build on a planted service-role key", () => {
    expect(() => run("client", `const k = "${SERVICE_ROLE_JWT}";`)).toThrow(
      /Refusing to ship secrets to the browser bundle:[\s\S]*service-role JWT in assets\/index\.js/,
    );
  });

  it("leaves the server bundle alone — that is where secrets live", () => {
    expect(() => run("server", `const k = "${SERVICE_ROLE_JWT}";`)).not.toThrow();
  });

  it("passes a clean client bundle", () => {
    expect(() => run("client", `export const a = 1;`)).not.toThrow();
  });

  it("scans assets as well as chunks", () => {
    const found = findBundleSecrets(
      { "x.json": { type: "asset", fileName: "x.json", source: planted.sbSecret } },
      {},
    );
    expect(found).toHaveLength(1);
  });

  it("is wired into the build the gate runs", () => {
    const config = readFileSync("vite.config.ts", "utf8");
    expect(config).toMatch(
      /import \{ bundleSecretScan \} from "\.\/src\/lib\/security\/bundle-secret-plugin";/,
    );
    expect(config).toMatch(/plugins: \[[\s\S]*?bundleSecretScan\(\),/);
  });
});
