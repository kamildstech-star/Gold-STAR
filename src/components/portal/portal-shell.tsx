/**
 * The customer portal's own frame. Deliberately not the staff AppShell: no
 * sidebar, no office switcher, no search, no app context — nothing that would
 * go and ask the database a staff question on a customer's behalf. It knows
 * the session and the brand, and that is all.
 */
import * as React from "react";
import { Link, redirect, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { isPortalUser } from "@/lib/portal";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * For every customer page's beforeLoad. No session, or a staff session, goes
 * to the portal sign-in, which explains the second case rather than bouncing.
 */
export async function requirePortalCustomer() {
  const { data } = await supabase.auth.getUser();
  if (!data.user || !isPortalUser(data.user)) {
    throw redirect({ to: "/portal/sign-in" });
  }
  return { user: data.user };
}

export function PortalShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [signedIn, setSignedIn] = React.useState(false);

  React.useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSignedIn(isPortalUser(data.session?.user));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(isPortalUser(session?.user));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/portal/sign-in" });
  };

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/portal" className="min-w-0">
            <span className="block truncate text-[15px] font-semibold">Gold Star Restoration</span>
            <span className="block text-[12px] text-muted-foreground">Customer portal</span>
          </Link>
          {signedIn && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void signOut()}>
              <LogOut className="size-4" />
              Sign out
            </Button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
    </div>
  );
}

/** Two decimals, because an invoice line is money to the cent. */
export function portalMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function portalDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(DATE_LOCALE, US_DATE);
}

export function PortalNotice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-6 text-center">
      <p className="text-[15px] font-semibold">{title}</p>
      {children && <div className="mt-1 text-[13px] text-muted-foreground">{children}</div>}
    </div>
  );
}
