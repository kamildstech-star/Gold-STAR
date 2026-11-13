import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  sendHeldEmailNow: vi.fn(async (_: { data: { id: string } }) => ({
    sent: true,
    provider: "outlook",
    reason: null,
  })),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: calls.toast }));
vi.mock("@/lib/email.functions", () => ({ sendHeldEmailNow: calls.sendHeldEmailNow }));

import { announceEmailSend, sendHeldNowFromToast } from "./email-send-toast";

/**
 * David, 13 Oct: an email waits about five minutes before it goes — the undo
 * window. A contract or an invoice somebody is waiting on needs a visible
 * "Send Now" that flushes it at once.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe("Send now from the toast", () => {
  it("a held send's toast carries a Send now action", () => {
    announceEmailSend(
      { id: "em-1", held: true, releaseAt: new Date(Date.now() + 300_000).toISOString() },
      { sent: "Contract sent" },
    );
    const [, opts] = calls.toast.success.mock.calls[0]!;
    expect(opts.action.label).toBe("Send now");
  });

  it("pressing it releases that one email immediately", async () => {
    expect(await sendHeldNowFromToast("em-1", "Contract sent")).toBe(true);
    expect(calls.sendHeldEmailNow).toHaveBeenCalledWith({ data: { id: "em-1" } });
    expect(calls.toast.success).toHaveBeenCalledWith("Contract sent");
  });

  it("says 'not sent yet' when nothing could carry it, instead of 'sent'", async () => {
    calls.sendHeldEmailNow.mockResolvedValueOnce({
      sent: false,
      provider: null as never,
      reason: "no_transport" as never,
    });
    expect(await sendHeldNowFromToast("em-1")).toBe(false);
    expect(calls.toast.warning).toHaveBeenCalled();
    expect(calls.toast.success).not.toHaveBeenCalled();
  });

  it("an email that already went says so, rather than failing silently", async () => {
    calls.sendHeldEmailNow.mockRejectedValueOnce(
      new Error("Too late: this email has already been sent or canceled."),
    );
    expect(await sendHeldNowFromToast("em-1")).toBe(false);
    expect(calls.toast.error).toHaveBeenCalledWith(
      "Too late: this email has already been sent or canceled.",
    );
  });

  it("an immediate send has no Send now — it already went", () => {
    announceEmailSend({ id: "em-2", held: false }, { sent: "Email sent" });
    expect(calls.toast.success).toHaveBeenCalledWith("Email sent");
  });
});

describe("Send now on the held email line", () => {
  const controls = readFileSync("src/components/held-email-controls.tsx", "utf8");

  it("is a real button, shown to the sender and to an owner or admin", () => {
    expect(controls).toMatch(/data-send-now/);
    expect(controls).toMatch(/variant="outline"[\s\S]{0,120}data-send-now/);
    expect(controls).toMatch(/const mayRelease = mine \|\| isPrivileged\(app\.realRoles\)/);
  });
});
