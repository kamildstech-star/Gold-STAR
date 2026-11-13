import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BackLink } from "@/components/back-link";
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, LogOut } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { CompanyHierarchyPanel } from "@/components/company-hierarchy-panel";
import { LocationPicker } from "@/components/location-picker";
import { AccountFunctionPicker } from "@/components/account-function-picker";
import { AccountLocationsPicker } from "@/components/account-locations-picker";
import { LeadSourcePicker } from "@/components/lead-source-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import { servingLocationIds } from "@/lib/account-locations";
import { isMissingSchema } from "@/lib/schema-fallback";

import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABEL,
  type AccountStatus,
} from "@/lib/accounts";
import { useAccountTypes } from "@/lib/account-types";

/**
 * Adding a company is two steps, not one page and a hunt.
 *
 * The client's complaint was that the structure of a customer — regional over
 * corporate over the super who runs the building — is exactly what he is told
 * at the moment he adds them, and the only place to record it was a panel on a
 * detail page he had to go and find afterwards. So the account row is still
 * created by step one on its own (nothing here may stop a company being
 * created), and step two is that same panel, handed the id that step one just
 * produced.
 *
 * The id lives in the URL rather than in component state so a reload, or a
 * Back out of the account page, lands on the structure step for the company
 * that was actually created instead of an empty form.
 */
interface NewAccountSearch {
  /** Id of the account step one created. Absent means step one. */
  created?: string;
}

export const Route = createFileRoute("/_authenticated/accounts/new")({
  // SearchSchemaInput so every existing plain link to /accounts/new keeps
  // working: arriving with no search at all is step one, which is what those
  // links have always meant.
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): NewAccountSearch => ({
    created: typeof raw["created"] === "string" && raw["created"] ? raw["created"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "New account · Recovery Hub" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: NewAccount,
});

function NewAccount() {
  const { created } = Route.useSearch();
  return created ? <CompanyStructureStep accountId={created} /> : <NewAccountForm />;
}

function NewAccountForm() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [name, setName] = useState("");
  /**
   * The type is a managed list, not the four-value legacy enum this screen used
   * to render — src/lib/account-types.ts: "nothing in the UI may hardcode the
   * set". It mattered the moment Homeowner was added, because the type now
   * decides whether an account's follow-up clocks run at all, and a type nobody
   * can select is a rule nobody can apply. The key still goes into
   * `account_type`; the trigger fills `account_type_id` from it.
   */
  const accountTypes = useAccountTypes();
  const [type, setType] = useState<string>("property_management");
  const [status, setStatus] = useState<AccountStatus>("prospect");
  const [locationId, setLocationId] = useState<string>("");
  const [whatTheyDo, setWhatTheyDo] = useState<string[]>([]);
  const [servedBy, setServedBy] = useState<string[]>([]);
  const [multi, setMulti] = useState(false);
  const [notes, setNotes] = useState("");
  const [leadSourceId, setLeadSourceId] = useState("");
  const [leadSourceDetail, setLeadSourceDetail] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const canSubmit = name.trim().length > 1 && !!locationId && whatTheyDo.length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit || !userId) return;
    setSaving(true);
    const payload = {
      name: name.trim(),
      account_type: type,
      status,
      location_id: locationId,
      assigned_rep: userId,
      what_they_do: whatTheyDo,
      notes: notes.trim() || null,
      lead_source_id: leadSourceId || null,
      lead_source_detail: leadSourceDetail.trim() || null,
      created_by: userId,
    };
    // The multi-location flag ships in a migration that is written but not
    // applied. Until then the account is still created and the serving
    // offices still land in account_locations; only the flag is lost.
    let res = await supabase
      .from("accounts")
      .insert({ ...payload, is_multi_location: multi })
      .select("id")
      .single();
    if (res.error && isMissingSchema(res.error)) {
      res = await supabase.from("accounts").insert(payload).select("id").single();
    }
    const { data, error } = res;
    setSaving(false);
    if (error || !data) {
      toastDbError(error ?? new Error("no row returned"), { action: "Creating account" });
      return;
    }
    const servingIds = servingLocationIds(locationId, servedBy, multi);
    await supabase
      .from("account_locations")
      .insert(servingIds.map((lid) => ({ account_id: data.id, location_id: lid })));
    toast.success("Account created");
    // Straight on to who's who, with the company already saved. Nothing below
    // this point can lose it — the worst case is the user closes the tab and
    // the company is still there, structure empty.
    navigate({ to: "/accounts/new", search: { created: data.id } });
  };

  return (
    <div className="min-h-full bg-muted/20">
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <BackLink
                fallbackTo="/accounts"
                fallbackSearch={{ status: "active_pipeline", q: "" }}
                label="Accounts"
              >
                <ArrowLeft className="mr-1.5 size-4" />
                Accounts
              </BackLink>
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/auth" });
            }}
          >
            <LogOut className="mr-1.5 size-4" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-3 py-4 sm:px-4">
        <Card>
          <CardHeader>
            <CardTitle>New account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="name">Company name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Property Management"
                className="h-11"
              />
              <p className="text-xs text-muted-foreground">
                Before adding, use the"Is this company already ours?" search on the board — a
                different office may already own them.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Account type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(accountTypes.options.length > 0
                      ? accountTypes.options.map((o) => ({ key: o.key, label: o.label }))
                      : // The list has not loaded (or the office has emptied it).
                        // Falling back to the legacy four keeps the form usable
                        // rather than offering an empty dropdown.
                        ACCOUNT_TYPES.map((t) => ({ key: t, label: ACCOUNT_TYPE_LABEL[t] }))
                    ).map((o) => (
                      <SelectItem key={o.key} value={o.key}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as AccountStatus)}>
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {ACCOUNT_STATUS_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <LocationPicker
              value={locationId}
              onChange={setLocationId}
              label="Owning office"
              className="space-y-1.5"
            />

            <AccountFunctionPicker value={whatTheyDo} onChange={setWhatTheyDo} />

            <LeadSourcePicker
              valueId={leadSourceId}
              onValueChange={setLeadSourceId}
              detail={leadSourceDetail}
              onDetailChange={setLeadSourceDetail}
              className="space-y-1.5"
            />

            <AccountLocationsPicker
              value={servedBy}
              onChange={setServedBy}
              owningLocationId={locationId}
              multi={multi}
              onMultiChange={setMulti}
            />

            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="How we got connected, decision structure, quirks"
                rows={4}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                onClick={() =>
                  navigate({ to: "/accounts", search: { status: "active_pipeline", q: "" } })
                }
              >
                Cancel
              </Button>
              <Button onClick={submit} disabled={!canSubmit}>
                {saving ? "Creating…" : "Create account"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

/**
 * Step two: the company exists, now say who is in it.
 *
 * This is the identical panel the account page shows — same reads, same
 * writes, same degraded behaviour when the migration hasn't landed — handed the
 * id step one just created. There is no second implementation of the tree to
 * drift out of step with the first, and anything added here is already on the
 * account by the time the user opens it.
 */
function CompanyStructureStep({ accountId }: { accountId: string }) {
  const navigate = useNavigate();

  const accountQ = useQuery({
    queryKey: ["new-account-name", accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("name")
        .eq("id", accountId)
        .maybeSingle();
      if (error) throw error;
      return data?.name ?? null;
    },
  });
  const companyName = accountQ.data ?? "the company";

  const openAccount = () => navigate({ to: "/accounts/$id", params: { id: accountId } });

  return (
    <div className="min-h-full bg-muted/20">
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={openAccount}>
            <ArrowLeft className="mr-1.5 size-4" />
            {accountQ.data ?? "Company"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/auth" });
            }}
          >
            <LogOut className="mr-1.5 size-4" />
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-3 py-4 sm:px-4">
        <div className="rounded-xl border bg-card px-4 py-3 sm:px-5">
          <p className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            <Check className="size-4 text-success" />
            {companyName} is saved
          </p>
          {/*
            Said plainly because the button below is a real exit, not a
            half-finished form: the company is already a company whether or not
            anybody is added here.
          */}
          <p className="mt-1 text-[12px] text-muted-foreground">
            While you have it in front of you, put in who you deal with there and who they answer
            to. You can stop at any point — the company is already saved, and this same panel is on
            its page whenever you want to come back to it.
          </p>
        </div>

        <CompanyHierarchyPanel accountId={accountId} />

        <div className="flex flex-wrap justify-end gap-2 pb-6">
          <Button
            variant="ghost"
            onClick={() => navigate({ to: "/accounts/new", search: { created: undefined } })}
          >
            Add another company
          </Button>
          <Button onClick={openAccount}>
            Open {accountQ.data ?? "the company"}
            <ArrowRight className="ml-1.5 size-4" />
          </Button>
        </div>
      </main>
    </div>
  );
}
