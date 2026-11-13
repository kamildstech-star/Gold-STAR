/**
 * The build step that FAILS when a secret is about to ship to browsers.
 *
 * Runs on the client environment only, over every emitted chunk and asset,
 * with the rules in bundle-secrets.ts. Server bundles are allowed to hold
 * secrets — that is where they live — so the SSR/worker environment is not
 * scanned. Wired in vite.config.ts, so `npx vite build` (the gate) enforces it.
 */
import type { Plugin } from "vite";

import { scanForSecrets, secretContext, type SecretFinding } from "./bundle-secrets";

type BundleItem =
  | { type: "chunk"; fileName: string; code: string }
  | { type: "asset"; fileName: string; source: string | Uint8Array };

/** Is this the browser build? Vite 6+ environments; older single-env builds say ssr. */
function isClient(ctx: unknown, ssr: boolean | undefined): boolean {
  const env = (ctx as { environment?: { name?: string; config?: { consumer?: string } } })
    .environment;
  if (env?.config?.consumer) return env.config.consumer === "client";
  if (env?.name) return env.name === "client";
  return !ssr;
}

export function findBundleSecrets(
  bundle: Record<string, BundleItem>,
  env: Record<string, string | undefined> = process.env,
): SecretFinding[] {
  const ctx = secretContext(env);
  const findings: SecretFinding[] = [];
  for (const item of Object.values(bundle)) {
    const text =
      item.type === "chunk"
        ? item.code
        : typeof item.source === "string"
          ? item.source
          : Buffer.from(item.source).toString("utf8");
    if (!text) continue;
    findings.push(...scanForSecrets(text, item.fileName, ctx));
  }
  return findings;
}

export function bundleSecretScan(): Plugin {
  let ssrBuild = false;
  return {
    name: "goldstar:bundle-secret-scan",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      ssrBuild = !!config.build?.ssr;
    },
    generateBundle(_options, bundle) {
      if (!isClient(this, ssrBuild)) return;
      const findings = findBundleSecrets(bundle as unknown as Record<string, BundleItem>);
      if (findings.length === 0) return;
      const lines = findings.map((f) => `  - ${f.rule} in ${f.where} (${f.sample})`).join("\n");
      this.error(
        `Refusing to ship secrets to the browser bundle:\n${lines}\n` +
          "Move the value behind a server function, or — only for a value that is public by " +
          "design — expose it deliberately as a VITE_ variable.",
      );
    },
  };
}
