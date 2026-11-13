import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { FileUp, Loader2, Sparkles } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { extractCredentialDocument } from "@/lib/ai.functions";
import {
  CATEGORY_LABEL,
  CREDENTIAL_CATALOG,
  CREDENTIAL_LIBRARY_BUCKET,
  credentialKind,
  credentialLabel,
} from "@/lib/credentials";

/**
 * Upload once, read the document, confirm what was read.
 *
 * The extraction is a proposal — every value is editable and visibly marked as
 * read from the file, because a misread expiry that quietly marks an account
 * compliant is the failure that actually costs money.
 */

type Draft = {
  kind: string;
  include: boolean;
  policy_number: string;
  effective_date: string;
  expiry_date: string;
  limit_occurrence: string;
  limit_aggregate: string;
};

const KEYS = CREDENTIAL_CATALOG.map((k) => k.key);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });
}

export function CredentialUploadDialog({
  locations,
  defaultLocationId,
  onClose,
  onSaved,
}: {
  locations: { id: string; name: string }[];
  defaultLocationId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const extract = useServerFn(extractCredentialDocument);

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState(false);
  const [confidence, setConfidence] = useState<string | null>(null);
  const [carrier, setCarrier] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [holderLoc, setHolderLoc] = useState(defaultLocationId ?? "all");
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const emptyDraft = (kind: string): Draft => ({
    kind,
    include: true,
    policy_number: "",
    effective_date: "",
    expiry_date: "",
    limit_occurrence: "",
    limit_aggregate: "",
  });

  const patch = (i: number, p: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...p } : d)));

  const onPick = async (f: File | null) => {
    setFile(f);
    setRead(false);
    setDrafts([]);
    if (!f) return;
    if (f.size > 15_000_000) {
      toast.error("That file is too large to read — 15 MB max.");
      return;
    }
    setReading(true);
    try {
      const base64 = await toBase64(f);
      const r = await extract({
        data: {
          file_base64: base64,
          mime: f.type || "application/pdf",
          file_name: f.name,
          kinds: KEYS,
        },
      });
      setCarrier(r.carrier ?? r.issuer ?? "");
      setStateCode(r.state_code ?? "");
      setConfidence(r.confidence);
      const rows: Draft[] =
        r.coverages.length > 0
          ? r.coverages.map((c) => ({
              kind: c.kind,
              include: true,
              policy_number: c.policy_number ?? r.policy_number ?? "",
              effective_date: c.effective_date ?? r.effective_date ?? "",
              expiry_date: c.expiry_date ?? r.expiry_date ?? "",
              limit_occurrence: c.limit_occurrence != null ? String(c.limit_occurrence) : "",
              limit_aggregate: c.limit_aggregate != null ? String(c.limit_aggregate) : "",
            }))
          : [
              {
                ...emptyDraft(r.kind ?? "certificate_of_insurance"),
                policy_number: r.policy_number ?? "",
                effective_date: r.effective_date ?? "",
                expiry_date: r.expiry_date ?? "",
                limit_occurrence: r.limit_occurrence != null ? String(r.limit_occurrence) : "",
                limit_aggregate: r.limit_aggregate != null ? String(r.limit_aggregate) : "",
              },
            ];
      setDrafts(rows);
      setRead(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read that document");
      setDrafts([emptyDraft("certificate_of_insurance")]);
      setRead(true);
    }
    setReading(false);
  };

  const save = async () => {
    const chosen = drafts.filter((d) => d.include);
    if (chosen.length === 0) {
      toast.error("Tick at least one credential to save.");
      return;
    }
    setBusy(true);

    // The document itself lives once, alongside the credentials it evidences.
    let storagePath: string | null = null;
    if (file) {
      const path = `library/${holderLoc === "all" ? "all" : holderLoc}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_").slice(-80)}`;
      const up = await supabase.storage
        .from(CREDENTIAL_LIBRARY_BUCKET)
        .upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (!up.error) storagePath = path;
    }

    const payload = chosen.map((d) => ({
      category: credentialKind(d.kind)?.category ?? "insurance",
      kind: d.kind,
      name: credentialLabel(d.kind),
      carrier: credentialKind(d.kind)?.category === "insurance" ? carrier || null : null,
      issuer: credentialKind(d.kind)?.category === "insurance" ? null : carrier || null,
      policy_number: d.policy_number || null,
      limit_occurrence: d.limit_occurrence ? Number(d.limit_occurrence) : null,
      limit_aggregate: d.limit_aggregate ? Number(d.limit_aggregate) : null,
      effective_date: d.effective_date || null,
      expiry_date: d.expiry_date || null,
      state_code: stateCode || null,
      holder_location_id: holderLoc === "all" ? null : holderLoc,
      notes: storagePath ? `Document: ${storagePath}` : null,
      created_by: app.userId,
    }));

    const { error } = await supabase.from("company_credentials").insert(payload);
    setBusy(false);
    if (error) {
      toastDbError(error, { action: "Save credentials" });
      return;
    }
    toast.success(
      `${payload.length} credential${payload.length === 1 ? "" : "s"} saved — matching requirements tick automatically`,
    );
    onSaved();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            <FileUp className="mr-1 inline size-4" /> Upload a certificate
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[11px]">Document (COI, IICRC, EPA RRP, license, W-9)</Label>
            <Input
              type="file"
              accept="application/pdf,image/*"
              className="h-9 text-[12px]"
              onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
            />
          </div>

          {reading && (
            <div className="flex items-center gap-2 rounded-[6px] border bg-muted/40 px-2.5 py-2 text-[12px]">
              <Loader2 className="size-3.5 animate-spin" /> Reading the document…
            </div>
          )}

          {read && (
            <>
              <div className="flex items-start gap-2 rounded-[6px] border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
                <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                <div>
                  <span className="font-medium">Check what was read.</span> These values came from
                  the document and nothing is saved until you confirm them — a wrong expiry would
                  mark clients compliant when they are not.
                  {confidence && (
                    <Badge variant="outline" className="ml-1.5 h-4 rounded-[4px] px-1 text-[10px]">
                      {confidence} confidence
                    </Badge>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">Carrier / issuer</Label>
                  <Input
                    className="h-8 text-[12px]"
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">State</Label>
                  <Input
                    className="h-8 text-[12px]"
                    value={stateCode}
                    onChange={(e) => setStateCode(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">Held by entity</Label>
                  <Select value={holderLoc} onValueChange={setHolderLoc}>
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All entities</SelectItem>
                      {locations.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                {drafts.map((d, i) => (
                  <div key={`${d.kind}-${i}`} className="rounded-[6px] border px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={d.include}
                        onCheckedChange={(v) => patch(i, { include: v === true })}
                      />
                      <Select value={d.kind} onValueChange={(v) => patch(i, { kind: v })}>
                        <SelectTrigger className="h-7 w-64 text-[12px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(["insurance", "certification", "licence"] as const).map((g) => (
                            <div key={g}>
                              <div className="px-2 py-1 text-[10px] uppercase text-muted-foreground">
                                {CATEGORY_LABEL[g]}
                              </div>
                              {CREDENTIAL_CATALOG.filter((k) => k.category === g).map((k) => (
                                <SelectItem key={k.key} value={k.key}>
                                  {k.label}
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      <Cell label="Policy / cert no.">
                        <Input
                          className="h-7 text-[11px]"
                          value={d.policy_number}
                          onChange={(e) => patch(i, { policy_number: e.target.value })}
                        />
                      </Cell>
                      <Cell label="Effective">
                        <Input
                          type="date"
                          className="h-7 text-[11px]"
                          value={d.effective_date}
                          onChange={(e) => patch(i, { effective_date: e.target.value })}
                        />
                      </Cell>
                      <Cell label="Expires">
                        <Input
                          type="date"
                          className="h-7 text-[11px]"
                          value={d.expiry_date}
                          onChange={(e) => patch(i, { expiry_date: e.target.value })}
                        />
                      </Cell>
                      <Cell label="Per occurrence">
                        <NumberInput
                          decimals={0}
                          className="h-7 text-[11px]"
                          value={d.limit_occurrence}
                          onValueChange={(_, clean) => patch(i, { limit_occurrence: clean })}
                        />
                      </Cell>
                      <Cell label="Aggregate">
                        <NumberInput
                          decimals={0}
                          className="h-7 text-[11px]"
                          value={d.limit_aggregate}
                          onValueChange={(_, clean) => patch(i, { limit_aggregate: clean })}
                        />
                      </Cell>
                    </div>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setDrafts((p) => [...p, emptyDraft("general_liability")])}
                >
                  Add another coverage
                </Button>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy || !read}>
            Save {drafts.filter((d) => d.include).length || ""} credential
            {drafts.filter((d) => d.include).length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
