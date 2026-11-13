// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { walkFiles } from "@/lib/source-files";

import { sanitizeEditorHtml, sanitizeExternalHtml } from "./safe-html";

describe("HTML from outside the app goes through one seam", () => {
  it.each([
    "<script>alert(1)</script><p>hi</p>",
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<form action="https://evil.example"><input name=p></form>',
    '<svg><g onload="alert(1)"></g></svg>',
    '<p style="position:fixed;inset:0;background:url(https://evil.example/x)">cover</p>',
  ])("strips active content: %s", (html) => {
    const out = sanitizeExternalHtml(html);
    expect(out).not.toMatch(/<script|onerror|onload|javascript:|<iframe|<form|<input|<svg|style=/i);
  });

  it("drops remote images — a read receipt and a tracking pixel — but keeps inline ones", () => {
    const out = sanitizeExternalHtml(
      '<img src="https://tracker.example/p.gif"><img src="cid:logo@mail"><img src="data:image/png;base64,AAAA">',
    );
    expect(out).not.toContain("tracker.example");
    expect(out).toContain('src="cid:logo@mail"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it("keeps an email's tables and headings, and opens links safely", () => {
    const out = sanitizeExternalHtml(
      '<h2>Claim</h2><table><tr><td colspan="2">Row</td></tr></table><a href="https://carrier.example/claim">claim</a>',
    );
    expect(out).toContain("<h2>Claim</h2>");
    expect(out).toContain('<td colspan="2">Row</td>');
    expect(out).toMatch(
      /<a href="https:\/\/carrier\.example\/claim" target="_blank" rel="noopener noreferrer nofollow">/,
    );
  });

  it("does not leak its link hook into the editor's sanitizer", () => {
    sanitizeExternalHtml('<a href="https://a.example">a</a>');
    expect(sanitizeEditorHtml('<a href="https://a.example">a</a>')).not.toContain("target=");
  });
});

/**
 * Raw HTML may only reach the DOM through the seam. A new
 * dangerouslySetInnerHTML or innerHTML assignment fails here until it either
 * uses safe-html.ts or is added below with the reason it is safe.
 */
const RAW_HTML_ALLOWED: Record<string, string> = {
  "src/routes/__root.tsx": "THEME_INIT_SCRIPT: a constant in the source, not data.",
  "src/components/ui/chart.tsx": "CSS variables generated from the chart's own config keys.",
  "src/components/token-editor.tsx":
    "Every assignment is sanitizeEditorHtml output or its own serialised content.",
  "src/components/chase/cockpit-map.tsx": "A marker template built from escaped values.",
};

describe("no raw HTML sink outside the reviewed list", () => {
  it("every dangerouslySetInnerHTML / innerHTML = is on the list or goes through safe-html", () => {
    const offenders = walkFiles("src")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        if (!/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(src)) return false;
        if (f in RAW_HTML_ALLOWED) return false;
        return !/from "@\/lib\/safe-html"|from "\.\/safe-html"/.test(src);
      });
    expect(offenders).toEqual([]);
  });
});
