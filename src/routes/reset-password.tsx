import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isRecoveryLink, validateRecoveryPassword } from "@/lib/password-recovery";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({ meta: [
    { title: "Reset password · Recovery Hub" },
    { name: "description", content: "Reset your Gold Star Restoration Recovery Hub password." },
    { property: "og:title", content: "Reset password · Recovery Hub" },
    { property: "og:description", content: "Secure password recovery for Gold Star Restoration staff." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
    { name: "robots", content: "noindex,nofollow" },
  ] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    const recovery = isRecoveryLink(window.location.href);
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (active && event === "PASSWORD_RECOVERY" && session) {
        setReady(true);
        setChecking(false);
      }
    });
    void supabase.auth.getUser().then(({ data, error }) => {
      if (!active) return;
      if (recovery && data.user && !error) setReady(true);
      setChecking(false);
    }).catch(() => { if (active) setChecking(false); });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    const validation = validateRecoveryPassword(password, confirmation);
    if (validation) { setError(validation); return; }
    setBusy(true);
    setError("");
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      await supabase.auth.signOut();
      setPassword("");
      setConfirmation("");
      setReady(false);
      setDone(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Password reset failed. Please try again.");
    } finally { setBusy(false); }
  };

  return <div className="flex min-h-svh flex-col bg-muted/30">
    <div aria-hidden className="gold-rule" />
    <main className="flex flex-1 items-center justify-center px-4 py-5">
      <div className="w-full max-w-md">
        <img src="/gold-star-logo.png" alt="Gold Star Restoration" className="mx-auto mb-6 h-20 w-auto" />
        <Card>
          <CardHeader><CardTitle>Reset password</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {done ? <p role="status">Your password has been reset. Sign in with your new password.</p>
              : checking ? <p role="status">Checking reset link…</p>
              : !ready ? <p role="alert">This reset link is missing or expired. Request a new link from the sign-in page.</p>
              : <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="confirm-password">Confirm new password</Label><Input id="confirm-password" type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} /></div>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving…" : "Save new password"}</Button>
              </form>}
            <Button asChild variant="outline" className="w-full"><Link to="/auth">Back to sign in</Link></Button>
          </CardContent>
        </Card>
      </div>
    </main>
  </div>;
}