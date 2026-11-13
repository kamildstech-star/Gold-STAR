import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FlaskConical, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useWritesDisabled } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { PUBLIC_PAGE_FIELDS, PUBLIC_PAGE_FIELD_LABEL } from "@/lib/fire-feed/public-page";
import { testPublicPage, type PublicPageTestResult } from "@/lib/fire-feed/public-page.functions";
import {
  addPublicPage,
  checkPageUrl,
  configFromForm,
  deletePublicPage,
  EMPTY_FORM,
  loadPublicPages,
  updatePublicPage,
  type PublicPageForm,
  type PublicPageSource,
} from "@/lib/fire-feed/public-pages-admin";
import type { WatchArea } from "@/lib/fire-feed/types";

const KEY = ["fire-feed-public-pages"] as const;

const PRESET_LABEL: Record<PublicPageForm["preset"], string> = {
  html_table: "Web page with a table of calls",
  json: "JSON data address",
  rss: "RSS feed of calls",
};

function ago(ts: string | null): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/**
 * Public incident pages — the panel the fire feed's settings screen shows
 * beneath its sources (found there by file name, `*.panel.tsx`).
 *
 * Mark: "I don't want to pay API fees." Many county 911 centers and fire
 * departments publish a live "active incidents" page; this is where an admin
 * adds one and tells the feed how to read it. The rules are on the screen,
 * because they are the reason this is allowed at all: public government
 * pages only, no logins or CAPTCHAs, robots.txt respected, every two minutes
 * at most.
 */
export default function PublicPagesPanel({
  onChange,
}: {
  areas: WatchArea[];
  onChange: () => void;
}) {
  const qc = useQueryClient();
  const pages = useQuery({ queryKey: KEY, queryFn: loadPublicPages });
  const { disabled } = useWritesDisabled();
  const [form, setForm] = useState<PublicPageForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<PublicPageTestResult | null>(null);

  if (pages.data === null) return null; // the fire feed's tables are not on this database yet
  const list = pages.data ?? [];

  async function save(write: () => Promise<void>, what: string): Promise<boolean> {
    try {
      await write();
      void qc.invalidateQueries({ queryKey: KEY });
      onChange();
      return true;
    } catch (err) {
      if (err instanceof Error && !("code" in err)) toast.error(err.message);
      else toastDbError(err, { action: what });
      return false;
    }
  }

  let needsAck = false;
  let insecure = false;
  try {
    const checked = form.url.trim() ? checkPageUrl(form.url) : null;
    needsAck = checked?.needsAck ?? false;
    insecure = checked?.insecure ?? false;
  } catch {
    needsAck = false;
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const url = checkPageUrl(form.url).url;
      // The same settings the feed will use, government confirmation included:
      // a page that may not be read on the schedule is not fetched to test it.
      const r = await testPublicPage({
        data: { url, label: form.label, config: configFromForm(form) },
      });
      setTest(r);
      if (!r.ok && r.error) toast.error(r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  const setField = (k: string, v: string) =>
    setForm({ ...form, fields: { ...form.fields, [k]: v } });

  return (
    <Card>
      <CardHeader className="p-3">
        <CardTitle className="text-sm">Public incident pages</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-0 text-sm">
        <div className="rounded border border-primary/30 bg-primary/5 p-2 text-xs">
          <p className="font-medium">The rules this source follows</p>
          <ul className="ml-4 list-disc text-muted-foreground">
            <li>
              Public government pages only — a county 911 center&rsquo;s or a fire
              department&rsquo;s live calls page. A site that is not .gov or .us needs you to
              confirm it.
            </li>
            <li>
              No logins, no CAPTCHAs, nothing behind a password. A page that asks for one is
              refused, never worked around.
            </li>
            <li>
              robots.txt is read first and obeyed (including a Crawl-delay). If it says no, the feed
              does not read the page.
            </li>
            <li>
              Never more often than every 2 minutes per page, and only changed pages are downloaded.
            </li>
          </ul>
        </div>

        {list.map((p) => (
          <PageRow key={p.id} page={p} disabled={disabled} save={save} />
        ))}
        {list.length === 0 && <p className="text-xs text-muted-foreground">No public pages yet.</p>}

        <div className="space-y-2 rounded border p-2">
          <div className="text-xs font-medium">Add a page</div>
          <div className="grid gap-2 sm:grid-cols-[2fr_3fr]">
            <Input
              className="h-8"
              placeholder="Name (e.g. Ocean County 911)"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <Input
              className="h-8"
              placeholder="https://…"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {(Object.keys(PRESET_LABEL) as PublicPageForm["preset"][]).map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                variant={form.preset === k ? "secondary" : "outline"}
                className="h-7 text-xs"
                onClick={() => setForm({ ...form, preset: k })}
              >
                {PRESET_LABEL[k]}
              </Button>
            ))}
            <label className="flex items-center gap-1">
              every
              <Input
                className="h-7 w-14"
                inputMode="numeric"
                value={form.poll}
                onChange={(e) => setForm({ ...form, poll: e.target.value })}
              />
              min
            </label>
          </div>

          {form.preset === "html_table" && (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  Table number on the page
                  <Input
                    className="h-7 w-14"
                    inputMode="numeric"
                    value={form.tableIndex}
                    onChange={(e) => setForm({ ...form, tableIndex: e.target.value })}
                  />
                </label>
                <label className="flex items-center gap-2">
                  or its id
                  <Input
                    className="h-7 w-32"
                    placeholder="e.g. GridView2"
                    value={form.tableId}
                    onChange={(e) => setForm({ ...form, tableId: e.target.value })}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                Which column holds what — its header text or its number (1 = first). Leave blank to
                let the feed guess from the headers; &ldquo;Test this page&rdquo; shows what it
                found.
              </p>
              <div className="grid gap-2 sm:grid-cols-4">
                {PUBLIC_PAGE_FIELDS.map((k) => (
                  <Input
                    key={k}
                    className="h-7 text-xs"
                    placeholder={PUBLIC_PAGE_FIELD_LABEL[k]}
                    value={form.fields[k] ?? ""}
                    onChange={(e) => setField(k, e.target.value)}
                  />
                ))}
              </div>
            </div>
          )}
          {form.preset === "json" && (
            <div className="space-y-1">
              <Input
                className="h-7 text-xs"
                placeholder="Path to the list of calls (blank for a list or GeoJSON)"
                value={form.itemsPath}
                onChange={(e) => setForm({ ...form, itemsPath: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                A path per field inside each call, e.g. <code>properties.address</code> or{" "}
                <code>geometry.coordinates[1]</code>. Blank fields are guessed.
              </p>
              <div className="grid gap-2 sm:grid-cols-4">
                {[...PUBLIC_PAGE_FIELDS, "lat", "lon"].map((k) => (
                  <Input
                    key={k}
                    className="h-7 text-xs"
                    placeholder={
                      PUBLIC_PAGE_FIELD_LABEL[k as keyof typeof PUBLIC_PAGE_FIELD_LABEL] ??
                      (k === "lat" ? "Latitude" : "Longitude")
                    }
                    value={form.fields[k as keyof PublicPageForm["fields"]] ?? ""}
                    onChange={(e) => setField(k, e.target.value)}
                  />
                ))}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={form.fireRowsOnly}
              onCheckedChange={(v) => setForm({ ...form, fireRowsOnly: v === true })}
            />
            Keep only fire calls (medical and traffic calls are dropped before anything else)
          </label>
          {form.preset !== "rss" && (
            <label className="flex flex-wrap items-center gap-2 text-xs">
              Drop calls whose status is
              <Input
                className="h-7 w-48 text-xs"
                placeholder="e.g. Completed, Closed (blank keeps all)"
                value={form.excludeStatuses}
                onChange={(e) => setForm({ ...form, excludeStatuses: e.target.value })}
              />
              <span className="text-muted-foreground">
                A fire put out an hour ago is still a lead, so most pages leave this blank.
              </span>
            </label>
          )}
          {insecure && (
            <p className="text-xs text-warning">
              Not encrypted: this page is only served over plain http, so what it returns could be
              altered on the way. Allowed for a public government page you confirm; leads from it
              are still checked against your watch areas.
            </p>
          )}
          {needsAck && (
            <label className="flex items-center gap-2 text-xs text-warning">
              <Checkbox
                checked={form.governmentAck}
                onCheckedChange={(v) => setForm({ ...form, governmentAck: v === true })}
              />
              This address is not a .gov or .us site. I confirm it is a public government page (a
              fire department or 911 center), with no login.
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={testing || !form.url.trim()}
              onClick={() => void runTest()}
            >
              <FlaskConical className="mr-1 size-3.5" />
              {testing ? "Testing…" : "Test this page"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || disabled}
              onClick={async () => {
                setBusy(true);
                const ok = await save(() => addPublicPage(form), "add the page");
                setBusy(false);
                if (ok) {
                  setForm(EMPTY_FORM);
                  setTest(null);
                }
              }}
            >
              <Plus className="mr-1 size-3.5" />
              Add page
            </Button>
          </div>
          {test && <TestResult result={test} />}
        </div>
      </CardContent>
    </Card>
  );
}

type Save = (write: () => Promise<void>, what: string) => Promise<boolean>;

function PageRow({
  page: p,
  disabled,
  save,
}: {
  page: PublicPageSource;
  disabled: boolean;
  save: Save;
}) {
  const preset = (p.config?.preset as PublicPageForm["preset"] | undefined) ?? "html_table";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border p-2">
      <Switch
        checked={p.enabled}
        disabled={disabled}
        aria-label={`Read ${p.label}`}
        onCheckedChange={(v) =>
          void save(() => updatePublicPage(p.id, { enabled: v }), "switch the page")
        }
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{p.label}</div>
        <a
          href={/^https?:\/\//i.test(p.url) ? p.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-xs text-muted-foreground hover:underline"
        >
          {p.url}
        </a>
        <div className="text-xs text-muted-foreground">
          {PRESET_LABEL[preset]} · every {p.poll_minutes} min
          {/^http:\/\//i.test(p.url) ? (
            <span className="text-warning"> · not encrypted (http)</span>
          ) : null}{" "}
          · last checked {ago(p.last_fetched_at)}
          {p.last_error ? (
            <span className="text-destructive"> · {p.last_error}</span>
          ) : p.last_fetched_at ? (
            " · OK"
          ) : (
            ""
          )}
        </div>
        {typeof p.config?.note === "string" && p.config.note.trim() && (
          <div className="text-xs italic text-muted-foreground">{p.config.note}</div>
        )}
      </div>
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled}
        aria-label={`Remove ${p.label}`}
        onClick={() => {
          if (window.confirm(`Remove ${p.label}? Leads it already created stay in the chase deck.`))
            void save(() => deletePublicPage(p.id), "remove the page");
        }}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function TestResult({ result: r }: { result: PublicPageTestResult }) {
  return (
    <div className="space-y-2 rounded border bg-muted/30 p-2 text-xs">
      <div className={r.ok ? "text-success" : "text-destructive"}>
        {r.ok
          ? `Read ${r.totalRows} row${r.totalRows === 1 ? "" : "s"}, ${r.fireRows} fire call${r.fireRows === 1 ? "" : "s"}.`
          : r.error}
      </div>
      {r.tables.length > 0 && (
        <div>
          <div className="font-medium">Tables on the page</div>
          <ol className="ml-4 list-decimal">
            {r.tables.slice(0, 8).map((t, i) => (
              <li key={i}>
                {t.rows} rows — {t.headers.slice(0, 8).join(" | ") || "(no headers)"}
              </li>
            ))}
          </ol>
        </div>
      )}
      {r.sample.length > 0 && (
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full min-w-[560px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                {PUBLIC_PAGE_FIELDS.map((f) => (
                  <th key={f} className="pr-2">
                    {PUBLIC_PAGE_FIELD_LABEL[f]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.sample.map((row, i) => (
                <tr key={i} className="border-t">
                  {PUBLIC_PAGE_FIELDS.map((f) => (
                    <td key={f} className="pr-2">
                      {row[f] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.fireSample.length > 0 && (
        <div>
          <div className="font-medium">Fire calls the feed would read</div>
          <ul className="ml-4 list-disc">
            {r.fireSample.map((s, i) => (
              <li key={i}>
                {s.title}
                {s.publishedAt ? ` · ${new Date(s.publishedAt).toLocaleString("en-US")}` : ""}
                {s.units != null ? ` · ${s.units} unit${s.units === 1 ? "" : "s"}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
