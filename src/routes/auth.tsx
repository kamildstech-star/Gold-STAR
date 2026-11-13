import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { z } from "zod";

import { InstallHint, IosInstallSheetHost } from "@/components/install-prompt";
import { MfaCodeInput } from "@/components/mfa-code-input";
import {
  TurnstileWidget,
  turnstileEnabled,
  type TurnstileHandle,
} from "@/components/turnstile-widget";
import { beginSignIn, endSignIn } from "@/lib/auth-guard.functions";
import { mfaGateForSession, verifyMfaChallenge, type MfaGate } from "@/lib/mfa";
import { safeAuthNext } from "@/lib/auth-next";
import { browserAuthProvider, oauthErrorFromUrl, supabaseOAuthRedirect } from "@/lib/auth-provider";

type Search = { next?: string };

export const Route = createFileRoute("/auth")({
  // Entirely client-driven (reads the Supabase session on mount), so skip SSR
  // for this route rather than hydrating a tree the server can't produce.
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in · Recovery Hub" },
      {
        name: "description",
        content: "Sign in to Recovery Hub — Gold Star Restoration's operations platform.",
      },
      { property: "og:title", content: "Sign in · Recovery Hub" },
      { property: "og:description", content: "Sign in to Recovery Hub." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    next: typeof raw.next === "string" ? raw.next : undefined,
  }),
  component: AuthPage,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function AuthPage() {
  const navigate = useNavigate();
  const { next } = useSearch({ from: "/auth" });
  const target = safeAuthNext(next);
  const gateSignIn = useServerFn(beginSignIn);
  const clearSignInCounters = useServerFn(endSignIn);

  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [resetSent, setResetSent] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle | null>(null);
  const [mfa, setMfa] = useState<Extract<MfaGate, { required: true }> | null>(null);

  // If already signed in, bounce out — unless a second factor is still owed,
  // in which case land on the challenge rather than ping-ponging with the
  // _authenticated guard, which sends that same session straight back here.
  useEffect(() => {
    let cancelled = false;
    // Supabase's Google round trip reports a failure in the URL it sends us
    // back to; say what it said instead of silently showing the form again.
    const oauthError =
      browserAuthProvider() === "supabase" ? oauthErrorFromUrl(window.location.href) : null;
    if (oauthError) toast.error(`Google sign-in failed: ${oauthError}`);
    void supabase.auth
      .getSession()
      .then(async ({ data, error }) => {
        if (error) throw error;
        if (!data.session) return;
        const gate = await mfaGateForSession();
        if (cancelled) return;
        if (gate.required) setMfa(gate);
        else await navigate({ to: target });
      })
      .catch(() => {
        if (!cancelled)
          toast.error("Your sign-in security could not be verified. Please sign in again.");
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, target]);

  /**
   * A password is only half of a sign-in for anyone enrolled in MFA. Land on
   * the challenge instead of the app, and never call it done until the session
   * is actually at aal2 — the counters are only cleared once it is.
   */
  const finishSignIn = async () => {
    const gate = await mfaGateForSession();
    if (gate.required) {
      setMfa(gate);
      return;
    }
    // Best effort: the sign-in worked, so a failure to clear the counter must
    // not become a failure to sign in.
    void clearSignInCounters().catch(() => {});
    navigate({ to: target });
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const schema = z.object({
        email: z.string().email("Enter a valid email"),
        password: mode === "forgot" ? z.string() : z.string().min(8, "Password must be at least 8 characters"),
      });
      const parsed = schema.safeParse({ email, password });
      if (!parsed.success) {
        toast.error(parsed.error.issues[0].message);
        return;
      }
      if (turnstileEnabled() && !captchaToken) {
        toast.error("Please complete the human check first.");
        return;
      }
      // Supabase verifies this token itself when CAPTCHA protection is enabled
      // on the project; the app never holds the secret key.
      const options = captchaToken ? { captchaToken } : undefined;

      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
          ...options,
        });
        if (error) throw error;
        setResetSent(true);
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            ...options,
            emailRedirectTo: `${window.location.origin}${target}`,
            data: { full_name: fullName || undefined },
          },
        });
        if (error) throw error;
        toast.success("Check your email to confirm your account.");
      } else {
        const gate = await gateSignIn({ data: { email } });
        if (!gate.allowed) {
          const minutes = Math.ceil(gate.retryAfterSeconds / 60);
          throw new Error(
            `Too many sign-in attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}, or use "Continue with Google".`,
          );
        }
        // Progressive stall. Free for someone who mistyped once, and by the
        // fifth attempt slow enough that guessing serially is not worth doing.
        if (gate.delayMs > 0) await wait(gate.delayMs);

        const { error } = await supabase.auth.signInWithPassword({ email, password, options });
        if (error) throw error;
        await finishSignIn();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      // A Turnstile token is single-use, so a retry needs a fresh challenge.
      turnstile.current?.reset();
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setBusy(true);
    try {
      if (browserAuthProvider() === "supabase") {
        // Off Lovable: a top-level redirect through Supabase Auth. The session
        // comes back in the URL and the effect above picks it up — MFA gate
        // included — so there is nothing more to do here unless it failed.
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: supabaseOAuthRedirect(window.location.origin, target) },
        });
        if (error) toast.error(error.message || "Google sign-in failed");
        return;
      }
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        toast.error(result.error.message || "Google sign-in failed");
        return;
      }
      if (result.redirected) return;
      // Popup path: session set. Still only aal1, so the MFA gate applies here
      // exactly as it does to a password sign-in.
      await finishSignIn();
    } finally {
      setBusy(false);
    }
  };

  if (mfa) {
    return (
      <MfaChallengePanel
        factorId={mfa.factorId}
        friendlyName={mfa.friendlyName}
        onVerified={() => {
          void clearSignInCounters().catch(() => {});
          navigate({ to: target });
        }}
        onCancel={async () => {
          // Leaving the challenge must leave no half-authenticated aal1 session
          // sitting in this browser for the next person on the tab.
          await supabase.auth.signOut();
          setMfa(null);
          setPassword("");
        }}
      />
    );
  }

  /*
   * svh, and a smaller logo on a phone: `min-h-screen` is iOS's LARGE
   * viewport, and a 96px logo with 32px under it put Sign in below the fold
   * of a 375×667 iPhone — the first screen a crew member ever sees.
   */
  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <div aria-hidden className="gold-rule" />
      <div className="flex flex-1 items-center justify-center px-4 py-5">
        <div className="w-full max-w-md">
          <div className="mb-4 flex flex-col items-center gap-3 sm:mb-8">
            <img
              src="/gold-star-logo.png"
              alt="Gold Star Restoration"
              className="h-16 w-auto sm:h-24"
            />
            <div className="display-heavy text-center text-[15px] uppercase tracking-[0.06em]">
              #1 Choice For Property Damage Restoration
            </div>
            <div className="label-caps text-muted-foreground">Recovery Hub</div>
          </div>
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="display-heavy text-[17px] uppercase tracking-[0.05em]">
                {mode === "forgot" ? "Reset password" : mode === "signin" ? "Sign in" : "Create account"}
              </CardTitle>
              <CardDescription>
                {mode === "forgot" ? "Enter your account email to receive a reset link." : mode === "signin" ? "Sign in to continue." : "Create your account."}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleGoogle}
                disabled={busy}
              >
                Continue with Google
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>

              <form onSubmit={handleEmail} className="space-y-3">
                {mode === "forgot" && resetSent && <p role="status" className="text-sm">If an account exists for this email, a reset link has been sent. Check your inbox and spam folder.</p>}
                {mode === "signup" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="name">Full name</Label>
                    <Input
                      id="name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      autoComplete="name"
                    />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                  />
                </div>
                {mode !== "forgot" && <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  />
                </div>}
                <TurnstileWidget onToken={setCaptchaToken} handleRef={turnstile} />
                <Button type="submit" className="w-full" disabled={busy}>
                  {mode === "forgot" ? "Send reset link" : mode === "signup" ? "Create account" : "Sign in"}
                </Button>
              </form>

              {mode === "signin" && <Button type="button" variant="link" className="w-full" onClick={() => { setMode("forgot"); setPassword(""); setResetSent(false); }}>Forgot password?</Button>}
              {mode === "forgot" && <Button type="button" variant="link" className="w-full" onClick={() => setMode("signin")}>Back to sign in</Button>}

              <div className="text-center text-sm text-muted-foreground">
                {mode === "signin" ? (
                  <>
                    No account?{" "}
                    <button
                      type="button"
                      className="text-foreground underline-offset-4 hover:underline"
                      onClick={() => setMode("signup")}
                    >
                      Create one
                    </button>
                  </>
                ) : (
                  <>
                    Have an account?{" "}
                    <button
                      type="button"
                      className="text-foreground underline-offset-4 hover:underline"
                      onClick={() => setMode("signin")}
                    >
                      Sign in
                    </button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
          {/* Install before signing in: on iPhone that is one sign-in, not two. */}
          <InstallHint />
          <IosInstallSheetHost />
          <a
            href="tel:+18779592837"
            className="emergency-bar mt-4 text-[12px] font-semibold uppercase tracking-[0.06em] flex items-center justify-center px-3 py-2"
          >
            Emergency? Call 1-877-95-WATER now
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * The second-factor step. Reached only when the session Supabase just issued
 * is at aal1 and the account has a verified factor, so nobody who has not
 * opted in ever sees it.
 */
function MfaChallengePanel({
  factorId,
  friendlyName,
  onVerified,
  onCancel,
}: {
  factorId: string;
  friendlyName: string | null;
  onVerified: () => void;
  onCancel: () => void | Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    try {
      await verifyMfaChallenge(factorId, code);
      onVerified();
    } catch (err) {
      // Supabase runs its own limit here — 15 challenge/verify calls a minute
      // per IP — so a wrong code costs nothing but the retry.
      toast.error(err instanceof Error ? err.message : "That code was not accepted");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <div aria-hidden className="gold-rule" />
      <div className="flex flex-1 items-center justify-center px-4 py-5">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center gap-3">
            <img src="/gold-star-logo.png" alt="Gold Star Restoration" className="h-24 w-auto" />
            <div className="label-caps text-muted-foreground">Recovery Hub</div>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="display-heavy text-[17px] uppercase tracking-[0.05em]">
                Two-factor code
              </CardTitle>
              <CardDescription>
                Open {friendlyName || "your authenticator app"} and enter the six-digit code.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-center">
                <MfaCodeInput
                  value={code}
                  onChange={setCode}
                  onComplete={submit}
                  disabled={busy}
                  autoFocus
                />
              </div>
              <Button className="w-full" onClick={submit} disabled={busy || code.length !== 6}>
                Verify
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Lost your phone? There are no backup codes — ask an owner or administrator to reset
                two-factor on your account from Admin → Security.
              </p>
              <Button variant="ghost" className="w-full" onClick={() => void onCancel()}>
                Back to sign in
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
