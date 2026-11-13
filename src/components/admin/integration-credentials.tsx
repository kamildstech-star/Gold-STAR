/**
 * Credential entry for one integration card.
 *
 * Values are write-only from the browser's point of view: once saved the UI
 * shows a mask and a timestamp, and editing replaces the stored value rather
 * than reading it back. Nothing here ever receives plaintext from the server.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Check, Globe, KeyRound, Loader2, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import {
  deleteIntegrationCredential,
  listIntegrationCredentials,
  saveIntegrationCredential,
  testIntegrationConnection,
  type CredentialMetaDTO,
} from "@/lib/integration-credentials.functions";
import type { IntegrationSpec } from "@/lib/integration-catalog";
import { cn } from "@/lib/utils";

export function useCredentialMeta(enabled: boolean) {
  const listFn = useServerFn(listIntegrationCredentials);
  return useQuery({
    queryKey: ["integration-credentials"],
    queryFn: () => listFn(),
    enabled,
    staleTime: 30_000,
  });
}

export function useTestResults(enabled: boolean) {
  return useQuery({
    queryKey: ["integration-test-results"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("integration_test_results")
        .select("provider, ok, message, tested_at");
      if (error) throw error;
      return data ?? [];
    },
    enabled,
    retry: false,
  });
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Drawn only for someone who may manage integrations — the page leaves it out
 * for everyone else. `writesDisabled` is the View As preview: shown, switched off.
 */
export function IntegrationCredentialEditor({
  spec,
  meta,
  writesDisabled = false,
}: {
  spec: IntegrationSpec;
  meta: CredentialMetaDTO[];
  writesDisabled?: boolean;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveIntegrationCredential);
  const delFn = useServerFn(deleteIntegrationCredential);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const stored = new Map(meta.filter((m) => m.provider === spec.id).map((m) => [m.key_name, m]));

  const save = useMutation({
    mutationFn: (vars: { keyName: string; value: string; isPublic: boolean }) =>
      saveFn({ data: { provider: spec.id, ...vars } }),
    onSuccess: (_res, vars) => {
      setDrafts((d) => ({ ...d, [vars.keyName]: "" }));
      toast.success(`${vars.keyName} saved — test the connection to confirm it works.`);
      void qc.invalidateQueries({ queryKey: ["integration-credentials"] });
      void qc.invalidateQueries({ queryKey: ["integration-credential-audit"] });
      void qc.invalidateQueries({ queryKey: ["integration-secrets"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (keyName: string) => delFn({ data: { provider: spec.id, keyName } }),
    onSuccess: () => {
      toast.success("Credential removed.");
      void qc.invalidateQueries({ queryKey: ["integration-credentials"] });
      void qc.invalidateQueries({ queryKey: ["integration-credential-audit"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-2.5">
      {spec.credentials.map((c) => {
        const row = stored.get(c.name);
        const draft = drafts[c.name] ?? "";
        const isPublic = Boolean(c.browser);
        return (
          <div key={c.name} className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] font-medium">{c.name}</span>
              {c.optional && <span className="text-[10px] text-muted-foreground">(optional)</span>}
              {isPublic ? (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Globe className="size-3" /> Public key
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <KeyRound className="size-3" /> Encrypted
                </Badge>
              )}
              {row && (
                <span className="text-[10px] text-muted-foreground">
                  {row.masked} · updated {ago(row.updated_at)}
                  {row.updated_by_name ? ` by ${row.updated_by_name}` : ""}
                </span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {c.what}
              {isPublic
                ? " — this key is visible in the browser by design. It is protected by HTTP referrer restrictions, not secrecy: lock it to your domains in the Google Cloud console."
                : ""}
            </p>
            <div className="flex items-center gap-1.5">
              <Input
                type={isPublic ? "text" : "password"}
                autoComplete="off"
                className="h-8 text-xs"
                placeholder={row ? "Enter a new value to replace it" : "Paste the value"}
                value={draft}
                disabled={writesDisabled}
                onChange={(e) => setDrafts((d) => ({ ...d, [c.name]: e.target.value }))}
              />
              <Button
                size="sm"
                className="h-8"
                disabled={writesDisabled || draft.trim().length < 4 || save.isPending}
                onClick={() => save.mutate({ keyName: c.name, value: draft, isPublic })}
              >
                {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
              </Button>
              {row && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0"
                  disabled={writesDisabled || remove.isPending}
                  onClick={() => remove.mutate(c.name)}
                  aria-label={`Remove ${c.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-[10px] text-muted-foreground">
        Stored values are encrypted and never sent back to this screen — there is no reveal. A key
        entered here takes precedence over the deployment secret of the same name.
      </p>
    </div>
  );
}

/** Drawn only for someone who may manage integrations; `writesDisabled` is the View As preview. */
export function TestConnectionButton({
  provider,
  writesDisabled = false,
  last,
}: {
  provider: string;
  writesDisabled?: boolean;
  last: { ok: boolean; message: string | null; tested_at: string } | null;
}) {
  const qc = useQueryClient();
  const testFn = useServerFn(testIntegrationConnection);
  const run = useMutation({
    mutationFn: () => testFn({ data: { provider } }),
    onSuccess: (res) => {
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      void qc.invalidateQueries({ queryKey: ["integration-test-results"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="w-full space-y-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={writesDisabled || run.isPending}
        onClick={() => run.mutate()}
      >
        {run.isPending ? (
          <Loader2 className="mr-1 size-3.5 animate-spin" />
        ) : (
          <Check className="mr-1 size-3.5" />
        )}
        {run.isPending ? "Testing…" : "Test connection"}
      </Button>
      {last && (
        <div
          className={cn(
            "flex items-start gap-1.5 rounded-sm border p-2 text-[11px]",
            last.ok
              ? "border-success/30 bg-success/10 text-foreground"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {last.ok ? (
            <Check className="mt-0.5 size-3 shrink-0" />
          ) : (
            <X className="mt-0.5 size-3 shrink-0" />
          )}
          <span>
            {last.message ?? (last.ok ? "Connected" : "Failed")}
            <span className="ml-1 text-muted-foreground">· tested {ago(last.tested_at)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/** Who changed which provider's credentials, and when. Never the value. */
export function CredentialAuditTrail({ enabled }: { enabled: boolean }) {
  const q = useQuery({
    queryKey: ["integration-credential-audit"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("integration_credential_audit")
        .select("id, provider, key_name, action, actor_email, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    enabled,
    retry: false,
  });

  const rows = q.data ?? [];
  if (!enabled) return null;

  return (
    <div className="rounded-sm border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <AlertTriangle className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Credential change log</span>
        <span className="text-[11px] text-muted-foreground">
          Who changed what, and when. Values are never recorded.
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">No credential changes recorded yet.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-2 px-3 py-1.5 text-[11px]">
              <span className="font-medium">{r.actor_email ?? "Someone"}</span>
              <span className="text-muted-foreground">{r.action}</span>
              <span className="font-mono">{r.key_name}</span>
              <span className="text-muted-foreground">on {r.provider}</span>
              <span className="ml-auto text-muted-foreground">{ago(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
