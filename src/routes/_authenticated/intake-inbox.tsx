import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Check, ChevronDown, Copy, Inbox, Link2, MapPin, Tent, X } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { CarrierConfirm } from "@/components/carrier-confirm";
import { JobSearchField, type PickedJob } from "@/components/job-search-field";
import { useJobCreatableLocations, useWritableLocations } from "@/components/location-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyIntakeLinkButton } from "@/components/intake-link-menu";
import { EmptyLine, LoadError, PageHeader, WarningLine } from "@/components/ui-density";
import { toastDbError } from "@/lib/db-errors";
import { intakeGeoPoint, isIntakeGeoField } from "@/lib/intake-form";
import { MapsLink } from "@/components/maps-link";
import {
  INTAKE_FIELD_LABEL,
  attachIntakeToJob,
  createStandaloneIntakeLink,
  dismissIntake,
  listUnassignedIntakes,
  setIntakeOffice,
  type IntakeInboxRow,
} from "@/lib/intake-inbox";
import {
  saveIntakeGeneralSettings,
  useIntakeGeneralSettings,
  useInvalidateIntakeGeneralSettings,
} from "@/lib/intake-general-settings";
import { intakePhotoUrls } from "@/lib/intake-photos.functions";
import { officeBadgeTail, officeSwitchChoices } from "@/lib/intake-office-switch";
import { useIntakeQuestions } from "@/lib/intake-questions";
import { isPrivileged } from "@/lib/roles";
import { useLossTypes } from "@/lib/loss-categories";
import type { CarrierAccount } from "@/lib/carrier-match";
import { signedUrlStaleMs } from "@/lib/signed-url";

export const Route = createFileRoute("/_authenticated/intake-inbox")({
  head: () => ({
    meta: [
      { title: "Intake forms — Gold Star Recovery Hub" },
      {
        name: "description",
        content:
          "Intake forms completed by people who are not a job yet. Attach each one to an existing job or create a new job from it.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: IntakeInboxPage,
});

export const INTAKE_INBOX_QUERY_KEY = ["intake-inbox"] as const;

/**
 * The triage queue for completed intake forms.
 *
 * Every row here is a person who filled the form in without being in the CRM.
 * Two decisions are possible and both are made by a human: this is the job we
 * already have, or this is a new one.
 */
function IntakeInboxPage() {
  const app = useAppContext();
  const canCreateJobs = useJobCreatableLocations().length > 0;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const questions = useIntakeQuestions({ includeInactive: true });
  const lossTypes = useLossTypes();

  const list = useQuery({
    queryKey: INTAKE_INBOX_QUERY_KEY,
    queryFn: listUnassignedIntakes,
  });

  const [attaching, setAttaching] = useState<IntakeInboxRow | null>(null);
  const [minting, setMinting] = useState(false);

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissIntake(id, app.userId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: INTAKE_INBOX_QUERY_KEY }),
    onError: (e) => toastDbError(e, { action: "Dismissing intake form" }),
  });

  const rows = list.data?.rows ?? [];

  return (
    // `page-shell` is the standard gutter every other page carries. Without it
    // this one's title sat flush against the sidebar with no left margin, which
    // is what QA caught on 2026-09-16.
    <div className="page-shell space-y-3">
      <PageHeader
        title="Intake forms"
        subtitle="Completed forms waiting to become a job"
        count={rows.length ? `${rows.length} waiting` : undefined}
      >
        {/* The standing link is the front door; a one-off link for a named
            recipient or a single office is still here for whatever needs one. */}
        <CopyIntakeLinkButton />
        <Button size="sm" variant="outline" onClick={() => setMinting(true)}>
          <Link2 className="mr-1.5 size-4" /> One-time link
        </Button>
      </PageHeader>

      {/* A failed read is never an empty inbox — that is a lead disappearing. */}
      {list.isError ? (
        <LoadError
          what="completed intake forms"
          error={list.error}
          onRetry={() => void list.refetch()}
        />
      ) : null}

      {list.data && !list.data.migrated ? (
        <WarningLine>
          Standalone intake links are not live yet — the database is still missing the migration
          that lets an intake form exist without a job. Forms sent from a job still work, and this
          list stays empty until it is applied.
        </WarningLine>
      ) : null}

      {list.isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : !list.isError && rows.length === 0 ? (
        <EmptyLine>
          Nothing waiting. Completed forms from people who are not a job yet land here.
        </EmptyLine>
      ) : null}

      {rows.map((row) => {
        const label = (key: string) => INTAKE_FIELD_LABEL[key] ?? key;
        const value = (key: string, raw: string | null) =>
          key === "loss_type_id" ? lossTypes.label(raw) : (raw ?? "");
        /* The parts Google filled in are machine data, not a line a dispatcher
           reads — they show as one map link below instead of seven rows. */
        const filled = Object.entries(row.fields ?? {}).filter(
          ([k, v]) => (v ?? "").trim() && !isIntakeGeoField(k),
        );
        const point = intakeGeoPoint(row.fields);
        const answered = Object.entries(row.answers ?? {})
          .map(([questionId, a]) => {
            const question = (questions.data ?? []).find((x) => x.id === questionId);
            const text =
              a.bool != null ? (a.bool ? "Yes" : "No") : ((a.date || a.text) ?? "").trim();
            return { prompt: question?.prompt ?? "Question", text };
          })
          .filter((a) => a.text);

        return (
          <Card key={row.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <Inbox className="size-4 text-primary" />
                {row.fields["site_address"]?.trim() ||
                  (row.request?.tradeshow_id
                    ? row.fields["company"]?.trim() ||
                      row.fields["customer_name"]?.trim() ||
                      "Booth form"
                    : "No address given")}
                {row.request?.tradeshow_id ? (
                  <Link
                    to="/tradeshows/$id"
                    params={{ id: row.request.tradeshow_id }}
                    className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/20"
                    title="Open the show this came from"
                  >
                    <Tent className="size-3" /> Trade show
                  </Link>
                ) : null}
                {row.request?.label ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {row.request.label}
                  </Badge>
                ) : null}
                <OfficeBadge row={row} />
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                From {row.submitted_by_name || row.submitted_by_email || "an unnamed sender"} ·{" "}
                {new Date(row.created_at).toLocaleString("en-US")}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="grid gap-1 sm:grid-cols-2">
                {filled.map(([key, raw]) => (
                  <li key={key} className="text-xs">
                    <span className="text-muted-foreground">{label(key)}: </span>
                    <span className="font-medium">{value(key, raw)}</span>
                  </li>
                ))}
                {answered.map((a) => (
                  <li key={a.prompt} className="text-xs">
                    <span className="text-muted-foreground">{a.prompt}: </span>
                    <span className="font-medium">{a.text}</span>
                  </li>
                ))}
              </ul>

              {point ? (
                <MapsLink
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  query={point}
                  title="This address was picked from Google, not typed"
                >
                  <MapPin className="size-3" /> Confirmed address — open in Maps
                </MapsLink>
              ) : null}

              {row.photos.length > 0 ? (
                <IntakePhotoStrip submissionId={row.id} count={row.photos.length} />
              ) : null}

              <div className="flex flex-wrap gap-2">
                {/* 13 Nov: only for a role that may create jobs; hidden otherwise. */}
                {canCreateJobs && (
                  <Button
                    size="sm"
                    onClick={() =>
                      navigate({
                        to: "/jobs/new",
                        search: { fromIntake: row.id } as never,
                      })
                    }
                    disabled={app.writesDisabled}
                  >
                    Create new job
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAttaching(row)}
                  disabled={app.writesDisabled}
                >
                  Attach to existing job
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dismiss.mutate(row.id)}
                  disabled={app.writesDisabled || dismiss.isPending}
                >
                  <X className="mr-1 size-3.5" /> Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <AttachDialog
        submission={attaching}
        onClose={() => setAttaching(null)}
        onDone={() => {
          setAttaching(null);
          void qc.invalidateQueries({ queryKey: INTAKE_INBOX_QUERY_KEY });
        }}
      />
      <MintLinkDialog
        open={minting}
        available={list.data?.migrated !== false}
        onClose={() => setMinting(false)}
      />
    </div>
  );
}

/**
 * The photos a customer attached. Signed URLs come from the server after RLS
 * has let this user read the submission, and last ten minutes.
 */
function IntakePhotoStrip({ submissionId, count }: { submissionId: string; count: number }) {
  const load = useServerFn(intakePhotoUrls);
  const q = useQuery({
    queryKey: ["intake-photos", submissionId],
    queryFn: () => load({ data: { submissionId } }),
    staleTime: signedUrlStaleMs(),
  });
  if (q.isError) {
    return (
      <p className="text-xs text-destructive">
        {count} photo{count === 1 ? "" : "s"} attached, but they could not be loaded.
      </p>
    );
  }
  const photos = q.data ?? [];
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {count} photo{count === 1 ? "" : "s"} from the customer
      </p>
      <div className="flex flex-wrap gap-2">
        {photos.map((p) =>
          p.url ? (
            <a
              key={p.path}
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="block size-20 overflow-hidden rounded-md border bg-muted"
              title={p.name}
            >
              <img src={p.url} alt={p.name} className="size-full object-cover" loading="lazy" />
            </a>
          ) : (
            <span
              key={p.path}
              className="grid size-20 place-items-center rounded-md border bg-muted text-[10px] text-muted-foreground"
            >
              {p.name}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Which office this lead belongs to, and why: a rule on the Territory page
 * ("from state rule (PA)"), the map ("from address (nearest)"), or a person
 * ("set by Dana"). A lead from a general link with no match is said so
 * plainly — it is visible to privileged staff only until someone routes it.
 *
 * Mark: "give a way to switch the office quickly if they don't like the
 * match". The badge IS the switch: tap it, tap the office, done — saved at
 * once, no dialog. It is offered only to someone who manages the form's
 * current office, and lists only offices they manage (see
 * intake-office-switch.ts); everyone else sees the plain badge.
 */
function OfficeBadge({ row }: { row: IntakeInboxRow }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const officeId = row.location_id ?? row.request?.location_id ?? null;
  const office = officeId ? app.allLocations.find((l) => l.id === officeId) : undefined;
  const { canSwitch, choices } = officeSwitchChoices(app, app.visibleLocations, officeId);

  const move = useMutation({
    mutationFn: (locationId: string) =>
      setIntakeOffice({ submissionId: row.id, locationId, userId: app.userId }),
    onSuccess: (_, locationId) => {
      const to = app.allLocations.find((l) => l.id === locationId);
      toast.success(to ? `Moved to ${to.code} · ${to.name}` : "Office changed");
      void qc.invalidateQueries({ queryKey: INTAKE_INBOX_QUERY_KEY });
    },
    onError: (e) => toastDbError(e, { action: "Changing the intake form's office" }),
  });

  const why = officeBadgeTail(row, app.userId);
  const label = officeId
    ? `${office ? `${office.code} · ${office.name}` : "Office"}${why ? ` · ${why}` : ""}`
    : "No office matched — general link";
  const tone = officeId ? "text-[10px]" : "text-[10px] text-warning";

  if (!canSwitch || app.writesDisabled) {
    return (
      <Badge variant="outline" className={tone}>
        {label}
      </Badge>
    );
  }
  return (
    <DropdownMenu>
      {/* The badge is small; the button around it is a full 44px touch
          target on a phone, where most of this triage happens. */}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex min-h-11 items-center rounded-full md:min-h-0"
          disabled={move.isPending}
          aria-label="Change this form's office"
          title="Change office"
        >
          <Badge variant="outline" className={`${tone} cursor-pointer gap-1 hover:bg-muted`}>
            {label}
            <ChevronDown className="size-3" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs">Send to office</DropdownMenuLabel>
        {choices.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => move.mutate(o.id)}>
            {o.code} · {o.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AttachDialog({
  submission,
  onClose,
  onDone,
}: {
  submission: IntakeInboxRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const app = useAppContext();
  const [job, setJob] = useState<PickedJob | null>(null);
  const [carrier, setCarrier] = useState<CarrierAccount | null>(null);

  const attach = useMutation({
    mutationFn: async () => {
      if (!submission || !job) return;
      await attachIntakeToJob({
        submission,
        jobId: job.id,
        userId: app.userId,
        carrierAccountId: carrier?.id ?? null,
      });
    },
    onSuccess: () => {
      toast.success("Attached to the job");
      setJob(null);
      setCarrier(null);
      onDone();
    },
    onError: (e) => toastDbError(e, { action: "Attaching intake form to job" }),
  });

  return (
    <Dialog open={Boolean(submission)} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach to an existing job</DialogTitle>
        </DialogHeader>
        <JobSearchField value={job} onChange={setJob} label="Job" />
        {/* The customer may have named a carrier nobody has entered yet. That
            decision is made here, before anything is written. */}
        <CarrierConfirm
          name={submission?.fields["insurance_carrier"]}
          value={carrier}
          onChange={setCarrier}
        />
        <p className="text-xs text-muted-foreground">
          Blank fields on the job are filled from this form and unanswered questions are answered.
          Anything that disagrees with what the office already recorded is left for the job's own
          review card, so nothing typed by staff is overwritten.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => attach.mutate()}
            disabled={!job || attach.isPending || app.writesDisabled}
          >
            <Check className="mr-1.5 size-4" />
            {attach.isPending ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Sentinel for the office select — a general link has no office. */
const GENERAL_LINK = "__general__";

function MintLinkDialog({
  open,
  available,
  onClose,
}: {
  open: boolean;
  /** False until the standalone migration lands — minting would fail. */
  available: boolean;
  onClose: () => void;
}) {
  const app = useAppContext();
  const locations = useWritableLocations();
  const [locationId, setLocationId] = useState("");
  /* David: a user with one office never selects an office. When the only
     choice is their own office, it is already chosen. */
  const onlyOffice =
    !isPrivileged(app.roles) && locations.length === 1 ? (locations[0]?.id ?? "") : "";
  const chosenLocationId = locationId || onlyOffice;
  const [label, setLabel] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [url, setUrl] = useState("");

  /* The general link has no office and is multi-use, which the request RLS
     reserves for privileged users — so only they are offered it. */
  const canMintGeneral = isPrivileged(app.roles);
  const general = locationId === GENERAL_LINK;
  const { settings: generalSettings } = useIntakeGeneralSettings();
  const invalidateGeneral = useInvalidateIntakeGeneralSettings();
  const saveFallback = useMutation({
    mutationFn: (fallback: string) =>
      saveIntakeGeneralSettings({ fallback_location_id: fallback || null }, app.userId),
    onSuccess: () => {
      invalidateGeneral();
      toast.success("Default office saved");
    },
    onError: (e) => toastDbError(e, { action: "Saving the default office" }),
  });

  const mint = useMutation({
    mutationFn: () =>
      createStandaloneIntakeLink({
        locationId: general ? null : chosenLocationId,
        label,
        recipientName,
        recipientEmail,
        userId: app.userId,
      }),
    onSuccess: (created) => setUrl(created),
    onError: (e) => toastDbError(e, { action: "Creating intake link" }),
  });

  const close = () => {
    setUrl("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New intake link</DialogTitle>
        </DialogHeader>

        {!available ? (
          <WarningLine>
            This cannot be created yet — the migration that lets an intake request exist without a
            job has not been applied to the database.
          </WarningLine>
        ) : url ? (
          <div className="space-y-2">
            <p className="text-sm">
              {general
                ? "Put this link behind a button on the website. It can be used any number of times and does not expire; each form sent through it goes to the closest office to the property."
                : "Send this link to the customer. It expires on its own."}
            </p>
            <div className="flex gap-2">
              <Input readOnly value={url} />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(url);
                  toast.success("Link copied");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Office</Label>
              <Select value={chosenLocationId} onValueChange={setLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an office" />
                </SelectTrigger>
                <SelectContent>
                  {canMintGeneral ? (
                    <SelectItem value={GENERAL_LINK}>
                      General — any office, routed by the address
                    </SelectItem>
                  ) : null}
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {general ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Default office when the address matches nothing</Label>
                <Select
                  value={generalSettings.fallback_location_id ?? ""}
                  onValueChange={(v) => saveFallback.mutate(v)}
                  disabled={saveFallback.isPending}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose the default office" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Each submission goes to the office a state or ZIP rule on Settings › Territory
                  names, otherwise the closest office in the property's state. This default takes
                  anything that cannot be placed. This is a company-wide setting.
                </p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label className="text-xs">Label (optional)</Label>
              <Input
                placeholder="e.g. Website form, storm door-knock"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Recipient name (optional)</Label>
                <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Recipient email (optional)</Label>
                <Input value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {url ? "Done" : "Cancel"}
          </Button>
          {available && !url ? (
            <Button
              onClick={() => mint.mutate()}
              disabled={!chosenLocationId || mint.isPending || app.writesDisabled}
            >
              {mint.isPending ? "Creating…" : "Create link"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
