import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Building2,
  CalendarClock,
  Globe,
  Mail,
  MapPin,
  Phone,
  Undo2,
  User,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DetailDrawer, DrawerField, DrawerSection } from "@/components/detail-drawer";
import { LabelPicker } from "@/components/label-picker";
import { useAppContext } from "@/components/app-context";
import { fullRecordDestination } from "@/components/account-prospect/use-prospect-view";
import { assertWritesEnabled } from "@/lib/write-guard";
import {
  AWAITING_APPROVAL_CARD,
  approvalLabel,
  approveLead,
  canApproveLeads,
  isAwaitingApproval,
} from "@/lib/approval";

export function AccountDrawer({
  accountId,
  name,
  subtitle,
  onOpenChange,
  onChanged,
}: {
  accountId: string | null;
  name: string;
  subtitle?: string;
  onOpenChange: (v: boolean) => void;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const app = useAppContext();
  const navigate = useNavigate();
  /**
   * The account page the drawer is open on, if any. The account has one page
   * now (6 Nov: no Overview / Full record), so on that page "Open record"
   * only closes the drawer; anywhere else it goes to the account.
   */
  const pageMatch = useMatch({ from: "/_authenticated/accounts/$id", shouldThrow: false });
  const currentAccountId = pageMatch?.params.id ?? null;

  const openFullRecord = () => {
    if (!accountId) return;
    const dest = fullRecordDestination(accountId, currentAccountId);
    onOpenChange(false);
    if (dest.kind === "navigate") void navigate({ to: dest.to, params: dest.params });
  };

  const detailQ = useQuery({
    queryKey: ["account-drawer", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select(
          "id, name, status, phone, email, website, address_line1, city, state, postal_code, notes, archived_at, approval_state, approval_due_on",
        )
        .eq("id", accountId!)
        .maybeSingle();
      if (error) throw error;
      return data as Record<string, unknown> | null;
    },
  });

  const contactsQ = useQuery({
    queryKey: ["account-drawer-contacts", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, full_name, title, phone, email, is_primary")
        .eq("account_id", accountId!)
        .is("archived_at", null)
        .order("is_primary", { ascending: false })
        .limit(10);
      if (error) throw error;
      return data ?? [];
    },
  });

  const approve = useMutation({
    mutationFn: () => {
      assertWritesEnabled(app.writesDisabled, app.writesDisabledReason);
      return approveLead(accountId!);
    },
    onSuccess: () => {
      toast.success("Lead approved");
      qc.invalidateQueries({ queryKey: ["account-drawer", accountId] });
      qc.invalidateQueries({ queryKey: ["accounts-rollup"] });
      qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
      onChanged?.();
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const patch = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      assertWritesEnabled(app.writesDisabled, app.writesDisabledReason);
      const { error } = await supabase
        .from("accounts")
        .update(values as never)
        .eq("id", accountId!);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-drawer", accountId] });
      onChanged?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const archive = useMutation({
    mutationFn: async (archived: boolean) => {
      assertWritesEnabled(app.writesDisabled, app.writesDisabledReason);
      const { error } = await supabase
        .from("accounts")
        .update({ archived_at: archived ? new Date().toISOString() : null } as never)
        .eq("id", accountId!);
      if (error) throw error;
    },
    onSuccess: (_d, archived) => {
      toast.success(archived ? "Account archived" : "Account restored");
      qc.invalidateQueries({ queryKey: ["account-drawer", accountId] });
      onChanged?.();
      if (archived) onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = (detailQ.data ?? {}) as Record<string, string | null>;
  const isArchived = !!d.archived_at;

  return (
    <DetailDrawer
      open={!!accountId}
      onOpenChange={onOpenChange}
      title={name}
      subtitle={subtitle}
      headerExtra={
        isArchived ? (
          <Badge variant="outline" className="text-[10px]">
            Archived
          </Badge>
        ) : undefined
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          {accountId && (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 text-[12px]"
              onClick={openFullRecord}
            >
              Open record
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-[12px]"
            disabled={app.writesDisabled || archive.isPending}
            title={app.writesDisabledReason ?? undefined}
            onClick={() => archive.mutate(!isArchived)}
          >
            {isArchived ? (
              <>
                <Undo2 className="mr-1.5 size-3.5" />
                Restore
              </>
            ) : (
              <>
                <Archive className="mr-1.5 size-3.5" />
                Archive
              </>
            )}
          </Button>
        </div>
      }
    >
      {accountId && isAwaitingApproval(d.approval_state as string | null) && (
        <div className={`m-2 border px-3 py-2 text-[12px] ${AWAITING_APPROVAL_CARD}`}>
          <div className="font-semibold uppercase tracking-[0.03em] text-warning">
            {approvalLabel(d.approval_state as string | null, d.approval_due_on as string | null)}
          </div>
          <p className="mt-0.5 text-muted-foreground">
            Rep-entered — workable now, but a Sales Head still has to sign it off.
          </p>
          {canApproveLeads(app.roles) && (
            <Button
              size="sm"
              className="mt-2 h-8 text-[12px]"
              disabled={app.writesDisabled || approve.isPending}
              title={app.writesDisabledReason ?? undefined}
              onClick={() => approve.mutate()}
            >
              Approve lead
            </Button>
          )}
        </div>
      )}

      {accountId && (
        <>
          <DrawerSection title="Labels">
            <div className="px-4 py-1.5">
              <LabelPicker scope="account" recordId={accountId} />
            </div>
          </DrawerSection>

          <DrawerSection title="ACCOUNT">
            <DrawerField
              icon={Building2}
              label="Account name"
              value={d.name}
              readOnly={app.writesDisabled}
              onSave={(v) => {
                const next = v.trim();
                if (!next) {
                  toast.error("Account name is required");
                  return;
                }
                patch.mutate({ name: next });
              }}
            />
            <DrawerField icon={Building2} label="Status" value={d.status} readOnly />
            <DrawerField
              icon={Phone}
              label="Phone"
              value={d.phone}
              type="tel"
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ phone: v || null })}
            />
            <DrawerField
              icon={Mail}
              label="Email"
              value={d.email}
              type="email"
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ email: v || null })}
            />
            <DrawerField
              icon={Globe}
              label="Website"
              value={d.website}
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ website: v || null })}
            />
            <DrawerField
              icon={MapPin}
              label="Address"
              value={d.address_line1}
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ address_line1: v || null })}
            />
            <DrawerField
              icon={MapPin}
              label="City"
              value={d.city}
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ city: v || null })}
            />
            <DrawerField
              icon={MapPin}
              label="State"
              value={d.state}
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ state: v || null })}
            />
            <DrawerField
              icon={MapPin}
              label="Postal code"
              value={d.postal_code}
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ postal_code: v || null })}
            />
            <DrawerField
              icon={CalendarClock}
              label="Notes"
              value={d.notes}
              readOnly={app.writesDisabled}
              onSave={(v) => patch.mutate({ notes: v || null })}
            />
          </DrawerSection>

          <DrawerSection title={`Contacts (${contactsQ.data?.length ?? 0})`}>
            {(contactsQ.data ?? []).length === 0 ? (
              <p className="px-4 py-2 text-[12px] text-muted-foreground">No contacts yet.</p>
            ) : (
              <ul className="divide-y">
                {(contactsQ.data ?? []).map((c) => (
                  <li key={c.id} className="flex items-center gap-2 px-4 py-1.5">
                    <User className="size-3.5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium">
                        {c.full_name}
                        {c.is_primary && (
                          <Badge variant="secondary" className="ml-1.5 text-[10px]">
                            Primary
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {[c.title, c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}
