/** Polaris mark — a gold guiding star, used in place of a robot icon. */
export function PolarisMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
      // A host can recolour the star by setting --polaris-mark (the prospect
      // record's Polaris panel draws it in the AI tone); otherwise brand gold.
      style={{ color: "var(--polaris-mark, var(--brand-gold))" }}
    >
      <path
        d="M12 1.5c.35 4.6 2.4 7.5 6.9 8.3l3.6.7-3.6.7c-4.5.8-6.55 3.7-6.9 8.3-.35-4.6-2.4-7.5-6.9-8.3L1.5 10.5l3.6-.7C9.6 9 11.65 6.1 12 1.5Z"
        fill="currentColor"
      />
      <circle cx="19.5" cy="4.5" r="1.1" fill="currentColor" opacity=".65" />
      <circle cx="4.8" cy="17.6" r=".8" fill="currentColor" opacity=".5" />
    </svg>
  );
}
