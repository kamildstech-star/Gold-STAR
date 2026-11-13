import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, Eye, EyeOff, Lock, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listEnvKeys, unlockEnvKeys } from "@/lib/env-keys.functions";

export const Route = createFileRoute("/env-keys")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Environment keys — Recovery Hub" },
      { name: "description", content: "Password-protected checklist of the app's configuration keys." },
      { property: "og:title", content: "Environment keys — Recovery Hub" },
      { property: "og:description", content: "Password-protected checklist of the app's configuration keys." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: EnvKeysPage,
});

const INACTIVITY_MS = 15 * 60 * 1000;

type Secret = { name: string; purpose: string; source: string; isSet: boolean };
type Row =
  | { kind: "public"; name: string; value: string; purpose: string }
  | ({ kind: "secret" } & Secret);

// Browser keys already ship in the site bundle; listed here only after unlock.
function publicKeys(): Row[] {
  const env = import.meta.env;
  return [
    { name: "VITE_SUPABASE_URL", value: env.VITE_SUPABASE_URL, purpose: "Database address used by the browser." },
    { name: "VITE_SUPABASE_PUBLISHABLE_KEY", value: env.VITE_SUPABASE_PUBLISHABLE_KEY, purpose: "Public database key used by the browser." },
    { name: "VITE_SUPABASE_PROJECT_ID", value: env.VITE_SUPABASE_PROJECT_ID, purpose: "Database project reference." },
    { name: "VITE_PUBLIC_SITE_URL", value: env.VITE_PUBLIC_SITE_URL, purpose: "Site address used in links." },
    { name: "VITE_TURNSTILE_SITE_KEY", value: env.VITE_TURNSTILE_SITE_KEY, purpose: "Bot check on public forms." },
    { name: "VITE_AUTH_PROVIDER", value: env.VITE_AUTH_PROVIDER, purpose: "Which sign-in provider the app uses." },
    { name: "VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY", value: env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY, purpose: "Google Maps in the browser." },
    { name: "VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID", value: env.VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID, purpose: "Maps usage tracking." },
  ].map((r) => ({ kind: "public" as const, ...r, value: String(r.value ?? "") }));
}

function EnvKeysPage() {
  // Held in memory only, so a refresh locks the page.
  const [token, setToken] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const list = useServerFn(listEnvKeys);

  const lock = useCallback(() => {
    setToken(null);
    setSecrets([]);
  }, []);

  useEffect(() => {
    if (!token) return;
    let timer = window.setTimeout(lock, INACTIVITY_MS);
    const bump = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, INACTIVITY_MS);
    };
    const events = ["mousemove", "keydown", "click", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [token, lock]);

  async function onUnlocked(t: string, expiresAt: number) {
    const res = await list({ data: { token: t } });
    if (!res.ok) return toast.error(res.error);
    setToken(t);
    setSecrets(res.secrets);
    window.setTimeout(lock, Math.max(0, expiresAt - Date.now()));
  }

  return (
    <main className="min-h-screen bg-background p-4 md:p-8">
      {token ? <KeysTable secrets={secrets} onLock={lock} /> : <PasswordGate onUnlocked={onUnlocked} />}
    </main>
  );
}

function PasswordGate({ onUnlocked }: { onUnlocked: (token: string, expiresAt: number) => Promise<unknown> }) {
  const unlock = useServerFn(unlockEnvKeys);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await unlock({ data: { password } });
      if (!res.ok) setError(res.error);
      else await onUnlocked(res.token, res.expiresAt);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
      form.reset();
    }
  }

  return (
    <Card className="mx-auto mt-16 max-w-sm">
      <CardHeader className="items-center text-center">
        <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <Lock className="size-6" />
        </div>
        <CardTitle>Environment keys</CardTitle>
        <p className="text-sm text-muted-foreground">Enter the page password to continue.</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <Input name="password" type="password" autoComplete="current-password" placeholder="Password" autoFocus aria-label="Password" />
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Checking…" : "Unlock"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function KeysTable({ secrets, onLock }: { secrets: Secret[]; onLock: () => void }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<Set<string>>(new Set());
  const rows = useMemo<Row[]>(
    () => [...publicKeys(), ...secrets.map((s) => ({ kind: "secret" as const, ...s }))],
    [secrets],
  );
  const filtered = rows.filter((r) => r.name.toLowerCase().includes(query.trim().toLowerCase()));
  const publicNames = rows.filter((r) => r.kind === "public" && r.value).map((r) => r.name);
  const allShown = publicNames.length > 0 && publicNames.every((n) => shown.has(n));

  const toggle = (name: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Environment keys</h1>
          <p className="text-sm text-muted-foreground">
            Public values can be shown. Secret values are never sent to this page — only whether they are set and where to get them.
          </p>
        </div>
        <Button variant="outline" onClick={onLock}>
          <Lock className="mr-2 size-4" /> Lock
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by key name" className="pl-8" aria-label="Search by key name" />
        </div>
        <Button variant="secondary" onClick={() => setShown(allShown ? new Set() : new Set(publicNames))}>
          {allShown ? <EyeOff className="mr-2 size-4" /> : <Eye className="mr-2 size-4" />}
          {allShown ? "Hide all" : "Show all"}
        </Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key name</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.name}>
                <TableCell className="align-top">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm">{r.name}</code>
                    <Badge variant={r.kind === "public" ? "secondary" : "default"}>{r.kind === "public" ? "Public" : "Secret"}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{r.purpose}</p>
                </TableCell>
                <TableCell className="max-w-md align-top">
                  {r.kind === "public" ? (
                    r.value ? (
                      <code className="break-all font-mono text-sm">{shown.has(r.name) ? r.value : "••••••••"}</code>
                    ) : (
                      <span className="text-sm text-muted-foreground">Not set</span>
                    )
                  ) : (
                    <div className="space-y-1">
                      <Badge variant="outline" className={r.isSet ? "" : "text-muted-foreground"}>
                        {r.isSet ? <><Check className="mr-1 size-3" /> Set</> : "Not set"}
                      </Badge>
                      <p className="text-xs text-muted-foreground">Get a new one: {r.source}</p>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right align-top">
                  {r.kind === "public" && r.value ? (
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" onClick={() => toggle(r.name)} aria-label={shown.has(r.name) ? `Hide ${r.name}` : `Show ${r.name}`}>
                        {shown.has(r.name) ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </Button>
                      <CopyButton name={r.name} value={r.value} />
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">No keys match.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function CopyButton({ name, value }: { name: string; value: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<number | undefined>(undefined);
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={`Copy ${name}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          window.clearTimeout(t.current);
          t.current = window.setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Couldn't copy");
        }
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}
