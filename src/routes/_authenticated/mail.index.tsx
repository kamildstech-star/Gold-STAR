import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Archive,
  Inbox,
  Link2,
  Mail,
  Paperclip,
  PenSquare,
  Search,
  Send,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
  FileText,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { EmailContextSidebar } from "@/components/email-context-sidebar";
import { EmailComposer } from "@/components/email-composer";
import { EmptyLine, LoadError, PageHeader } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { graphStatus } from "@/lib/graph.functions";
import { myOutlookConnection } from "@/lib/microsoft-connection.functions";
import { knownOutlookOutcome, OUTLOOK_OUTCOME_MESSAGES } from "@/lib/outlook-connect-outcomes";
import { startConnect } from "@/lib/outlook-connect-start";
import { isPrivileged } from "@/lib/roles";
import type { CapturedComm } from "@/lib/email-context";
import {
  FOLDERS,
  categories,
  folderOf,
  hasAttachment,
  inFolder,
  isFlagged,
  isUnread,
  listDate,
  matchesQuery,
  parseMailQuery,
  senderLabel,
  type FolderKey,
} from "@/lib/mail-client";

export const Route = createFileRoute("/_authenticated/mail/")({
  // `?outlook=<outcome>` is where /api/auth/microsoft/callback lands a person
  // who pressed Connect Outlook here. Known codes only, as on /security.
  validateSearch: (search: Record<string, unknown>): { outlook?: string } => {
    const outlook = knownOutlookOutcome(search.outlook);
    return outlook ? { outlook } : {};
  },
  head: () => ({
    meta: [
      { title: "Mail · Recovery Hub" },
      {
        name: "description",
        content:
          "Outlook mail with the people, next activity and linked record beside every message.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: MailPage,
});

const FOLDER_ICON: Record<FolderKey, typeof Inbox> = {
  inbox: Inbox,
  starred: Star,
  sent: Send,
  drafts: FileText,
  archive: Archive,
  spam: TriangleAlert,
  trash: Trash2,
};

type Thread = {
  key: string;
  subject: string;
  messages: CapturedComm[];
  last: CapturedComm;
  unread: boolean;
  flagged: boolean;
  attachment: boolean;
};

function MailPage() {
  const [folder, setFolder] = useState<FolderKey>("inbox");
  const [label, setLabel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const status = useServerFn(graphStatus);
  const statusQuery = useQuery({
    queryKey: ["graph", "status", "mail"],
    queryFn: () => status({}),
  });

  /* Back from Microsoft's sign-in: say how it went once, then drop the code
     from the URL so a refresh does not say it again. */
  const { outlook } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    if (!outlook) return;
    const message = OUTLOOK_OUTCOME_MESSAGES[outlook];
    if (outlook === "connected") {
      // The mailbox row exists now; its first messages come with the
      // graph-sync job, which runs every 15 minutes.
      toast.success(message.text, {
        description: "Your first messages arrive at the next sync, within 15 minutes.",
      });
      void qc.invalidateQueries({ queryKey: ["graph", "status", "mail"] });
      void qc.invalidateQueries({ queryKey: ["my-outlook-connection"] });
    } else if (message) {
      (message.ok ? toast.success : toast.error)(message.text);
    }
    void navigate({ to: "/mail", search: {}, replace: true });
  }, [outlook, navigate, qc]);

  const query = useQuery({
    queryKey: ["mail-threads"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("captured_communications")
        .select("*")
        .eq("channel", "email")
        .order("occurred_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as CapturedComm[];
    },
  });

  const all = useMemo(() => query.data ?? [], [query.data]);

  /* Rail counts — unread per folder, mirroring Outlook. */
  const counts = useMemo(() => {
    const out = {} as Record<FolderKey, number>;
    for (const f of FOLDERS) out[f.key] = 0;
    for (const m of all) {
      if (!isUnread(m)) continue;
      out[folderOf(m)] += 1;
      if (isFlagged(m)) out.starred += 1;
    }
    return out;
  }, [all]);

  const labels = useMemo(() => {
    const set = new Map<string, number>();
    for (const m of all) {
      for (const c of categories(m)) set.set(c, (set.get(c) ?? 0) + 1);
    }
    return [...set.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all]);

  const threads = useMemo<Thread[]>(() => {
    const parsed = parseMailQuery(q);
    const scoped = all.filter((m) => {
      if (label) return categories(m).includes(label);
      return inFolder(m, folder);
    });
    const visible = scoped.filter((m) => matchesQuery(m, parsed));

    const map = new Map<string, CapturedComm[]>();
    for (const m of visible) {
      const key = m.conversation_id ?? m.id;
      const list = map.get(key) ?? [];
      list.push(m);
      map.set(key, list);
    }
    return [...map.entries()]
      .map(([key, messages]) => {
        const sorted = [...messages].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
        return {
          key,
          subject: sorted[0]?.subject || "(no subject)",
          messages: sorted,
          last: sorted[0]!,
          unread: sorted.some(isUnread),
          flagged: sorted.some(isFlagged),
          attachment: sorted.some(hasAttachment),
        };
      })
      .sort((a, b) => b.last.occurred_at.localeCompare(a.last.occurred_at));
  }, [all, folder, label, q]);

  const current = threads.find((t) => t.key === selected) ?? threads[0] ?? null;

  const mailboxes = (statusQuery.data?.mailboxes ?? []).filter((m) => m.sync_mail && m.enabled);
  const connected = mailboxes.length > 0;

  if (query.error) return <LoadError what="mail" error={query.error} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Mail" />

      {/* Search ------------------------------------------------------------ */}
      <div className="border-b bg-card px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search Outlook mail — try from:kestrel is:unread"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Search syntax: <code>from:</code> <code>to:</code> <code>subject:</code>{" "}
          <code>is:unread</code> <code>is:starred</code> <code>has:attachment</code>{" "}
          <code>label:</code>
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row">
        {/* Rail ------------------------------------------------------------ */}
        <aside className="w-full shrink-0 border-b p-2 lg:w-[196px] lg:border-b-0 lg:border-r">
          <Button
            className="w-full justify-start gap-2"
            size="sm"
            onClick={() => setComposeOpen(true)}
          >
            <PenSquare className="size-3.5" />
            Compose
          </Button>
          <MyOutlookButton />

          <nav className="mt-2 space-y-0.5">
            {FOLDERS.map((f) => {
              const Icon = FOLDER_ICON[f.key];
              const active = !label && folder === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => {
                    setLabel(null);
                    setFolder(f.key);
                    setSelected(null);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-muted/60",
                    active && "bg-primary/10 font-medium text-primary",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{f.label}</span>
                  {counts[f.key] > 0 ? (
                    <span className="text-[11px] font-semibold tabular-nums">{counts[f.key]}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div className="mt-3 border-t pt-2">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Labels
            </div>
            {labels.length === 0 ? (
              <p className="px-2 text-[11px] text-muted-foreground">
                Outlook categories appear here once synced.
              </p>
            ) : (
              labels.map(([name, n]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    setLabel(name);
                    setSelected(null);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-muted/60",
                    label === name && "bg-primary/10 font-medium text-primary",
                  )}
                >
                  <Tag className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{n}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Message list ---------------------------------------------------- */}
        <div className="w-full shrink-0 overflow-auto border-b lg:w-[340px] lg:border-b-0 lg:border-r">
          {!connected && !statusQuery.isLoading ? (
            <NotConnected />
          ) : query.isLoading ? (
            <EmptyLine>Loading mail…</EmptyLine>
          ) : threads.length === 0 ? (
            <EmptyLine>No messages here.</EmptyLine>
          ) : (
            <ul>
              {threads.map((t) => (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => setSelected(t.key)}
                    className={cn(
                      "flex w-full items-start gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/50",
                      current?.key === t.key && "bg-primary/5",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        t.unread ? "bg-primary" : "bg-transparent",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-[13px]",
                            t.unread ? "font-semibold" : "font-medium",
                          )}
                        >
                          {senderLabel(t.last)}
                        </span>
                        {t.flagged ? (
                          <Star className="size-3 shrink-0 fill-current text-amber-500" />
                        ) : null}
                        {t.attachment ? (
                          <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                        ) : null}
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {listDate(t.last.occurred_at)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "mt-0.5 block truncate text-[12px]",
                          t.unread ? "font-medium" : "text-muted-foreground",
                        )}
                      >
                        {t.subject}
                        {t.messages.length > 1 ? (
                          <span className="ml-1 text-muted-foreground">({t.messages.length})</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                        {t.last.body_preview ?? "No preview"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Reading pane + context ------------------------------------------ */}
        {current ? (
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
            <article className="min-w-0 flex-1 space-y-2 overflow-auto">
              <h2 className="text-[15px] font-semibold">{current.subject}</h2>
              {current.messages.map((m) => (
                <div key={m.id} className="rounded-[6px] border bg-card p-2.5">
                  <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <span className="min-w-0 truncate">
                      {m.from_address} → {m.to_address}
                    </span>
                    {hasAttachment(m) ? <Paperclip className="size-3 shrink-0" /> : null}
                    <span className="ml-auto shrink-0">
                      {new Date(m.occurred_at).toLocaleString("en-US")}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px]">
                    {m.body_preview ?? "(no preview stored)"}
                  </p>
                  {m.web_link ? (
                    <a
                      href={m.web_link}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-[12px] text-primary hover:underline"
                    >
                      Open in Outlook
                    </a>
                  ) : null}
                </div>
              ))}
            </article>

            <EmailContextSidebar
              messages={current.messages}
              accountId={current.last.account_id}
              jobId={null}
              onChanged={() => query.refetch()}
            />
          </div>
        ) : null}
      </div>

      <EmailComposer
        open={composeOpen}
        onOpenChange={setComposeOpen}
        context={{ category: "follow_up" }}
        onSent={() => query.refetch()}
      />
    </div>
  );
}

/**
 * Shown when no Outlook mailbox is syncing yet.
 *
 * Where people sign in to Microsoft themselves (delegated mode, set up), the
 * button is the same Connect as the Security page's card: Microsoft's own
 * sign-in, then back here, and connecting registers their mailbox for sync.
 * Otherwise there is nothing a person can do here: an owner, admin or
 * developer gets the setup screen, everyone else is told who can.
 */
/**
 * The signed-in person's own Outlook, always in the rail. The empty state
 * below only shows when NO mailbox syncs — once one colleague (or a shared
 * office mailbox) is connected, everyone else lost their way to connect
 * their own (live, 2026-10-14). Delegated mode only; nothing to show
 * otherwise.
 */
function MyOutlookButton() {
  const lookup = useServerFn(myOutlookConnection);
  const q = useQuery({
    queryKey: ["my-outlook-connection"],
    queryFn: () => lookup(),
    retry: false,
  });
  const connect = useMutation({
    mutationFn: () => startConnect({ shared: false, returnTo: "mail" }),
    onError: (e: Error) => toast.error(e.message),
  });
  const info = q.data;
  if (!info || info.mode !== "delegated" || !info.configured || !info.available) return null;
  const connection = info.connection ?? null;
  if (connection?.status === "connected") {
    return (
      <p
        className="mt-2 truncate px-1 text-[11px] text-muted-foreground"
        title={connection.upn ?? undefined}
        data-my-outlook="connected"
      >
        Your Outlook: {connection.upn ?? "connected"}
      </p>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="mt-2 w-full justify-start gap-2"
      onClick={() => connect.mutate()}
      disabled={connect.isPending}
      data-my-outlook={connection ? "reconnect" : "connect"}
    >
      <Link2 className="size-3.5" />
      {connection ? "Reconnect your Outlook" : "Connect your Outlook"}
    </Button>
  );
}

function NotConnected() {
  const app = useAppContext();
  const lookup = useServerFn(myOutlookConnection);
  const q = useQuery({
    queryKey: ["my-outlook-connection"],
    queryFn: () => lookup(),
    retry: false,
  });
  const connect = useMutation({
    mutationFn: () => startConnect({ shared: false, returnTo: "mail" }),
    onError: (e: Error) => toast.error(e.message),
  });

  const info = q.data;
  const canConnect = info?.mode === "delegated" && info.configured && info.available;
  const connection = info?.connection ?? null;

  return (
    <div className="p-4 text-center">
      <Mail className="mx-auto size-6 text-muted-foreground" />
      <h3 className="mt-2 text-[13px] font-semibold">Outlook is not connected</h3>
      {q.isLoading ? null : q.isError ? (
        <p className="mx-auto mt-1 max-w-[26rem] text-[12px] text-muted-foreground">
          Couldn't check your Outlook connection. Refresh the page to try again.
        </p>
      ) : canConnect ? (
        <>
          <p className="mx-auto mt-1 max-w-[26rem] text-[12px] text-muted-foreground">
            {connection?.status === "connected"
              ? "You're signed in to Microsoft, but your mailbox isn't syncing yet. If nothing arrives within 15 minutes, reconnect or ask an administrator."
              : "Sign in with your Microsoft 365 work account to pull your inbox in here, with the people, next activity and linked record beside every message."}
          </p>
          <Button
            size="sm"
            className="mt-3"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
          >
            <Link2 className="mr-2 size-3.5" />
            {connection ? "Reconnect Outlook" : "Connect Outlook"}
          </Button>
        </>
      ) : isPrivileged(app.roles) ? (
        <>
          <p className="mx-auto mt-1 max-w-[26rem] text-[12px] text-muted-foreground">
            No mailbox is syncing here yet. Finish the Microsoft 365 setup, or add mailboxes, on the
            Outlook settings screen.
          </p>
          <Button asChild size="sm" className="mt-3">
            <Link to="/admin/integrations/outlook">Set up Outlook</Link>
          </Button>
        </>
      ) : (
        <p className="mx-auto mt-1 max-w-[26rem] text-[12px] text-muted-foreground">
          Ask an administrator to set up Microsoft 365.
        </p>
      )}
    </div>
  );
}
