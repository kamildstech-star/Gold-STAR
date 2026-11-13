import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift, ShieldAlert, Send, Coins } from "lucide-react";
import { toast } from "sonner";

import { useDefaultLocationId } from "@/components/location-picker";
import { useAppContext } from "@/components/app-context";
import { EntityPicker, type EntityOption } from "@/components/entity-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadError, PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { toastDbError } from "@/lib/db-errors";

import {
  GIFT_CAMPAIGN_STATUS_LABEL,
  GIFT_DELIVERY_STATUS_LABEL,
  GIFT_OCCASIONS,
  GIFT_OCCASION_LABEL,
  MONTHS,
  fmtCents,
  type GiftOccasion,
} from "@/lib/lifecycle";
import {
  buildCandidates,
  listCampaigns,
  listCatalog,
  listRecipients,
  listSends,
  saveRecipients,
  sendCampaign,
  type Campaign,
  type Candidate,
} from "@/lib/gifts";
import { supabase } from "@/integrations/supabase/client";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const GIFT_OCCASION_OPTS = optionsFrom(GIFT_OCCASIONS, GIFT_OCCASION_LABEL);

export const Route = createFileRoute("/_authenticated/farming/campaigns")({
  head: () => ({
    meta: [
      { title: "Active Clients campaigns · Recovery Hub" },
      {
        name: "description",
        content:
          "Month-batched gift and seasonal sends for farmed accounts, with gift-policy exclusions shown before anything goes out.",
      },
      { property: "og:title", content: "Active Clients campaigns · Recovery Hub" },
      {
        property: "og:description",
        content: "Build a batch, review who is excluded and why, send and track cost.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CampaignsPage,
});

function CampaignsPage() {
  const app = useAppContext();
  const defaultLocationId = useDefaultLocationId();
  const qc = useQueryClient();
  const [selected, setSelected] = React.useState<Campaign | null>(null);

  const campaignsQ = useQuery({ queryKey: ["gift-campaigns"], queryFn: listCampaigns });
  const catalogQ = useQuery({ queryKey: ["gift-catalog"], queryFn: () => listCatalog() });
  const sendsQ = useQuery({ queryKey: ["gift-sends"], queryFn: () => listSends() });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["gift-campaigns"] });
    void qc.invalidateQueries({ queryKey: ["gift-sends"] });
    void qc.invalidateQueries({ queryKey: ["campaign-recipients"] });
  };

  if (campaignsQ.isError) {
    return (
      <LoadError
        what="campaigns"
        error={campaignsQ.error}
        onRetry={() => void campaignsQ.refetch()}
      />
    );
  }

  const campaigns = campaignsQ.data ?? [];
  const sends = sendsQ.data ?? [];
  const totalCostCents = sends.reduce((sum, s) => sum + (s.cost_cents ?? 0), 0);

  return (
    <div className="space-y-3 p-3">
      <PageHeader
        title="Campaigns"
        subtitle="The monthly batch — everyone with a June birthday in one run. Seasonal sends work the same way. Every send writes a touchpoint, so it counts toward the quarterly cadence."
      />

      <MetricStrip
        metrics={[
          { label: "Campaigns", value: campaigns.length.toLocaleString("en-US"), icon: Gift },
          { label: "Gifts sent", value: sends.length.toLocaleString("en-US"), icon: Send },
          { label: "Total cost", value: fmtCents(totalCostCents), icon: Coins },
        ]}
      />

      <NewCampaign
        catalog={catalogQ.data ?? []}
        locationId={defaultLocationId}
        userId={app.userId}
        onCreated={(c) => {
          invalidate();
          setSelected(c);
        }}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Campaigns</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(campaignsQ.data ?? []).length === 0 ? (
            <EmptyRow
              title="No campaigns yet"
              body="A campaign groups everyone due a gift in the same month. Create one above once the catalog has an item and contacts have birthdays recorded."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Occasion</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(campaignsQ.data ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-xs">{GIFT_OCCASION_LABEL[c.occasion]}</TableCell>
                    <TableCell className="text-xs">
                      {c.target_month
                        ? `${MONTHS[c.target_month - 1]} ${c.target_year ?? ""}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{GIFT_CAMPAIGN_STATUS_LABEL[c.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setSelected(c)}
                      >
                        Review list
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {selected && (
        <RecipientReview
          campaign={selected}
          locationId={defaultLocationId}
          userId={app.userId}
          writesDisabled={app.writesDisabled}
          onChanged={invalidate}
        />
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Delivery and cost</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(sendsQ.data ?? []).length === 0 ? (
            <EmptyRow
              title="Nothing sent yet"
              body="Every gift sent from a campaign, or logged from an account, lands here with its cost and delivery status."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sent</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(sendsQ.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-xs">
                      {new Date(s.sent_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                    </TableCell>
                    <TableCell className="text-sm">{s.account?.name ?? "—"}</TableCell>
                    <TableCell className="text-xs">{s.contact?.full_name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{fmtCents(s.cost_cents)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {GIFT_DELIVERY_STATUS_LABEL[s.delivery_status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex gap-3 p-3 text-sm">
      <Gift className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
      <div>
        <div className="font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function NewCampaign({
  catalog,
  locationId,
  userId,
  onCreated,
}: {
  catalog: { id: string; name: string; unit_cost_cents: number; active: boolean }[];
  locationId: string | null;
  userId: string | null;
  onCreated: (c: Campaign) => void;
}) {
  const now = new Date();
  const [name, setName] = React.useState("");
  const [occasion, setOccasion] = React.useState<GiftOccasion>("birthday");
  const [month, setMonth] = React.useState(String(now.getMonth() + 1));
  const [item, setItem] = React.useState<string>("none");
  const [itemOption, setItemOption] = React.useState<EntityOption | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      if (name.trim().length < 2) throw new Error("Name the campaign.");
      const { data, error } = await supabase
        .from("gift_campaigns")
        .insert({
          name: name.trim(),
          occasion,
          status: "draft",
          target_month: Number(month),
          target_year: now.getFullYear(),
          catalog_item_id: item === "none" ? null : item,
          location_id: locationId,
          created_by: userId,
        })
        .select(
          "id, name, occasion, status, target_month, target_year, notes, catalog_item_id, location_id, created_at",
        )
        .single();
      if (error) throw error;
      return data as Campaign;
    },
    onSuccess: (c) => {
      toast.success("Campaign created — review the recipient list");
      setName("");
      onCreated(c);
    },
    onError: (e) => toastDbError(e, { action: "Create campaign" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">New batch</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              className="w-[220px]"
              value={name}
              placeholder="June birthdays"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Occasion</Label>
            <Select value={occasion} onValueChange={(v) => setOccasion(v as GiftOccasion)}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ManagedOptionItems listKey="gift_occasion" fallback={GIFT_OCCASION_OPTS} />
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Batch month</Label>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={m} value={String(i + 1)}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[240px]">
            {/* Catalogue gap used to end the flow here; now the search adds
                the item inline for anyone with the right. */}
            <EntityPicker
              kind="gift_item"
              label="Item"
              placeholder="No item yet"
              value={itemOption}
              onChange={(o) => {
                setItemOption(o);
                setItem(o?.id ?? "none");
              }}
            />
          </div>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RecipientReview({
  campaign,
  locationId,
  userId,
  writesDisabled,
  onChanged,
}: {
  campaign: Campaign;
  locationId: string | null;
  userId: string | null;
  writesDisabled: boolean;
  onChanged: () => void;
}) {
  const qc = useQueryClient();

  const storedQ = useQuery({
    queryKey: ["campaign-recipients", campaign.id],
    queryFn: () => listRecipients(campaign.id),
  });

  const build = useMutation({
    mutationFn: async () => {
      const candidates: Candidate[] = await buildCandidates({
        month: campaign.occasion === "birthday" ? campaign.target_month : null,
        locationId: campaign.location_id ?? locationId,
      });
      await saveRecipients(campaign.id, candidates);
      return candidates;
    },
    onSuccess: (c) => {
      const excluded = c.filter((x) => !x.eligible).length;
      toast.success(`${c.length - excluded} eligible · ${excluded} excluded by gift policy`);
      void qc.invalidateQueries({ queryKey: ["campaign-recipients", campaign.id] });
    },
    onError: (e) => toastDbError(e, { action: "Build recipient list" }),
  });

  const send = useMutation({
    mutationFn: () => sendCampaign(campaign, userId),
    onSuccess: (n) => {
      toast.success(`${n} send${n === 1 ? "" : "s"} recorded — each wrote a touchpoint`);
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "Send campaign" }),
  });

  const rows = storedQ.data ?? [];
  const excluded = rows.filter((r) => r.excluded_reason);
  const approval = rows.filter((r) => !r.excluded_reason && !r.approved);
  const eligible = rows.filter((r) => !r.excluded_reason);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <span>Recipient list — {campaign.name}</span>
          <Badge variant="outline">{GIFT_CAMPAIGN_STATUS_LABEL[campaign.status]}</Badge>
          <span className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={writesDisabled || build.isPending}
              onClick={() => build.mutate()}
            >
              Rebuild list
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={
                writesDisabled ||
                send.isPending ||
                eligible.length === 0 ||
                campaign.status === "sent"
              }
              onClick={() => send.mutate()}
            >
              Send {eligible.length > 0 ? `(${eligible.length})` : ""}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {storedQ.isError && (
          <LoadError
            what="recipient list"
            error={storedQ.error}
            onRetry={() => void storedQ.refetch()}
          />
        )}

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No list built yet. Rebuild pulls every contact on your farmed accounts
            {campaign.occasion === "birthday" && campaign.target_month
              ? ` with a birthday in ${MONTHS[campaign.target_month - 1]}`
              : ""}
            , then applies the gift policy.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <Badge variant="secondary">{eligible.length} will receive</Badge>
              <Badge variant="destructive">{excluded.length} excluded</Badge>
              <Badge variant="outline">{approval.length} need pre-approval</Badge>
            </div>

            {excluded.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-destructive">
                  <ShieldAlert className="size-3.5" /> Excluded and why
                </div>
                <ul className="mt-1 space-y-0.5 text-[11.5px] text-muted-foreground">
                  {excluded.map((r) => (
                    <li key={r.id}>
                      <span className="font-medium text-foreground">
                        {r.contact?.full_name ?? "Contact"}
                      </span>{" "}
                      · {r.account?.name ?? "—"} — {r.excluded_reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Gift policy</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-[12.5px] font-medium">
                      {r.contact?.full_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">{r.account?.name ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {r.excluded_reason ? "Prohibited" : r.approved ? "Allowed" : "Needs approval"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.excluded_reason ? (
                        <span className="text-destructive">Excluded</span>
                      ) : r.approved ? (
                        "Will send"
                      ) : (
                        <span className="text-warning">Hold for approval</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
