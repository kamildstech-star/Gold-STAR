import { Lock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { PAGE_SOURCE_LABEL, type PageAccessSource } from "@/lib/page-access";

/**
 * One line of the Access screen: what it is, whether it is on, and — the part
 * the old matrix never showed — where the answer came from.
 *
 * A tick with no visible reason is a support ticket, so the source is always
 * rendered, never inferred from a checkbox's colour.
 *
 * Nearly every line is a switch: Mark asked for a screen with no locks on it, so
 * a line whose consequences need saying says them in `note`, and a line whose
 * consequences need confirming is confirmed by the panel before it saves.
 *
 * `locked` is the single exception, and it is what makes the rest safe to
 * unlock: the break-glass role is drawn with a padlock and no control at all,
 * because a switch that silently does nothing is worse than no switch. The
 * reason travels with it, as `note`, so the padlock never has to be guessed at.
 */
export function AccessRow({
  label,
  detail,
  note,
  allowed,
  source,
  disabled,
  locked,
  onToggle,
  trailing,
}: {
  label: string;
  detail?: string;
  note?: string;
  allowed: boolean;
  source: PageAccessSource;
  disabled?: boolean;
  /** Read-only for a structural reason. Renders a padlock instead of a control. */
  locked?: boolean;
  onToggle?: (next: boolean) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium">{label}</span>
          {detail ? (
            <span className="font-mono text-[11px] text-muted-foreground">{detail}</span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <SourceBadge allowed={allowed} source={source} />
          {note ? <span className="text-[11px] text-muted-foreground">{note}</span> : null}
        </div>
      </div>
      {locked ? (
        <span
          className="mt-0.5 flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground"
          title={note}
        >
          <Lock className="size-3.5" aria-hidden />
          <span>Locked</span>
          <span className="sr-only">
            {label}: allowed, and cannot be changed. {note}
          </span>
        </span>
      ) : null}
      {locked ? null : trailing}
      {!locked && onToggle ? (
        <Switch
          className="mt-0.5"
          checked={allowed}
          disabled={disabled}
          aria-label={`${label}: ${allowed ? "allowed" : "not allowed"}`}
          onCheckedChange={onToggle}
        />
      ) : null}
    </div>
  );
}

export function SourceBadge({ allowed, source }: { allowed: boolean; source: PageAccessSource }) {
  const tone = allowed
    ? source === "granted"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : source === "fallback"
        ? "border-border bg-muted text-muted-foreground"
        : "border-primary/30 bg-primary/10 text-primary"
    : source === "revoked"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : "border-border bg-muted text-muted-foreground";

  return (
    <Badge variant="outline" className={cn("h-5 px-1.5 text-[10px] font-medium", tone)}>
      {PAGE_SOURCE_LABEL[source]}
    </Badge>
  );
}
