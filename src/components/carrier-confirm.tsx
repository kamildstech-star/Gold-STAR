/**
 * "The customer named a carrier we may not have."
 *
 * Someone outside the company typed a carrier name into a public form. That
 * name may be a carrier the CRM already holds, a spelling of one, or genuinely
 * new. Only the third case should ever create an account, and only when a
 * person says so — a carrier account created by a homeowner's typo is a
 * duplicate somebody has to merge later.
 *
 * Used by every intake review path: the unassigned-lead inbox, the job-bound
 * review card, and the new-job form when it is being filled from a lead.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Building2, Check, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { useDefaultLocationId } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import { useAccountTypes } from "@/lib/account-types";
import {
  CARRIER_TYPE_KEY,
  createCarrierAccount,
  matchCarrier,
  type CarrierAccount,
} from "@/lib/carrier-match";
import { toastDbError } from "@/lib/db-errors";

export function CarrierConfirm({
  name,
  value,
  onChange,
  className,
}: {
  /** Carrier text as the customer typed it. */
  name: string | null | undefined;
  /** The account this carrier has been resolved to, if any. */
  value: CarrierAccount | null;
  onChange: (account: CarrierAccount | null) => void;
  className?: string;
}) {
  const app = useAppContext();
  const accountTypes = useAccountTypes();
  const defaultLocationId = useDefaultLocationId();
  const typeId = accountTypes.idForKey(CARRIER_TYPE_KEY);
  const typed = (name ?? "").trim();
  const [declined, setDeclined] = useState(false);

  const match = useQuery({
    queryKey: ["carrier-match", typed, typeId],
    enabled: typed.length > 1 && !accountTypes.isLoading,
    queryFn: () => matchCarrier(typed, typeId),
    staleTime: 60_000,
  });

  /* An exact match needs no decision — it is the carrier, so link it and say
     so. Anything less than exact stays a question for the reviewer. */
  const result = match.data;
  useEffect(() => {
    if (result?.status === "exact" && !value) onChange(result.account);
    // Linking once on resolution; re-running on every render would fight the
    // reviewer's own choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.status, result?.status === "exact" ? result.account.id : null]);

  const create = useMutation({
    mutationFn: () =>
      createCarrierAccount({
        name: typed,
        accountTypeId: typeId,
        locationId: defaultLocationId ?? "",
        userId: app.userId,
      }),
    onSuccess: (account) => {
      toast.success(`${account.name} added as a carrier`);
      onChange(account);
    },
    onError: (e) => toastDbError(e, { action: "Creating the carrier" }),
  });

  if (!typed) return null;

  const box = (tone: string, children: React.ReactNode) => (
    <div className={`rounded-md border-l-2 px-3 py-2 text-xs ${tone} ${className ?? ""}`}>
      {children}
    </div>
  );

  if (value) {
    return box(
      "border-l-emerald-600 bg-emerald-600/5",
      <span className="flex items-center gap-1.5">
        <Check className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
        Carrier <span className="font-medium">{typed}</span> is linked to{" "}
        <span className="font-medium">{value.name}</span>.
        <button
          type="button"
          className="ml-1 text-primary underline-offset-2 hover:underline"
          onClick={() => onChange(null)}
        >
          Change
        </button>
      </span>,
    );
  }

  if (match.isLoading) {
    return box("border-l-border bg-muted/40", <>Checking whether {typed} is already a carrier…</>);
  }

  /* A lookup that failed is not "this carrier is new". Offering a create here
     would have the office duplicating carriers it already has, which is the
     single most expensive way this screen can be wrong. */
  if (match.isError || result?.status === "unavailable") {
    return box(
      "border-l-destructive bg-destructive/5",
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 font-medium">
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
          We could not check the carrier list
        </p>
        <p className="text-muted-foreground">
          The customer gave <span className="font-medium">{typed}</span>, but we cannot tell whether
          we already hold it, so nothing will be created. The name is still recorded on the job.
        </p>
        <button
          type="button"
          className="font-medium text-primary underline-offset-2 hover:underline"
          onClick={() => void match.refetch()}
        >
          Try again
        </button>
      </div>,
    );
  }

  if (!result || result.status === "empty") return null;

  const candidates = result.status === "candidates" ? result.candidates : [];

  if (declined) {
    return box(
      "border-l-border bg-muted/40",
      <span>
        <span className="font-medium">{typed}</span> stays on the job as text only — no carrier
        record was created.{" "}
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => setDeclined(false)}
        >
          Undo
        </button>
      </span>,
    );
  }

  return box(
    "border-l-warning bg-warning/10",
    <div className="space-y-2">
      <p className="font-medium">
        New carrier: <span className="underline decoration-dotted">{typed}</span> is not in the
        system
      </p>
      {candidates.length ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">
            Did they mean one of these? Picking an existing carrier is what stops a second copy of
            it existing.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {candidates.slice(0, 6).map((c) => (
              <Button
                key={c.id}
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => onChange(c)}
              >
                <Building2 className="mr-1 size-3" />
                This is {c.name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={create.isPending || app.writesDisabled || !defaultLocationId}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : `Create "${typed}" as a new carrier`}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDeclined(true)}>
          Keep as text only
        </Button>
      </div>
    </div>,
  );
}
