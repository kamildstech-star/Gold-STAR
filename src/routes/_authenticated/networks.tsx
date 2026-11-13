import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Network as NetworkIcon, Plus, Settings2 } from "lucide-react";

import { PageHeader } from "@/components/ui-density";
import { RecordLoadError } from "@/components/record-load-error";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
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
import { COMPLIANCE_STATUS_LABEL, COMPLIANCE_STATUS_TONE, formatLimit } from "@/lib/compliance";
import {
  CATEGORY_LABEL,
  CREDENTIAL_CATALOG,
  credentialLabel,
  type CredentialCategory,
} from "@/lib/credentials";
import {
  NETWORK_PROGRAMS,
  NETWORK_STATUS_LABEL,
  NETWORK_STATUS_TONE,
  fetchMemberships,
  fetchNetworkRequirements,
  fetchNetworks,
  progressOf,
  type Membership,
  type NetworkRequirementRow,
  type NetworkStatus,
} from "@/lib/networks";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/networks")({
  head: () => ({
    meta: [
      { title: "Networks — Gold Star Recovery Hub" },
      {
        name: "description",
        content:
          "DKI, Sublynk and other restoration networks: membership per legal entity, credentialing status, programs serviced and the paperwork each one demands.",
      },
      { property: "og:title", content: "Networks — Gold Star Recovery Hub" },
      {
        property: "og:description",
        content:
          "Network membership by entity with compliance progress, states serviced and the next credential to expire.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  errorComponent: ({ error }) => (
    <RecordLoadError error={error} record="Networks" table="networks" />
  ),
  notFoundComponent: () => <div className="p-6 text-sm">Not found.</div>,
  component: NetworksPage,
});

function NetworksPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Membership | null>(null);
  const [adding, setAdding] = useState(false);

  const networks = useQuery({ queryKey: ["networks"], queryFn: fetchNetworks });
  const memberships = useQuery({
    queryKey: ["network-memberships"],
    queryFn: () => fetchMemberships(),
  });
  const rows = useQuery({
    queryKey: ["network-requirements"],
    queryFn: () => fetchNetworkRequirements(),
  });

  const byMembership = useMemo(() => {
    const m = new Map<string, NetworkRequirementRow[]>();
    for (const r of rows.data ?? []) {
      const list = m.get(r.membership_id) ?? [];
      list.push(r);
      m.set(r.membership_id, list);
    }
    return m;
  }, [rows.data]);

  const locName = (id: string) =>
    app.allLocations.find((l) => l.id === id)?.code ??
    app.allLocations.find((l) => l.id === id)?.name ??
    "—";

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["network-memberships"] });
    void qc.invalidateQueries({ queryKey: ["network-requirements"] });
    void qc.invalidateQueries({ queryKey: ["networks"] });
  };

  const loading = networks.isLoading || memberships.isLoading || rows.isLoading;

  return (
    <div className="space-y-3 p-3">
      <PageHeader title="Networks" count={(memberships.data ?? []).length}>
        <Button
          size="sm"
          className="h-7 text-[12px]"
          disabled={app.writesDisabled}
          onClick={() => setAdding(true)}
        >
          <Plus className="mr-1 size-3" /> Add membership
        </Button>
      </PageHeader>
      <p className="text-[12px] text-muted-foreground">
        DKI, Sublynk and similar. Requirements are answered from the one credentials library —
        nothing is uploaded twice.
      </p>

      {loading && <p className="text-[12px] text-muted-foreground">Loading…</p>}

      {!loading && (memberships.data ?? []).length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          No network memberships yet. Add one to track what DKI or Sublynk demand of each entity.
        </p>
      )}

      <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-[6px] border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Network</th>
              <th className="px-2 py-1.5 text-left font-medium">Entity</th>
              <th className="px-2 py-1.5 text-left font-medium">Status</th>
              <th className="px-2 py-1.5 text-left font-medium">States</th>
              <th className="px-2 py-1.5 text-left font-medium">Programs</th>
              <th className="px-2 py-1.5 text-left font-medium">Progress</th>
              <th className="px-2 py-1.5 text-left font-medium">Next expiry</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {(memberships.data ?? []).map((m) => {
              const reqs = byMembership.get(m.id) ?? [];
              const p = progressOf(reqs);
              const net = networks.data?.find((n) => n.id === m.network_id);
              return (
                <tr key={m.id} className="border-t align-top hover:bg-muted/40">
                  <td className="px-2 py-1.5">
                    <button className="font-medium hover:underline" onClick={() => setOpen(m)}>
                      <NetworkIcon className="mr-1 inline size-3" />
                      {net?.name ?? "—"}
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    {m.entity_name}
                    <div className="text-[10px] text-muted-foreground">
                      {locName(m.location_id)}
                      {m.member_id ? ` · ${m.member_id}` : ""}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge
                      variant="outline"
                      className={`h-4 rounded-[4px] px-1.5 text-[10px] ${NETWORK_STATUS_TONE[m.status]}`}
                    >
                      {NETWORK_STATUS_LABEL[m.status]}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5">{m.states_serviced.join(", ") || "—"}</td>
                  <td className="max-w-[220px] px-2 py-1.5 text-[11px] text-muted-foreground">
                    {m.programs.length
                      ? m.programs
                          .map((k) => NETWORK_PROGRAMS.find((p2) => p2.key === k)?.label ?? k)
                          .join(", ")
                      : "—"}
                  </td>
                  <td className="w-[140px] px-2 py-1.5">
                    <div className="text-[11px]">
                      {p.complete} of {p.total} complete
                    </div>
                    <Progress
                      value={p.total ? Math.round((p.complete / p.total) * 100) : 0}
                      className="mt-0.5 h-1.5"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    {p.nextExpiry
                      ? new Date(`${p.nextExpiry}T00:00:00`).toLocaleDateString(
                          DATE_LOCALE,
                          US_DATE,
                        )
                      : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => setOpen(m)}
                    >
                      <Settings2 className="mr-1 size-3" /> Open
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {open && (
        <MembershipDialog
          membership={open}
          networkName={networks.data?.find((n) => n.id === open.network_id)?.name ?? "Network"}
          rows={byMembership.get(open.id) ?? []}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            refresh();
          }}
        />
      )}
      {adding && (
        <AddMembershipDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** Membership detail: status, states, programmes and the requirement chips. */
function MembershipDialog({
  membership,
  networkName,
  rows,
  onClose,
  onSaved,
}: {
  membership: Membership;
  networkName: string;
  rows: NetworkRequirementRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const disabled = app.writesDisabled;
  const [status, setStatus] = useState<NetworkStatus>(membership.status);
  const [states, setStates] = useState(membership.states_serviced.join(", "));
  const [memberId, setMemberId] = useState(membership.member_id ?? "");
  const [programs, setPrograms] = useState<Set<string>>(new Set(membership.programs));
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
  const [busy, setBusy] = useState(false);
  const p = progressOf(rows);

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    apply(next);
  };

  const save = async () => {
    setBusy(true);
    const { error: mErr } = await supabase
      .from("network_memberships")
      .update({
        status,
        member_id: memberId || null,
        programs: [...programs],
        states_serviced: states
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      })
      .eq("id", membership.id);
    if (mErr) {
      setBusy(false);
      toastDbError(mErr, { action: "Save membership" });
      return;
    }

    const keys = [...selected];
    if (keys.length) {
      const { error } = await supabase.from("network_requirements").upsert(
        keys.map((key) => ({
          membership_id: membership.id,
          requirement_type: key,
          required_amount: limits[key] ? Number(limits[key]) : null,
          active: true,
          created_by: app.userId,
        })),
        { onConflict: "membership_id,requirement_type" },
      );
      if (error) {
        setBusy(false);
        toastDbError(error, { action: "Save requirements" });
        return;
      }
    }
    const removed = rows
      .filter((r) => !selected.has(r.requirement_type))
      .map((r) => r.requirement_id);
    if (removed.length) {
      const { error } = await supabase.from("network_requirements").delete().in("id", removed);
      if (error) {
        setBusy(false);
        toastDbError(error, { action: "Remove requirements" });
        return;
      }
    }
    setBusy(false);
    toast.success("Membership saved");
    onSaved();
  };

  const groups: CredentialCategory[] = ["insurance", "certification", "licence"];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {networkName} — {membership.entity_name}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Compliance status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as NetworkStatus)}>
              <SelectTrigger className="h-7 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(NETWORK_STATUS_LABEL) as NetworkStatus[]).map((s) => (
                  <SelectItem key={s} value={s} className="text-[12px]">
                    {NETWORK_STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">States serviced</Label>
            <Input
              className="h-7 text-[12px]"
              placeholder="NC, VA"
              value={states}
              onChange={(e) => setStates(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Member ID</Label>
            <Input
              className="h-7 text-[12px]"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
            />
          </div>
        </div>

        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            Selected programs
          </div>
          <div className="mt-1 grid gap-1 sm:grid-cols-3">
            {NETWORK_PROGRAMS.map((prog) => (
              <label
                key={prog.key}
                className="flex cursor-pointer items-center gap-2 rounded-[6px] border px-2 py-1 text-[12px]"
              >
                <Checkbox
                  checked={programs.has(prog.key)}
                  onCheckedChange={() => toggle(programs, prog.key, setPrograms)}
                />
                <span>
                  <span className="text-muted-foreground">{prog.group} · </span>
                  {prog.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-[6px] border bg-card px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium">
              {p.complete} of {p.total} complete
            </span>
            {p.nextExpiry && (
              <span className="text-[11px] text-muted-foreground">
                Next expiry{" "}
                {new Date(`${p.nextExpiry}T00:00:00`).toLocaleDateString(DATE_LOCALE, US_DATE)}
              </span>
            )}
          </div>
          <Progress
            value={p.total ? Math.round((p.complete / p.total) * 100) : 0}
            className="mt-1 h-1.5"
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {rows.map((r) => (
              <span
                key={r.requirement_id}
                className={`rounded-[6px] border px-2 py-1 text-[11px] ${COMPLIANCE_STATUS_TONE[r.status]}`}
                title={
                  r.credential_id
                    ? `${r.credential_name ?? ""} ${r.carrier ?? ""} ${
                        r.covered_amount != null
                          ? formatLimit(r.covered_amount, r.currency ?? "USD")
                          : ""
                      }`.trim()
                    : "Nothing in the library matches this"
                }
              >
                <span className="font-medium">{credentialLabel(r.requirement_type)}</span>
                <span className="ml-1 opacity-75">{COMPLIANCE_STATUS_LABEL[r.status]}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="text-[11px] font-medium uppercase text-muted-foreground">
            Required insurance and credentials
          </div>
          {groups.map((g) => (
            <div key={g} className="space-y-1">
              <div className="text-[11px] text-muted-foreground">{CATEGORY_LABEL[g]}</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {CREDENTIAL_CATALOG.filter((k) => k.category === g).map((k) => {
                  const on = selected.has(k.key);
                  return (
                    <div
                      key={k.key}
                      className={`rounded-[6px] border px-2 py-1.5 ${on ? "border-primary/60 bg-primary/5" : "bg-card"}`}
                    >
                      <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                        <Checkbox
                          checked={on}
                          onCheckedChange={() => toggle(selected, k.key, setSelected)}
                        />
                        <span className="flex-1">{k.label}</span>
                      </label>
                      {on && k.hasLimits && (
                        <NumberInput
                          className="mt-1 h-7 text-[11px]"
                          decimals={0}
                          placeholder="Required limit, e.g. 2,000,000"
                          value={limits[k.key] ?? ""}
                          onValueChange={(_, clean) =>
                            setLimits((prev) => ({ ...prev, [k.key]: clean }))
                          }
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy || disabled}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A network plus the entity that joined it — created together. */
function AddMembershipDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const app = useAppContext();
  const networks = useQuery({ queryKey: ["networks"], queryFn: fetchNetworks });
  const [networkId, setNetworkId] = useState<string>("");
  const [newNetwork, setNewNetwork] = useState("");
  const [locationId, setLocationId] = useState<string>("");
  const [entity, setEntity] = useState("");
  const [busy, setBusy] = useState(false);

  const loc = app.allLocations.find((l) => l.id === locationId);
  const suggested = loc ? `Gold Star Restoration - ${loc.code}` : "";

  const save = async () => {
    if (!locationId || (!networkId && !newNetwork.trim())) return;
    setBusy(true);
    let id = networkId;
    if (!id) {
      const { data, error } = await supabase
        .from("networks")
        .insert({ name: newNetwork.trim(), created_by: app.userId })
        .select("id")
        .single();
      if (error || !data) {
        setBusy(false);
        toastDbError(error, { action: "Create network" });
        return;
      }
      id = data.id;
    }
    const { error } = await supabase.from("network_memberships").insert({
      network_id: id,
      location_id: locationId,
      entity_name: entity.trim() || suggested,
      created_by: app.userId,
    });
    setBusy(false);
    if (error) {
      toastDbError(error, { action: "Add membership" });
      return;
    }
    toast.success("Membership added");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Add a network membership</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Network</Label>
            <Select value={networkId} onValueChange={setNetworkId}>
              <SelectTrigger className="h-7 text-[12px]">
                <SelectValue placeholder="Choose an existing network" />
              </SelectTrigger>
              <SelectContent>
                {(networks.data ?? []).map((n) => (
                  <SelectItem key={n.id} value={n.id} className="text-[12px]">
                    {n.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!networkId && (
              <Input
                className="h-7 text-[12px]"
                placeholder="…or type a new one, e.g. DKI"
                value={newNetwork}
                onChange={(e) => setNewNetwork(e.target.value)}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Entity / office</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="h-7 text-[12px]">
                <SelectValue placeholder="Choose an office" />
              </SelectTrigger>
              <SelectContent>
                {app.allLocations.map((l) => (
                  <SelectItem key={l.id} value={l.id} className="text-[12px]">
                    {l.code} — {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">
              Name they joined under
            </Label>
            <Input
              className="h-7 text-[12px]"
              placeholder={suggested || "Gold Star Restoration - NC"}
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={
              busy || app.writesDisabled || !locationId || (!networkId && !newNetwork.trim())
            }
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
