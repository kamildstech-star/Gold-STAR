/**
 * Starting "Connect Outlook" in the browser — one implementation for the
 * Security page's card and the Mail page's button.
 *
 * Connecting is a top-level navigation to Microsoft's own sign-in page, never
 * a popup or a frame: ask /api/auth/microsoft/start for the URL (with the
 * session's Bearer token — the only way to prove who is asking), then leave.
 * `returnTo` names the page the callback brings the person back to; the server
 * accepts only "mail" or "security" and treats anything else as Security.
 */
import { supabase } from "@/integrations/supabase/client";
import type { ReturnTarget } from "@/lib/microsoft-oauth";

export const LOGIN_PREFIX = "https://login.microsoftonline.com/";

export async function startConnect({
  shared,
  returnTo,
}: {
  shared: boolean;
  returnTo: ReturnTarget;
}): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to connect Outlook.");
  const res = await fetch("/api/auth/microsoft/start", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ shared, returnTo }),
  });
  const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
  if (!res.ok || !body?.url)
    throw new Error(body?.error ?? "Couldn't start the Microsoft sign-in.");
  // Belt and braces: whatever the server said, this page only ever leaves for
  // Microsoft's own sign-in host.
  if (!body.url.startsWith(LOGIN_PREFIX)) throw new Error("Unexpected sign-in address.");
  window.location.assign(body.url);
}
