import type { ReactNode } from "react";
import { Clock, ShieldX } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";

/**
 * New signups land as `pending` with no role. Until an admin approves them
 * they see this screen and nothing else — the approval gate, not email
 * confirmation, is the control on who gets into the app.
 */
export function ApprovalGate({ children }: { children: ReactNode }) {
  const app = useAppContext();

  if (app.loading || app.approvalStatus === "approved") return <>{children}</>;

  const rejected = app.approvalStatus === "rejected";

  async function signOut() {
    await supabase.auth.signOut();
    window.location.assign("/auth");
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
            {rejected ? (
              <ShieldX className="size-6 text-destructive" />
            ) : (
              <Clock className="size-6 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-1.5">
            <h1 className="font-display text-[17px] font-semibold">
              {rejected ? "Access was not approved" : "Waiting for approval"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {rejected
                ? app.rejectedReason ||
                  "An administrator declined this account. Contact your manager if you think this is a mistake."
                : "Your account was created and an administrator has been notified. You'll get access as soon as they assign your role and office."}
            </p>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{app.email}</p>
          <Button variant="outline" className="w-full" onClick={() => void signOut()}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
