import { describe, expect, it } from "vitest";
import { secureResponse } from "./security-response";

describe("dynamic response security", () => {
  it("prevents shared caching and token referrers while preserving the response", async () => {
    const response = secureResponse(
      new Response("private report", {
        status: 201,
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Content-Type": "text/html",
          "Set-Cookie": "session=value; HttpOnly",
        },
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("private report");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
  it("preserves redirects and handles immutable upstream headers", () => {
    const response = secureResponse(Response.redirect("https://example.com/login"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/login");
  });
});
