import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { PortalNotice } from "@/components/portal/portal-shell";
import {
  TurnstileWidget,
  turnstileEnabled,
  type TurnstileHandle,
} from "@/components/turnstile-widget";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { beginSignIn } from "@/lib/auth-guard.functions";
import { isPortalUser } from "@/lib/portal";

export const Route = createFileRoute("/portal/sign-in")({
  component: PortalSignIn,
});

/**
 * Sign-in for customers who already accepted an invitation. There is no
 * "create an account" here, and there never will be: a customer exists only
 * because staff invited them. The per-account brute-force gate and the CAPTCHA
 * are the staff sign-in's own.
 */
function PortalSignIn() {
  const navigate = useNavigate();
  const gateSignIn = useServerFn(beginSignIn);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle | null>(null);
  const [staffSession, setStaffSession] = useState(false);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      if (isPortalUser(data.user)) navigate({ to: "/portal" });
      else if (data.user) setStaffSession(true);
    });
  }, [navigate]);

  if (staffSession) {
    return (
      <PortalNotice title="You're signed in with a staff account">
        <p>The customer portal is for customers. Staff use Recovery Hub.</p>
        <div className="mt-3 flex justify-center gap-2">
          <Button variant="outline" onClick={() => navigate({ to: "/" })}>
            Go to Recovery Hub
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await supabase.auth.signOut();
              setStaffSession(false);
            }}
          >
            Sign out
          </Button>
        </div>
      </PortalNotice>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    if (turnstileEnabled() && !captchaToken) {
      toast.error("Please complete the human check first.");
      return;
    }
    setBusy(true);
    try {
      const gate = await gateSignIn({ data: { email } });
      if (!gate.allowed) {
        const minutes = Math.ceil(gate.retryAfterSeconds / 60);
        throw new Error(
          `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      }
      if (gate.delayMs > 0) await new Promise((r) => setTimeout(r, gate.delayMs));
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: captchaToken ? { captchaToken } : undefined,
      });
      if (error) throw error;
      // A staff sign-in typed into the customer form is not let in here.
      if (!isPortalUser(data.user)) {
        await supabase.auth.signOut();
        throw new Error("This sign-in is for customers. Staff sign in to Recovery Hub.");
      }
      navigate({ to: "/portal" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      turnstile.current?.reset();
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mx-auto max-w-sm space-y-4 rounded-xl border bg-card p-6"
    >
      <div>
        <h1 className="text-[18px] font-semibold">Sign in</h1>
        <p className="text-[13px] text-muted-foreground">
          Use the email your Gold Star contact invited and the password you set.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portal-email">Email</Label>
        <Input
          id="portal-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portal-password">Password</Label>
        <Input
          id="portal-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <TurnstileWidget onToken={setCaptchaToken} handleRef={turnstile} />
      <Button type="submit" className="w-full" disabled={busy || !email || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-[12px] text-muted-foreground">
        Forgot your password, or no invitation? Ask your Gold Star contact to send you a new
        invitation.
      </p>
    </form>
  );
}
