import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, ShieldCheck, ExternalLink, Settings2 } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { assertWritesEnabled } from "@/lib/write-guard";
import { toastDbError } from "@/lib/db-errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  RequirementFiles,
  // per-company certificates address, shared with the Send COI action
} from "@/components/compliance-files";
import { fetchCertificatesEmail, saveCertificatesEmail } from "@/lib/compliance-files";
import { ComplianceIndicatorChip } from "@/components/compliance-indicator";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  COMPLIANCE_STATUS_LABEL,
  COMPLIANCE_STATUS_TONE,
  ENDORSEMENT_TYPES,
  fetchAccountCompliance,
  fetchComplianceSendLog,
  formatLimit,
  satisfyingDocument,
  type ComplianceRow,
  type ComplianceSendLogEntry,
} from "@/lib/compliance";
import {
  CATEGORY_LABEL,
  CREDENTIAL_CATALOG,
  credentialLabel,
  type CredentialCategory,
} from "@/lib/credentials";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Compliance on an account: tick what this client requires, and the central
 * credentials library answers each tick with the policy or certificate we
 * already hold. Nothing is uploaded here — that lives in the library.
 */
export function AccountCompliance({
  accountId,
  locationId: _locationId,
}: {
  accountId: string;
  locationId: string | null;
}) {
  const app = useAppContext();
  const disabled = app.writesDisabled;
  const [rows, setRows] = useState<ComplianceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState<ComplianceRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchAccountCompliance(accountId));
    } catch (e) {
      toastDbError(e, { action: "Load compliance" });
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = rows.length;
  const done = rows.filter((r) => r.status === "satisfied").length;
  const unmet = rows.filter((r) => r.status !== "satisfied");
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="@container space-y-2 px-3 py-2">
      {/*
        Narrow rail: badge, summary and action each get their own row so the
        summary never breaks mid-phrase and the action never runs off the card.
        Once the card is wide enough they collapse back onto a single row.
      */}
      <div className="flex flex-col items-start gap-1.5 @[22rem]:flex-row @[22rem]:items-center @[22rem]:justify-between @[22rem]:gap-2">
        <div className="flex min-w-0 max-w-full flex-col items-start gap-1 @[22rem]:flex-row @[22rem]:items-center @[22rem]:gap-2">
          <ComplianceIndicatorChip accountId={accountId} />
          <span className="min-w-0 text-[12px] font-medium">
            {loading ? "Loading…" : `${done} of ${total} requirements complete`}
          </span>
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full shrink-0 justify-start px-2 text-[11px] @[22rem]:h-6 @[22rem]:w-auto @[22rem]:justify-center @[22rem]:px-1.5"
          disabled={disabled}
          title={app.writesDisabledReason ?? undefined}
          onClick={() => setEditing(true)}
        >
          <Settings2 className="mr-1 size-3" /> Requirements
        </Button>
      </div>
      {total > 0 && <Progress value={pct} className="h-1.5" />}

      <CertificatesEmailField accountId={accountId} disabled={disabled} />

      {/* Missing credentials, first — what is actually unmet ---------------- */}
      {unmet.length > 0 && (
        <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-2.5 py-1.5 dark:border-amber-500/40 dark:bg-amber-500/15">
          <div className="text-[11px] font-medium uppercase text-amber-800 dark:text-amber-300">
            Missing credentials
          </div>
          <ul className="mt-1 space-y-0.5">
            {unmet.map((r) => (
              <li key={r.requirement_id} className="text-[11px] text-amber-900 dark:text-amber-300">
                {credentialLabel(r.requirement_type)}
                {r.state_code ? ` (${r.state_code})` : ""} —{" "}
                {COMPLIANCE_STATUS_LABEL[r.status].toLowerCase()}
                {r.status === "insufficient" &&
                  ` (holds ${formatLimit(r.covered_amount, r.currency ?? "USD")}, needs ${formatLimit(
                    r.required_amount,
                    r.required_currency,
                  )})`}
              </li>
            ))}
          </ul>
          <Link
            to="/compliance"
            className="mt-1 inline-block text-[11px] font-medium text-amber-900 underline dark:text-amber-300"
          >
            Open credentials library
          </Link>
        </div>
      )}

      {!loading && total === 0 && (
        <p className="text-[12px] text-muted-foreground">
          Nothing ticked yet. Open Requirements and select what this client demands of a vendor.
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <button
            key={r.requirement_id}
            type="button"
            onClick={() => setDetail(r)}
            className={`max-w-full break-words rounded-[6px] border px-2 py-1 text-left text-[11px] ${COMPLIANCE_STATUS_TONE[r.status]}`}
          >
            <span className="font-medium">{credentialLabel(r.requirement_type)}</span>
            {r.must_name_account && (
              <span title="Must name this client as additional insured" className="ml-0.5">
                *
              </span>
            )}
            <span className="ml-1 opacity-75">{COMPLIANCE_STATUS_LABEL[r.status]}</span>
          </button>
        ))}
      </div>

      <SendLog accountId={accountId} />

      {editing && (
        <RequirementGridDialog
          accountId={accountId}
          rows={rows}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      {detail && <RequirementDetail row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** What the library holds against one requirement. */
function RequirementDetail({ row, onClose }: { row: ComplianceRow; onClose: () => void }) {
  const requiredSummary = [
    row.required_amount != null
      ? formatLimit(row.required_amount, row.required_currency)
      : "no limit specified",
    row.required_value,
    row.must_name_account ? "must name the client" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const doc = satisfyingDocument(row);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            <ShieldCheck className="mr-1 inline size-4" />
            {credentialLabel(row.requirement_type)}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={`h-5 rounded-[4px] px-1.5 text-[10px] ${COMPLIANCE_STATUS_TONE[row.status]}`}
            >
              {COMPLIANCE_STATUS_LABEL[row.status]}
            </Badge>
            {row.must_name_account && (
              <Badge
                variant="outline"
                className="h-5 gap-1 rounded-[4px] border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
              >
                <AlertTriangle className="size-3" /> Must name this client
              </Badge>
            )}
          </div>
          <Field label="Client requires">
            {row.required_amount != null
              ? formatLimit(row.required_amount, row.required_currency)
              : "No limit specified"}
            {row.required_value ? ` · ${row.required_value}` : ""}
          </Field>
          {/* Which piece of paper is actually answering this, and until when. */}
          <Field label="Satisfied by">
            {doc.source ? (
              <>
                {doc.name}
                {doc.policy ? ` · ${doc.policy}` : ""}
                <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                  {doc.source === "certificate"
                    ? "certificate filed on this account"
                    : "central credential"}
                </span>
              </>
            ) : (
              "Nothing on file — we have never held this"
            )}
          </Field>
          {doc.source && (
            <Field label="Expires">
              {doc.expiry
                ? new Date(`${doc.expiry}T00:00:00`).toLocaleDateString(DATE_LOCALE, US_DATE)
                : "No expiry"}
              {row.days_to_expiry != null &&
                ` (${row.days_to_expiry < 0 ? `${Math.abs(row.days_to_expiry)}d ago` : `in ${row.days_to_expiry}d`})`}
            </Field>
          )}
          {row.credential_id && (
            <Field label="Limits">
              {formatLimit(row.covered_amount, row.currency ?? "USD")} per occurrence
              {row.limit_aggregate != null &&
                ` · ${formatLimit(row.limit_aggregate, row.currency ?? "USD")} aggregate`}
            </Field>
          )}
          {row.must_name_account && (
            <p className="rounded-[4px] bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
              This client must be named as additional insured — a generic copy of our certificate
              does not satisfy it.
            </p>
          )}
          <RequirementFiles
            requirementId={row.requirement_id}
            accountId={row.account_id}
            accountName={row.account_name ?? "This client"}
            requirementLabel={credentialLabel(row.requirement_type)}
            requiredSummary={requiredSummary}
          />
          <Link to="/compliance" className="inline-flex items-center gap-1 text-[11px] underline">
            <ExternalLink className="size-3" /> Manage in the credentials library
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What has been emailed out, to whom, by whom, and when. */
function SendLog({ accountId }: { accountId: string }) {
  const [rows, setRows] = useState<ComplianceSendLogEntry[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void fetchComplianceSendLog(accountId)
      .then(async (r) => {
        if (!live) return;
        setRows(r);
        const ids = [...new Set(r.map((x) => x.sent_by).filter(Boolean))] as string[];
        if (!ids.length) return;
        const { data } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", ids);
        if (!live) return;
        setNames(Object.fromEntries((data ?? []).map((p) => [p.user_id, p.full_name ?? "—"])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [accountId]);

  if (!rows.length) return null;

  return (
    <div className="rounded-[6px] border bg-card">
      <div className="border-b px-2.5 py-1.5 text-[11px] font-medium uppercase text-muted-foreground">
        Certificates sent
      </div>
      {/* Five columns never fit the narrow rail — scroll the table, not the card. */}
      <div className="w-full overflow-x-auto md:max-h-[75svh] md:overflow-auto">
        <table className="w-full min-w-[24rem] text-[11px]">
          <thead className="text-muted-foreground">
            <tr className="[&>th]:px-2.5 [&>th]:py-1 [&>th]:text-left [&>th]:font-normal">
              <th>When</th>
              <th>Requirement</th>
              <th>To</th>
              <th>By</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t [&>td]:px-2.5 [&>td]:py-1">
                <td className="whitespace-nowrap">
                  {new Date(r.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                </td>
                <td className="truncate">{r.requirement_label ?? r.file_name ?? "Certificate"}</td>
                <td className="truncate">{r.to_email}</td>
                <td className="truncate">{r.sent_by ? (names[r.sent_by] ?? "—") : "—"}</td>
                <td>
                  <Badge
                    variant="outline"
                    className={`h-4 rounded-[3px] px-1 text-[9px] ${
                      r.status === "queued"
                        ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
                        : r.status === "failed"
                          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-400"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-400"
                    }`}
                  >
                    {r.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** The grid of selectable boxes — tick what this client requires. */
function RequirementGridDialog({
  accountId,
  rows,
  onClose,
  onSaved,
}: {
  accountId: string;
  rows: ComplianceRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const existing = useMemo(() => new Map(rows.map((r) => [r.requirement_type, r])), [rows]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.map((r) => r.requirement_type)),
  );
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((r) => [
        r.requirement_type,
        r.required_amount != null ? String(r.required_amount) : "",
      ]),
    ),
  );
  const [wording, setWording] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.requirement_type, r.required_value ?? ""])),
  );
  const [busy, setBusy] = useState(false);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const save = async () => {
    assertWritesEnabled(app.writesDisabled, app.writesDisabledReason);
    setBusy(true);
    const keys = [...selected];
    const upserts = keys.map((key) => ({
      account_id: accountId,
      requirement_type: key,
      mandatory: existing.get(key)?.mandatory ?? true,
      required_amount: limits[key] ? Number(limits[key]) : null,
      required_value: wording[key] || null,
      must_name_account: ENDORSEMENT_TYPES.has(key),
      renewal_lead_days: existing.get(key)?.renewal_lead_days ?? 7,
      active: true,
      created_by: app.userId,
    }));
    const removed = rows
      .filter((r) => !selected.has(r.requirement_type))
      .map((r) => r.requirement_id);

    if (upserts.length) {
      const { error } = await supabase
        .from("account_compliance_requirements")
        .upsert(upserts, { onConflict: "account_id,requirement_type" });
      if (error) {
        setBusy(false);
        toastDbError(error, { action: "Save requirements" });
        return;
      }
    }
    if (removed.length) {
      const { error } = await supabase
        .from("account_compliance_requirements")
        .delete()
        .in("id", removed);
      if (error) {
        setBusy(false);
        toastDbError(error, { action: "Remove requirements" });
        return;
      }
    }
    setBusy(false);
    toast.success("Requirements saved");
    onSaved();
  };

  const groups: CredentialCategory[] = ["insurance", "certification", "licence"];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[14px]">What this client requires</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g} className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase text-muted-foreground">
                {CATEGORY_LABEL[g]}
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {CREDENTIAL_CATALOG.filter((k) => k.category === g).map((k) => {
                  const on = selected.has(k.key);
                  return (
                    <div
                      key={k.key}
                      className={`rounded-[6px] border px-2 py-1.5 ${on ? "border-primary/60 bg-primary/5" : "bg-card"}`}
                    >
                      <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                        <Checkbox checked={on} onCheckedChange={() => toggle(k.key)} />
                        <span className="flex-1">{k.label}</span>
                        {on && <Check className="size-3 text-primary" />}
                      </label>
                      {on && (
                        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                          {k.hasLimits && (
                            <div>
                              <Label className="text-[10px] text-muted-foreground">
                                Required limit
                              </Label>
                              {/* An insurance limit is a seven-figure number
                                  more often than not; it groups as you type. */}
                              <NumberInput
                                className="h-7 text-[11px]"
                                decimals={0}
                                placeholder="2,000,000"
                                value={limits[k.key] ?? ""}
                                onValueChange={(_, clean) =>
                                  setLimits((p) => ({ ...p, [k.key]: clean }))
                                }
                              />
                            </div>
                          )}
                          <div className={k.hasLimits ? "" : "col-span-2"}>
                            <Label className="text-[10px] text-muted-foreground">
                              Specific wording
                            </Label>
                            <Input
                              className="h-7 text-[11px]"
                              placeholder="Primary and non-contributory"
                              value={wording[k.key] ?? ""}
                              onChange={(e) =>
                                setWording((p) => ({ ...p, [k.key]: e.target.value }))
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={save}
            disabled={busy || app.writesDisabled}
            title={app.writesDisabledReason ?? undefined}
          >
            Save requirements
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Where this company wants its certificates emailed. Set once, reused by "Send COI". */
function CertificatesEmailField({ accountId, disabled }: { accountId: string; disabled: boolean }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    void fetchCertificatesEmail(accountId).then((e) => {
      setValue(e ?? "");
      setSaved(e ?? "");
    });
  }, [accountId]);

  const commit = async () => {
    if (value.trim() === saved) return;
    try {
      assertWritesEnabled(disabled);
      await saveCertificatesEmail(accountId, value.trim() || null);
      setSaved(value.trim());
      toast.success("Certificates address saved");
    } catch (e) {
      toastDbError(e, { action: "Save certificates email" });
    }
  };

  return (
    <div className="flex flex-col gap-1 @[22rem]:flex-row @[22rem]:items-center @[22rem]:gap-2">
      <Label className="whitespace-nowrap text-[10px] uppercase text-muted-foreground @[22rem]:w-[130px] @[22rem]:shrink-0">
        Send certificates to
      </Label>
      <Input
        className="h-7 w-full min-w-0 text-[12px]"
        placeholder="compliance@client.com"
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
      />
    </div>
  );
}
