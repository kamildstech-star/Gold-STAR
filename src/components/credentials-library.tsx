import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { FileUp, Plus, Users } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchCredentialImpact, impactSentence } from "@/lib/networks";
import {
  CATEGORY_LABEL,
  CREDENTIAL_CATALOG,
  CREDENTIAL_STATUS_LABEL,
  CREDENTIAL_STATUS_TONE,
  credentialKind,
  credentialLabel,
  credentialStatus,
  daysToExpiry,
  fetchAccountsAtRisk,
  fetchCredentials,
  type CompanyCredential,
} from "@/lib/credentials";
import { formatLimit } from "@/lib/compliance";
import { CredentialUploadDialog } from "@/components/credential-upload-dialog";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Everything Gold Star holds, stored once. Each row is a policy or certificate;
 * accounts point at these rather than carrying their own copy.
 */
export function CredentialsLibrary({ locationId }: { locationId: string | null }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CompanyCredential | "new" | null>(null);
  const [risk, setRisk] = useState<CompanyCredential | null>(null);
  const [uploading, setUploading] = useState(false);

  const creds = useQuery({
    queryKey: ["company-credentials", locationId],
    queryFn: () => fetchCredentials({ locationId }),
  });

  const locations = useQuery({
    queryKey: ["locations-min"],
    queryFn: async () => {
      const { data, error } = await supabase.from("locations").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const people = useQuery({
    queryKey: ["profiles-min"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = useMemo(() => creds.data ?? [], [creds.data]);
  // One expiry, every consequence — networks and accounts that lean on it.
  const impact = useQuery({ queryKey: ["credential-impact"], queryFn: fetchCredentialImpact });
  const locName = (id: string | null) =>
    id ? ((locations.data ?? []).find((l) => l.id === id)?.name ?? "Office") : "All entities";
  const person = (id: string | null) =>
    id ? ((people.data ?? []).find((p) => p.user_id === id)?.full_name ?? "Staff") : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted-foreground">
          Held once, per legal entity or by the person who sat the exam.
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[12px]"
            disabled={app.writesDisabled}
            onClick={() => setUploading(true)}
          >
            <FileUp className="mr-1 size-3" /> Upload certificate
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            disabled={app.writesDisabled}
            onClick={() => setEditing("new")}
          >
            <Plus className="mr-1 size-3" /> Credential
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-[6px] border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Credential</th>
              <th className="px-2 py-1.5 text-left font-medium">Held by</th>
              <th className="px-2 py-1.5 text-left font-medium">Carrier / issuer</th>
              <th className="px-2 py-1.5 text-left font-medium">Limits</th>
              <th className="px-2 py-1.5 text-left font-medium">Expires</th>
              <th className="px-2 py-1.5 text-left font-medium">Status</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const st = credentialStatus(c);
              const d = daysToExpiry(c.expiry_date);
              return (
                <tr key={c.id} className="border-t hover:bg-muted/40">
                  <td className="px-2 py-1.5">
                    <button className="hover:underline" onClick={() => setEditing(c)}>
                      {c.name || credentialLabel(c.kind)}
                    </button>
                    {c.state_code && (
                      <span className="ml-1 text-[10px] text-muted-foreground">{c.state_code}</span>
                    )}
                    {impactSentence(impact.data?.get(c.id)) && (
                      <div className="text-[10px] text-muted-foreground">
                        {impactSentence(impact.data?.get(c.id))}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {person(c.holder_user_id) ?? locName(c.holder_location_id)}
                  </td>
                  <td className="px-2 py-1.5">
                    {c.carrier || c.issuer || "—"}
                    {c.policy_number && (
                      <span className="ml-1 text-muted-foreground">· {c.policy_number}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {c.limit_occurrence != null ? formatLimit(c.limit_occurrence, c.currency) : "—"}
                    {c.limit_aggregate != null &&
                      ` / ${formatLimit(c.limit_aggregate, c.currency)}`}
                  </td>
                  <td className="px-2 py-1.5">
                    {c.expiry_date
                      ? new Date(`${c.expiry_date}T00:00:00`).toLocaleDateString(
                          DATE_LOCALE,
                          US_DATE,
                        )
                      : "—"}
                    {d != null && d >= 0 && st !== "active" && (
                      <span className="ml-1 text-muted-foreground">({d}d)</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge
                      variant="outline"
                      className={`h-4 rounded-[4px] px-1.5 text-[10px] ${CREDENTIAL_STATUS_TONE[st]}`}
                    >
                      {CREDENTIAL_STATUS_LABEL[st]}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => setRisk(c)}
                    >
                      <Users className="mr-1 size-3" /> At risk
                    </Button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">
                  {creds.isLoading ? "Loading…" : "Nothing in the library yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {uploading && (
        <CredentialUploadDialog
          locations={locations.data ?? []}
          defaultLocationId={locationId}
          onClose={() => setUploading(false)}
          onSaved={() => {
            setUploading(false);
            void qc.invalidateQueries({ queryKey: ["company-credentials"] });
            void qc.invalidateQueries({ queryKey: ["credential-impact"] });
          }}
        />
      )}

      {editing && (
        <CredentialDialog
          credential={editing === "new" ? null : editing}
          locations={locations.data ?? []}
          people={(people.data ?? []) as { user_id: string; full_name: string | null }[]}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["company-credentials"] });
          }}
        />
      )}
      {risk && <AtRiskDialog credential={risk} onClose={() => setRisk(null)} />}
    </div>
  );
}

function AtRiskDialog({
  credential,
  onClose,
}: {
  credential: CompanyCredential;
  onClose: () => void;
}) {
  const at = useQuery({
    queryKey: ["credential-risk", credential.id],
    queryFn: () => fetchAccountsAtRisk(credential.id),
  });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            Clients relying on {credential.name || credentialLabel(credential.kind)}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto text-[12px]">
          {(at.data ?? []).map((a) => (
            <Link
              key={`${a.account_id}-${a.requirement_type}`}
              to="/accounts/$id"
              params={{ id: a.account_id }}
              className="block rounded-[4px] px-1.5 py-1 hover:bg-muted"
            >
              {a.account_name}
              <span className="ml-1 text-muted-foreground">
                · {credentialLabel(a.requirement_type)}
              </span>
            </Link>
          ))}
          {!at.isLoading && (at.data ?? []).length === 0 && (
            <p className="text-muted-foreground">No client requires this today.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CredentialDialog({
  credential,
  locations,
  people,
  onClose,
  onSaved,
}: {
  credential: CompanyCredential | null;
  locations: { id: string; name: string }[];
  people: { user_id: string; full_name: string | null }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const [kind, setKind] = useState(credential?.kind ?? "general_liability");
  const [name, setName] = useState(credential?.name ?? "");
  const [carrier, setCarrier] = useState(credential?.carrier ?? "");
  const [issuer, setIssuer] = useState(credential?.issuer ?? "");
  const [policy, setPolicy] = useState(credential?.policy_number ?? "");
  const [occ, setOcc] = useState(
    credential?.limit_occurrence != null ? String(credential.limit_occurrence) : "",
  );
  const [agg, setAgg] = useState(
    credential?.limit_aggregate != null ? String(credential.limit_aggregate) : "",
  );
  const [effective, setEffective] = useState(credential?.effective_date ?? "");
  const [expiry, setExpiry] = useState(credential?.expiry_date ?? "");
  const [state, setState] = useState(credential?.state_code ?? "");
  const [holderLoc, setHolderLoc] = useState(credential?.holder_location_id ?? "all");
  const [holderUser, setHolderUser] = useState(credential?.holder_user_id ?? "none");
  const [notes, setNotes] = useState(credential?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const meta = credentialKind(kind);

  const save = async () => {
    setBusy(true);
    const payload = {
      category: meta?.category ?? "insurance",
      kind,
      name: name || null,
      carrier: carrier || null,
      issuer: issuer || null,
      policy_number: policy || null,
      limit_occurrence: occ ? Number(occ) : null,
      limit_aggregate: agg ? Number(agg) : null,
      effective_date: effective || null,
      expiry_date: expiry || null,
      state_code: state || null,
      holder_location_id: holderLoc === "all" ? null : holderLoc,
      holder_user_id: holderUser === "none" ? null : holderUser,
      notes: notes || null,
      created_by: app.userId,
    };
    const { error } = credential
      ? await supabase.from("company_credentials").update(payload).eq("id", credential.id)
      : await supabase.from("company_credentials").insert(payload);
    setBusy(false);
    if (error) {
      toastDbError(error, { action: "Save credential" });
      return;
    }
    toast.success("Credential saved");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {credential ? "Edit credential" : "Add credential"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[11px]">Type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="h-8 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["insurance", "certification", "licence"] as const).map((g) => (
                  <div key={g}>
                    <div className="px-2 py-1 text-[10px] uppercase text-muted-foreground">
                      {CATEGORY_LABEL[g]}
                    </div>
                    {CREDENTIAL_CATALOG.filter((k) => k.category === g).map((k) => (
                      <SelectItem key={k.key} value={k.key}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Text label="Label" value={name} onChange={setName} placeholder="CGL 2026" />
            <Text
              label={meta?.category === "insurance" ? "Carrier" : "Issued by"}
              value={meta?.category === "insurance" ? carrier : issuer}
              onChange={meta?.category === "insurance" ? setCarrier : setIssuer}
            />
            <Text label="Policy / certificate number" value={policy} onChange={setPolicy} />
            {meta?.stateScoped && <Text label="State" value={state} onChange={setState} />}
            {meta?.hasLimits && (
              <>
                <Text label="Per occurrence" value={occ} onChange={setOcc} numeric />
                <Text label="Aggregate" value={agg} onChange={setAgg} numeric />
              </>
            )}
            <Text label="Effective" value={effective} onChange={setEffective} date />
            <Text label="Expires" value={expiry} onChange={setExpiry} date />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px]">Held by entity</Label>
              <Select value={holderLoc} onValueChange={setHolderLoc}>
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All entities</SelectItem>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">Held by person</Label>
              <Select value={holderUser} onValueChange={setHolderUser}>
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not personal</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name ?? "Staff"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Textarea
            className="text-[12px]"
            rows={2}
            placeholder="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button size="sm" onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Text({
  label,
  value,
  onChange,
  placeholder,
  numeric,
  date,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  numeric?: boolean;
  date?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px]">{label}</Label>
      <Input
        className="h-8 text-[12px]"
        type={date ? "date" : "text"}
        inputMode={numeric ? "numeric" : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
