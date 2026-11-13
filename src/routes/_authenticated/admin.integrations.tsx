import { browserAppOrigin } from "@/lib/app-origin";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Bot,
  Camera,
  ChevronDown,
  Copy,
  FileSignature,
  Flame,
  Mail,
  MapPin,
  Megaphone,
  PhoneCall,
  Play,
  Radio,
  RefreshCcw,
  Satellite,
  Search,
  Truck,
  Wrench,
} from "lucide-react";

import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import {
  integrationSecretStatus,
  probeGoogleMaps,
  syncKahiEquipmentNow,
  syncRavenFleet,
} from "@/lib/integrations.functions";
import {
  INTEGRATIONS,
  STATUS_LABEL,
  STATUS_TONE,
  loadIntegrationSignals,
  resolveStatus,
  type IntegrationSpec,
  type IntegrationStatusKey,
} from "@/lib/integration-catalog";
import {
  CredentialAuditTrail,
  IntegrationCredentialEditor,
  TestConnectionButton,
  useCredentialMeta,
  useTestResults,
} from "@/components/admin/integration-credentials";
import type { CredentialMetaDTO } from "@/lib/integration-credentials.functions";
import { GOOGLE_MAPS_BROWSER_KEY_ENV, googleMapsBrowserKey } from "@/lib/google-maps-loader";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/integrations")({
  head: () => ({
    meta: [
      { title: "Integrations — Recovery Hub" },
      {
        name: "description",
        content:
          "Every external connection Recovery Hub uses, with live status, the credential each one needs, and who supplies it.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: IntegrationsAdmin,
});

const ICONS: Record<string, typeof Mail> = {
  outlook: Mail,
  google_maps: MapPin,
  dialer: PhoneCall,
  callrail: PhoneCall,
  raven: Truck,
  kai: Satellite,
  propertyshark: Search,
  fire_feed: Flame,
  bnn: Radio,
  scanner: Radio,
  hpd: Wrench,
  esign: FileSignature,
  email_marketing: Megaphone,
  companycam: Camera,
  ai_gateway: Bot,
};

const WHO_LABEL: Record<string, string> = {
  client: "Gold Star supplies",
  vendor: "Vendor / public",
  us: "We generate",
};

const ORDER: IntegrationStatusKey[] = ["error", "pending", "not_connected", "connected"];

function IntegrationsAdmin() {
  const app = useAppContext();
  const { disabled: writesDisabled } = useWritesDisabled();
  const qc = useQueryClient();
  const canManage = app.roles.some((r) => ["admin", "owner", "dev"].includes(r));

  const secretsFn = useServerFn(integrationSecretStatus);
  const mapsFn = useServerFn(probeGoogleMaps);

  const secretsQ = useQuery({ queryKey: ["integration-secrets"], queryFn: () => secretsFn() });
  const signalsQ = useQuery({
    queryKey: ["integration-signals"],
    queryFn: loadIntegrationSignals,
    refetchInterval: 120_000,
  });
  const mapsQ = useQuery({
    queryKey: ["integration-maps-probe"],
    queryFn: () => mapsFn(),
    enabled: Boolean(secretsQ.data?.present["GOOGLE_MAPS_API_KEY"]),
    staleTime: 5 * 60_000,
  });

  const browserKeys = useMemo(
    () => ({ [GOOGLE_MAPS_BROWSER_KEY_ENV]: Boolean(googleMapsBrowserKey()) }),
    [],
  );

  const credsQ = useCredentialMeta(canManage);
  const testsQ = useTestResults(canManage);
  const testByProvider = useMemo(() => {
    const m = new Map<string, { ok: boolean; message: string | null; tested_at: string }>();
    for (const t of testsQ.data ?? []) m.set(t.provider, t);
    return m;
  }, [testsQ.data]);

  const resolved = useMemo(() => {
    if (!secretsQ.data || !signalsQ.data) return null;
    const probe = {
      secrets: secretsQ.data.present,
      browserKeys,
      signals: signalsQ.data,
      mapsProbe: mapsQ.data ?? null,
      aiModels: secretsQ.data.ai,
    };
    return INTEGRATIONS.map((spec) => {
      const base = resolveStatus(spec, probe);
      // A live test beats every other signal: green only ever follows a real
      // call that came back clean, red carries the provider's own message.
      const test = testByProvider.get(spec.id);
      if (test) {
        return {
          spec,
          ...base,
          status: (test.ok ? "connected" : "error") as IntegrationStatusKey,
          detail: test.message ?? base.detail,
        };
      }
      return { spec, ...base };
    });
  }, [secretsQ.data, signalsQ.data, mapsQ.data, browserKeys, testByProvider]);

  const counts = useMemo(() => {
    const c: Record<IntegrationStatusKey, number> = {
      connected: 0,
      pending: 0,
      not_connected: 0,
      error: 0,
    };
    for (const r of resolved ?? []) c[r.status] += 1;
    return c;
  }, [resolved]);

  const sorted = useMemo(
    () =>
      [...(resolved ?? [])].sort(
        (a, b) =>
          ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
          a.spec.name.localeCompare(b.spec.name),
      ),
    [resolved],
  );

  const loading = secretsQ.isLoading || signalsQ.isLoading;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Status is probed live — a card only turns green when the credential exists and something
          has actually come through.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: ["integration-secrets"] });
            void qc.invalidateQueries({ queryKey: ["integration-signals"] });
            void qc.invalidateQueries({ queryKey: ["integration-maps-probe"] });
          }}
        >
          <RefreshCcw className="mr-1 size-3.5" /> Re-check all
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {ORDER.map((s) => (
          <Card key={s}>
            <CardContent className="p-3">
              <div className="text-2xl font-semibold tabular-nums">{counts[s]}</div>
              <div className="text-xs text-muted-foreground">{STATUS_LABEL[s]}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {loading ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Probing connections…
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {sorted.map(({ spec, status, detail, missing }) => (
            <IntegrationCard
              key={spec.id}
              spec={spec}
              status={status}
              detail={detail}
              missing={missing}
              secrets={secretsQ.data?.present ?? {}}
              publicOrigin={secretsQ.data?.base_url ?? null}
              browserKeys={browserKeys}
              canManage={canManage}
              writesDisabled={writesDisabled}
              credMeta={credsQ.data ?? []}
              lastTest={testByProvider.get(spec.id) ?? null}
            />
          ))}
        </div>
      )}

      <CredentialAuditTrail enabled={canManage} />
    </div>
  );
}

function IntegrationCard({
  spec,
  status,
  detail,
  missing,
  secrets,
  browserKeys,
  canManage,
  writesDisabled,
  credMeta,
  lastTest,
  publicOrigin,
}: {
  spec: IntegrationSpec;
  status: IntegrationStatusKey;
  detail: string;
  missing: string[];
  secrets: Record<string, boolean>;
  browserKeys: Record<string, boolean>;
  /** The role may set credentials, test and sync. Without it those controls are not drawn. */
  canManage: boolean;
  /** View As preview: the controls show, switched off. */
  writesDisabled: boolean;
  credMeta: CredentialMetaDTO[];
  lastTest: { ok: boolean; message: string | null; tested_at: string } | null;
  publicOrigin: string | null;
}) {
  const Icon = ICONS[spec.id] ?? Wrench;
  const [setupOpen, setSetupOpen] = useState(false);
  // What a vendor must call is the deployment's public address
  // (PUBLIC_SITE_URL), not whichever host this admin happens to be on.
  const origin = publicOrigin ?? browserAppOrigin();

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-3 p-4">
        <div className="flex gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{spec.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {spec.vendor} · {spec.category}
                </div>
              </div>
              <Badge variant="outline" className={cn("shrink-0 text-[11px]", STATUS_TONE[status])}>
                {STATUS_LABEL[status]}
              </Badge>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{spec.powers}</p>
            <p
              className={cn(
                "mt-1.5 text-xs font-medium",
                status === "error" ? "text-destructive" : "text-foreground/80",
              )}
            >
              {detail}
            </p>
          </div>
        </div>

        <div className="space-y-2.5 rounded-sm border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Credentials
            </div>
            <div className="flex gap-1.5">
              {spec.credentials.map((c) => {
                const probeable = Boolean(c.secret || c.browser);
                const present = c.browser
                  ? browserKeys[c.name]
                  : c.secret
                    ? secrets[c.name] ||
                      credMeta.some((m) => m.provider === spec.id && m.key_name === c.name)
                    : undefined;
                return (
                  <span
                    key={c.name}
                    title={`${c.name} — ${probeable ? (present ? "set" : "missing") : WHO_LABEL[c.who]}`}
                    className={cn(
                      "size-1.5 rounded-full",
                      !probeable
                        ? "bg-muted-foreground/40"
                        : present
                          ? "bg-success"
                          : c.optional
                            ? "bg-warning"
                            : "bg-destructive",
                    )}
                  />
                );
              })}
            </div>
          </div>

          {canManage && (
            <IntegrationCredentialEditor
              spec={spec}
              meta={credMeta}
              writesDisabled={writesDisabled}
            />
          )}

          {canManage && (
            <TestConnectionButton
              provider={spec.id}
              writesDisabled={writesDisabled}
              last={lastTest}
            />
          )}

          <div className="pt-1 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/70">Who provides it: </span>
            {spec.suppliedBy}
          </div>
        </div>

        {spec.webhookPath && (
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">Inbound endpoint</Label>
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
                {origin}
                {spec.webhookPath}
              </code>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Copy endpoint"
                onClick={() => {
                  void navigator.clipboard.writeText(`${origin}${spec.webhookPath}`);
                  toast.success("Endpoint copied");
                }}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          </div>
        )}

        {spec.screens.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {spec.screens.map((s) => (
              <Button key={s.to} asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
                <Link to={s.to}>{s.label}</Link>
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Collapsible open={setupOpen} onOpenChange={setSetupOpen}>
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="outline">
                Setup
                <ChevronDown
                  className={cn("ml-1 size-3.5 transition-transform", setupOpen && "rotate-180")}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <ol className="list-decimal space-y-1 rounded-sm border border-dashed p-3 pl-6 text-xs text-muted-foreground">
                {spec.setup.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {missing.length > 0 && (
                <p className="mt-2 text-xs">
                  <span className="font-medium">Still needed: </span>
                  <span className="font-mono">{missing.join(", ")}</span> — add in Project Settings
                  → Secrets.
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>

          {spec.detailTo && (
            <Button asChild size="sm" variant="outline">
              <Link to={spec.detailTo}>{spec.detailLabel ?? "Mailboxes"}</Link>
            </Button>
          )}
          {canManage && spec.id === "hpd" && <RunHpdSync disabled={writesDisabled} />}
          {canManage && spec.id === "raven" && <RunRavenSync disabled={writesDisabled} />}
          {canManage && spec.id === "kai" && <RunKahiSync disabled={writesDisabled} />}
          {spec.undecided && (
            <Badge variant="outline" className="text-[10px]">
              Provider decision outstanding
            </Badge>
          )}
        </div>

        <ConnectionToggles
          provider={spec.id}
          canManage={canManage}
          writesDisabled={writesDisabled}
        />
      </CardContent>
    </Card>
  );
}

/** The live-sync providers keep per-office connection rows; show them inline. */
/** Only these providers exist in the integration_provider enum. */
const CONNECTION_PROVIDERS = new Set(["raven", "kai", "callrail", "outlook"]);

function ConnectionToggles({
  provider,
  canManage,
  writesDisabled,
}: {
  provider: string;
  /** Without it the switch is not drawn — the state shows as text. */
  canManage: boolean;
  writesDisabled: boolean;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["integration-connections", provider],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("integration_connections")
        .select(
          "id, display_name, external_account_ref, enabled, location_id, last_sync_at, last_error",
        )
        .eq("provider", provider as never);
      if (error) throw error;
      return data ?? [];
    },
    enabled: CONNECTION_PROVIDERS.has(provider),
    retry: false,
  });

  const rows = q.data ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {rows.map((c) => (
        <div
          key={c.id}
          className="flex items-center justify-between gap-2 rounded-sm border px-3 py-2 text-xs"
        >
          <div className="min-w-0">
            <div className="truncate font-medium">
              {c.display_name ?? c.external_account_ref ?? "Connection"}
            </div>
            <div className="truncate text-muted-foreground">
              {c.location_id
                ? (app.allLocations.find((l) => l.id === c.location_id)?.code ?? "location")
                : "All locations"}
              {c.last_error ? ` · error: ${c.last_error}` : ""}
            </div>
          </div>
          {!canManage ? (
            <span className="shrink-0 text-muted-foreground">{c.enabled ? "On" : "Off"}</span>
          ) : (
            <Switch
              checked={c.enabled}
              disabled={writesDisabled}
              aria-label={`${c.display_name ?? c.external_account_ref ?? "Connection"} enabled`}
              onCheckedChange={async (v) => {
                const { error } = await supabase
                  .from("integration_connections")
                  .update({ enabled: v })
                  .eq("id", c.id);
                if (error) {
                  toastDbError(error, { action: "update the connection" });
                  return;
                }
                void qc.invalidateQueries({ queryKey: ["integration-connections", provider] });
                void qc.invalidateQueries({ queryKey: ["integration-signals"] });
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Raven pulls positions on a 5-minute cron; this forces one now and shows
 * exactly what their API answered — including a raw payload sample — so a
 * credential rejection reads as the provider's own message, not "failed".
 */
function RunRavenSync({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const syncFn = useServerFn(syncRavenFleet);
  const [report, setReport] = useState<Awaited<ReturnType<typeof syncRavenFleet>> | null>(null);
  const run = useMutation({
    mutationFn: () => syncFn({ data: undefined }),
    onSuccess: (res) => {
      setReport(res);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      void qc.invalidateQueries({ queryKey: ["integration-connections", "raven"] });
      void qc.invalidateQueries({ queryKey: ["integration-signals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || run.isPending}
        onClick={() => run.mutate()}
      >
        <Play className="mr-1 size-3.5" /> {run.isPending ? "Syncing…" : "Sync Ravens"}
      </Button>
      {report && (
        <div className="mt-2 w-full rounded-md border bg-muted/40 p-2 text-[11px]">
          <p className={report.ok ? "text-foreground" : "text-destructive"}>{report.message}</p>
          {report.ok && (
            <p className="text-muted-foreground">
              {report.vehicles} Ravens · {report.positions} GPS positions
            </p>
          )}

          {report.sample && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
              {report.sample}
            </pre>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Kahi polls every 15 minutes; this forces a pull now and reports the asset
 * count, which tracking fields their payload actually carries, and the alerts
 * the sync raised — so "Connected" only ever follows a real live call.
 */
function RunKahiSync({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const syncFn = useServerFn(syncKahiEquipmentNow);
  const [report, setReport] = useState<Awaited<ReturnType<typeof syncKahiEquipmentNow>> | null>(
    null,
  );
  const run = useMutation({
    mutationFn: () => syncFn({}),
    onSuccess: (res) => {
      setReport(res);
      if (res.ok) toast.success(res.message);
      else if (res.partial) toast.warning(res.message);
      else toast.error(res.message);
      void qc.invalidateQueries({ queryKey: ["integration-connections", "kai"] });
      void qc.invalidateQueries({ queryKey: ["integration-signals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || run.isPending}
        onClick={() => run.mutate()}
      >
        <Play className="mr-1 size-3.5" /> {run.isPending ? "Syncing…" : "Sync equipment"}
      </Button>
      {report && (
        <div className="mt-2 w-full rounded-md border bg-muted/40 p-2 text-[11px]">
          <p className={report.ok ? "text-foreground" : "text-destructive"}>{report.message}</p>
          {(report.ok || report.partial) && (
            <>
              <p className="text-muted-foreground">
                {report.matched} matched · {report.created} new · {report.unmapped} unmapped shop ·{" "}
                {report.alerts.offsite + report.alerts.overdue + report.alerts.idle} open alerts
              </p>
              {report.failed.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-destructive">
                  {report.failed.map((f) => (
                    <li key={f.external_tracker_id}>
                      {f.asset_tag}: {f.reason}
                    </li>
                  ))}
                </ul>
              )}
              {report.fields.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  Fields provided: {report.fields.join(" · ")}
                </p>
              )}
            </>
          )}
          {report.sample && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
              {report.sample}
            </pre>
          )}
        </div>
      )}
    </>
  );
}

function RunHpdSync({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/public/hooks/sync-nyc-fire-leads", { method: "POST" });
      if (!res.ok) throw new Error(`Sync returned ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      toast.success("Sync finished");
      void qc.invalidateQueries({ queryKey: ["integration-signals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || run.isPending}
      onClick={() => run.mutate()}
    >
      <Play className="mr-1 size-3.5" /> {run.isPending ? "Syncing…" : "Run sync now"}
    </Button>
  );
}
