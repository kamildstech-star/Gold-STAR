import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "for intake form, when upload photo, there need to be a camera roll".
 * One input with `capture` opens the camera and hides the library on phones;
 * the form offers both, and only the camera input carries `capture`.
 */
const src = readFileSync("src/routes/intake.$token.tsx", "utf8").replace(/\r\n/g, "\n");

describe("intake form photos: camera and camera roll", () => {
  it("has a camera input with capture and a library input without it", () => {
    const inputs = [...src.matchAll(/<input\s[\s\S]*?\/>/g)]
      .map((m) => m[0])
      .filter((t) => t.includes('type="file"'));
    expect(inputs).toHaveLength(2);
    const camera = inputs.find((t) => t.includes("ref={cameraInput}"))!;
    const library = inputs.find((t) => t.includes("ref={fileInput}"))!;
    expect(camera).toMatch(/capture="environment"/);
    expect(library).not.toMatch(/capture=/);
    expect(library).toMatch(/\bmultiple\b/);
  });

  it("offers both buttons", () => {
    expect(src).toMatch(/Take photo/);
    expect(src).toMatch(/Choose from camera roll/);
  });
});
