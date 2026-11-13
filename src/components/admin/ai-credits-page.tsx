import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Info, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { MetricStat } from "@/components/metric-stat";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";

/**
 * Settings → AI credits. Gold Star prepays for AI (Polaris, dictation, reading
 * tickets and cards, loss reports…) in credits; 100 credits = $1. Usage, prices
 * and grants are managed from the Falcon Console; this page is where an Owner
 * or Admin sees the balance and buys more.
 *
 * Credits only: never raw provider cost, tokens or markup (the RPC does not
 * return them). Buying goes through Stripe Checkout on the billing Stripe
 * account; credits arrive only when Stripe's webhook confirms the payment.
 */

type Pack = { id: string; price_cents: number; credits: number };
type HistoryRow = {
  id: number;
  at: string;
  kind: "topup" | "adjustment";
  credits: number;
  amount_paid_cents: number | null;
  pack_id: string | null;
  receipt_url: string | null;
  source: string | null;
  reason: string | null;
};
type Overview = {
  month: string;
  balance: number;
  last_topup_credits: number;
  used_this_month: number;
  used_last_month: number;
  packs: Pack[];
  auto_topup: {
    enabled: boolean;
    pack_id: string | null;
    threshold_credits: number | null;
    card_brand: string | null;
    card_last4: string | null;
    pending: boolean;
    failed_at: string | null;
    failure: string | null;
  };
  history: HistoryRow[];
};

// The billing functions are not in the generated Database types.
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (
    supabase.rpc as unknown as (
      f: string,
      a?: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>
  )(fn, args);

const n = (v: number) => Math.round(v).toLocaleString("en-US");
const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const bonus = (p: Pack) => Math.round(((p.credits - p.price_cents) / p.price_cents) * 100);

export function AiCreditsPage({ returned }: { returned?: string }) {
  const qc = useQueryClient();
  const overview = useQuery({
    queryKey: ["ai-credits", "overview"],
    queryFn: async () => {
      const { data, error } = await rpc("ai_credits_overview");
      if (error) throw new Error(error.message);
      return data as Overview;
    },
  });
  const status = useQuery({
    queryKey: ["ai-credits", "status"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("ai-credits", {
        body: { action: "status" },
      });
      if (error) return { enforced: false };
      return data as { enforced: boolean };
    },
  });

  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!returned) return;
    const messages: Record<string, () => void> = {
      "checkout=success": () =>
        toast.success("Payment received. Credits appear here as soon as Stripe confirms it."),
      "checkout=cancelled": () => toast("Checkout cancelled. Nothing was charged."),
      "card=saved": () => toast.success("Card saved. You can now turn on automatic top-up."),
      "card=cancelled": () => toast("No card was saved."),
    };
    messages[returned]?.();
    // A webhook may land a moment after the redirect.
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: ["ai-credits"] }), 4000);
    return () => clearTimeout(t);
  }, [returned, qc]);

  const goToStripe = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      const { data, error } = await supabase.functions.invoke("ai-credits", { body });
      const url = (data as { url?: string } | null)?.url;
      if (error || !url) {
        const ctx = (error as { context?: Response } | null)?.context;
        const msg = ctx
          ? ((await ctx.json().catch(() => null)) as { error?: string } | null)
          : null;
        throw new Error(msg?.error ?? "Stripe could not be opened. Try again in a moment.");
      }
      window.location.assign(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Stripe could not be opened.");
      setBusy(null);
    }
  };

  if (overview.isLoading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading AI credits…</div>;
  }
  if (overview.error || !overview.data) {
    const denied = /not permitted/i.test(String(overview.error?.message));
    return (
      <Alert variant={denied ? "warning" : "destructive"}>
        <TriangleAlert />
        <AlertTitle>
          {denied ? "Owners and Admins only" : "AI credits could not be loaded"}
        </AlertTitle>
        <AlertDescription>
          {denied
            ? "Only an Owner, Admin or Developer can see and buy AI credits."
            : String(overview.error?.message ?? "Try again in a moment.")}
        </AlertDescription>
      </Alert>
    );
  }

  const o = overview.data;
  const low = o.last_topup_credits > 0 && o.balance <= o.last_topup_credits * 0.25;

  return (
    <div className="space-y-4">
      {o.balance <= 0 ? (
        <Alert variant={status.data?.enforced ? "destructive" : "warning"}>
          <TriangleAlert />
          <AlertTitle>No AI credits left</AlertTitle>
          <AlertDescription>
            {status.data?.enforced
              ? "AI features are paused until credits are added. Buy a pack below."
              : "AI keeps working for now, but usage is being counted. Buy a pack below to stay ahead."}
          </AlertDescription>
        </Alert>
      ) : low ? (
        <Alert variant="warning">
          <Info />
          <AlertTitle>Credits are running low</AlertTitle>
          <AlertDescription>Less than a quarter of the last top-up is left.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricStat
          value={n(o.balance)}
          label="Credits left"
          tone={o.balance <= 0 ? "danger" : low ? "warning" : "default"}
          hint={`about ${usd(Math.max(o.balance, 0))}`}
        />
        <MetricStat value={n(o.used_this_month)} label="Used this month" />
        <MetricStat value={n(o.used_last_month)} label="Used last month" />
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Buy credits</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {o.packs.map((p) => (
            <div key={p.id} className="flex flex-col gap-2 rounded-xl border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xl font-semibold tabular-nums">{n(p.credits)}</span>
                {bonus(p) > 0 && <Badge variant="secondary">+{bonus(p)}%</Badge>}
              </div>
              <span className="text-sm text-muted-foreground">
                credits for {usd(p.price_cents)}
              </span>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void goToStripe({ action: "checkout", pack_id: p.id }, p.id)}
              >
                <Sparkles className="size-4" />
                {busy === p.id ? "Opening Stripe…" : "Buy"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <AutoTopupCard
        overview={o}
        busy={busy}
        onSaveCard={() => void goToStripe({ action: "setup_card" }, "card")}
      />

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Top-up history</CardTitle>
        </CardHeader>
        <CardContent>
          {o.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No top-ups yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {o.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {new Date(h.at).toLocaleDateString("en-US", { dateStyle: "medium" })} ·{" "}
                    {h.kind === "topup"
                      ? h.source === "auto_topup"
                        ? "Automatic top-up"
                        : "Pack bought"
                      : (h.reason ?? "Adjustment by Falcon")}
                  </span>
                  <span className="flex items-center gap-3 tabular-nums">
                    <span className={h.credits < 0 ? "text-destructive" : undefined}>
                      {h.credits > 0 ? "+" : ""}
                      {n(h.credits)} credits
                    </span>
                    {h.amount_paid_cents ? <span>{usd(h.amount_paid_cents)}</span> : null}
                    {h.receipt_url ? (
                      <a
                        className="underline"
                        href={h.receipt_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Receipt
                      </a>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AutoTopupCard({
  overview: o,
  busy,
  onSaveCard,
}: {
  overview: Overview;
  busy: string | null;
  onSaveCard: () => void;
}) {
  const qc = useQueryClient();
  const a = o.auto_topup;
  const [enabled, setEnabled] = useState(a.enabled);
  const [pack, setPack] = useState(a.pack_id ?? o.packs[0]?.id ?? "");
  const [threshold, setThreshold] = useState<number | null>(a.threshold_credits ?? 2000);
  const [saving, setSaving] = useState(false);
  const hasCard = Boolean(a.card_last4);

  const save = async () => {
    setSaving(true);
    const { error } = await rpc("ai_credits_set_auto_topup", {
      p_enabled: enabled,
      p_pack_id: pack || null,
      p_threshold_credits: threshold,
    });
    setSaving(false);
    if (error) return void toast.error(error.message);
    toast.success(enabled ? "Automatic top-up is on" : "Automatic top-up is off");
    void qc.invalidateQueries({ queryKey: ["ai-credits"] });
  };

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Automatic top-up</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {a.failed_at && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>The last automatic top-up failed</AlertTitle>
            <AlertDescription>
              {a.failure ?? "The card was declined"}. Save a card again to turn it back on.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <CreditCard className="size-4 text-muted-foreground" />
          {hasCard ? (
            <span>
              {a.card_brand ?? "Card"} ending {a.card_last4}
            </span>
          ) : (
            <span className="text-muted-foreground">No card saved</span>
          )}
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={onSaveCard}>
            {busy === "card" ? "Opening Stripe…" : hasCard ? "Replace card" : "Save a card"}
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-2">
            <Switch
              id="ai-auto"
              checked={enabled}
              disabled={!hasCard}
              onCheckedChange={setEnabled}
            />
            <Label htmlFor="ai-auto">Top up automatically</Label>
          </div>
          <div className="space-y-1">
            <Label>When credits drop below</Label>
            <NumberInput value={threshold} decimals={0} onValueChange={(v) => setThreshold(v)} />
          </div>
          <div className="space-y-1">
            <Label>Buy this pack</Label>
            <Select value={pack} onValueChange={setPack}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a pack" />
              </SelectTrigger>
              <SelectContent>
                {o.packs.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {n(p.credits)} credits for {usd(p.price_cents)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button size="sm" disabled={saving || !hasCard} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
