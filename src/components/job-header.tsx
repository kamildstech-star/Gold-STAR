import { useState } from "react";
import { Copy, Check, MapPin, MoreHorizontal, ChevronDown, Pencil, User } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { JobFieldEditor, type JobRecordLike } from "@/components/job-inline-field";
import { JOB_FIELD_BY_KEY } from "@/lib/job-fields";
import { useJobFieldAccess } from "@/lib/job-field-access";
import { saveJobField } from "@/lib/job-update";
import { EXTERNAL_LINK_REL } from "@/lib/maps-links";
import { cn } from "@/lib/utils";

/** One thing you can do to the job from the header. */
export interface JobHeaderAction {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  /** Rendered as a link instead of a button — Directions opens a map. */
  href?: string;
  /** The one filled (brand) button; on a phone it stays out of the menu too. */
  primary?: boolean;
  /** Lives in the ⋯ menu on every screen size instead of the button row. */
  overflow?: boolean;
}

/**
 * The job shell. Above the tabs on every tab, because the address gets pasted
 * into maps, texts and adjuster emails all day and nobody should have to
 * navigate back to General to find it. Pinned from md up; on a phone it
 * scrolls away and only the tab strip stays (the job page owns that wrapper),
 * because 175px of pinned header was a third of a small phone on every tab.
 *
 * Three stacked rows rather than one wrapping line. On a phone the old single
 * row put the title, job number, address, five badges and five controls into
 * the same flex container, so the address — the one thing a PM standing in a
 * wet building actually needs — was whatever happened to be left after the
 * buttons took their space. Now the identity block owns the first row, the
 * actions collapse to one overflow button below `md`, and the badges get a
 * line of their own to wrap on.
 */
export function JobHeader({
  jobNumber,
  jobName,
  address,
  primaryContactName,
  primaryContactRole,
  customerName,
  siteLine,
  onEditAddress,
  onEditName,
  actions,
  badges,
  sticky,
}: {
  jobNumber: string;
  jobName: string;
  address: string;
  primaryContactName?: string | null;
  primaryContactRole?: string | null;
  /**
   * Whose job it is, in a small line under the address (David, 21 Oct) — the
   * job name is usually the address, so the header did not say.
   */
  customerName?: string | null;
  /** Facility · building · community, when any is set. */
  siteLine?: string | null;
  /** A pencil beside the address that opens the address correction. */
  onEditAddress?: () => void;
  /** Rename the job (26 Oct) — a pencil beside the title, like the address's. */
  onEditName?: () => void;
  /** Inline buttons on a desktop; one overflow menu on a phone. */
  actions?: JobHeaderAction[];
  /** Stage, job type, loss type, office — their own wrapping row. */
  badges?: React.ReactNode;
  /** When false, the caller owns the sticky wrapper (header + tab row together). */
  sticky?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const items = actions ?? [];
  // The primary action goes last, right beside the ⋯ — the eye ends on it.
  const inline = items
    .filter((a) => !a.overflow)
    .sort((a, b) => Number(!!a.primary) - Number(!!b.primary));
  /*
   * The ⋯ menu: the overflow actions everywhere, plus — below md only — the
   * inline ones a phone has no room for. The primary action is never in it;
   * it stays on screen at every width.
   */
  const menuItems = items.filter((a) => a.overflow || !a.primary);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Address copied");
    } catch {
      toast.error("Could not copy — select the address and copy manually.");
    }
  };

  /* The customer line under the address already names them; a contact chip
     for the same person said it twice. Shown only for someone else. */
  const same = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const showContact = !!primaryContactName && !same(primaryContactName, customerName);

  return (
    <div
      className={
        sticky === false
          ? "py-2"
          : "sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      }
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="display-heavy truncate text-[18px] leading-tight sm:text-[22px]">
              {jobName}
            </h1>
            {onEditName ? (
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 self-center"
                title="Rename the job"
                aria-label="Rename the job"
                onClick={onEditName}
                data-edit-job-name
              >
                <Pencil className="size-3.5" />
              </Button>
            ) : null}
            <span className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {jobNumber}
            </span>
          </div>

          <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
            <MapPin className="size-3.5 shrink-0" />
            {/* Never truncated away by a neighbour: the actions sit outside
                this block, so the address keeps the whole first column. */}
            <span className="truncate">{address}</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0"
              title="Copy address"
              aria-label="Copy site address"
              onClick={copyAddress}
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </Button>
            {onEditAddress ? (
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0"
                title="Correct the address"
                aria-label="Correct the site address"
                onClick={onEditAddress}
              >
                <Pencil className="size-3.5" />
              </Button>
            ) : null}
          </div>
          {customerName || siteLine ? (
            <div
              className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
              data-header-customer
            >
              <User className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {[customerName, siteLine].filter(Boolean).join(" · ")}
              </span>
            </div>
          ) : null}
        </div>

        {items.length > 0 && (
          <div className="flex shrink-0 items-center gap-2">
            {/* Inline from md up; on a phone only the primary action stays out. */}
            {inline.map((a) => (
              <HeaderActionButton
                key={a.key}
                action={a}
                className={a.primary ? undefined : "hidden md:inline-flex"}
              />
            ))}
            {menuItems.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-9 shrink-0"
                    aria-label="Job actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-52">
                  {menuItems.map((a) => (
                    <DropdownMenuItem
                      key={a.key}
                      asChild={!!a.href}
                      onSelect={a.href ? undefined : () => a.onSelect?.()}
                      className={inline.includes(a) ? "md:hidden" : undefined}
                    >
                      {a.href ? (
                        <a href={a.href} target="_blank" rel={EXTERNAL_LINK_REL}>
                          {a.icon}
                          {a.label}
                        </a>
                      ) : (
                        <>
                          {a.icon}
                          {a.label}
                        </>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>

      {(badges || showContact) && (
        /* One line that scrolls on a phone, wrapping only from md up. Each of
           these chips is a 44px tap target under the coarse-pointer rule, so a
           set that wraps costs a second 44px row — half again the height of the
           job's name and address put together. The bleed lets it scroll to the
           screen edge instead of stopping inside the header's padding — by the
           page's own gutter (px-2, sm:px-4), not past it, or the row is 8px
           wider than the phone on each side and the page scrolls sideways. */
        <div className="no-scrollbar mt-2.5 flex flex-wrap items-center gap-1.5 max-md:-mx-2 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-2 max-md:[&>*]:shrink-0 sm:max-md:-mx-4 sm:max-md:px-4">
          {badges}
          {showContact && (
            <span className="inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] font-medium text-foreground">
              <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">
                {primaryContactName}
                {primaryContactRole ? (
                  <span className="text-muted-foreground"> · {primaryContactRole}</span>
                ) : null}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** One header action as a button (or a link, for Directions). */
function HeaderActionButton({
  action: a,
  className,
}: {
  action: JobHeaderAction;
  className?: string;
}) {
  const variant = a.primary ? "cta" : "outline";
  const cls = `h-9 ${className ?? ""}`;
  return a.href ? (
    <Button size="sm" variant={variant} className={cls} asChild>
      <a href={a.href} target="_blank" rel={EXTERNAL_LINK_REL}>
        {a.icon}
        {a.label}
      </a>
    </Button>
  ) : (
    <Button
      size="sm"
      variant={variant}
      className={cls}
      onClick={a.onSelect}
      aria-label={a.primary ? a.label : undefined}
    >
      {a.icon}
      {/* A phone keeps the primary action but not its words: the job's name
          and address need that width more than the button does. */}
      <span className={a.primary ? "max-sm:sr-only" : undefined}>{a.label}</span>
    </Button>
  );
}

/* ------------------------------------------------------------- badge edit */

/**
 * A header badge you can change in place.
 *
 * The badges were the only summary of the job anyone reads, and every one of
 * them was read-only — correcting a loss type meant scrolling to a card or
 * opening the full edit form. Clicking one swaps it for the same picker the
 * inline fields use (`JobFieldEditor`), which resolves the managed option list,
 * the pipeline stages and the warn-before-save copy from one definition, so a
 * badge can never offer a different set of choices than the card below it.
 *
 * A viewer who cannot edit the field gets the badge exactly as before — no
 * cursor change, no chevron, no disabled control that reads as broken.
 */
export function JobBadgeField({
  job,
  fieldKey,
  label,
  onSaved,
  onCommit,
  options,
  pillClassName,
  pillStyle,
  children,
}: {
  job: JobRecordLike;
  fieldKey: string;
  /** Overrides the field definition's label in the confirm dialog and toast. */
  label?: string;
  onSaved?: () => void;
  /** Replaces the write. The stage badge routes through the equipment guard. */
  onCommit?: (value: unknown) => void | Promise<void>;
  /*
   * Explicit choices for a column with no entry in JOB_FIELDS — `loss_type_id`
   * and the office both store a row id, while the managed-option machinery
   * keys everything by option *key*, so the ids have to be supplied here.
   */
  options?: { value: string; label: string }[];
  /** The pill's colour as classes (a loss or job-type tone)… */
  pillClassName?: string;
  /** …or as an inline style (a stage's own hex). Neither: a plain white pill. */
  pillStyle?: React.CSSProperties;
  /** The value, as text — the pill itself is drawn here. */
  children: React.ReactNode;
}) {
  const def = JOB_FIELD_BY_KEY[fieldKey];
  const access = useJobFieldAccess();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<unknown>(undefined);

  if (!access.canSee(fieldKey)) return null;
  const title = label ?? def?.label ?? fieldKey;
  /*
   * 3 Nov: one pill per badge — its colour, a small label, the value, and a
   * chevron when it can be changed. The label goes on a phone, where the row
   * scrolls and every badge's width counts.
   */
  const pill = cn(
    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold whitespace-nowrap",
    pillClassName || (pillStyle ? undefined : "border-border bg-card text-foreground"),
  );
  const toned = !!(pillClassName || pillStyle);
  /*
   * The tone tints the pill and colours the dot; the words stay in the body
   * colour. Some tones (amber, slate) are too light to read as text on their
   * own 10% tint.
   */
  const body = (
    <>
      {toned ? <span className="size-2 shrink-0 rounded-full bg-current" aria-hidden /> : null}
      <span className="font-medium text-muted-foreground max-md:hidden">{title}</span>
      <span className="text-foreground">{children}</span>
    </>
  );
  if (!access.canEdit(fieldKey) || (!def && !options)) {
    return (
      <span className={pill} style={pillStyle}>
        {body}
      </span>
    );
  }

  const write = async (value: unknown) => {
    setEditing(false);
    setPending(undefined);
    if (onCommit) return void (await onCommit(value));
    const ok = await saveJobField(job.id, fieldKey, value, title);
    if (ok) onSaved?.();
  };

  const commit = async (value: unknown) => {
    if (value === job[fieldKey]) {
      setEditing(false);
      return;
    }
    // Same confirm the inline field shows — an office move or a status jump has
    // consequences whether it was started from a card or from a badge.
    if (def?.warn) {
      setPending(value);
      setEditing(false);
      return;
    }
    await write(value);
  };

  return (
    <>
      {editing ? (
        <div className="min-w-[10rem] max-w-[16rem]">
          {options ? (
            <Select
              defaultOpen
              value={(job[fieldKey] as string) ?? ""}
              onOpenChange={(o) => {
                if (!o) setEditing(false);
              }}
              onValueChange={(v) => void commit(v || null)}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder={title} />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <JobFieldEditor
              job={job}
              def={def!}
              autoOpen
              onCancel={() => setEditing(false)}
              onCommit={commit}
            />
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title={`Change ${title.toLowerCase()}`}
          aria-label={`Change ${title.toLowerCase()}`}
          /*
           * Shaped like a dropdown, not a tag: a pill with an edge and a
           * chevron, so it reads as something you can change.
           */
          style={pillStyle}
          className={cn(
            pill,
            "pr-2 transition-[filter,box-shadow] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {body}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      )}

      <AlertDialog
        open={pending !== undefined}
        onOpenChange={(o) => {
          if (!o) setPending(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change {title.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>{def?.warn}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPending(undefined)}>Keep as is</AlertDialogCancel>
            <AlertDialogAction onClick={() => void write(pending)}>Change anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
