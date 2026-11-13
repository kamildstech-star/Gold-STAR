import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileText, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SignaturePad } from "@/components/signature-pad";
import { loadSignPacket, submitSignPacket } from "@/lib/document-sign.functions";

export const Route = createFileRoute("/sign/$token")({
  head: () => ({
    meta: [
      { title: "Review and sign — Gold Star Restoration" },
      {
        name: "description",
        content:
          "Securely review your restoration paperwork and add your signature. No account needed.",
      },
      { name: "robots", content: "noindex" },
      { property: "og:title", content: "Review and sign — Gold Star Restoration" },
      {
        property: "og:description",
        content: "Securely review and sign your restoration paperwork.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PublicSignPage,
});

const DEAD_LINK: Record<string, string> = {
  not_found: "This link is not valid. Ask your Gold Star contact to send a new one.",
  revoked: "This request was withdrawn. Please contact your Gold Star representative.",
  expired: "This link has expired. Ask your Gold Star contact for a fresh link.",
  completed: "These documents have already been signed. Thank you.",
};

/** A typed name is rendered to a PNG so the stamped PDF looks the same either way. */
function typedSignatureDataUrl(name: string): string | null {
  if (typeof document === "undefined" || !name.trim()) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#10243D";
  ctx.font = "italic 76px Georgia, 'Times New Roman', serif";
  ctx.textBaseline = "middle";
  ctx.fillText(name.trim().slice(0, 40), 24, 110);
  return canvas.toDataURL("image/png");
}

function PublicSignPage() {
  const { token } = Route.useParams();
  const load = useServerFn(loadSignPacket);
  const submit = useServerFn(submitSignPacket);

  const q = useQuery({
    queryKey: ["public-sign", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [signerName, setSignerName] = useState("");
  const [signerRole, setSignerRole] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [done, setDone] = useState(false);
  const scrolled = useRef(false);

  useEffect(() => {
    if (!q.data?.ok || scrolled.current) return;
    scrolled.current = true;
    setSignerName(q.data.recipientName ?? "");
    const pre: Record<string, string> = {};
    for (const f of q.data.fields ?? []) if (f.value) pre[f.key] = f.value;
    setValues(pre);
  }, [q.data]);

  const needsSignature = useMemo(
    () => (q.data?.documents ?? []).some((d) => d.requiresSignature),
    [q.data],
  );

  const signature = mode === "draw" ? drawn : typedSignatureDataUrl(signerName);

  const send = useMutation({
    mutationFn: () =>
      submit({
        data: {
          token,
          signerName,
          signerRole: signerRole || null,
          signerEmail: signerEmail || null,
          signatureDataUrl: signature ?? "",
          fieldValues: values,
        },
      }),
    onSuccess: () => setDone(true),
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not submit your signature."),
  });

  if (q.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/40 p-6 text-sm text-muted-foreground">
        Loading your documents…
      </div>
    );
  }

  if (!q.data?.ok) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/40 p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Link unavailable</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {DEAD_LINK[q.data?.reason ?? "not_found"]}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (done) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/40 p-6">
        <Card className="max-w-md text-center">
          <CardContent className="space-y-3 pt-8 pb-8">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            <h1 className="text-lg font-semibold">Thank you — we have your signature</h1>
            <p className="text-sm text-muted-foreground">
              A copy has been filed with your job
              {q.data.jobNumber ? ` (${q.data.jobNumber})` : ""}. Your Gold Star team has been
              notified and will be in touch.
            </p>
            {q.data.officePhone ? (
              <p className="text-sm">
                Questions? Call{" "}
                <a className="font-medium underline" href={`tel:${q.data.officePhone}`}>
                  {q.data.officePhone}
                </a>
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  const fields = q.data.fields ?? [];
  const missing = fields.filter((f) => !(values[f.key] ?? "").trim());
  const canSubmit =
    signerName.trim().length > 1 &&
    agreed &&
    !missing.length &&
    (!needsSignature || Boolean(signature));

  return (
    <div className="min-h-screen bg-muted/40 pb-24">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          {q.data.officeLogoUrl ? (
            <img
              src={q.data.officeLogoUrl}
              alt={`${q.data.companyName} logo`}
              className="h-9 w-auto"
            />
          ) : (
            <span className="text-base font-semibold">{q.data.companyName}</span>
          )}
          <div className="ml-auto text-right text-xs text-muted-foreground">
            <div>{q.data.officeName}</div>
            {q.data.jobNumber ? <div>Job {q.data.jobNumber}</div> : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div className="rounded-lg border bg-background p-4">
          <h1 className="text-lg font-semibold">{q.data.subject}</h1>
          {q.data.message ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
              {q.data.message}
            </p>
          ) : null}
        </div>

        {(q.data.documents ?? []).map((doc) => (
          <Card key={doc.id}>
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">{doc.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-md border bg-card p-4 text-sm leading-relaxed">
                {doc.body || "This document has no content yet."}
              </div>
            </CardContent>
          </Card>
        ))}

        {fields.length ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Information we still need</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`f-${f.key}`}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sign</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="signer-name">Full name</Label>
                <Input
                  id="signer-name"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  autoComplete="name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signer-role">Capacity</Label>
                <Input
                  id="signer-role"
                  placeholder="Property owner"
                  value={signerRole}
                  onChange={(e) => setSignerRole(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signer-email">Email</Label>
                <Input
                  id="signer-email"
                  type="email"
                  value={signerEmail}
                  onChange={(e) => setSignerEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
            </div>

            {needsSignature ? (
              <div className="space-y-2">
                <Tabs value={mode} onValueChange={(v) => setMode(v as "draw" | "type")}>
                  <TabsList>
                    <TabsTrigger value="draw">Draw</TabsTrigger>
                    <TabsTrigger value="type">Type</TabsTrigger>
                  </TabsList>
                </Tabs>
                {mode === "draw" ? (
                  <SignaturePad onChange={setDrawn} />
                ) : (
                  <div className="grid h-[120px] place-items-center rounded-md border bg-card">
                    <span
                      className="text-4xl text-primary"
                      style={{
                        fontFamily: "Georgia, 'Times New Roman', serif",
                        fontStyle: "italic",
                      }}
                    >
                      {signerName || "Your name"}
                    </span>
                  </div>
                )}
              </div>
            ) : null}

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>
                I have read the {(q.data.documents ?? []).length === 1 ? "document" : "documents"}{" "}
                above and agree that my electronic signature is legally binding.
              </span>
            </label>

            <Button
              size="lg"
              className="w-full"
              disabled={!canSubmit || send.isPending}
              onClick={() => send.mutate()}
            >
              {send.isPending ? "Submitting…" : "Sign and submit"}
            </Button>

            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Your signature, the time and your device are recorded with the document.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
