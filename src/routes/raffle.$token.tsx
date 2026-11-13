import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { CheckCircle2, Ticket, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { enterPublicRaffle, loadPublicRaffle } from "@/lib/raffle-public.functions";
import {
  DEFAULT_RAFFLE_TERMS,
  RAFFLE_INDUSTRIES,
  RAFFLE_MARKETING_TERMS,
  splitFullName,
  type RaffleEntryInput,
  type RaffleEntryResult,
} from "@/lib/raffles";

export const Route = createFileRoute("/raffle/$token")({
  head: () => ({
    meta: [
      { title: "Enter the prize draw — Gold Star Restoration" },
      {
        name: "description",
        content: "Enter the Gold Star Restoration trade show prize draw.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PublicRafflePage,
});

type FormState = {
  full_name: string;
  phone: string;
  email: string;
  company: string;
  industry: string;
  consent_terms: boolean;
};

const EMPTY: FormState = {
  full_name: "",
  phone: "",
  email: "",
  company: "",
  industry: "",
  consent_terms: false,
};

const REFUSED: Record<Exclude<RaffleEntryResult, { ok: true }>["reason"], string> = {
  duplicate: "This email is already entered — good luck! Each person can enter once.",
  closed: "Entries for this draw have just closed.",
  full: "Sorry — this draw has reached its maximum number of entries.",
  invalid: "Please fill in the required fields and agree to the terms and conditions.",
  not_found: "This draw is no longer available.",
  error: "Something went wrong at our end. Please try again in a moment.",
};

/** "OJBA" + 2026-11-18 → "OJBA 2026"; a name that already has its year keeps it. */
function showLabel(name: string, startsOn: string | null): string {
  const year = startsOn?.slice(0, 4);
  return year && !name.includes(year) ? `${name} ${year}` : name;
}

/* The booth form, 11 Nov redesign: brand and show on top, the offer in big
   type, then Full Name, Phone, Email, Company, Industry and one "I agree"
   box. The rules fold open under it and include the marketing permission,
   so agreeing records marketing consent too. */
const FIELD = "h-12 rounded-full px-5 text-base";

function PublicRafflePage() {
  const { token } = Route.useParams();
  const load = useServerFn(loadPublicRaffle);
  const enter = useServerFn(enterPublicRaffle);
  const q = useQuery({
    queryKey: ["public-raffle", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });

  const [form, setForm] = React.useState<FormState>(EMPTY);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [entered, setEntered] = React.useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const send = useMutation({
    mutationFn: () => {
      const entry: RaffleEntryInput = {
        ...splitFullName(form.full_name),
        email: form.email.trim(),
        phone: form.phone.trim(),
        company: form.company.trim(),
        job_title: "",
        industry: form.industry,
        consent_terms: form.consent_terms,
        consent_marketing: form.consent_terms,
      };
      return enter({ data: { token, entry } });
    },
    onSuccess: (r) => {
      if (r.ok) {
        setEntered(splitFullName(form.full_name).first_name);
        setProblem(null);
      } else {
        setProblem(REFUSED[r.reason]);
      }
    },
    onError: () => setProblem(REFUSED.error),
  });

  if (q.isLoading) {
    return (
      <Shell>
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      </Shell>
    );
  }
  const r = q.data;
  if (q.isError || !r || (!r.ok && r.reason === "error")) {
    return (
      <Shell>
        <div className="space-y-3 py-6 text-center">
          <p className="flex items-center justify-center gap-2 text-sm font-medium">
            <TriangleAlert className="size-4 text-destructive" /> This page could not be loaded
          </p>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }
  if (!r.ok) {
    return (
      <Shell>
        <p className="py-10 text-center text-sm text-muted-foreground">
          This prize draw is not available.
        </p>
      </Shell>
    );
  }

  const closes = r.closes_at
    ? new Date(r.closes_at).toLocaleString(DATE_LOCALE, {
        ...US_DATE,
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  const missing =
    !form.full_name.trim() ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim()) ||
    (r.ask_phone && r.require_phone && !form.phone.trim()) ||
    !form.industry ||
    !form.consent_terms;

  return (
    <Shell>
      <div className="space-y-2 text-center">
        <p className="text-[13px] font-medium uppercase tracking-wider text-muted-foreground">
          Gold Star Restoration | {showLabel(r.show_name, r.show_starts_on)}
        </p>
        <h1 className="text-3xl font-extrabold leading-tight">{r.title}</h1>
        {r.headline && (
          <p className="text-2xl font-bold leading-snug text-foreground">{r.headline}</p>
        )}
        <p className="text-base text-muted-foreground">Enter in seconds for your chance to win.</p>
        {r.description && (
          <p className="whitespace-pre-line pt-1 text-sm text-muted-foreground">{r.description}</p>
        )}
      </div>

      <div className="mt-6 border-t pt-6">
        {entered ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center" role="status">
            <CheckCircle2 className="size-10 text-success" />
            <p className="text-lg font-bold">You&apos;re in the draw, {entered}!</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Winners are drawn at random after entries close and contacted by email or phone. Good
              luck!
            </p>
          </div>
        ) : !r.open ? (
          <div className="py-4 text-center">
            <p className="font-semibold">{r.full ? "This draw is full" : "Entries are closed"}</p>
            <p className="text-sm text-muted-foreground">
              Thank you for your interest. Winners are being contacted directly.
            </p>
          </div>
        ) : (
          <form
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (missing) {
                setProblem(REFUSED.invalid);
                return;
              }
              send.mutate();
            }}
          >
            <Field id="full_name" label="Full Name" required>
              <Input
                id="full_name"
                autoComplete="name"
                placeholder="Your full name"
                className={FIELD}
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
                maxLength={160}
              />
            </Field>
            {r.ask_phone && (
              <Field id="phone" label="Phone Number" required={r.require_phone}>
                <Input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="Your phone number"
                  className={FIELD}
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  maxLength={40}
                />
              </Field>
            )}
            <Field id="email" label="Email Address" required>
              <Input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@company.com"
                className={FIELD}
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                maxLength={254}
              />
            </Field>
            {r.ask_company && (
              <Field id="company" label="Company Name">
                <Input
                  id="company"
                  autoComplete="organization"
                  placeholder="Your company"
                  className={FIELD}
                  value={form.company}
                  onChange={(e) => set("company", e.target.value)}
                  maxLength={160}
                />
              </Field>
            )}
            <Field id="industry" label="Industry" required>
              <Select value={form.industry} onValueChange={(v) => set("industry", v)}>
                <SelectTrigger id="industry" className={FIELD}>
                  <SelectValue placeholder="Select your industry" />
                </SelectTrigger>
                <SelectContent className="max-h-[60vh]">
                  {RAFFLE_INDUSTRIES.map((i) => (
                    <SelectItem key={i} value={i} className="py-2.5">
                      {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-3 text-base">
                <Checkbox
                  className="size-6 rounded-full"
                  checked={form.consent_terms}
                  onCheckedChange={(v) => set("consent_terms", v === true)}
                />
                <span>
                  I agree to the terms and conditions. <span className="text-destructive">*</span>
                </span>
              </label>
              <details className="rounded-2xl border px-4 py-2.5 text-[13px] text-muted-foreground">
                <summary className="cursor-pointer font-medium text-foreground">
                  Terms and conditions
                </summary>
                <div className="mt-2 space-y-2 whitespace-pre-line">
                  <p>{r.terms || DEFAULT_RAFFLE_TERMS}</p>
                  <p>{RAFFLE_MARKETING_TERMS}</p>
                </div>
              </details>
            </div>

            {problem && (
              <p className="rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {problem}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              className="h-14 w-full rounded-full text-lg font-bold"
              disabled={send.isPending}
            >
              <Ticket className="mr-2 size-5" />
              {send.isPending ? "Entering…" : "Enter the Draw"}
            </Button>
            {closes && (
              <p className="text-center text-[12px] text-muted-foreground">
                Entries close {closes}
              </p>
            )}
          </form>
        )}
      </div>
    </Shell>
  );
}

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[15px] font-medium">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-lg">
        <div className="mb-4 flex justify-center">
          <img src="/gold-star-logo.png" alt="Gold Star Restoration" className="h-12 w-auto" />
        </div>
        <div className="rounded-2xl border bg-card p-5 shadow-sm sm:p-7">{children}</div>
        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Your details are used for this draw and for Gold Star Restoration updates, as set out in
          the terms. Unsubscribe any time.
        </p>
      </div>
    </main>
  );
}
