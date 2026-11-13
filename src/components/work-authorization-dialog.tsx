import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { loadLocationBrand } from "@/lib/document-templates";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SignaturePad } from "@/components/signature-pad";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import {
  WORK_AUTHORIZATION_BODY,
  enqueueAuthorization,
  flushAuthorizationQueue,
  getPositionOnce,
  listAuthorizationQueue,
  submitAuthorization,
  type AuthorizationInput,
} from "@/lib/documents";
import { CloudOff, Mail, MapPin, PenLine, RefreshCw } from "lucide-react";

type Target = {
  jobId?: string | null;
  accountId?: string | null;
  incidentId?: string | null;
  locationId: string;
  jobNumber?: string | null;
  address: string;
  lossType?: string | null;
  /** The folder open in Documents; null files it in Work Authorizations. */
  folderId?: string | null;
};

/**
 * The single most important document in the business: the no-cost work
 * authorisation, signed on a phone at the loss site. It must complete with no
 * signal — if the network is gone the whole payload (including the rendered
 * PDF inputs) is queued locally and synced later.
 */
export function WorkAuthorizationDialog({
  target,
  open,
  onOpenChange,
  onSigned,
  onEmailInstead,
}: {
  target: Target;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSigned?: () => void;
  /**
   * The signer is not standing there: email it to them to sign instead
   * (David, 15 Oct). The caller opens its send dialog.
   */
  onEmailInstead?: () => void;
}) {
  const app = useAppContext();
  const [signerName, setSignerName] = useState("");
  const [signerRole, setSignerRole] = useState("Property owner");
  const [signerPhone, setSignerPhone] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [body, setBody] = useState(WORK_AUTHORIZATION_BODY);
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);

  // Entity identity for the PDF header — resolved from the job's billing
  // location (falling back to the operating office), never hardcoded.
  const brandQ = useQuery({
    queryKey: ["auth-doc-brand", target.jobId ?? null, target.locationId, open],
    enabled: open,
    queryFn: async () => {
      let locId = target.locationId;
      if (target.jobId) {
        const { data } = await supabase
          .from("jobs")
          .select("billing_location_id, location_id")
          .eq("id", target.jobId)
          .maybeSingle();
        locId = data?.billing_location_id ?? data?.location_id ?? locId;
      }
      return locId ? await loadLocationBrand(locId) : null;
    },
  });

  useEffect(() => {
    if (!open) return;
    setCoords(null);
    getPositionOnce().then((p) => {
      if (p) setCoords({ lat: p.coords.latitude, lon: p.coords.longitude });
    });
  }, [open]);

  const submit = async () => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    if (!signerName.trim()) {
      toast.error("Signer name is required.");
      return;
    }
    if (!sig) {
      toast.error("A signature is required.");
      return;
    }
    setBusy(true);
    const input: AuthorizationInput = {
      documentId: crypto.randomUUID(),
      jobId: target.jobId ?? null,
      accountId: target.accountId ?? null,
      incidentId: target.incidentId ?? null,
      locationId: target.locationId,
      jobNumber: target.jobNumber ?? null,
      address: target.address,
      lossType: target.lossType ?? null,
      signerName: signerName.trim(),
      signerRole: signerRole.trim() || null,
      signerPhone: signerPhone.trim() || null,
      signerEmail: signerEmail.trim() || null,
      signedAtIso: new Date().toISOString(),
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      bodyText: body,
      signatureDataUrl: sig,
      capturedBy: app.userId,
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      entityName: brandQ.data?.legal_entity_name ?? brandQ.data?.name ?? null,
      entityPhone: brandQ.data?.office_phone ?? null,
      folderId: target.folderId ?? null,
    };

    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    try {
      if (!online) throw new Error("offline");
      await submitAuthorization(input);
      toast.success("Authorization signed and stored.");
      onOpenChange(false);
      onSigned?.();
    } catch (e) {
      // No signal, or the write failed — never lose the signature.
      await enqueueAuthorization(input);
      if (!online) {
        toast.warning(
          "No signal — authorization saved on this device and will sync automatically.",
        );
        onOpenChange(false);
        onSigned?.();
      } else {
        toastDbError(e, { action: "Storing the signed authorization" });
        toast.warning("Saved on this device; it will retry from the queue.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Work authorization</DialogTitle>
          <DialogDescription>
            {target.address}
            {target.jobNumber ? ` · ${target.jobNumber}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="signer">Signer name</Label>
              <Input
                id="signer"
                className="h-12 text-base"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Full name"
                autoComplete="name"
              />
            </div>
            <div>
              <Label htmlFor="capacity">Capacity</Label>
              <Input
                id="capacity"
                className="h-12 text-base"
                value={signerRole}
                onChange={(e) => setSignerRole(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                type="tel"
                inputMode="tel"
                className="h-12 text-base"
                value={signerPhone}
                onChange={(e) => setSignerPhone(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                inputMode="email"
                className="h-12 text-base"
                value={signerEmail}
                onChange={(e) => setSignerEmail(e.target.value)}
              />
            </div>
          </div>

          <details className="rounded-sm border p-3 text-sm">
            <summary className="cursor-pointer font-medium">Authorization text</summary>
            <Textarea
              className="mt-2 min-h-[160px] text-xs"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </details>

          <div>
            <Label className="mb-1 block">Signature</Label>
            <SignaturePad onChange={setSig} disabled={busy} />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            {coords
              ? `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)} captured at signing`
              : "Coordinates not available — the signature is still valid and will record without them"}
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            className="h-14 w-full text-base"
            onClick={submit}
            disabled={busy || app.writesDisabled}
          >
            <PenLine className="mr-2 h-5 w-5" />
            {busy ? "Storing…" : "Sign and store"}
          </Button>
          {onEmailInstead && (
            <Button
              variant="outline"
              className="h-11 w-full"
              disabled={busy || app.writesDisabled}
              onClick={onEmailInstead}
            >
              <Mail className="mr-2 h-4 w-4" />
              Not here? Email it to sign
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shows anything captured with no signal, with a manual retry. */
export function SignatureQueueBanner() {
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = async () => setCount((await listAuthorizationQueue()).length);

  useEffect(() => {
    refresh();
    const onOnline = () => flushAuthorizationQueue().then(refresh);
    window.addEventListener("online", onOnline);
    const t = setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(t);
    };
  }, []);

  if (count === 0) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <CloudOff className="h-4 w-4" />
        {count} signed authorization{count === 1 ? "" : "s"} waiting to sync from this device.
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await flushAuthorizationQueue();
          setBusy(false);
          await refresh();
          if (r.synced) toast.success(`${r.synced} authorization(s) synced.`);
          if (r.failed) toast.error(`${r.failed} still queued.`);
        }}
      >
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
        Sync now
      </Button>
    </div>
  );
}

/** Small helper used by the documents page to count signed authorisations. */
export function SignedBadge({ status }: { status: string }) {
  if (status !== "signed") return null;
  return <Badge className="bg-success/15 text-success">Signed</Badge>;
}

export async function countJobDocuments(jobId: string): Promise<number> {
  const { count } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  return count ?? 0;
}
