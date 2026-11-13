import { describe, expect, it } from "vitest";

import { checkPublicUrl } from "./public-url";

describe("checkPublicUrl — what the server may fetch on an admin's say-so", () => {
  it.each([
    "https://www.monroecounty.gov/incidents911.rss",
    "http://fire.example.gov/rss",
    "https://news.example.com:443/feed",
  ])("allows %s", (u) => {
    expect(checkPublicUrl(u).ok).toBe(true);
  });

  it.each([
    ["javascript:alert(1)", "Only http and https addresses"],
    ["file:///etc/passwd", "Only http and https addresses"],
    [
      "https://user:pass@example.com/feed",
      "Addresses with a login in them are not allowed — public pages only",
    ],
    ["http://localhost:8080/", "That address points inside a private network"],
    ["http://127.0.0.1/", "That address points inside a private network"],
    ["http://169.254.169.254/latest/meta-data/", "That address points inside a private network"],
    ["http://10.0.0.5/feed", "That address points inside a private network"],
    ["http://192.168.1.1/", "That address points inside a private network"],
    ["http://172.20.0.1/", "That address points inside a private network"],
    ["http://[::1]/", "That address points inside a private network"],
    ["http://printer.local/", "That address points inside a private network"],
    ["https://example.com:6379/", "Only the standard web ports"],
    ["not a url", "Not a web address"],
  ])("refuses %s", (u, reason) => {
    const r = checkPublicUrl(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
});
