import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ListChecks, Phone, PlayCircle, PlugZap } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { EmptyLine, LoadError, PageHeader } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PhoneLink, useDialer, useDialerConnected } from "@/components/dialer";
import {
  CALL_OUTCOMES,
  QUEUE_REASON_LABEL,
  buildQueue,
  connectedCall,
  fmtDurationShort,
  listCalls,
  outcomeLabel,
} from "@/lib/calls";
import { isPrivileged } from "@/lib/roles";

export const Route = createFileRoute("/_authenticated/calls/")({
  head: () => ({
    meta: [
      { title: "Calls · Recovery Hub" },
      {
        name: "description",
        content:
          "Every logged call with contact, account, outcome and recording, plus a call queue to work follow-ups one after another.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CallsPage,
});

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

function CallsPage() {
  const app = useAppContext();
  const [tab, setTab] = React.useState<"log" | "queue">("log");
  const [scope, setScope] = React.useState<"mine" | "team">("mine");
  const [range, setRange] = React.useState("30");
  const [outcome, setOutcome] = React.useState<string>("all");
  const [search, setSearch] = React.useState("");

  const canSeeTeam =
    isPrivileged(app.roles) ||
    app.roles.some((r) => ["regional", "location_manager", "sales_manager"].includes(r));

  const dialer = useDialerConnected();

  const from = React.useMemo(() => {
    if (range === "all") return undefined;
    return new Date(Date.now() - Number(range) * 86_400_000).toISOString();
  }, [range]);

  const callsQuery = useQuery({
    queryKey: ["calls", scope, app.viewerUserId, range, outcome, search],
    enabled: !!app.viewerUserId,
    queryFn: () =>
      listCalls({
        userIds: scope === "mine" && app.viewerUserId ? [app.viewerUserId] : undefined,
        from,
        outcome: outcome === "all" ? null : outcome,
        search,
      }),
  });

  const peopleQuery = useQuery({
    queryKey: ["calls-people"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("user_id,full_name");
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name ?? "—"]));
    },
  });

  const rows = callsQuery.data ?? [];
  const connectedCount = rows.filter((r) => connectedCall(r.outcome)).length;

  return (
    <div className="page-shell space-y-3">
      <PageHeader title="Calls" subtitle={`${rows.length} logged · ${connectedCount} connected`}>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "log" | "queue")}>
          <TabsList>
            <TabsTrigger value="log">
              <Phone className="mr-1.5 size-3.5" /> Call log
            </TabsTrigger>
            <TabsTrigger value="queue">
              <ListChecks className="mr-1.5 size-3.5" /> Queue
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      {dialer.data === false && (
        <Alert variant="info">
          <PlugZap className="size-4" />
          <AlertDescription className="text-[12px]">
            No dialer provider is connected. Calls still log — the number opens on your phone and
            the outcome and notes are captured here as self-reported. Connect CallRail in{" "}
            <Link to="/admin/integrations" className="underline">
              Admin → Integrations
            </Link>{" "}
            to place and record calls in-app.
          </AlertDescription>
        </Alert>
      )}

      {tab === "queue" ? (
        <CallQueue />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {canSeeTeam && (
              <Select value={scope} onValueChange={(v) => setScope(v as "mine" | "team")}>
                <SelectTrigger className="h-9 w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mine">My calls</SelectItem>
                  <SelectItem value="team">Everyone</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="h-9 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger className="h-9 w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                {CALL_OUTCOMES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-9 w-[220px]"
              placeholder="Account, contact or number…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <Card>
            <CardContent className="p-0">
              {callsQuery.isError ? (
                <LoadError
                  what="calls"
                  error={callsQuery.error}
                  onRetry={() => callsQuery.refetch()}
                />
              ) : rows.length === 0 ? (
                <EmptyLine>No calls in this range.</EmptyLine>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead>Rep</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Recording</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="whitespace-nowrap text-[12px]">
                          {new Date(c.occurred_at).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </TableCell>
                        <TableCell className="text-[13px]">
                          {c.contacts?.full_name ?? (
                            <PhoneLink
                              phone={c.to_address ?? c.from_address}
                              accountId={c.account_id}
                              accountName={c.accounts?.name ?? null}
                              contactId={c.contact_id}
                            />
                          )}
                        </TableCell>
                        <TableCell className="text-[13px]">
                          {c.account_id ? (
                            <Link
                              to="/accounts/$id"
                              params={{ id: c.account_id }}
                              className="hover:underline"
                            >
                              {c.accounts?.name ?? "Account"}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-[12px] text-muted-foreground">
                          {(c.user_id && peopleQuery.data?.get(c.user_id)) || "—"}
                        </TableCell>
                        <TableCell className="text-[12px] capitalize">{c.direction}</TableCell>
                        <TableCell className="text-[12px]">
                          {fmtDurationShort(c.duration_seconds)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={connectedCall(c.outcome) ? "default" : "secondary"}>
                            {outcomeLabel(c.outcome)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {c.recording_url ? (
                            <a
                              href={c.recording_url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[12px] underline"
                            >
                              <PlayCircle className="size-3.5" /> Play
                            </a>
                          ) : (
                            <span className="text-[12px] text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * The queue. One card at a time with the reason it is in front of you; dial,
 * log, and it advances — no going back to a list between calls.
 */
function CallQueue() {
  const app = useAppContext();
  const { startCall } = useDialer();
  const [index, setIndex] = React.useState(0);

  const queue = useQuery({
    queryKey: ["call-queue", app.viewerUserId],
    enabled: !!app.viewerUserId,
    queryFn: () => buildQueue(app.viewerUserId!),
  });

  const items = queue.data ?? [];
  const item = items[index] ?? null;

  if (queue.isError) {
    return <LoadError what="the call queue" error={queue.error} onRetry={() => queue.refetch()} />;
  }
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyLine>Nothing due — the queue is clear.</EmptyLine>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardContent className="space-y-4 p-5">
          {item ? (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{QUEUE_REASON_LABEL[item.reason]}</Badge>
                <span className="text-[12px] text-muted-foreground">
                  {index + 1} of {items.length}
                </span>
              </div>
              <div>
                <div className="text-[20px] font-semibold">{item.accountName}</div>
                <div className="text-[13px] text-muted-foreground">
                  {item.contactName ?? "No contact on file"} · {item.why}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="h-11"
                  disabled={!item.phone}
                  onClick={() =>
                    startCall({
                      phone: item.phone,
                      accountId: item.accountId,
                      accountName: item.accountName,
                      contactId: item.contactId,
                      contactName: item.contactName,
                      onLogged: () => setIndex((i) => Math.min(i + 1, items.length - 1)),
                    })
                  }
                >
                  <Phone className="mr-2 size-4" />
                  {item.phone ? `Call ${item.phone}` : "No number"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setIndex((i) => Math.min(i + 1, items.length - 1))}
                >
                  Skip <ChevronRight className="ml-1 size-4" />
                </Button>
                {item.accountId && (
                  <Button asChild variant="ghost">
                    <Link to="/accounts/$id" params={{ id: item.accountId }}>
                      Open account
                    </Link>
                  </Button>
                )}
              </div>
            </>
          ) : (
            <EmptyLine>Queue finished.</EmptyLine>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="max-h-[60vh] overflow-auto p-0 [--table-sticky-top:0px]">
          {items.map((q, i) => (
            <button
              key={q.key}
              type="button"
              onClick={() => setIndex(i)}
              className={`flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left text-[12px] hover:bg-muted/50 ${
                i === index ? "bg-muted" : ""
              }`}
            >
              <span className="font-medium">{q.accountName}</span>
              <span className="text-muted-foreground">
                {QUEUE_REASON_LABEL[q.reason]} · {q.why}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
