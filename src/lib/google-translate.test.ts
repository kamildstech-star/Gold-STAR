import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "./security-response";
import { cookieDomains, googleTranslateOn } from "./google-translate";

/* 12 Nov: Google Translate beside EN | ES, for the whole page. */
describe("Google Translate switch", () => {
  it("is on only while Google's cookie asks for English to Spanish", () => {
    expect(googleTranslateOn("a=1; googtrans=/en/es; b=2")).toBe(true);
    expect(googleTranslateOn("googtrans=/en/en")).toBe(false);
    expect(googleTranslateOn("")).toBe(false);
    expect(googleTranslateOn("xgoogtrans=/en/es")).toBe(false);
  });

  it("clears the cookie from the host and its parent domain, where Google may set it", () => {
    expect(cookieDomains("goldstar.falconstaging.com")).toEqual([
      "goldstar.falconstaging.com",
      ".falconstaging.com",
      ".goldstar.falconstaging.com",
    ]);
    expect(cookieDomains("localhost")).toEqual(["localhost"]);
  });

  it("is allowed by the content security policy, so enforcing it later will not break it", () => {
    const csp = contentSecurityPolicy({ host: "goldstar.falconstaging.com" });
    const script = csp.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script).toContain("https://translate.google.com");
    expect(script).toContain("https://translate.googleapis.com");
  });
});
