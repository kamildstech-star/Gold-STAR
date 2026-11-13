import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { toastDbError } from "@/lib/db-errors";
import {
  fetchLocationBillRate,
  listClientLaborRates,
  removeClientLaborRate,
  setClientLaborRate,
  setLocationBillRate,
} from "@/lib/labour-bill-rates";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";

/**
 * The labor CHARGE cards — what an hour is charged at each office, and a
 * client's own agreed rate. Billing & Costs › Client Agreements shows them
 * until prompt 4 rebuilds that tab.
 *
 * History: these were the Labor tab of Settings › Cost rates (23 Oct), beside
 * "Cost rate — what the crew is paid". That cost card, and this table's Labor
 * cost column, were replaced in prompt 3 by the overhead engine (Billing &
 * Costs › Cost), which publishes the crew wage into labour_rates itself.
 */
export function LaborChargeCards() {
  return (
    <div className="space-y-3">
      <BillRateCard />
      <ClientRatesCard />
    </div>
  );
}

/**
 * The location's BILL rate — what an hour is charged on an invoice.
 *
 * David, 13 Oct: two labour rates per location, cost ($45, above) and bill
 * ($65, here). "Pull from job" prices the invoice's labour line at this rate
 * (hours × bill rate); a customer with their own agreed rate on a price list
 * still gets theirs. Stored as the labour item on the location's branch price
 * list — see src/lib/labour-bill-rates.ts.
 */
function BillRateCard() {
  const app = useAppContext();
  const qc = useQueryClient();
  // Every office the admin can see, not only the one in the switcher (Mark,
  // 22 Oct: the charge was hidden behind "Pick one location").
  const offices = app.visibleLocations;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [allDraft, setAllDraft] = useState("");
  const ratesQ = useQuery({
    queryKey: ["labor-bill-rate", "all", offices.map((o) => o.id).join(",")],
    enabled: offices.length > 0,
    queryFn: async () =>
      Object.fromEntries(
        await Promise.all(
          offices.map(
            async (o) => [o.id, await fetchLocationBillRate(o.id).catch(() => null)] as const,
          ),
        ),
      ),
  });

  const save = useMutation({
    mutationFn: async (input: { ids: string[]; rate: number }) => {
      if (!(input.rate > 0)) throw new Error("Enter an hourly charge rate.");
      for (const id of input.ids) {
        await setLocationBillRate({
          locationId: id,
          locationName: offices.find((o) => o.id === id)?.name ?? null,
          rate: input.rate,
          userId: app.userId ?? null,
        });
      }
    },
    onSuccess: (_, input) => {
      toast.success(
        input.ids.length === 1
          ? "Charge rate saved"
          : `Charge rate saved for ${input.ids.length} offices`,
        { description: "New invoice labor lines and the job ledger's Labor Charge use it." },
      );
      setDrafts({});
      setAllDraft("");
      void qc.invalidateQueries({ queryKey: ["labor-bill-rate"] });
      void qc.invalidateQueries({ queryKey: ["job-ledger-labor-charge"] });
    },
    onError: (e) =>
      e instanceof Error && !("code" in e)
        ? toast.error(e.message)
        : toastDbError(e, { action: "Save the charge rate" }),
  });

  const rates = ratesQ.data ?? {};
  const sourceText = (id: string) => {
    const r = rates[id];
    if (!r) return "";
    return r.source === "location"
      ? "set for this office"
      : r.source === "catalog"
        ? "catalog default — not set for this office"
        : "standard rate — not set for this office";
  };

  return (
    <Card data-charge-rate>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Labor charge rate by office</CardTitle>
        <p className="text-xs text-muted-foreground">
          <b>What the customer is billed</b> per hour: invoice labor lines (Field items) are hours ×
          this rate, and the job ledger&rsquo;s <b>Labor Charge</b> shows it. A customer with their
          own price list keeps their agreed rate. What an hour <i>costs</i> is in Billing &amp;
          Costs › Cost (overhead engine).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {offices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No offices to set a rate for.</p>
        ) : ratesQ.isError ? (
          <p className="text-sm text-destructive">The charge rates could not be read.</p>
        ) : (
          <>
            <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-sm border">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Office</th>
                    <th className="px-2 py-1.5 font-medium">Labor rate — charged (USD/hr)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {offices.map((o) => (
                    <tr key={o.id}>
                      <td className="px-2 py-1.5">
                        {o.code} · {o.name}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="mb-1">
                          <span className="font-mono font-semibold">
                            {rates[o.id] ? `$${rates[o.id]!.rate.toFixed(2)}/hr` : "…"}
                          </span>{" "}
                          <span className="text-xs text-muted-foreground">{sourceText(o.id)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <NumberInput
                            className="w-[110px]"
                            decimals={2}
                            aria-label={`New charge rate for ${o.name}`}
                            value={drafts[o.id] ?? ""}
                            onValueChange={(_, clean) =>
                              setDrafts((d) => ({ ...d, [o.id]: clean }))
                            }
                            placeholder="65.00"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={save.isPending || app.writesDisabled || !drafts[o.id]}
                            onClick={() => save.mutate({ ids: [o.id], rate: Number(drafts[o.id]) })}
                          >
                            Save
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label className="text-xs">Same charge rate for every office above</Label>
                <NumberInput
                  className="w-[140px]"
                  decimals={2}
                  value={allDraft}
                  onValueChange={(_, clean) => setAllDraft(clean)}
                  placeholder="65.00"
                />
              </div>
              <Button
                disabled={save.isPending || app.writesDisabled || !allDraft}
                onClick={() =>
                  save.mutate({ ids: offices.map((o) => o.id), rate: Number(allDraft) })
                }
              >
                {save.isPending ? "Saving…" : `Apply to all ${offices.length} offices`}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Changing it re-prices new invoice lines only; lines already on an invoice keep their
              price.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A client's own agreed hourly charge (David, 23 Oct: "different rates for
 * different locations and clients"). Wins over the office's charge rate on
 * their invoices and in the job ledger. Stored in the client's price list —
 * see setClientLaborRate.
 */
function ClientRatesCard() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [client, setClient] = useState<PickedAccount | null>(null);
  const [draft, setDraft] = useState("");
  const listQ = useQuery({ queryKey: ["client-labor-rates"], queryFn: listClientLaborRates });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["client-labor-rates"] });
    void qc.invalidateQueries({ queryKey: ["job-ledger-labor-charge"] });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("Pick a client first.");
      await setClientLaborRate({
        accountId: client.id,
        accountName: client.name,
        rate: Number(draft),
        userId: app.userId ?? null,
      });
    },
    onSuccess: () => {
      toast.success(`Rate saved for ${client?.name ?? "the client"}`, {
        description: "Their new invoices and job ledgers use it instead of the office rate.",
      });
      setDraft("");
      setClient(null);
      refresh();
    },
    onError: (e) =>
      e instanceof Error && !("code" in e)
        ? toast.error(e.message)
        : toastDbError(e, { action: "Save the client rate" }),
  });
  const remove = useMutation({
    mutationFn: (priceListId: string) => removeClientLaborRate(priceListId),
    onSuccess: () => {
      toast.success("Client rate removed — the office rate applies again");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "Remove the client rate" }),
  });

  const rows = listQ.data ?? [];
  return (
    <Card data-client-rates>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Client rates — a client&rsquo;s own agreed charge</CardTitle>
        <p className="text-xs text-muted-foreground">
          For a client with their own agreed hourly rate. It wins over the office&rsquo;s charge
          rate on that client&rsquo;s invoices and job ledgers. Other agreed prices (supplies,
          equipment) are kept in Settings › Price lists.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[240px] flex-1">
            <AccountPicker
              value={client}
              onChange={setClient}
              label="Client"
              disabled={app.writesDisabled}
            />
          </div>
          <div>
            <Label className="text-xs">Their rate (USD/hr)</Label>
            <NumberInput
              className="w-[140px]"
              decimals={2}
              value={draft}
              onValueChange={(_, clean) => setDraft(clean)}
              placeholder="60.00"
            />
          </div>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || app.writesDisabled || !client || !draft}
          >
            {save.isPending ? "Saving…" : "Save client rate"}
          </Button>
        </div>
        {listQ.isError ? (
          <p className="text-sm text-destructive">Client rates could not be read.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No client has their own rate yet — every client is charged their office&rsquo;s rate.
          </p>
        ) : (
          <ul className="divide-y rounded-sm border text-sm">
            {rows.map((r) => (
              <li key={r.accountId} className="flex items-center justify-between gap-2 px-2 py-1.5">
                <span className="min-w-0 truncate">{r.accountName}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono font-semibold">${r.rate.toFixed(2)}/hr</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={remove.isPending || app.writesDisabled}
                    onClick={() => remove.mutate(r.priceListId)}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
