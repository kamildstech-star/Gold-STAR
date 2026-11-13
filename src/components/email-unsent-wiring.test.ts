import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The screens stop saying "sent" about email that has not gone.
 *
 * David's 11 Oct invoice: the toast said sent, the row sat in 'queued'. Every
 * Send now reports through announceEmailSend (which warns before the undo
 * window closes when nothing will carry the email), and every list that shows
 * a held email shows an unsent one as "Not sent yet — …" with Resend/Cancel.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const SENDERS = [
  "src/components/email-composer.tsx",
  "src/components/job-email-dialog.tsx",
  "src/components/quick-composer.tsx",
  "src/components/document-send-dialog.tsx",
  "src/components/compliance-files.tsx",
];

describe("every Send reports through one place", () => {
  for (const file of SENDERS) {
    it(file, () => {
      const src = read(file);
      expect(src).toMatch(/import \{ announceEmailSend \} from "@\/components\/email-send-toast";/);
      expect(src).toMatch(/announceEmailSend\(/);
      // No screen composes its own held/queued wording any more.
      expect(src).not.toMatch(/heldToastText\(/);
      const toasts = src.match(/toast\.success\([^;]*;/gs) ?? [];
      for (const t of toasts) expect(t).not.toMatch(/[Qq]ueued|mailbox (is )?connected/);
    });
  }

  it("warns with the fix, not a success, when nothing will carry it", () => {
    const src = read("src/components/email-send-toast.ts");
    const warnBranch = src.slice(src.indexOf("if (warn)"), src.indexOf("toast.success("));
    expect(warnBranch).toMatch(/toast\.warning\(/);
    expect(warnBranch).toMatch(/window\.location\.assign\("\/security"\)/);
    expect(warnBranch).not.toMatch(/toast\.success/);
  });
});

describe("where a sent email is listed", () => {
  const controls = read("src/components/held-email-controls.tsx");

  it("a queued or failed email renders the unsent line, not nothing", () => {
    const branch =
      /if \(row\.status === "queued" \|\| row\.status === "failed"\) \{\s*return <UnsentEmailNotice/.exec(
        controls,
      );
    expect(branch).not.toBeNull();
  });

  it("a held email its sender cannot send is flagged on the row, with the Security link", () => {
    expect(controls).toMatch(
      /const wontSend = held && mine && transport\.data && !transport\.data\.configured;/,
    );
    const flag = controls.slice(controls.indexOf("{wontSend ? ("));
    expect(flag.slice(0, 600)).toMatch(/<Link to="\/security"/);
  });

  it("Resend and Cancel go through the server, which claims before it sends", () => {
    expect(controls).toMatch(/await import\("@\/lib\/email\.functions"\)/);
    expect(controls).toMatch(/resendQueuedEmail\(\{ data: \{ id: row\.id \} \}\)/);
    expect(controls).toMatch(/cancelQueuedEmail\(\{ data: \{ id: row\.id \} \}\)/);
    // Not a static import: the account Timeline's render tests stub
    // @tanstack/react-start, and this file sits under the Timeline.
    expect(controls).not.toMatch(/^import [^;]*from "@\/lib\/email\.functions";/m);
  });

  it("the account Timeline hands unsent emails to the controls", () => {
    const tl = read("src/lib/account-timeline.ts");
    expect(tl).toMatch(/\(\(e\.status === "queued" \|\| e\.status === "failed"\) && !e\.sent_at\)/);
  });

  it("the outbox badge says not sent rather than 'queued'", () => {
    const dialog = read("src/components/job-email-dialog.tsx");
    expect(dialog).toMatch(
      /m\.status === "queued" \|\| m\.status === "failed" \? "not sent" : m\.status/,
    );
  });
});

describe("the delivery dialog does not promise a trail Outlook never sends", () => {
  const src = read("src/components/email-status-dialog.tsx");
  it("checks not-sent and Outlook before showing 'no events yet'", () => {
    const notSent = src.indexOf("{notSent ? (");
    const outlook = src.indexOf(") : viaOutlook ? (");
    const pending = src.indexOf(") : q.isPending ? (");
    const noEvents = src.indexOf("No delivery events yet.");
    expect(notSent).toBeGreaterThan(0);
    expect(outlook).toBeGreaterThan(notSent);
    expect(pending).toBeGreaterThan(outlook);
    expect(noEvents).toBeGreaterThan(pending);
    expect(src.slice(outlook, pending)).toMatch(/does not report delivery or opens/);
  });
});

describe("Send now skips the undo window", () => {
  const controls = read("src/components/held-email-controls.tsx");
  const fns = read("src/lib/email.functions.ts");

  it("the held row offers Send now — to its sender and, since 13 Oct, an owner or admin", () => {
    const actions = controls.slice(controls.indexOf("{held && mayRelease ? ("));
    expect(actions.slice(0, 1600)).toMatch(/Send now/);
    expect(controls).toMatch(/const mayRelease = mine \|\| isPrivileged\(app\.realRoles\)/);
    expect(controls).toMatch(/sendHeldEmailNow\(\{ data: \{ id: row\.id \} \}\)/);
  });

  it("releases with one conditional update, so it can never go twice", () => {
    const fn = fns.slice(fns.indexOf("export const sendHeldEmailNow"));
    const body = fn.slice(0, fn.indexOf("const NOT_HELD"));
    expect(body).toMatch(/\.eq\("status", "held" as never\)/);
    expect(body).toMatch(/status: "queued", released_at: nowIso/);
    expect(body).toMatch(/is_privileged/);
    expect(body).toMatch(/deliverEmailMessage\(/);
  });
});
