import { describe, expect, it } from "vitest";
import { lookup } from "./dom-translate";

const dict = new Map([
  ["Documents", "Documentos"],
  ["{n} documents", "{n} documentos"],
  ["No rate for {n} — those went in at {n}.", "Sin tarifa para {n}: se cargaron a {n}."],
]);

describe("lookup (the on-screen Spanish)", () => {
  it("finds a label, ignoring the spaces JSX leaves around it", () => {
    expect(lookup(dict, "  Documents ")).toBe("Documentos");
  });
  it("carries the numbers through a pattern", () => {
    expect(lookup(dict, "0 documents")).toBe("0 documentos");
    expect(lookup(dict, "No rate for 3 — those went in at $1,250.50.")).toBe(
      "Sin tarifa para 3: se cargaron a $1,250.50.",
    );
  });
  it("leaves what it does not know as written", () => {
    expect(lookup(dict, "Polaris")).toBeNull();
    expect(lookup(dict, "42")).toBeNull();
  });
});
