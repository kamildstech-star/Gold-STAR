// @vitest-environment node
import { expect, it } from "vitest";
import { escapeHtml, sanitizeEditorHtml, textToEmailHtml } from "./safe-html";

it("imports safely without a browser and fails closed for rich HTML", () => {
  expect(typeof window).toBe("undefined");
  expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  );
  expect(textToEmailHtml("A & B\nNext")).toBe("<p>A &amp; B<br/>Next</p>");
  expect(sanitizeEditorHtml('<svg onload="alert(1)"></svg>')).toBe(
    "&lt;svg onload=&quot;alert(1)&quot;&gt;&lt;/svg&gt;",
  );
});
