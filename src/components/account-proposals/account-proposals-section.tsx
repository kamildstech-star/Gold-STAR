import { Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSignature, Plus } from "lucide-react";

import { LazyAccountProposalDialog } from "@/components/account-proposals/lazy-proposal-dialog";
import { useWritesDisabled } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TONE,
  formatMoney,
  listAccountProposals,
  type AccountProposal,
} from "@/lib/account-proposals";
import { cn } from "@/lib/utils";

/** The date a proposal's status is about: when it was signed, declined, sent or written. */
function statusDate(p: AccountProposal): string {
  const at = p.signed_at ?? p.declined_at ?? p.expired_at ?? p.sent_at ?? p.created_at;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Proposals on an account — the list, and "Create proposal".
 *
 * Mark: "Is there a way to make something in the pipeline a proposal?" The
 * pipeline card opens the same dialog; this is where the proposals then live,
 * under the account's Documents on both record layouts. A proposal sent for
 * signature also files its document in the Documents panel beside it, so the
 * signed copy is where every other signed copy is.
 */
export function AccountProposalsSection({
  accountId,
  accountName,
  className,
  onChanged,
}: {
  accountId: string;
  accountName: string;
  className?: string;
  /** Called after any change, so the record can refresh its stage rail. */
  onChanged?: () => void;
}) {
  const writes = useWritesDisabled();
  const [dialog, setDialog] = useState<{ id: string | null } | null>(null);

  const q = useQuery({
    queryKey: ["account-proposals", accountId],
    queryFn: () => listAccountProposals(accountId),
  });
  const rows = q.data?.rows ?? [];
  const unavailable = q.data?.available === false;

  return (
    <section
      aria-label="Proposals"
      data-testid="account-proposals"
      className={cn("rounded-xl border bg-card px-4 py-3", className)}
    >
      <header className="flex items-center gap-2">
        <FileSignature className="size-4 shrink-0 text-primary" />
        <h2 className="text-[13px] font-semibold text-foreground">Proposals</h2>
        {!q.isLoading && !unavailable && (
          <span className="text-[12px] tabular-nums text-muted-foreground">· {rows.length}</span>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8"
          disabled={writes.disabled || unavailable}
          title={writes.disabled ? (writes.reason ?? undefined) : undefined}
          onClick={() => setDialog({ id: null })}
        >
          <Plus className="mr-1 size-3.5" />
          Create proposal
        </Button>
      </header>

      <div className="mt-2">
        {q.isLoading ? (
          <p className="py-1.5 text-[12.5px] text-muted-foreground">Loading…</p>
        ) : q.isError ? (
          <div className="flex items-center justify-between gap-2 py-1.5 text-[12.5px]">
            <span className="text-destructive">Proposals could not be loaded.</span>
            <Button size="sm" variant="outline" className="h-8" onClick={() => void q.refetch()}>
              Retry
            </Button>
          </div>
        ) : unavailable ? (
          <p className="py-1.5 text-[12.5px] text-muted-foreground">
            Proposals need a database update before they can be used.
          </p>
        ) : rows.length === 0 ? (
          <p className="py-1.5 text-[12.5px] text-muted-foreground">
            No proposals yet. Create one to price the work and send it for signature.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex min-h-10 w-full items-center gap-2 py-1.5 text-left"
                  onClick={() => setDialog({ id: p.id })}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-tight hover:underline">
                      {p.title}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {formatMoney(p.total)} · {statusDate(p)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold",
                      PROPOSAL_STATUS_TONE[p.status],
                    )}
                  >
                    {PROPOSAL_STATUS_LABEL[p.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialog && (
        <Suspense fallback={null}>
          <LazyAccountProposalDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            accountId={accountId}
            accountName={accountName}
            proposalId={dialog.id}
            onChanged={onChanged}
          />
        </Suspense>
      )}
    </section>
  );
}
