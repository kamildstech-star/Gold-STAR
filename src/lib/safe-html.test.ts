// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeEditorHtml, textToEmailHtml } from "./safe-html";

describe("untrusted editor HTML", () => {
  it.each([
    '<img src=x onerror="alert(1)">',
    '<svg><g onload="alert(1)"></g></svg>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<p onclick="alert(1)" style="position:fixed">Hello</p><script>alert(1)</script>',
    '<a href="jav&#x61;script:alert(1)">bad</a>',
    '<a href="java&#10;script:alert(1)">bad</a>',
    '<a href="data:text/html,<script>alert(1)</script>">bad</a>',
  ])("removes active content: %s", (payload) => {
    const el = document.createElement("div");
    el.innerHTML = sanitizeEditorHtml(payload);
    expect(el.querySelector("script,img,svg,math,iframe,style,object,embed")).toBeNull();
    for (const node of el.querySelectorAll("*")) {
      for (const attr of node.attributes) expect(attr.name).not.toMatch(/^on|^style$/);
    }
    for (const link of el.querySelectorAll<HTMLAnchorElement>("a[href]"))
      expect(link.protocol).toMatch(/^https?:|^mailto:|^tel:/);
  });

  it("keeps supported formatting and secure links", () => {
    const html =
      '<p><b>Hello</b> <u>world</u></p><ul><li>Item</li></ul><a href="https://example.com/pay?a=1&amp;b=2">Pay</a>';
    expect(sanitizeEditorHtml(html)).toBe(html);
  });

  it("escapes plain text rather than interpreting tags and entities", () => {
    const html = textToEmailHtml(
      'Hello <img src=x onerror=alert(1)> & "name"\nnext\n\n<a href="https://evil.example">Pay</a>',
    );
    const el = document.createElement("div");
    el.innerHTML = html;
    expect(el.querySelector("img,a")).toBeNull();
    expect(el.querySelectorAll("p")).toHaveLength(2);
    expect(el.querySelectorAll("br")).toHaveLength(1);
    expect(el.textContent).toContain('<img src=x onerror=alert(1)> & "name"');
  });
});
