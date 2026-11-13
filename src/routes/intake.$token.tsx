import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, ImagePlus, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import type {
  AddressResolveFn,
  AddressReverseFn,
  AddressSearchFn,
  AddressSuggestion,
} from "@/lib/address.functions";

import { AddressAutocomplete } from "@/components/address-autocomplete";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  clearedIntakeGeoFields,
  INTAKE_PHOTO_BUCKET,
  INTAKE_PHOTO_MAX_BYTES,
  INTAKE_PHOTO_MAX_COUNT,
  standaloneFormProblem,
  type IntakePhoto,
} from "@/lib/intake-form";
import {
  createIntakePhotoUpload,
  loadIntakeRequest,
  resolveIntakeAddress,
  reverseIntakeAddress,
  searchIntakeAddresses,
  submitIntakeRequest,
} from "@/lib/intake-public.functions";

export const Route = createFileRoute("/intake/$token")({
  head: () => ({
    meta: [
      { title: "Claim information request — Gold Star Restoration" },
      {
        name: "description",
        content:
          "Secure form to confirm the property, insured and claim details for an active restoration job.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PublicIntakePage,
});

type Answer = { text?: string | null; bool?: boolean | null; date?: string | null };

function PublicIntakePage() {
  const { token } = Route.useParams();
  const load = useServerFn(loadIntakeRequest);
  const submit = useServerFn(submitIntakeRequest);
  const uploadUrl = useServerFn(createIntakePhotoUpload);
  const lookupAddress = useServerFn(searchIntakeAddresses);
  const completeAddress = useServerFn(resolveIntakeAddress);
  const locateAddress = useServerFn(reverseIntakeAddress);

  const q = useQuery({
    queryKey: ["public-intake", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });

  /* The lookup carries the token the same way every other call on this page
     does — it is the only credential the person filling the form has. */
  const addressSearch = useCallback<AddressSearchFn>(
    (args) => lookupAddress({ data: { token, q: args.data.q, near: args.data.near } }),
    [lookupAddress, token],
  );
  const addressReverse = useCallback<AddressReverseFn>(
    (args) => locateAddress({ data: { token, lat: args.data.lat, lon: args.data.lon } }),
    [locateAddress, token],
  );
  const addressResolve = useCallback<AddressResolveFn>(
    (args) => completeAddress({ data: { token, placeId: args.data.placeId } }),
    [completeAddress, token],
  );

  const [fields, setFields] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [photos, setPhotos] = useState<IntakePhoto[]>([]);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const known = q.data?.known;
    if (!known) return;
    /* The form is the four fields the client kept. Loss type, dates, carrier
       and claim are no longer asked here — the office asks them on the call. */
    setFields({
      site_address: known.site_address ?? "",
      customer_name: known.customer_name ?? "",
      customer_phone: known.customer_phone ?? "",
      customer_email: known.customer_email ?? "",
    });
    setName(q.data?.recipientName ?? "");
    const pre: Record<string, Answer> = {};
    for (const question of q.data?.questions ?? []) {
      if (question.prefill) pre[question.id] = question.prefill;
    }
    setAnswers(pre);
  }, [q.data]);

  const send = useMutation({
    mutationFn: () =>
      submit({
        data: {
          token,
          /* On a standalone form the person filling it in IS the customer, so
             asking a second time for their name and email would be a third and
             fourth field between them and sending. */
          submittedByName: (q.data?.standalone ? fields["customer_name"] : name) || null,
          submittedByEmail: (q.data?.standalone ? fields["customer_email"] : email) || null,
          fields,
          answers,
          photos,
        },
      }),
    onSuccess: () => setDone(true),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not submit."),
  });

  /* Each photo goes straight to storage through a signed URL minted against
     the link, so the form never carries image bytes. A photo that fails is
     reported and skipped; the form can still be sent without it. */
  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    const room = INTAKE_PHOTO_MAX_COUNT - photos.length;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) toast.error(`Up to ${INTAKE_PHOTO_MAX_COUNT} photos can be attached.`);
    for (const file of list) {
      const mime = file.type || "image/jpeg";
      if (file.size > INTAKE_PHOTO_MAX_BYTES) {
        toast.error(`${file.name} is larger than 15 MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const target = await uploadUrl({
          data: { token, name: file.name, mime, size: file.size },
        });
        const { error } = await supabase.storage
          .from(INTAKE_PHOTO_BUCKET)
          .uploadToSignedUrl(target.path, target.token, file, { contentType: mime });
        if (error) throw new Error(error.message);
        setPhotos((p) => [...p, { path: target.path, name: file.name, mime, size: file.size }]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Could not upload ${file.name}.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  if (q.isLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Shell>
    );
  }

  /* A thrown query and a server-reported read failure are the same event to the
     person holding the phone, and neither may render as "this link is dead". */
  if (q.isError || !q.data || q.data.reason === "error") {
    return (
      <Shell>
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <TriangleAlert className="size-4 shrink-0 text-destructive" />
            This form could not be loaded
          </p>
          <p className="text-sm text-muted-foreground">
            Something went wrong at our end — your link is most likely fine. Please try again in a
            moment.
          </p>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  if (!q.data.ok) {
    const reason = q.data.reason;
    const message =
      reason === "submitted"
        ? "This form has already been submitted. Thank you — nothing further is needed."
        : reason === "expired"
          ? "This link has expired. Please contact the office for a new one."
          : reason === "revoked"
            ? "This link was withdrawn by the office."
            : "This link is not valid.";
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">{message}</p>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 className="size-8 text-emerald-700 dark:text-emerald-400" />
          <p className="text-base font-semibold">Thank you — your details were sent.</p>
          <p className="text-sm text-muted-foreground">
            Our team will review the information and follow up if anything else is needed.
          </p>
        </div>
      </Shell>
    );
  }

  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  /* The address box is the one field the office cannot work around, so it is
     the one worth resolving. Picking a suggestion stores Google's own
     formatted address plus the structured parts and the coordinates; typing
     over it throws all of that away, because a stale point under a hand-edited
     address would send a crew to the previous suggestion. */
  const typeAddress = (v: string) =>
    setFields((f) => ({ ...f, ...clearedIntakeGeoFields(), site_address: v }));
  const pickAddress = (s: AddressSuggestion) =>
    setFields((f) => ({
      ...f,
      site_address: s.label || s.address,
      site_locality: s.locality ?? "",
      site_region: s.region ?? "",
      site_postal_code: s.postal_code ?? "",
      site_county: s.county ?? "",
      site_lat: s.lat == null ? "" : String(s.lat),
      site_lon: s.lon == null ? "" : String(s.lon),
      site_place_id: s.id,
      /* Prefilled when Google named a subpremise, and CLEARED when it did not.
         A different building means the apartment number typed for the last one
         is wrong, and a wrong unit sends a crew to a stranger's door — the
         same reasoning as clearing the coordinates above. */
      site_unit: s.unit ?? "",
    }));
  const standalone = Boolean(q.data.standalone);
  /* A trade show link: headed by the show, and short — a name, a company and a
     way to reach them is all a booth conversation can honestly produce. */
  const booth = Boolean(q.data.booth);

  /* The four fields carry an asterisk and the button waits for them; photos
     and notes never block. A booth form keeps its own, shorter rule. */
  const hasReply =
    (fields["customer_phone"] ?? "").trim().length > 0 ||
    (fields["customer_email"] ?? "").trim().length > 0;
  const hasWho =
    (fields["customer_name"] ?? "").trim().length > 0 ||
    (fields["company"] ?? "").trim().length > 0;
  const missing = standalone && !booth ? standaloneFormProblem(fields) : null;
  const blocked = booth ? !hasWho || !hasReply : (standalone && missing !== null) || uploading > 0;

  return (
    <Shell
      entityName={booth ? (q.data.tradeshowName ?? q.data.entityName) : q.data.entityName}
      subtitle={
        booth
          ? [q.data.entityName, q.data.officeName].filter(Boolean).join(" · ") || undefined
          : standalone
            ? (q.data.officeName ?? undefined)
            : `Job ${q.data.jobNumber}${q.data.officeName ? ` · ${q.data.officeName}` : ""}`
      }
    >
      {q.data.note ? <p className="mb-3 rounded-md bg-muted p-3 text-sm">{q.data.note}</p> : null}
      <p className="mb-4 text-sm text-muted-foreground">
        {booth
          ? "Good to meet you. Leave your details and we will follow up after the show."
          : standalone
            ? "Tell us where the damage is and how to reach you. Photos and notes help but are optional — we will ask the rest when we call."
            : "We have filled in what we already have. Please correct anything that is wrong and add photos or notes if you have them."}
      </p>

      {booth ? (
        <BoothFields fields={fields} set={set} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Property address" required={standalone} className="sm:col-span-2">
            <AddressAutocomplete
              id="intake-site-address"
              label={null}
              value={fields["site_address"] ?? ""}
              onValueChange={typeAddress}
              onSelect={pickAddress}
              search={addressSearch}
              resolve={addressResolve}
              reverse={addressReverse}
            />
          </Field>
          {/*
           * Its own box, because the address lookup does not reliably resolve
           * one. Google returns a subpremise only when the customer picks a
           * suggestion that names the unit, and most do not — so the office
           * was receiving "12 Maple Ave" for a 40-unit building and phoning
           * back to ask which apartment. Typed here it arrives with the rest.
           */}
          <Field label="Apt / Unit / Suite" className="sm:col-span-2">
            <Input
              id="intake-site-unit"
              value={fields["site_unit"] ?? ""}
              onChange={(e) => set("site_unit", e.target.value)}
              placeholder="Apt 4B"
              autoComplete="address-line2"
            />
          </Field>
          <Field label={standalone ? "Your name" : "Insured name"} required={standalone}>
            <Input
              value={fields["customer_name"] ?? ""}
              onChange={(e) => set("customer_name", e.target.value)}
              autoComplete="name"
            />
          </Field>
          <Field label="Phone" required={standalone}>
            <Input
              type="tel"
              inputMode="tel"
              value={fields["customer_phone"] ?? ""}
              onChange={(e) => set("customer_phone", e.target.value)}
              autoComplete="tel"
            />
          </Field>
          <Field label="Email" required={standalone} className="sm:col-span-2">
            <Input
              type="email"
              inputMode="email"
              value={fields["customer_email"] ?? ""}
              onChange={(e) => set("customer_email", e.target.value)}
              autoComplete="email"
            />
          </Field>

          <Field
            label="Photos"
            help="Optional. A few pictures of the damage help us come prepared."
            className="sm:col-span-2"
          >
            {/* Two inputs, not one: `capture` forces the camera and hides the
                camera roll on phones, and most people already took their
                pictures before opening this form. */}
            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                void addPhotos(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addPhotos(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => cameraInput.current?.click()}
                disabled={uploading > 0 || photos.length >= INTAKE_PHOTO_MAX_COUNT}
              >
                <Camera className="mr-1.5 size-4" />
                Take photo
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
                disabled={uploading > 0 || photos.length >= INTAKE_PHOTO_MAX_COUNT}
              >
                <ImagePlus className="mr-1.5 size-4" />
                {uploading > 0 ? "Uploading…" : "Choose from camera roll"}
              </Button>
              {photos.map((p) => (
                <span
                  key={p.path}
                  className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs"
                >
                  <span className="truncate">{p.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${p.name}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setPhotos((list) => list.filter((x) => x.path !== p.path))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </Field>

          <Field
            label="Notes"
            help="Optional. Anything you want us to know."
            className="sm:col-span-2"
          >
            <Textarea
              rows={3}
              value={fields["notes"] ?? ""}
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>
      )}

      {(q.data.questions ?? []).length > 0 ? (
        <div className="mt-5 space-y-3 border-t pt-4">
          {(q.data.questions ?? []).map((question) => {
            const a = answers[question.id] ?? {};
            const update = (patch: Answer) =>
              setAnswers((prev) => ({
                ...prev,
                [question.id]: { ...prev[question.id], ...patch },
              }));
            return (
              <Field key={question.id} label={question.prompt} help={question.help_text}>
                {question.answer_type === "yes_no" ? (
                  <Select
                    value={a.bool == null ? "" : a.bool ? "yes" : "no"}
                    onValueChange={(v) => update({ bool: v === "yes" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="no">No</SelectItem>
                    </SelectContent>
                  </Select>
                ) : question.answer_type === "choice" ? (
                  <Select value={a.text ?? ""} onValueChange={(v) => update({ text: v })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {question.choices.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : question.answer_type === "date" ? (
                  <Input
                    type="date"
                    value={a.date ?? ""}
                    onChange={(e) => update({ date: e.target.value })}
                  />
                ) : question.answer_type === "long_text" ? (
                  <Textarea
                    rows={3}
                    value={a.text ?? ""}
                    onChange={(e) => update({ text: e.target.value })}
                  />
                ) : (
                  <Input value={a.text ?? ""} onChange={(e) => update({ text: e.target.value })} />
                )}
              </Field>
            );
          })}
        </div>
      ) : null}

      {standalone ? null : (
        <div className="mt-5 grid gap-3 border-t pt-4 sm:grid-cols-2">
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Your email">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
      )}

      {blocked ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {booth
            ? "Add your name or company, and a phone number or email, to send this."
            : uploading > 0
              ? "Waiting for your photos to finish uploading."
              : (missing ?? "Fill in the four required fields to send this.")}
        </p>
      ) : null}
      <Button
        className={booth ? "mt-2 h-12 w-full text-base" : "mt-2 w-full sm:w-auto"}
        onClick={() => send.mutate()}
        disabled={send.isPending || blocked}
      >
        {send.isPending ? "Sending…" : booth ? "Send" : "Submit details"}
      </Button>
    </Shell>
  );
}

/**
 * The booth form. Big inputs for a tablet on a table; the fields are the same
 * keys the inbox and the account already understand, plus `company` and
 * `notes`, which are what a conversation at a show is actually about.
 */
function BoothFields({
  fields,
  set,
}: {
  fields: Record<string, string>;
  set: (k: string, v: string) => void;
}) {
  const input = (k: string, type = "text", mode?: "tel" | "email") => (
    <Input
      className="h-12 text-base"
      type={type}
      inputMode={mode}
      autoComplete="off"
      value={fields[k] ?? ""}
      onChange={(e) => set(k, e.target.value)}
    />
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Your name">{input("customer_name")}</Field>
      <Field label="Company">{input("company")}</Field>
      <Field label="Phone" help="A phone number or an email address — either is enough.">
        {input("customer_phone", "tel", "tel")}
      </Field>
      <Field label="Email">{input("customer_email", "email", "email")}</Field>
      <Field label="What can we help with?" className="sm:col-span-2">
        <Textarea
          rows={3}
          className="text-base"
          value={fields["notes"] ?? ""}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>
    </div>
  );
}

function Field({
  label,
  help,
  required,
  className,
  children,
}: {
  label: string;
  help?: string | null;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="text-xs">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {help ? <p className="mb-1 text-[11px] text-muted-foreground">{help}</p> : null}
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Shell({
  children,
  subtitle,
  entityName,
}: {
  children: React.ReactNode;
  subtitle?: string;
  /** Legal entity for the job's billing office — never a hardcoded name. */
  entityName?: string | null;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Secure information request
          </div>
          {entityName ? <CardTitle className="text-lg">{entityName}</CardTitle> : null}
          {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
