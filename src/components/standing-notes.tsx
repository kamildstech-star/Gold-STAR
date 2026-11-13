import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, Home, Pencil, Percent } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import {
  fetchAccountStandingNote,
  fetchPropertyNote,
  saveAccountStandingNote,
  savePropertyNote,
  STANDING_NOTE_KINDS,
  type StandingNoteKind,
} from "@/lib/standing-notes";
import { cn } from "@/lib/utils";

/**
 * Standing notes render as banners next to the job's own Important
 * Instructions. Each one is labelled with where it comes from, because a crew
 * member needs to know whether "call before invoicing" is this job or every
 * job for the customer. Editing writes back to the single source record.
 */

function BannerShell({
  icon,
  label,
  tone,
  children,
  onEdit,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "amber" | "blue";
  children: React.ReactNode;
  onEdit?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-sm border-2 p-3",
        tone === "amber" ? "border-warning bg-warning/15" : "border-primary/50 bg-primary/10",
      )}
    >
      <span className={cn("mt-0.5 shrink-0", tone === "amber" ? "text-warning" : "text-primary")}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold uppercase tracking-wide">{label}</div>
        <div className="whitespace-pre-wrap text-sm font-medium">{children}</div>
      </div>
      {onEdit && (
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`Edit ${label}`}
          onClick={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function Editor({
  title,
  value,
  kind,
  onKindChange,
  onChange,
  onSave,
  onCancel,
  saving,
  placeholder,
}: {
  title: string;
  value: string;
  kind?: StandingNoteKind;
  onKindChange?: (k: StandingNoteKind) => void;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  placeholder: string;
}) {
  return (
    <div className="space-y-2 rounded-sm border border-warning/50 bg-warning/10 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide">{title}</div>
      {kind && onKindChange && (
        <Select value={kind} onValueChange={(v) => onKindChange(v as StandingNoteKind)}>
          <SelectTrigger className="h-8 w-full max-w-xs text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STANDING_NOTE_KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
        autoFocus
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        This note is stored once and shows on every job in scope — editing it here updates it
        everywhere.
      </p>
    </div>
  );
}

export function AccountStandingNoteBanner({
  accountId,
  editable = true,
}: {
  accountId: string | null;
  editable?: boolean;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<StandingNoteKind>("general");

  const q = useQuery({
    queryKey: ["account-standing-note", accountId],
    queryFn: () => fetchAccountStandingNote(accountId),
    enabled: !!accountId,
  });

  useEffect(() => {
    setDraft(q.data?.note ?? "");
    setKind(q.data?.kind ?? "general");
  }, [q.data?.note, q.data?.kind]);

  const save = useMutation({
    mutationFn: () => saveAccountStandingNote(accountId!, draft.trim() || null, kind),
    onSuccess: () => {
      setEditing(false);
      toast.success("Account note saved — it now shows on every job for this account.");
      void qc.invalidateQueries({ queryKey: ["account-standing-note", accountId] });
      void qc.invalidateQueries({ queryKey: ["account", accountId] });
    },
    onError: (e) => toastDbError(e, { action: "save the account note" }),
  });

  const canEdit = editable && !!accountId && !app.writesDisabled;
  if (!accountId) return null;

  if (editing) {
    return (
      <Editor
        title="Account note"
        value={draft}
        kind={kind}
        onKindChange={setKind}
        onChange={setDraft}
        onSave={() => save.mutate()}
        onCancel={() => {
          setDraft(q.data?.note ?? "");
          setEditing(false);
        }}
        saving={save.isPending}
        placeholder="20% discount arrangement, always call before invoicing…"
      />
    );
  }

  if (!q.data) {
    if (!canEdit) return null;
    return (
      <Button
        size="sm"
        variant="outline"
        className="border-warning/50 text-xs"
        onClick={() => setEditing(true)}
      >
        <Building2 className="mr-1 size-3.5 text-warning" /> Add account note
      </Button>
    );
  }

  return (
    <BannerShell
      icon={
        q.data.kind === "discount" ? (
          <Percent className="size-5" />
        ) : (
          <Building2 className="size-5" />
        )
      }
      label={`Account note — ${q.data.accountName}`}
      tone="amber"
      onEdit={canEdit ? () => setEditing(true) : undefined}
    >
      {q.data.note}
    </BannerShell>
  );
}

export function PropertyStandingNoteBanner({
  address,
  locationId,
  editable = true,
}: {
  address: string | null;
  locationId?: string | null;
  editable?: boolean;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const q = useQuery({
    queryKey: ["property-note", address],
    queryFn: () => fetchPropertyNote(address),
    enabled: !!address,
  });

  useEffect(() => setDraft(q.data?.note ?? ""), [q.data?.note]);

  const save = useMutation({
    mutationFn: () =>
      savePropertyNote({
        address: address!,
        note: draft.trim() || null,
        userId: app.userId ?? null,
        locationId: locationId ?? null,
      }),
    onSuccess: () => {
      setEditing(false);
      toast.success("Property note saved — it now shows on every job at this address.");
      void qc.invalidateQueries({ queryKey: ["property-note"] });
    },
    onError: (e) => toastDbError(e, { action: "save the property note" }),
  });

  const canEdit = editable && !!address && !app.writesDisabled;
  if (!address) return null;

  if (editing) {
    return (
      <Editor
        title={`Property note — ${address}`}
        value={draft}
        onChange={setDraft}
        onSave={() => save.mutate()}
        onCancel={() => {
          setDraft(q.data?.note ?? "");
          setEditing(false);
        }}
        saving={save.isPending}
        placeholder="Rear entrance code 4412, fragile tenant relationship, park on the north side…"
      />
    );
  }

  if (!q.data) {
    if (!canEdit) return null;
    return (
      <Button
        size="sm"
        variant="outline"
        className="border-primary/40 text-xs"
        onClick={() => setEditing(true)}
      >
        <Home className="mr-1 size-3.5 text-primary" /> Add property note
      </Button>
    );
  }

  return (
    <BannerShell
      icon={<Home className="size-5" />}
      label={`Property note — ${q.data.address}`}
      tone="blue"
      onEdit={canEdit ? () => setEditing(true) : undefined}
    >
      {q.data.note}
    </BannerShell>
  );
}

/**
 * Discount arrangements are easy to miss when someone is heads-down building
 * an estimate, so the account note gets repeated at the top of the pricing
 * flow when it is money-related.
 */
export function AccountDiscountCallout({ accountId }: { accountId: string | null }) {
  const q = useQuery({
    queryKey: ["account-standing-note", accountId],
    queryFn: () => fetchAccountStandingNote(accountId),
    enabled: !!accountId,
  });
  const note = q.data;
  if (!note || (note.kind !== "discount" && note.kind !== "billing")) return null;
  return (
    <div className="flex items-start gap-2 rounded-sm border-2 border-warning bg-warning/15 p-3">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="text-xs font-bold uppercase tracking-wide">
          {note.kind === "discount" ? "Pricing arrangement" : "Billing instruction"} —{" "}
          {note.accountName}
        </div>
        <div className="whitespace-pre-wrap text-sm font-medium">{note.note}</div>
      </div>
    </div>
  );
}
