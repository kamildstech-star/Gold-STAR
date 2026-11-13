import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  CalendarClock,
  Copy,
  Gift,
  Globe,
  Mail,
  MapPin,
  Phone,
  StickyNote,
  User,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { fetchGiftPolicies } from "@/lib/gift-policy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtCents } from "@/lib/lifecycle";
import { birthdayLabel, ytdUpkeepCents } from "@/lib/gifts";
import { DetailDrawer, DrawerField, DrawerSection } from "@/components/detail-drawer";
import { useSectionCollapse } from "@/components/master-detail";
import { LabelPicker } from "@/components/label-picker";
import { RecordLoadError } from "@/components/record-load-error";
import { QuickComposer, type ComposerRequest as ComposerTab } from "@/components/quick-composer";
import { DealTimeline } from "@/components/deal-timeline";
import { AccountFocus } from "@/components/ai-suggestions";
import { StagePath } from "@/components/stage-path";
import { useAppContext } from "@/components/app-context";
import type { Touchpoint } from "@/lib/timeline";
import {
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_TYPE_LABEL,
  CONTACT_ROLE_LABEL,
  HEALTH_LABEL,
  cadenceHealth,
  daysSinceTs,
  nextInPersonDueLabel,
  type AccountStatus,
  type AccountType,
  type ContactDecisionRole,
  type GiftPolicy,
} from "@/lib/accounts";
import {
  AWAITING_APPROVAL_CARD,
  approvalLabel,
  approveLead,
  canApproveLeads,
  isAwaitingApproval,
} from "@/lib/approval";
import { cn } from "@/lib/utils";

type PanelAccount = {
  id: string;
  name: string;
  account_type: AccountType;
  status: AccountStatus;
  location_id: string;
  phone: string | null;
  website: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  notes: string | null;
  archived_at: string | null;
  approval_state: string | null;
  approval_due_on: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  stage_changed_at: string | null;
  health_pipeline_id: string | null;
  health_stage_id: string | null;
  health_changed_at: string | null;
};

type PanelContact = {
  id: string;
  full_name: string;
  title: string | null;
  decision_role: ContactDecisionRole | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  gift_policy: GiftPolicy;
  birthday_month: number | null;
  birthday_day: number | null;
};

function copy(value: string) {
  navigator.clipboard
    .writeText(value)
    .then(() => toast.success("Copied"))
    .catch(() => toast.error("Copy failed"));
}

/**
 * Dense record panel for an account. Same information as the full page, laid
 * out as an icon-led key/value list rather than a column of stacked cards, so
 * a rep can see the cadence signal, the actions and the contacts without
 * scrolling on a laptop.
 */
export function AccountPanel({
  accountId,
  fallbackName,
  onOpenChange,
  onChanged,
}: {
  accountId: string | null;
  fallbackName?: string;
  onOpenChange: (v: boolean) => void;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const app = useAppContext();
  const { collapsed, toggle, setAll } = useSectionCollapse("account-panel");
  const SECTION_IDS = ["focus", "details", "contacts", "timeline"];
  const allCollapsed = SECTION_IDS.every((id) => collapsed[id]);
  const [userId, setUserId] = useState<string | null>(null);
  /** The Timeline card's "+ Add" opens the composer above it on that tab. */
  const [composerTab, setComposerTab] = useState<{ tab: ComposerTab; token: number } | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const accountQ = useQuery({
    queryKey: ["account-panel", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select(
          "id,name,account_type,status,location_id,phone,website,address_line1,city,state,notes,archived_at,approval_state,approval_due_on,pipeline_id,stage_id,stage_changed_at,health_pipeline_id,health_stage_id,health_changed_at",
        )
        .eq("id", accountId!)
        .maybeSingle();
      if (error) throw error;
      return data as PanelAccount | null;
    },
  });

  const locationQ = useQuery({
    queryKey: ["location", accountQ.data?.location_id],
    enabled: !!accountQ.data?.location_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("locations")
        .select("id,code,name")
        .eq("id", accountQ.data!.location_id)
        .maybeSingle();
      return data;
    },
  });

  const contactsQ = useQuery({
    queryKey: ["account-panel-contacts", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select(
          "id,full_name,title,decision_role,email,phone,is_primary,birthday_month,birthday_day",
        )
        .eq("account_id", accountId!)
        .is("archived_at", null)
        .order("is_primary", { ascending: false })
        .order("created_at");
      if (error) throw error;
      const rows = data ?? [];
      const policies = await fetchGiftPolicies(rows.map((r) => r.id));
      return rows.map((r) => ({
        ...r,
        gift_policy: policies.get(r.id) ?? "unknown",
      })) as PanelContact[];
    },
  });

  // Year-to-date relationship upkeep, shown next to the cadence signal so the
  // cost of keeping an account warm sits beside the reason for keeping it.
  const upkeepQ = useQuery({
    queryKey: ["account-panel-upkeep", accountId],
    enabled: !!accountId,
    queryFn: () => ytdUpkeepCents(accountId!),
  });

  const touchpointsQ = useQuery({
    queryKey: ["account-panel-touchpoints", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("touchpoints")
        .select("*")
        .eq("account_id", accountId!)
        .order("occurred_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Touchpoint[];
    },
  });

  // Reply-driven cadence: outbound alone never satisfies the cadence.
  const replyQ = useQuery({
    queryKey: ["account-reply-status", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("account_email_reply_status", {
        _account_id: accountId!,
      });
      if (error) throw error;
      return (data ?? [])[0] ?? null;
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["account-panel", accountId] });
    qc.invalidateQueries({ queryKey: ["account-panel-contacts", accountId] });
    qc.invalidateQueries({ queryKey: ["account-panel-touchpoints", accountId] });
    qc.invalidateQueries({ queryKey: ["accounts-cadence"] });
    onChanged?.();
  };

  const patch = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const { error } = await supabase
        .from("accounts")
        .update(values as never)
        .eq("id", accountId!);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const approve = useMutation({
    mutationFn: () => approveLead(accountId!),
    onSuccess: () => {
      toast.success("Lead approved");
      invalidate();
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const a = accountQ.data;
  const touches = touchpointsQ.data ?? [];
  const last = touches[0]?.occurred_at ?? null;
  const lastInPerson = touches.find((t) => t.type === "meeting_in_person")?.occurred_at ?? null;
  const health = cadenceHealth(last, lastInPerson);
  const contacts = contactsQ.data ?? [];
  const loc = locationQ.data;

  return (
    <DetailDrawer
      open={!!accountId}
      onOpenChange={onOpenChange}
      expandHref={accountId ? `/accounts/${accountId}` : undefined}
      title={a?.name ?? fallbackName ?? "Account"}
      subtitle={a ? ACCOUNT_TYPE_LABEL[a.account_type] : undefined}
      headerExtra={
        a ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {ACCOUNT_STATUS_LABEL[a.status]}
            </Badge>
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Building2 className="size-3" />
              {loc ? `${loc.code} · ${loc.name}` : "Unknown office"}
            </span>
            {a.archived_at && (
              <Badge variant="outline" className="text-[10px]">
                Archived
              </Badge>
            )}
            {accountId && <LabelPicker scope="account" recordId={accountId} />}
          </div>
        ) : undefined
      }
    >
      {!a ? (
        accountQ.isLoading ? (
          <p className="p-3 text-[12px] text-muted-foreground">Loading…</p>
        ) : (
          <RecordLoadError
            compact
            error={accountQ.error}
            record="account"
            table="accounts"
            id={accountId}
            onRetry={() => accountQ.refetch()}
          />
        )
      ) : (
        <>
          {/* Slim cadence strip — the farming signal, one line. */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-1.5 text-[12px]",
              health === "overdue"
                ? "bg-destructive/10 text-destructive"
                : health === "never"
                  ? "bg-warning/10"
                  : health === "due_soon"
                    ? "bg-warning/10"
                    : "bg-success/10 text-success",
            )}
          >
            <span className="font-semibold">{HEALTH_LABEL[health]}</span>
            <span className="text-muted-foreground">
              {last ? `Last touch ${daysSinceTs(last)}d ago` : "No touches logged yet"} ·
              {nextInPersonDueLabel(lastInPerson)}
            </span>
          </div>

          {/* Outbound with no reply is not a touchpoint — say so plainly. */}
          {replyQ.data && replyQ.data.emails_sent > 0 && (
            <div
              className={cn(
                "border-b px-3 py-1.5 text-[12px]",
                replyQ.data.cadence_met
                  ? "text-muted-foreground"
                  : "bg-destructive/10 text-destructive",
              )}
            >
              <Mail className="mr-1 inline size-3" />
              {replyQ.data.cadence_met ? (
                <>
                  {replyQ.data.emails_sent} email{replyQ.data.emails_sent === 1 ? "" : "s"} sent ·{" "}
                  {replyQ.data.emails_replied} repl
                  {replyQ.data.emails_replied === 1 ? "y" : "ies"}
                  {replyQ.data.last_reply_at
                    ? ` · last reply ${daysSinceTs(replyQ.data.last_reply_at)}d ago`
                    : ""}
                </>
              ) : (
                <span className="font-semibold">
                  {replyQ.data.outbound_since_reply || replyQ.data.emails_sent} email
                  {(replyQ.data.outbound_since_reply || replyQ.data.emails_sent) === 1
                    ? ""
                    : "s"}{" "}
                  sent, no reply — cadence not met
                </span>
              )}
            </div>
          )}

          {isAwaitingApproval(a.approval_state) && (
            <div className={cn("border-b px-3 py-1.5 text-[12px]", AWAITING_APPROVAL_CARD)}>
              <span className="font-semibold uppercase tracking-[0.03em] text-warning">
                {approvalLabel(a.approval_state, a.approval_due_on)}
              </span>
              {canApproveLeads(app.roles) && (
                <Button
                  size="sm"
                  className="ml-2 h-6 px-2 text-[11px]"
                  disabled={app.writesDisabled || approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  Approve
                </Button>
              )}
            </div>
          )}

          {/* One action surface: the tabbed composer. Off-system logging lives
              inside its Call tab, so no parallel button row is needed. */}
          <div className="border-b px-3 py-1.5">
            <div className="mb-1 flex justify-end">
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setAll(SECTION_IDS, !allCollapsed)}
              >
                {allCollapsed ? "Expand all sections" : "Collapse all sections"}
              </button>
            </div>
            <QuickComposer
              accountId={a.id}
              accountName={a.name}
              locationId={a.location_id}
              address={[a.address_line1, a.city, a.state].filter(Boolean).join(", ") || a.name}
              contacts={contacts}
              userId={userId}
              defaultStateCode={a.state}
              requestTab={composerTab}
              onCreated={invalidate}
            />
          </div>

          <div className="border-b px-3 py-2">
            <StagePath
              accountId={a.id}
              kind="prospecting"
              pipelineId={a.pipeline_id}
              currentStageId={a.stage_id}
              changedAt={a.stage_changed_at}
              onMoved={invalidate}
            />
            {a.health_stage_id && (
              <div className="mt-1.5">
                <StagePath
                  accountId={a.id}
                  kind="farming"
                  pipelineId={a.health_pipeline_id}
                  currentStageId={a.health_stage_id}
                  changedAt={a.health_changed_at}
                  onMoved={invalidate}
                />
              </div>
            )}
          </div>

          <DrawerSection
            title="Focus"
            collapsible
            collapsed={collapsed.focus}
            onToggle={() => toggle("focus")}
          >
            <AccountFocus accountId={a.id} />
          </DrawerSection>

          <DrawerSection
            title="Details"
            collapsible
            collapsed={collapsed.details}
            onToggle={() => toggle("details")}
          >
            <DrawerField
              icon={Phone}
              label="Phone"
              value={a.phone}
              type="tel"
              onSave={(v) => patch.mutate({ phone: v || null })}
            />
            <DrawerField
              icon={Globe}
              label="Website"
              value={a.website}
              onSave={(v) => patch.mutate({ website: v || null })}
            />
            <DrawerField
              icon={MapPin}
              label="Address"
              value={a.address_line1}
              onSave={(v) => patch.mutate({ address_line1: v || null })}
            />
            <DrawerField
              icon={MapPin}
              label="City"
              value={a.city}
              onSave={(v) => patch.mutate({ city: v || null })}
            />
            <DrawerField
              icon={CalendarClock}
              label="Last touch"
              value={last ? `${daysSinceTs(last)}d ago` : "Never"}
              readOnly
            />
            <DrawerField
              icon={Gift}
              label="Upkeep YTD"
              value={fmtCents(upkeepQ.data ?? 0)}
              readOnly
            />
            <DrawerField
              icon={StickyNote}
              label="Notes"
              value={a.notes}
              onSave={(v) => patch.mutate({ notes: v || null })}
            />
          </DrawerSection>

          <DrawerSection
            title={`Contacts (${contacts.length})`}
            collapsible
            collapsed={collapsed.contacts}
            onToggle={() => toggle("contacts")}
          >
            {contacts.length === 0 ? (
              <p className="px-3 py-1.5 text-[12px] text-muted-foreground">
                No contacts yet — add the person you are actually building the relationship with.
              </p>
            ) : (
              <ul className="divide-y">
                {contacts.map((c) => (
                  <ContactRow key={c.id} contact={c} />
                ))}
              </ul>
            )}
          </DrawerSection>

          <DrawerSection
            title="Timeline"
            collapsible
            collapsed={collapsed.timeline}
            onToggle={() => toggle("timeline")}
          >
            <div className="px-2 pb-2">
              <DealTimeline
                accountId={a.id}
                touchpoints={touches}
                userId={userId}
                onChanged={invalidate}
                onAdd={(tab) => setComposerTab({ tab, token: Date.now() })}
              />
            </div>
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}

function ContactRow({ contact }: { contact: PanelContact }) {
  return (
    <li className="px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <User className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[12.5px] font-medium">{contact.full_name}</span>
        {contact.is_primary && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            Primary
          </Badge>
        )}
        {contact.decision_role && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {CONTACT_ROLE_LABEL[contact.decision_role]}
          </Badge>
        )}
        {/* Policy sits on the row, not on a separate tab: a send can start here. */}
        {contact.gift_policy === "prohibited" && (
          <Badge variant="destructive" className="shrink-0 text-[10px]">
            Gifts prohibited
          </Badge>
        )}
        {contact.gift_policy === "approval_required" && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            Gift needs approval
          </Badge>
        )}
        {birthdayLabel(contact.birthday_month, contact.birthday_day) && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            🎂 {birthdayLabel(contact.birthday_month, contact.birthday_day)}
          </span>
        )}
        {contact.title && (
          <span className="truncate text-[11px] text-muted-foreground">{contact.title}</span>
        )}
      </div>
      {contact.phone && (
        <div className="flex items-center gap-1.5 pl-5 text-[12px]">
          <Phone className="size-3 text-muted-foreground" />
          <a href={`tel:${contact.phone}`} className="truncate hover:underline">
            {contact.phone}
          </a>
          <Button
            size="sm"
            variant="ghost"
            className="size-5 p-0"
            aria-label="Copy phone"
            onClick={() => copy(contact.phone!)}
          >
            <Copy className="size-3" />
          </Button>
        </div>
      )}
      {contact.email && (
        <div className="flex items-center gap-1.5 pl-5 text-[12px]">
          <Mail className="size-3 text-muted-foreground" />
          <a href={`mailto:${contact.email}`} className="truncate hover:underline">
            {contact.email}
          </a>
          <Button
            size="sm"
            variant="ghost"
            className="size-5 p-0"
            aria-label="Copy email"
            onClick={() => copy(contact.email!)}
          >
            <Copy className="size-3" />
          </Button>
        </div>
      )}
    </li>
  );
}
