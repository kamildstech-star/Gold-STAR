import { cn } from "@/lib/utils";

/**
 * The company's initials on a navy tile — the one picture an account has.
 *
 * Drawn in the sidebar's navy and gold so it reads as Gold Star's mark for the
 * record in every palette; the sidebar tokens are the only pair the theme keeps
 * contrast-checked against each other in both modes.
 */
export function accountInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s&]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "&");
  if (words.length === 0) return "?";
  // One short word of capitals ("AJH", "CBRE") is already the monogram.
  if (words.length === 1 || /^[A-Z0-9]{2,4}$/.test(words[0])) {
    return /^[A-Z0-9]{2,4}$/.test(words[0]) ? words[0] : words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function AccountMonogram({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "font-display flex size-11 shrink-0 items-center justify-center rounded-xl bg-sidebar text-[16px] font-bold tracking-wide text-sidebar-accent-foreground",
        className,
      )}
    >
      {accountInitials(name)}
    </span>
  );
}
