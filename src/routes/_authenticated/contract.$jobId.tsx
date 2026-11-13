/**
 * Signed on glass — the contract a homeowner signs on an iPad at the loss.
 *
 * Everything on this page has to complete with no signal: the signature is
 * captured on a canvas, the PDF is rendered on the device, the job is created
 * with a client-generated id and the sync plus the homeowner's email queue
 * locally. Nothing here waits on the network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Check,
  ChevronRight,
  ClipboardList,
  DollarSign,
  FileText,
  Home,
  Mail,
  MapPin,
  PenLine,
  RotateCcw,
  Save,
  ShieldCheck,
  User,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { getPositionOnce } from "@/lib/documents";
import { downloadPdf } from "@/lib/pdf-actions";
import {
  DEFAULT_TERMS,
  PAYMENT_NOTE,
  contractBrandFrom,
  enqueueContract,
  flushContractQueue,
  loadBrandLogo,
  loadContractContext,
  money,
  propertyAddress,
  pushSignedContract,
  renderContractPdf,
  type ContractSignInput,
} from "@/lib/contract-signing";
import { FitText } from "@/components/ui/fit-text";
import { DocumentSendDialog } from "@/components/document-send-dialog";

export const Route = createFileRoute("/_authenticated/contract/$jobId")({
  head: () => ({
    meta: [
      { title: "Contract signing · Recovery Hub" },
      {
        name: "description",
        content:
          "Sign the restoration services agreement on glass at the loss — works fully offline, files the signed PDF to the job.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ContractPage,
});

/* ------------------------------------------------------------------ */
/* Signature canvas                                                    */
/* ------------------------------------------------------------------ */

function GlassSignaturePad({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0f172a";
    };
    setup();
    window.addEventListener("resize", setup);
    return () => window.removeEventListener("resize", setup);
  }, []);

  useEffect(() => {
    if (value) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, [value]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div className="relative rounded-[10px] border border-primary/40 bg-background">
      <canvas
        ref={canvasRef}
        className="h-[150px] w-full touch-none rounded-[10px]"
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          drawing.current = true;
          const { x, y } = at(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          const { x, y } = at(e);
          ctx.lineTo(x, y);
          ctx.stroke();
        }}
        onPointerUp={() => {
          if (!drawing.current) return;
          drawing.current = false;
          onChange(canvasRef.current?.toDataURL("image/png") ?? null);
        }}
        onPointerLeave={() => {
          if (!drawing.current) return;
          drawing.current = false;
          onChange(canvasRef.current?.toDataURL("image/png") ?? null);
        }}
      />
      <div className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-dashed border-border" />
      <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[13px] text-muted-foreground">
        Sign with your finger
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Document sections                                                   */
/* ------------------------------------------------------------------ */

function SectionRow({
  n,
  icon: Icon,
  title,
  children,
}: {
  n: number;
  icon: typeof Home;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 border-b border-border py-6 last:border-b-0">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Icon className="size-5 text-primary" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="mb-3 text-[17px] font-bold text-foreground">
          {n}. {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="text-[14px] font-semibold text-foreground">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const TOTAL_PAGES = 3;

function ContractPage() {
  const { jobId } = Route.useParams();
  const app = useAppContext();
  const navigate = useNavigate();

  const ctxQ = useQuery({
    queryKey: ["contract-context", jobId],
    queryFn: () => loadContractContext(jobId),
  });

  const [page, setPage] = useState(1);
  const [sig, setSig] = useState<string | null>(null);
  const [printedName, setPrintedName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signDate, setSignDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [online, setOnline] = useState(true);
  const [steps, setSteps] = useState({ signature: false, pdf: false, email: false, job: false });
  const [signedJobNumber, setSignedJobNumber] = useState<string | null>(null);
  /** David, 15 Oct: the homeowner is not here — email the agreement to sign. */
  const [emailOpen, setEmailOpen] = useState(false);

  const ctx = ctxQ.data;
  const job = ctx?.job;
  const customerName = ctx?.customer.name ?? job?.customer_name ?? "Homeowner";

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => {
      setOnline(true);
      void flushContractQueue();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (!ctx) return;
    setPrintedName((n) => n || (ctx.customer.name ?? ctx.job.customer_name ?? ""));
    void getPositionOnce().then((p) => {
      if (p) setCoords({ lat: p.coords.latitude, lon: p.coords.longitude });
    });
  }, [ctx]);

  const signed = steps.signature;
  const status: "draft" | "ready" | "signed" = signed
    ? "signed"
    : sig && printedName.trim() && agreed
      ? "ready"
      : "draft";
  const canSign = !!sig && printedName.trim().length > 1 && agreed && !busy && !signed;

  const addr = job ? propertyAddress(job) : { line1: "—", line2: null };

  const buildInput = useCallback(async (): Promise<ContractSignInput | null> => {
    if (!ctx) return null;
    const logo = await loadBrandLogo(ctx.brand?.logo_url ?? null);
    return {
      documentId: crypto.randomUUID(),
      jobId: ctx.job.id,
      createJob: null,
      locationId: ctx.job.location_id,
      accountId: ctx.job.account_id,
      jobNumber: ctx.job.job_number,
      title: `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ""}`,
      body: ctx.body || DEFAULT_TERMS,
      meta: [
        ["Homeowner", customerName ?? "—"],
        ["Property", `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ""}`],
        ["Job", ctx.job.job_number ?? "To be assigned"],
        ["Carrier", ctx.job.insurance_carrier ?? "—"],
        ["Claim number", ctx.job.claim_number ?? "—"],
        ["Adjuster", ctx.job.adjuster_name ?? "—"],
        ["Estimated contract value", money(ctx.job.agreed_price ?? ctx.job.estimated_amount)],
        ["Deductible", money(ctx.job.deductible)],
      ],
      templateVersionId: ctx.version?.id ?? null,
      signerName: printedName.trim(),
      signerEmail: ctx.customer.email,
      signerPhone: ctx.customer.phone,
      signedAtIso: new Date(`${signDate}T${new Date().toTimeString().slice(0, 8)}`).toISOString(),
      signatureDataUrl: sig ?? "",
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      capturedBy: app.userId,
      userAgent: navigator.userAgent,
      brand: contractBrandFrom(ctx.brand, logo),
      emailTo: ctx.customer.email,
    };
  }, [ctx, addr.line1, addr.line2, customerName, printedName, signDate, sig, coords, app.userId]);

  const accept = async () => {
    if (!canSign || !ctx) return;
    setBusy(true);
    try {
      const input = await buildInput();
      if (!input) return;

      // 1. Signature is captured the moment the canvas is committed.
      setSteps((s) => ({ ...s, signature: true }));

      // 2. PDF renders on this device — no network involved.
      const bytes = await renderContractPdf(input);
      setSteps((s) => ({ ...s, pdf: true }));

      // 3 + 4. Upload, document rows, job link, homeowner email. Queued when
      // the device is offline or the write fails.
      let queued = false;
      try {
        if (!navigator.onLine) throw new Error("offline");
        await pushSignedContract(input);
      } catch {
        await enqueueContract(input);
        queued = true;
      }
      setSteps((s) => ({ ...s, email: true, job: true }));
      setSignedJobNumber(ctx.job.job_number);

      if (queued) {
        toast.warning(
          "No signal — signature, PDF and email are held on this device and will sync automatically.",
        );
      } else {
        toast.success("Contract signed and filed to the job.");
      }
      downloadPdf(bytes, `contract-${ctx.job.job_number ?? ctx.job.id.slice(0, 8)}.pdf`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not complete signing.");
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!ctx) return;
    const { error } = await supabase.from("documents").insert({
      location_id: ctx.job.location_id,
      job_id: ctx.job.id,
      account_id: ctx.job.account_id,
      doc_type: "contract",
      name: `Contract draft — ${addr.line1}`,
      status: "draft",
      template_version_id: ctx.version?.id ?? null,
      created_by: app.userId,
    } as never);
    if (error)
      toast.error("Draft could not be saved right now — the signature flow still works offline.");
    else toast.success("Draft saved to the job's documents.");
  };

  if (ctxQ.isLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-14 w-full" />
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Skeleton className="h-[600px]" />
          <Skeleton className="h-[600px]" />
        </div>
      </div>
    );
  }

  if (ctxQ.isError || !ctx || !job) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        This job could not be loaded for signing.{" "}
        <BackLink fallbackTo="/jobs" label="jobs" className="text-primary underline">
          Back to jobs
        </BackLink>
      </div>
    );
  }

  const contractValue = job.agreed_price ?? job.estimated_amount;

  return (
    <div className="min-h-full bg-muted/40">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-background px-5 py-3.5">
        <BackLink
          fallbackTo="/jobs/$id"
          fallbackParams={{ id: job.id }}
          label="Job"
          className="flex shrink-0 items-center gap-2 text-[15px] font-medium text-foreground"
        >
          <ArrowLeft className="size-5" aria-hidden />
          Back to Job
        </BackLink>
        <h1 className="display-heavy shrink-0 text-[26px] tracking-tight text-foreground">
          Contract
        </h1>
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-medium text-foreground">
          <Home className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{addr.line1}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-medium text-foreground">
          <User className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{customerName}</span>
        </div>
        <Badge
          className={
            status === "signed"
              ? "rounded-full bg-success/15 px-3 py-1 text-[13px] font-semibold text-success"
              : status === "ready"
                ? "rounded-full bg-warning/15 px-3 py-1 text-[13px] font-semibold text-warning"
                : "rounded-full bg-muted px-3 py-1 text-[13px] font-semibold text-muted-foreground"
          }
        >
          {status === "signed" ? "Signed" : status === "ready" ? "Ready for Signature" : "Draft"}
        </Badge>
        <Button
          variant="outline"
          className="ml-auto h-10 rounded-[10px] text-[15px] font-semibold text-primary"
          onClick={saveDraft}
          disabled={app.writesDisabled}
        >
          <Save className="mr-2 size-4" aria-hidden />
          Save Draft
        </Button>
        {/* Email is the primary action (David, 21 Oct: most contracts are
            emailed); signing on this screen stays below. */}
        <Button
          className="h-10 rounded-[10px] text-[15px] font-semibold"
          onClick={() => setEmailOpen(true)}
          disabled={app.writesDisabled || signed}
          data-contract-email
        >
          <Mail className="mr-2 size-4" aria-hidden />
          Email to sign
        </Button>
        <DocumentSendDialog
          open={emailOpen}
          onOpenChange={setEmailOpen}
          jobId={job.id}
          accountId={job.account_id}
          locationId={job.location_id}
          // The dialog says what happened to the email itself.
          onSent={() => undefined}
          presetDocTypes={["service_agreement", "contract"]}
        />
      </header>

      <div className="grid items-start gap-5 px-5 pb-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* ---------------- Document ---------------- */}
        <section className="overflow-hidden rounded-xl border border-border bg-background">
          <div className="flex items-center justify-between gap-4 border-b border-border px-8 py-6">
            <div className="flex items-center gap-3">
              <img
                src="/gold-star-badge.png"
                alt=""
                aria-hidden
                className="size-9 object-contain"
              />
              <span className="display-heavy text-[22px] uppercase tracking-[0.04em] text-[var(--brand-gold-text)]">
                Gold Star
              </span>
            </div>
            <div className="text-[17px] font-bold text-foreground">
              Restoration Services Agreement
            </div>
          </div>

          <div className="px-8 pb-2">
            {page === 1 && (
              <>
                <SectionRow n={1} icon={User} title="Customer & Property">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Homeowner">
                      <div>{customerName}</div>
                      <div className="font-normal text-muted-foreground">
                        {ctx.customer.email ?? "—"}
                      </div>
                      <div className="font-normal text-muted-foreground">
                        {ctx.customer.phone ?? "—"}
                      </div>
                    </Field>
                    <Field label="Property Address">
                      <div>{addr.line1}</div>
                      <div className="font-normal text-muted-foreground">{addr.line2 ?? "—"}</div>
                    </Field>
                  </div>
                </SectionRow>

                <SectionRow n={2} icon={ClipboardList} title="Scope of Work">
                  <p className="text-[14px] leading-6 text-foreground">
                    {job.scope?.trim() ||
                      job.loss_description?.trim() ||
                      `Gold Star Restoration will provide labor, materials, equipment, and supervision to perform ${
                        job.loss_type ? `${job.loss_type} ` : ""
                      }mitigation, structural drying, and rebuild services as outlined in the detailed scope of work and estimate.`}
                  </p>
                </SectionRow>

                <SectionRow n={3} icon={ShieldCheck} title="Insurance & Claim">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Insurance Carrier">{job.insurance_carrier ?? "—"}</Field>
                    <Field label="Claim Number">{job.claim_number ?? "—"}</Field>
                    <Field label="Assigned Adjuster">{job.adjuster_name ?? "—"}</Field>
                  </div>
                  <p className="mt-3 text-[14px] leading-6 text-foreground">
                    Work will be completed according to carrier requirements and industry standards.
                  </p>
                </SectionRow>

                <SectionRow n={4} icon={DollarSign} title="Pricing Summary">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <div className="text-[13px] text-muted-foreground">
                        Estimated Contract Value
                      </div>
                      <FitText className="text-[22px] font-bold text-foreground tabular-nums">
                        {money(contractValue)}
                      </FitText>
                    </div>
                    <div>
                      <div className="text-[13px] text-muted-foreground">Deductible</div>
                      <FitText className="text-[22px] font-bold text-foreground tabular-nums">
                        {money(job.deductible)}
                      </FitText>
                    </div>
                    <Field label="Insurance Carrier">{job.insurance_carrier ?? "—"}</Field>
                  </div>
                  <p className="mt-3 text-[14px] leading-6 text-foreground">{PAYMENT_NOTE}</p>
                </SectionRow>

                <SectionRow n={5} icon={PenLine} title="Terms & Authorization">
                  <p className="text-[14px] leading-6 text-foreground">
                    {(ctx.body || DEFAULT_TERMS).split("\n\n")[0]}
                  </p>
                </SectionRow>
              </>
            )}

            {page === 2 && (
              <div className="space-y-4 py-6">
                <h3 className="text-[17px] font-bold text-foreground">Full agreement terms</h3>
                {(ctx.body || DEFAULT_TERMS).split("\n\n").map((p, i) => (
                  <p key={i} className="text-[14px] leading-6 text-foreground">
                    {p}
                  </p>
                ))}
              </div>
            )}

            {page === 3 && (
              <div className="space-y-4 py-6">
                <h3 className="text-[17px] font-bold text-foreground">Signature & record</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Template">{ctx.template?.name ?? "Standard agreement"}</Field>
                  <Field label="Version signed">
                    {ctx.version ? `v${ctx.version.version}` : "Standard wording"}
                  </Field>
                  <Field label="Signing office">
                    {ctx.brand?.legal_entity_name ?? ctx.brand?.name ?? "Gold Star Restoration"}
                  </Field>
                  <Field label="Job">{job.job_number ?? "To be assigned on signing"}</Field>
                </div>
                <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <MapPin className="size-3.5" aria-hidden />
                  {coords
                    ? `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)} will be recorded with the signature`
                    : "Coordinates unavailable — the signature is still valid and records without them"}
                </p>
                <p className="text-[14px] leading-6 text-foreground">
                  The signed PDF, the signer's printed name, the timestamp and the exact template
                  version are stored together so the wording agreed to can always be proven.
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-border px-8 py-5">
            <Button
              variant="secondary"
              className="h-11 rounded-[10px] px-5 text-[15px] font-semibold"
              disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ArrowLeft className="mr-2 size-4" aria-hidden />
              Previous
            </Button>
            <div className="text-[15px] font-medium text-foreground">
              Page {page} of {TOTAL_PAGES}
            </div>
            <Button
              className="h-11 rounded-[10px] px-6 text-[15px] font-semibold"
              disabled={page === TOTAL_PAGES}
              onClick={() => setPage((p) => Math.min(TOTAL_PAGES, p + 1))}
            >
              Next
              <ArrowRight className="ml-2 size-4" aria-hidden />
            </Button>
          </div>
        </section>

        {/* ---------------- Right rail ---------------- */}
        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-background p-5">
            <Stepper current={signed ? 3 : sig ? 2 : 1} />

            <h2 className="mb-2 mt-6 text-[15px] font-bold text-foreground">Homeowner Signature</h2>
            <GlassSignaturePad value={sig} onChange={setSig} disabled={signed} />

            <button
              className="mt-2 flex items-center gap-1.5 text-[14px] font-medium text-primary disabled:opacity-50"
              onClick={() => setSig(null)}
              disabled={!sig || signed}
            >
              <RotateCcw className="size-4" aria-hidden />
              Clear Signature
            </button>

            <div className="mt-4 space-y-2">
              <Label htmlFor="printed" className="text-[14px] text-muted-foreground">
                Signer Printed Name
              </Label>
              <Input
                id="printed"
                className="h-11 rounded-[10px] text-[15px]"
                value={printedName}
                onChange={(e) => setPrintedName(e.target.value)}
                disabled={signed}
                autoComplete="name"
              />
            </div>

            <label className="mt-4 flex items-center gap-2.5 text-[15px] font-medium text-foreground">
              <Checkbox
                checked={agreed}
                onCheckedChange={(v) => setAgreed(v === true)}
                disabled={signed}
                className="size-5"
              />
              I agree to the contract terms
            </label>

            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[15px] text-muted-foreground">Date</span>
              <Input
                type="date"
                className="h-10 w-[180px] rounded-[10px] text-[15px]"
                value={signDate}
                onChange={(e) => setSignDate(e.target.value)}
                disabled={signed}
              />
            </div>

            <Button
              className="mt-4 h-14 w-full rounded-[10px] text-[16px] font-semibold"
              disabled={!canSign}
              onClick={accept}
            >
              <PenLine className="mr-2 size-5" aria-hidden />
              {signed ? "Contract Signed" : busy ? "Signing…" : "Accept & Sign Contract"}
            </Button>
          </section>

          <section className="rounded-xl border border-border bg-background p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-bold text-foreground">After Signing</h2>
              <span className="flex items-center gap-1.5 text-[13px] font-medium">
                <span
                  className={`size-2.5 rounded-full ${online ? "bg-success" : "bg-warning"}`}
                  aria-hidden
                />
                <span className={online ? "text-success" : "text-warning"}>
                  {online ? "Online" : "Offline"}
                </span>
              </span>
            </div>
            <ul className="overflow-hidden rounded-[10px] border border-border">
              {[
                { icon: FileText, tone: "text-destructive", label: "Generate PDF on this device" },
                { icon: Mail, tone: "text-primary", label: "Email homeowner immediately" },
                { icon: RotateCcw, tone: "text-warning", label: "Queue email when offline" },
                {
                  icon: Briefcase,
                  tone: "text-success",
                  label: "Automatically create restoration job",
                },
              ].map((r) => (
                <li
                  key={r.label}
                  className="flex items-center gap-3 border-b border-border px-3.5 py-3 text-[14px] text-foreground last:border-b-0"
                >
                  <r.icon className={`size-4 shrink-0 ${r.tone}`} aria-hidden />
                  {r.label}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] leading-5 text-muted-foreground">
              When offline, the signed PDF and email are securely queued until connection returns.
            </p>
          </section>

          <section className="rounded-xl border border-border bg-background px-4 py-4">
            <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]">
              <ChainStep done={steps.signature} label={["Signature", "captured"]} />
              <ChainSep />
              <ChainStep done={steps.pdf} label={["PDF", "generated"]} />
              <ChainSep />
              <ChainStep done={steps.email} label={["Email", online ? "sent" : "queued"]} />
              <ChainSep />
              <ChainStep
                done={steps.job}
                label={["Job", signedJobNumber ?? job.job_number ?? "pending"]}
                href={steps.job ? job.id : null}
              />
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  const steps: [number, string][] = [
    [1, "Review"],
    [2, "Sign"],
    [3, "Complete"],
  ];
  return (
    <div className="flex items-start">
      {steps.map(([n, label], i) => (
        <div key={n} className="flex flex-1 items-start">
          <div className="flex w-full flex-col items-center">
            <div
              className={`flex size-8 items-center justify-center rounded-full text-[14px] font-semibold ${
                n === current
                  ? "bg-primary text-primary-foreground"
                  : n < current
                    ? "bg-success text-success-foreground"
                    : "border border-border bg-background text-muted-foreground"
              }`}
            >
              {n < current ? <Check className="size-4" aria-hidden /> : n}
            </div>
            <div
              className={`mt-2 text-[13px] ${
                n === current ? "font-semibold text-primary" : "text-muted-foreground"
              }`}
            >
              {label}
            </div>
          </div>
          {i < steps.length - 1 && <div className="mt-4 h-px w-full flex-1 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function ChainSep() {
  return <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />;
}

function ChainStep({
  done,
  label,
  href,
}: {
  done: boolean;
  label: [string, string];
  href?: string | null;
}) {
  const body = (
    <span className="flex items-center gap-1.5">
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded-full ${
          done ? "bg-success text-success-foreground" : "border border-border text-transparent"
        }`}
      >
        <Check className="size-2.5" aria-hidden />
      </span>
      <span className="leading-4">
        <span className="block text-muted-foreground">{label[0]}</span>
        <span className={`block font-medium ${href ? "text-primary" : "text-foreground"}`}>
          {label[1]}
        </span>
      </span>
    </span>
  );
  if (href) {
    return (
      <li>
        <Link to="/jobs/$id" params={{ id: href }}>
          {body}
        </Link>
      </li>
    );
  }
  return <li>{body}</li>;
}
