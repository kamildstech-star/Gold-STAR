/**
 * The signed-in user's own two-factor settings, and their own Outlook
 * connection.
 *
 * Opt-in by design: whether MFA becomes mandatory is Gold Star's call, not
 * ours. See src/lib/mfa.ts for what that would take.
 *
 * `?outlook=<outcome>` is where /api/auth/microsoft/callback lands a person
 * after Microsoft's sign-in. Only the fixed codes in OUTLOOK_OUTCOME_MESSAGES
 * are kept; anything else in the URL is dropped before it reaches the page.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { KeyRound, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { MfaCodeInput } from "@/components/mfa-code-input";
import { OutlookConnectionCard } from "@/components/outlook-connection-card";
import { LoadError } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OUTLOOK_OUTCOME_MESSAGES } from "@/lib/outlook-connect-outcomes";
import {
  confirmMfaEnrolment,
  listMfaFactors,
  removeMfaFactor,
  startMfaEnrolment,
  type MfaEnrolment,
} from "@/lib/mfa";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/security")({
  head: () => ({
    meta: [
      { title: "Security — Recovery Hub" },
      { name: "description", content: "Two-factor authentication for your Recovery Hub account." },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { outlook?: string } => {
    const outlook = typeof search.outlook === "string" ? search.outlook : undefined;
    return outlook && outlook in OUTLOOK_OUTCOME_MESSAGES ? { outlook } : {};
  },
  component: SecurityPage,
});

function SecurityPage() {
  const qc = useQueryClient();
  const { outlook } = Route.useSearch();
  const navigate = useNavigate();
  // Shown once, then gone from the URL, so a refresh does not toast it again.
  const clearOutlookOutcome = useCallback(() => {
    void navigate({ to: "/security", search: {}, replace: true });
  }, [navigate]);
  const [enrolment, setEnrolment] = useState<MfaEnrolment | null>(null);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("Authenticator app");

  const factorsQ = useQuery({ queryKey: ["mfa-factors"], queryFn: listMfaFactors, retry: false });

  const start = useMutation({
    mutationFn: () => startMfaEnrolment(deviceName.trim() || "Authenticator app"),
    onSuccess: (data) => {
      setEnrolment(data);
      setCode("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const confirm = useMutation({
    mutationFn: () => confirmMfaEnrolment(enrolment!.factorId, code),
    onSuccess: async () => {
      setEnrolment(null);
      setCode("");
      await qc.invalidateQueries({ queryKey: ["mfa-factors"] });
      toast.success("Two-factor authentication is on.");
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setCode("");
    },
  });

  const remove = useMutation({
    mutationFn: (factorId: string) => removeMfaFactor(factorId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mfa-factors"] });
      toast.success("Two-factor authentication removed.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const factors = factorsQ.data ?? [];
  const verified = factors.filter((f) => f.status === "verified");
  const pending = factors.filter((f) => f.status === "unverified");

  return (
    <div className="mx-auto max-w-2xl space-y-3 p-3">
      <div>
        <h1 className="display-heavy text-[17px] uppercase tracking-[0.05em]">Security</h1>
        <p className="text-sm text-muted-foreground">
          A password alone is one stolen laptop away from someone else reading every claim, check
          image and payroll hour in here.
        </p>
      </div>

      {factorsQ.isError ? (
        /* A read that failed is not an account with no factor. Saying "off" here
           would invite someone to enrol a second one and confuse themselves. */
        <LoadError
          what="your two-factor settings"
          error={factorsQ.error as Error}
          onRetry={() => void factorsQ.refetch()}
        />
      ) : factorsQ.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[15px]">
              {verified.length > 0 ? (
                <ShieldCheck className="size-4 text-emerald-700 dark:text-emerald-400" />
              ) : (
                <ShieldOff className="size-4 text-muted-foreground" />
              )}
              Authenticator app
              <Badge variant={verified.length > 0 ? "default" : "secondary"}>
                {verified.length > 0 ? "On" : "Off"}
              </Badge>
            </CardTitle>
            <CardDescription>
              A six-digit code from an app on your phone — Google Authenticator, 1Password, Authy,
              Microsoft Authenticator. Asked for once per sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {verified.map((f) => (
              <div key={f.id} className="flex items-center justify-between rounded-md border p-3">
                <div className="text-sm">
                  <div className="font-medium">{f.friendlyName || "Authenticator"}</div>
                  <div className="text-xs text-muted-foreground">
                    Added{" "}
                    {f.createdAt
                      ? new Date(f.createdAt).toLocaleDateString(DATE_LOCALE, US_DATE)
                      : "—"}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(f.id)}
                >
                  Turn off
                </Button>
              </div>
            ))}

            {pending.length > 0 && !enrolment && (
              <div className="flex items-center justify-between rounded-md border border-dashed p-3">
                <div className="text-sm">
                  <div className="font-medium">Setup was not finished</div>
                  <div className="text-xs text-muted-foreground">
                    Clear it to start again with a fresh code.
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(pending[0].id)}
                >
                  Clear
                </Button>
              </div>
            )}

            {enrolment ? (
              <div className="space-y-3">
                <div className="flex justify-center rounded-md border bg-white p-3">
                  {/* Supabase hands back the QR as an SVG data URL, so there is
                      no QR library in this app and nothing to keep patched. */}
                  <img
                    src={enrolment.qrCode}
                    alt="Scan this QR code with your authenticator app"
                    className="size-44"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-secret">Or type this key in by hand</Label>
                  <Input
                    id="mfa-secret"
                    readOnly
                    value={enrolment.secret}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Enter the code the app shows</Label>
                  <MfaCodeInput
                    value={code}
                    onChange={setCode}
                    onComplete={() => confirm.mutate()}
                    disabled={confirm.isPending}
                    autoFocus
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => confirm.mutate()}
                    disabled={code.length !== 6 || confirm.isPending}
                  >
                    Turn on two-factor
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEnrolment(null);
                      setCode("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : verified.length === 0 ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="device-name">Name this device</Label>
                  <Input
                    id="device-name"
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    maxLength={60}
                  />
                </div>
                <Button onClick={() => start.mutate()} disabled={start.isPending}>
                  <KeyRound className="mr-2 size-4" />
                  Set up two-factor
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <OutlookConnectionCard outcome={outlook} onOutcomeShown={clearOutlookOutcome} />

      <Card className="border-amber-500/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[15px]">
            <TriangleAlert className="size-4 text-amber-700 dark:text-amber-400" />
            If you lose your phone
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">There are no backup codes.</strong> Supabase Auth
            does not issue them, so nothing you can print or save now will get you back in.
          </p>
          <p>
            The only way back is an owner or administrator removing the factor from your account
            (Admin → Security). That takes seconds, but it needs a person who is awake — worth
            knowing before a 3am callout.
          </p>
          <p>
            Before you replace a phone, come here first and turn two-factor off, then set it up
            again on the new one. That is the difference between a two-minute job and a phone call
            to your manager.
          </p>
          <p>
            Enrolling on two devices — your phone and a desktop password manager — costs nothing and
            removes the problem entirely.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
