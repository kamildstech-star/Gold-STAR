import * as React from "react";
import { cn } from "@/lib/utils";
import { HiddenSectionsBar } from "@/lib/hidden-sections";

/**
 * Empty state: one line of plain, left-aligned text with an inline action.
 * No centred icon, no encouraging copy.
 */
export function EmptyLine({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-3 py-2.5 text-[13px] text-muted-foreground", className)}>{children}</div>
  );
}

/** Inline text action used inside an empty line. */
export function InlineAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-primary underline-offset-2 hover:underline"
    >
      {children}
    </button>
  );
}

/** Page header: token-scaled title, description line, actions right. */
export function PageHeader({
  title,
  count,
  subtitle,
  children,
  className,
}: {
  title: string;
  count?: React.ReactNode;
  /** Quiet line under the title, Revive360 style. Falls back to `count`. */
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const sub = subtitle ?? count;
  return (
    <div
      className={cn(
        "sticky top-0 z-20 -mx-3 flex flex-wrap items-center justify-between gap-3 border-b bg-background px-3 py-3 md:-mx-4 md:px-4",
        className,
      )}
    >
      <div className="min-w-0">
        {/*
         * The title is the top rung of the scale (26px against 13px body),
         * read from the token so all 42 pages using PageHeader move together.
         * `subtitle` is the description line; actions stay right.
         */}
        <h1 className="display-heavy truncate text-[length:var(--text-page-title)] leading-tight">
          {title}
        </h1>
        {sub != null && (
          <p className="mt-0.5 truncate text-[length:var(--text-body)] text-muted-foreground">
            {sub}
          </p>
        )}
      </div>

      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}

      {/* Anything this person hid on this page, with a way to bring it back. */}
      <HiddenSectionsBar className="w-full" />
    </div>
  );
}

/**
 * Load failure. Deliberately distinct from EmptyLine: an error is not an
 * empty result, and must never be presented as one.
 */
export function LoadError({
  what,
  error,
  onRetry,
  className,
}: {
  what: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ((error as { message?: string } | null)?.message ?? "unknown error");
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-2 border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-[13px] text-foreground",
        className,
      )}
    >
      <span>
        Couldn't load {what} — {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** Non-blocking notice: part of the data is degraded but the page still works. */
export function WarningLine({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-l-2 border-warning bg-warning/10 px-3 py-1.5 text-[12px] text-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
