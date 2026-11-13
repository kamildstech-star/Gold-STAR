// TODO(remove after cutover): delete with src/lib/secret-transfer.functions.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const FUNCTIONS = read("src/lib/secret-transfer.functions.ts");
const SERVER = read("src/lib/secret-transfer.server.ts");
const CARD = read("src/components/secret-transfer-card.tsx");
const SECTION = read("src/components/moving-servers-section.tsx");
const PAGE = read("src/routes/_authenticated/admin.security.tsx");

function chain(name: string): string {
  const m = FUNCTIONS.match(
    new RegExp(`export const ${name} = createServerFn\\([\\s\\S]*?\\n  \\}\\);`),
  );
  expect(m, name).not.toBeNull();
  return m![0];
}

describe("secret transfer wiring", () => {
  it("both doors sit behind the session + active-profile middleware", () => {
    for (const name of ["checkSecretTransfer", "runSecretTransfer"]) {
      expect(chain(name)).toMatch(/\.middleware\(\[requireSupabaseAuth\]\)/);
      expect(chain(name)).toMatch(/handleSecretTransfer\(/);
    }
  });

  it("the browser can send the confirmation word and nothing else", () => {
    const validator = chain("runSecretTransfer").match(
      /\.inputValidator\([\s\S]*?\)\s*\n\s*\.handler/,
    );
    const compact = validator![0].replace(/\s+/g, "");
    expect(compact).toContain("z.object({confirm:z.string().max(32)}).strict().parse(data)");
    expect(chain("checkSecretTransfer")).not.toMatch(/inputValidator/);
    // Destination, token and env are server-side constants, never request data.
    expect(FUNCTIONS).not.toMatch(/data\.(url|project|team|target|token|env)/);
  });

  it("uses the shared limiter rules and the service-role client only on the server", () => {
    const deps = FUNCTIONS.match(/async function serverDeps\(\)[\s\S]*?\n\}/)![0];
    expect(deps).toMatch(/await import\("@\/lib\/rate-limit\.server"\)/);
    expect(deps).toMatch(/RATE_LIMITS\.secretTransferCheck/);
    expect(deps).toMatch(/RATE_LIMITS\.secretTransfer\b/);
    expect(deps).toMatch(/await import\("@\/integrations\/supabase\/client\.server"\)/);
    expect(FUNCTIONS).not.toMatch(/^import .*client\.server/m);
  });

  it("the server module never logs or throws a value", () => {
    const logs = [...SERVER.matchAll(/console\.\w+\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(logs.length).toBeGreaterThan(0);
    for (const args of logs) expect(args).not.toMatch(/\bvalue\b|token|env\[|body/);
    expect(SERVER).not.toMatch(/res\.text\(\)/);
  });

  it("the card and its section are shown to owners only", () => {
    expect(CARD).toMatch(/if \(!app\.roles\.includes\("owner"\)\) return null;/);
    expect(SECTION).toMatch(/if \(!app\.roles\.includes\("owner"\)\) return null;/);
    expect(PAGE).toMatch(
      /<MovingServersSection>\s*<SecretTransferCard \/>\s*<StorageExportCard \/>\s*<\/MovingServersSection>/,
    );
  });
});
