import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, PhoneOff, Pin, ShieldAlert, Circle } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fireNoteTriggers, fmtDuration, type AccountNote } from "@/lib/timeline";
import { useWritesDisabled } from "@/components/app-context";

type CallContact = { id: string; full_name: string; phone: string | null };

const OUTCOMES = [
  { value: "connected", label: "Connected — spoke with them" },
  { value: "voicemail", label: "Voicemail" },
  { value: "no_answer", label: "No answer" },
  { value: "wrong_number", label: "Wrong number" },
  { value: "gatekeeper", label: "Blocked by gatekeeper" },
] as const;

/**
 * The call screen. Two things only happen here, and both are the point:
 *
 * 1. Triggered notes fire the second the call connects — on this screen, in
 *    front of the rep, not in a notification list an hour later.
 * 2. Recording consent is resolved from where the other party is, against the
 *    per-state rules table. There is no global record switch.
 *
 * The call logs itself. The rep picks an outcome; the duration and the
 * provenance come from the dialer, so it cannot be faked without doing the work.
 */
export function CallScreen({
  accountId,
  accountName,
  contacts,
  defaultStateCode,
  userId,
  onLogged,
  compact,
}: {
  accountId: string;
  accountName: string;
  contacts: CallContact[];
  defaultStateCode?: string | null;
  userId: string | null;
  onLogged: () => void;
  /** Small inline button for the master-detail panel action row. */
  compact?: boolean;
}) {
  const { disabled, reason } = useWritesDisabled();
  const [open, setOpen] = useState(false);
  const [contactId, setContactId] = useState<string>(contacts[0]?.id ?? "none");
  const [stateCode, setStateCode] = useState<string>(defaultStateCode ?? "NY");
  const [connected, setConnected] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<string>("connected");
  const [notes, setNotes] = useState("");
  const [triggered, setTriggered] = useState<AccountNote[]>([]);
  const [pinned, setPinned] = useState<AccountNote[]>([]);
  const [consentGiven, setConsentGiven] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const rulesQuery = useQuery({
    queryKey: ["recording-consent-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recording_consent_rules")
        .select("*")
        .order("state_name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const rule = rulesQuery.data?.find((r) => r.state_code === stateCode) ?? null;
  const allParty = rule?.consent_type === "all_party" || rule?.consent_type === "unclear";

  useEffect(() => {
    if (!open) return;
    supabase
      .from("account_notes")
      .select("*")
      .eq("account_id", accountId)
      .eq("is_pinned", true)
      .then(({ data }) => setPinned(data ?? []));
  }, [open, accountId]);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const connect = async () => {
    setConnected(true);
    const t0 = Date.now();
    setStartedAt(t0);
    timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    // The moment the note is useful.
    try {
      const notesFired = await fireNoteTriggers(accountId, "next_call");
      setTriggered(notesFired);
    } catch {
      /* a failed trigger read must never block the call */
    }
  };

  const hangUp = async () => {
    if (timer.current) clearInterval(timer.current);
    const duration = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    if (!userId) return;
    setSaving(true);

    const outcomeLabel = OUTCOMES.find((o) => o.value === outcome)?.label ?? outcome;
    const body = [`Outcome: ${outcomeLabel}`, notes.trim()].filter(Boolean).join("\n");

    const { data: tp, error } = await supabase
      .from("touchpoints")
      .insert({
        account_id: accountId,
        contact_id: contactId === "none" ? null : contactId,
        type: "call",
        notes: body,
        created_by: userId,
        capture_source: "dialer",
        direction: "outbound",
        duration_seconds: outcome === "connected" ? duration : 0,
      })
      .select("id")
      .single();

    if (error) {
      setSaving(false);
      toast.error(error.message);
      return;
    }

    const contact = contacts.find((c) => c.id === contactId);
    await supabase.from("captured_communications").insert({
      provider: "in_app_dialer",
      external_id: crypto.randomUUID(),
      channel: "call",
      direction: "outbound",
      duration_seconds: duration,
      to_address: contact?.phone ?? null,
      outcome,
      account_id: accountId,
      contact_id: contactId === "none" ? null : contactId,
      user_id: userId,
      touchpoint_id: tp.id,
      recording_consent_state: recording ? stateCode : null,
    });

    setSaving(false);
    toast.success(
      outcome === "connected"
        ? `Call logged — ${fmtDuration(duration)}`
        : "Call logged — no answer, does not count toward cadence",
    );
    reset();
    onLogged();
  };

  const reset = () => {
    setOpen(false);
    setConnected(false);
    setStartedAt(null);
    setElapsed(0);
    setNotes("");
    setTriggered([]);
    setOutcome("connected");
    setRecording(false);
    setConsentGiven(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : reset())}>
      <DialogTrigger asChild>
        <Button
          size={compact ? "sm" : "lg"}
          className={compact ? "h-7 px-2 text-[12px]" : "h-12 w-full text-base"}
          disabled={disabled}
          title={reason ?? undefined}
        >
          <Phone className={compact ? "mr-1 size-3.5" : "mr-2 size-5"} />
          Start call
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{accountName}</DialogTitle>
        </DialogHeader>

        {/* Triggered notes — the entire feature is that these land here. */}
        {triggered.length > 0 && (
          <div className="space-y-2">
            {triggered.map((n) => (
              <Alert key={n.id} className="border-border border-l-2 border-l-gold bg-card">
                <Pin className="size-4" />
                <AlertTitle>Before you forget</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap text-foreground">
                  {n.body}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        {pinned.length > 0 && (
          <div className="rounded-md border bg-muted/40 p-2 text-[12px]">
            {pinned.map((n) => (
              <div key={n.id} className="flex gap-1.5">
                <Pin className="mt-0.5 size-3 shrink-0" />
                <span className="whitespace-pre-wrap">{n.body}</span>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Contact</Label>
            <Select value={contactId} onValueChange={setContactId} disabled={connected}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No specific contact —</SelectItem>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.full_name}
                    {c.phone ? ` · ${c.phone}` : " · no number"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Recording consent — per state, driven by where they are. */}
          <div className="rounded-md border p-2">
            <div className="flex items-center gap-2">
              <Circle
                className={`size-2.5 ${recording ? "fill-destructive text-destructive" : "text-muted-foreground"}`}
              />
              <span className="text-[12px] font-medium">Call recording</span>
              <Select value={stateCode} onValueChange={setStateCode} disabled={connected}>
                <SelectTrigger className="ml-auto h-7 w-[190px] text-[12px]">
                  <SelectValue placeholder="Where are they?" />
                </SelectTrigger>
                <SelectContent>
                  {(rulesQuery.data ?? []).map((r) => (
                    <SelectItem key={r.state_code} value={r.state_code}>
                      {r.state_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {rule && (
              <div className="mt-2 space-y-2 text-[12px]">
                <div className="flex items-center gap-2">
                  <Badge variant={allParty ? "destructive" : "secondary"}>
                    {rule.consent_type === "all_party"
                      ? "All-party consent"
                      : rule.consent_type === "unclear"
                        ? "Consent unclear"
                        : "One-party consent"}
                  </Badge>
                  <span className="text-muted-foreground">{rule.notes}</span>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="font-medium">Read this aloud before recording:</div>
                  <div className="mt-0.5 italic">“{rule.disclosure_text}”</div>
                </div>
                {allParty && !consentGiven && (
                  <Alert variant="destructive">
                    <ShieldAlert className="size-4" />
                    <AlertTitle>Recording is blocked in {rule.state_name}</AlertTitle>
                    <AlertDescription>
                      Every party must agree on the recording. Read the disclosure, then confirm
                      they said yes.
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex gap-2">
                  {allParty && (
                    <Button
                      size="sm"
                      variant={consentGiven ? "secondary" : "outline"}
                      onClick={() => setConsentGiven((v) => !v)}
                    >
                      {consentGiven ? "Consent captured" : "They said yes"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={recording ? "destructive" : "outline"}
                    disabled={allParty && !consentGiven}
                    onClick={() => setRecording((v) => !v)}
                  >
                    {recording ? "Stop recording" : "Record this call"}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {connected ? (
            <>
              <div className="flex items-center justify-between rounded-md border bg-success/10 px-3 py-2 text-sm">
                <span className="font-medium">Connected</span>
                <span className="font-mono">{fmtDuration(elapsed)}</span>
              </div>
              <div className="space-y-1.5">
                <Label>Outcome</Label>
                <Select value={outcome} onValueChange={setOutcome}>
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OUTCOMES.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {outcome !== "connected" && (
                  <p className="text-[11px] text-muted-foreground">
                    An unanswered call is recorded but does not satisfy cadence.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Notes (optional — or dictate one after)</Label>
                <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
              <Button
                size="lg"
                variant="destructive"
                className="h-12 w-full"
                onClick={hangUp}
                disabled={saving}
              >
                <PhoneOff className="mr-2 size-5" />
                {saving ? "Logging…" : "End call and log"}
              </Button>
            </>
          ) : (
            <Button size="lg" className="h-12 w-full" onClick={connect}>
              <Phone className="mr-2 size-5" />
              Connect
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
