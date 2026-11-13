import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { LocationPicker } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLossTypes } from "@/lib/loss-categories";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { useAccountInference, useAutoLinkedAccount } from "@/lib/account-inference";
import { JobSearchField, type PickedJob } from "@/components/job-search-field";
import {
  CustomerPicker,
  PriorJobsBanner,
  customerFromPriorJob,
  emptyCustomer,
  type CustomerKind,
  type PickedCustomer,
} from "@/components/customer-picker";

export const Route = createFileRoute("/_authenticated/projects/new")({
  head: () => ({
    meta: [
      { title: "New project · Recovery Hub" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: NewProject,
});

function NewProject() {
  const app = useAppContext();
  const navigate = useNavigate();

  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [lossTypeId, setLossTypeId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [job, setJob] = useState<PickedJob | null>(null);
  const [customerKind, setCustomerKind] = useState<CustomerKind>("person");
  const [customer, setCustomer] = useState<PickedCustomer>(() => emptyCustomer("person"));
  const [submitting, setSubmitting] = useState(false);

  const lossTypes = useLossTypes(locationId || null);
  useEffect(() => {
    if (!lossTypeId && lossTypes.defaultId) setLossTypeId(lossTypes.defaultId);
  }, [lossTypeId, lossTypes.defaultId]);

  const inference = useAccountInference({
    customer,
    address,
    typedName: customer.name,
  });
  const linked = useAutoLinkedAccount(inference, account, (a) => {
    setAccount(a);
    if (a) {
      if (!locationId) setLocationId(a.location_id);
    }
  });

  const applyCustomer = async (c: PickedCustomer) => {
    setCustomer(c);
    if (c.accountId && c.accountId !== account?.id) {
      const { data } = await supabase
        .from("accounts")
        .select("id, name, location_id")
        .eq("id", c.accountId)
        .maybeSingle();
      if (data) {
        setAccount({
          id: data.id,
          name: data.name,
          location_id: data.location_id,
          primary_contact: null,
        });
        if (!locationId) setLocationId(data.location_id);
      }
    }
  };

  const applyJob = async (j: PickedJob | null) => {
    setJob(j);
    if (!j) return;
    setAddress(j.address);
    if (!name.trim()) setName(j.job_name?.trim() || `${j.job_number} · ${j.address}`);
    setLocationId(j.location_id);
    if (j.loss_type_id) setLossTypeId(j.loss_type_id);
    if (j.customer_name) {
      setCustomer((prev) => ({ ...prev, name: j.customer_name as string }));
    }
    if (j.account_id) {
      const { data } = await supabase
        .from("accounts")
        .select("id, name, location_id")
        .eq("id", j.account_id)
        .maybeSingle();
      if (data)
        setAccount({
          id: data.id,
          name: data.name,
          location_id: data.location_id,
          primary_contact: null,
        });
    }
  };

  const disabled = app.writesDisabled || submitting || !address.trim() || !locationId;

  const submit = async () => {
    if (disabled) return;
    setSubmitting(true);
    const finalName = name.trim() || address.trim();
    const { data, error } = await supabase
      .from("projects")
      .insert({
        name: finalName,
        address: address.trim(),
        loss_type_id: lossTypeId,
        location_id: locationId,
        account_id: account?.id ?? null,
        job_id: job?.id ?? null,
        customer_name: customer.name.trim() || null,
        customer_phone:
          customer.methods.find((m) => m.kind === "phone" && m.value)?.value ??
          customer.phone ??
          null,
        customer_email:
          customer.methods.find((m) => m.kind === "email" && m.value)?.value ??
          customer.email ??
          null,
        created_by: app.userId,
      })
      .select("id")
      .single();
    if (error || !data) {
      toastDbError(error ?? new Error("no row returned"), { action: "Creating project" });
      setSubmitting(false);
      return;
    }
    // Add creator as owner-member so subsequent membership-scoped reads work.
    if (app.userId) {
      const { error: memberErr } = await supabase.from("project_members").insert({
        project_id: data.id,
        user_id: app.userId,
        member_role: "owner",
      });
      if (memberErr) {
        toastDbError(memberErr, { action: "Adding you as project owner" });
        setSubmitting(false);
        return;
      }
    }
    toast.success("Project created");
    navigate({ to: "/projects/$id", params: { id: data.id } });
  };

  return (
    <main className="mx-auto max-w-xl px-3 py-4 sm:px-4">
      <Card>
        <CardHeader>
          <CardTitle>New project</CardTitle>
          <p className="text-sm text-muted-foreground">
            One field is required — the address. Loss type and details are editable after.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <JobSearchField
            value={job}
            onChange={(j) => void applyJob(j)}
            label="Job (optional)"
            disabled={app.writesDisabled}
          />
          <div className="space-y-1.5">
            <Label htmlFor="addr">Address</Label>
            <Input
              id="addr"
              autoFocus
              placeholder="123 Main St, Brooklyn NY"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name">Name (optional)</Label>
            <Input
              id="name"
              placeholder={address || "Defaults to the address"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-11"
            />
          </div>
          <PriorJobsBanner
            address={address}
            onAdopt={async (j) => {
              const c = await customerFromPriorJob(j);
              setCustomerKind(c.kind);
              await applyCustomer(c);
              toast.success(`Customer taken from job ${j.job_number}`);
            }}
          />
          <CustomerPicker
            kind={customerKind}
            value={customer}
            defaultAccount={account}
            defaultLocationId={locationId}
            onChange={(c) => void applyCustomer(c)}
            label="Customer"
            disabled={app.writesDisabled}
          />
          <AccountPicker
            value={account}
            reason={linked.reason}
            suggestion={linked.suggestion}
            onAcceptSuggestion={linked.acceptSuggestion}
            onDismissSuggestion={linked.dismissSuggestion}
            onChange={(a) => {
              linked.onManualChange(a);
              if (a) setLocationId(a.location_id);
            }}
            disabled={app.writesDisabled}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Loss type</Label>
              <Select value={lossTypeId} onValueChange={setLossTypeId}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {lossTypes.options.map((lt) => (
                    <SelectItem key={lt.id} value={lt.id}>
                      {lt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <LocationPicker value={locationId} onChange={setLocationId} className="space-y-1.5" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => navigate({ to: "/projects", search: { f: "all" as const, q: "" } })}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={disabled}>
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
