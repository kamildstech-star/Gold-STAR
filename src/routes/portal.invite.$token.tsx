import { useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { PortalNotice, portalDate } from "@/components/portal/portal-shell";
import {
  TurnstileWidget,
  turnstileEnabled,
  type TurnstileHandle,
} from "@/components/turnstile-widget";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PORTAL_MIN_PASSWORD, isPortalUser, portalPasswordProblem } from "@/lib/portal";
import { acceptPortalInvite, peekPortalInvite } from "@/lib/portal.functions";

export const Route = createFileRoute("/portal/invite/$token")({
  component: PortalInvite,
});

const GONE: Record<string, string> = {
  used: "This invitation has already been used. Sign in instead, or ask your Gold Star contact for a new one.",
  expired: "This invitation has expired. Ask your Gold Star contact for a new one.",
  revoked: "This invitation has been replaced or turned off. Use the newest one you were sent.",
  not_found: "This invitation link isn't valid. Check you have the whole link.",
  invalid: "This invitation link isn't valid. Check you have the whole link.",
};

/**
 * Accepting an invitation: the one way a customer ever comes to exist. The
 * link is single-use and expires; the password set here is theirs, and the
 * next visit is an ordinary sign-in.
 */
function PortalInvite() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const peek = useServerFn(peekPortalInvite);
  const accept = useServerFn(acceptPortalInvite);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle | null>(null);

  const q = useQuery({
    queryKey: ["portal", "invite", token],
    queryFn: () => peek({ data: { token } }),
    retry: false,
  });

  if (q.isLoading)
    return <p className="text-[13px] text-muted-foreground">Checking your invitation…</p>;
  if (q.isError)
    return (
      <PortalNotice title="Your invitation could not be checked">
        {q.error instanceof Error ? q.error.message : "Please try again in a minute."}
      </PortalNotice>
    );
  const invite = q.data!;
  if (invite.status !== "ok") {
    return <PortalNotice title="This invitation can't be used">{GONE[invite.status]}</PortalNotice>;
  }

  const problem = password ? portalPasswordProblem(password) : null;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (portalPasswordProblem(password) || password !== confirm) return;
    if (turnstileEnabled() && !captchaToken) {
      toast.error("Please complete the human check first.");
      return;
    }
    setBusy(true);
    try {
      const { email } = await accept({ data: { token, password } });
      // Any other session in this browser (a staff tab, say) goes first, so
      // the portal never runs under the wrong identity.
      await supabase.auth.signOut();
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: captchaToken ? { captchaToken } : undefined,
      });
      if (error) {
        toast.success("Your password is set. Please sign in.");
        navigate({ to: "/portal/sign-in" });
        return;
      }
      if (!isPortalUser(data.user)) {
        await supabase.auth.signOut();
        throw new Error("The customer portal is not available right now.");
      }
      navigate({ to: "/portal" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      void q.refetch();
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
        <h1 className="text-[18px] font-semibold">
          {invite.name ? `Welcome, ${invite.name}` : "Welcome"}
        </h1>
        <p className="text-[13px] text-muted-foreground">
          {invite.returning ? "Set a new password" : "Set a password"} for {invite.emailHint} to see
          what Gold Star Restoration has shared with you. This link works once and expires{" "}
          {portalDate(invite.expiresAt)}.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portal-new-password">Password</Label>
        <Input
          id="portal-new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p
          className={problem ? "text-[12px] text-destructive" : "text-[12px] text-muted-foreground"}
        >
          {problem ?? `At least ${PORTAL_MIN_PASSWORD} characters.`}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portal-confirm-password">Type it again</Label>
        <Input
          id="portal-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch && <p className="text-[12px] text-destructive">The two passwords don't match.</p>}
      </div>
      <TurnstileWidget onToken={setCaptchaToken} handleRef={turnstile} />
      <Button
        type="submit"
        className="w-full"
        disabled={busy || !password || !!problem || password !== confirm}
      >
        {busy ? "Setting up…" : "Continue"}
      </Button>
    </form>
  );
}
