import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEND_DELAY_MINUTES,
  composeOutgoingHtml,
  formatCountdown,
  heldToastText,
  holdLabel,
  parseAttachments,
  parseSendDelay,
  releaseAtFrom,
  secondsLeft,
} from "./email-hold";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("send delay setting", () => {
  it("defaults to 5 minutes when nothing readable is stored", () => {
    expect(DEFAULT_SEND_DELAY_MINUTES).toBe(5);
    expect(parseSendDelay(undefined)).toBe(5);
    expect(parseSendDelay(null)).toBe(5);
    expect(parseSendDelay({})).toBe(5);
    expect(parseSendDelay({ delay_minutes: "soon" })).toBe(5);
  });

  it("honors 0 (no hold) and clamps to an hour", () => {
    expect(parseSendDelay({ delay_minutes: 0 })).toBe(0);
    expect(parseSendDelay({ delay_minutes: "10" })).toBe(10);
    expect(parseSendDelay({ delay_minutes: 500 })).toBe(60);
    expect(parseSendDelay({ delay_minutes: -3 })).toBe(0);
  });
});

describe("countdown", () => {
  const now = new Date("2026-09-25T12:00:00Z");

  it("reads like David's example", () => {
    const at = new Date(now.getTime() + 272_000).toISOString();
    expect(holdLabel({ status: "held", release_at: at }, now)).toBe("Sending in 4:32");
    expect(formatCountdown(5)).toBe("0:05");
  });

  it("says 'Sending now' once the window is over but the sweep has not run", () => {
    const past = new Date(now.getTime() - 10_000).toISOString();
    expect(secondsLeft(past, now)).toBe(0);
    expect(holdLabel({ status: "held", release_at: past }, now)).toBe("Sending now");
  });

  it("shows nothing for sent mail and says so for a canceled one", () => {
    expect(holdLabel({ status: "sent" }, now)).toBeNull();
    expect(holdLabel({ status: "queued" }, now)).toBeNull();
    expect(holdLabel({ status: "cancelled" }, now)).toBe("Canceled — not sent");
  });

  it("releases N minutes from now", () => {
    expect(releaseAtFrom(now, 5).toISOString()).toBe("2026-09-25T12:05:00.000Z");
    expect(heldToastText(releaseAtFrom(now, 5).toISOString(), now)).toMatch(/^Sending in 5:00/);
  });
});

describe("attachments ride separately", () => {
  it("appends links at release, escaped", () => {
    const html = composeOutgoingHtml("<p>Hi</p>", [
      { label: "Invoice <1>.pdf", url: "https://x.test/a?b=1&c=2" },
    ]);
    expect(html).toBe(
      '<p>Hi</p><p><a href="https://x.test/a?b=1&amp;c=2">Invoice &lt;1&gt;.pdf</a></p>',
    );
    expect(composeOutgoingHtml("<p>Hi</p>", [])).toBe("<p>Hi</p>");
  });

  it("drops malformed stored entries", () => {
    expect(parseAttachments([{ url: "https://a" }, { label: "x" }, null, "y"])).toEqual([
      { label: "https://a", url: "https://a" },
    ]);
    expect(parseAttachments(null)).toEqual([]);
  });
});

describe("the held state in the database", () => {
  const enumSql = read("supabase/migrations/20260928121000_email_status_held_cancelled.sql");
  const sql = read("supabase/migrations/20260928122000_email_send_delay.sql");

  it("adds the states in their own file, before they are used", () => {
    expect(enumSql).toMatch(/ADD VALUE IF NOT EXISTS 'held'/);
    expect(enumSql).toMatch(/ADD VALUE IF NOT EXISTS 'cancelled'/);
    expect(sql).not.toMatch(/ADD VALUE/);
  });

  it("claims due rows atomically, service role only", () => {
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/SET status = 'queued', released_at = now\(\)/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_due_held_emails\(integer\) FROM PUBLIC, anon, authenticated/,
    );
  });

  it("lets the sender change a held email only while it is held", () => {
    expect(sql).toMatch(/IF OLD\.status = 'held' THEN/);
    expect(sql).toMatch(/NEW\.status NOT IN \('held', 'cancelled'\)/);
    expect(sql).toMatch(/NEW\.release_at := OLD\.release_at/);
    expect(sql).toMatch(/already been sent and can no longer be changed/);
  });

  it("seeds the 5-minute default without overwriting a stored one", () => {
    expect(sql).toMatch(
      /'email_send', '\{"delay_minutes": 5\}'::jsonb\)\s*ON CONFLICT \(key\) DO NOTHING/,
    );
  });

  it("sweeps each minute, and only calls the app when something is due", () => {
    expect(sql).toMatch(/'email-release',\s*'\* \* \* \* \*'/);
    expect(sql).toMatch(
      /IF NOT EXISTS \(\s*SELECT 1 FROM public\.email_messages WHERE status = 'held'/,
    );
    expect(sql).toMatch(/'x-cron-secret', public\.cron_secret\(\)/);
  });
});

describe("the send path", () => {
  const fn = read("src/lib/email.functions.ts");
  const hook = read("src/routes/api/public/hooks/email-release.ts");
  const seam = read("src/lib/email-delivery.server.ts");

  it("holds a person's send instead of sending it", () => {
    expect(fn).toMatch(/if \(delay > 0\)/);
    expect(fn).toMatch(/status: "held", release_at: releaseAt/);
    expect(fn).toMatch(/held: true/);
  });

  it("sends through the one transport seam either way", () => {
    expect(fn).toMatch(/deliverEmailMessage\(/);
    expect(hook).toMatch(/deliverEmailMessage\(supabaseAdmin, row\)/);
    // No transport is a parked row with a reason (email-transport.ts), not
    // a silent 'queued' — and nothing is sent before the transport is known.
    expect(seam).toMatch(/if \(!resolution\.ok\)/);
    expect(seam).toMatch(
      /composeOutgoingHtml\(row\.body_html, parseAttachments\(row\.attachments\)\)/,
    );
    expect(fn).not.toMatch(/sendViaResend\(/);
  });

  it("the hook is cron-authenticated and claims before it sends", () => {
    // Through the webhook seam since 2026-09-28 (src/lib/webhook-verify.ts).
    expect(hook).toMatch(/verifyWebhook\(request, CRON_WEBHOOK\)/);
    const claim = hook.indexOf("claim_due_held_emails");
    expect(hook.indexOf("verifyWebhook(request")).toBeLessThan(claim);
    const deliver = hook.indexOf("deliverEmailMessage(supabaseAdmin");
    expect(claim).toBeGreaterThan(-1);
    expect(deliver).toBeGreaterThan(claim);
  });

  it("automation email to staff is not held", () => {
    const auto = read("src/lib/automation-jobs.server.ts");
    expect(auto).not.toMatch(/status: "held"/);
    expect(auto).not.toMatch(/sendEmail\(/);
  });
});

describe("where a held email shows", () => {
  const controls = read("src/components/held-email-controls.tsx");

  it("Edit and Cancel only while still held, and say so when too late", () => {
    const writes = controls.match(/\.eq\("status", "held" as never\)/g) ?? [];
    expect(writes.length).toBe(2);
    expect(controls).toMatch(/if \(!data\?\.length\) throw new Error\(ALREADY_GONE\)/);
    // Edit and Cancel stay the sender's own; Send now also shows for an admin.
    expect(controls).toMatch(/held && mayRelease \?/);
    expect(controls).toMatch(/\{mine \? \(/);
    expect(controls).toMatch(/>\s*Edit\s*</);
    expect(controls).toMatch(/"Cancel"\}/);
  });

  it("can take a wrong file off", () => {
    expect(controls).toMatch(/setFiles\(\(prev\) => prev\.filter/);
    expect(controls).toMatch(/attachments: files/);
  });

  it("shows on the job Communications tab, the send outbox and the account timeline", () => {
    for (const f of [
      "src/components/job-communications-tab.tsx",
      "src/components/job-email-dialog.tsx",
      "src/components/deal-timeline.tsx",
    ]) {
      expect(read(f)).toMatch(/<HeldEmailControls/);
    }
  });

  it("the job send passes files apart from the body", () => {
    const dialog = read("src/components/job-email-dialog.tsx");
    expect(dialog).toMatch(/attachments: files,/);
    expect(dialog).not.toMatch(/files\s*\.map\(\(f\) => `<a href/);
  });
});

describe("the admin setting", () => {
  it("lives on Admin → Email templates and merges into the stored row", () => {
    expect(read("src/routes/_authenticated/admin.email-templates.tsx")).toMatch(
      /<EmailSendDelayCard \/>/,
    );
    const card = read("src/components/email-send-delay-card.tsx");
    expect(card).toMatch(/\{ \.\.\.\(q\.data \?\? \{\}\), delay_minutes: next \}/);
    expect(card).toMatch(/onConflict: "key"/);
  });
});
