// Server-only Resend transport. Never imported from client code.
export type SendResult = { id: string | null };

export function resendConfigured() {
  return Boolean(process.env["RESEND_API_KEY"]);
}

export function defaultFrom() {
  return process.env["RESEND_FROM"] ?? "Gold Star Restoration <onboarding@resend.dev>";
}

/**
 * Sends through Resend. Throws with the provider's own status and body so a
 * failure is never swallowed into a generic error — the caller records it on
 * the email log row and shows it to the user.
 */
export async function sendViaResend(input: {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  replyTo?: string | null;
  from?: string | null;
}): Promise<SendResult> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not configured. Add it in Project Settings → Secrets before sending email.",
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: input.from || defaultFrom(),
      to: input.to,
      ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      subject: input.subject,
      html: input.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[email] Resend failed [${response.status}]: ${body}`);
    throw new Error(`Email provider rejected the send [${response.status}]: ${body}`);
  }

  const payload = (await response.json()) as { id?: string };
  return { id: payload.id ?? null };
}
