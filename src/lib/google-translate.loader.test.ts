// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { LOADER_ID, hasWords, isNewText } from "./google-translate";

/* 12 Nov: the "Traduciendo…" loader waits on new English, never on Google's own output. */
describe("what the loader waits for", () => {
  it("counts words, not numbers or symbols", () => {
    expect(hasWords("Dispatch crew")).toBe(true);
    expect(hasWords("$95,280")).toBe(false);
    expect(hasWords("11/12/2026")).toBe(false);
    expect(hasWords("")).toBe(false);
  });

  it("waits on new English, not Google's <font> output, the loader or notranslate", () => {
    document.body.innerHTML = `
      <main><p id="en">Send email</p><p><font id="g">Enviar correo</font></p></main>
      <div class="notranslate"><span id="brand">Gold Star</span></div>
      <div id="${LOADER_ID}"><span id="busy">Traduciendo</span></div>`;
    const $ = (id: string) => document.getElementById(id)!;
    expect(isNewText($("en"))).toBe(true);
    expect(isNewText($("en").firstChild!)).toBe(true);
    expect(isNewText($("g"))).toBe(false);
    expect(isNewText($("g").firstChild!)).toBe(false);
    expect(isNewText($("brand"))).toBe(false);
    expect(isNewText($("busy"))).toBe(false);
  });
});
