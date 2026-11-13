/**
 * Two-factor adoption across the company, and the reset that gets somebody
 * back in when their phone is gone. Read the recovery note in src/lib/mfa.ts
 * before changing anything here.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { MovingServersSection } from "@/components/moving-servers-section";
import { SecretTransferCard } from "@/components/secret-transfer-card";
import { StorageExportCard } from "@/components/storage-export-card";
import { LoadError, WarningLine } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminListMfaAdoption, adminResetMfa, type MfaAdoptionRow } from "@/lib/mfa.functions";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/admin/security")({
  head: () => ({
    meta: [
      { title: "Security — Admin — Recovery Hub" },
      { name: "description", content: "Two-factor authentication adoption across Recovery Hub." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminSecurityPage,
});

function AdminSecurityPage() {
  const qc = useQueryClient();
  const list = useServerFn(adminListMfaAdoption);
  const reset = useServerFn(adminResetMfa);
  const [search, setSearch] = useState("");
  const [confirming, setConfirming] = useState<MfaAdoptionRow | null>(null);

  const q = useQuery({ queryKey: ["admin-mfa-adoption"], queryFn: () => list(), retry: false });

  const resetMutation = useMutation({
    mutationFn: (userId: string) => reset({ data: { userId } }),
    onSuccess: async (result) => {
      setConfirming(null);
      await qc.invalidateQueries({ queryKey: ["admin-mfa-adoption"] });
      toast.success(
        result.removed > 0
          ? `Removed ${result.removed} factor${result.removed === 1 ? "" : "s"}. They can sign in with their password now.`
          : "That account had no factors to remove.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = q.data?.rows ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        (r.email ?? "").toLowerCase().includes(needle) ||
        (r.fullName ?? "").toLowerCase().includes(needle),
    );
  }, [rows, search]);

  const enrolled = rows.filter((r) => r.verifiedFactors > 0).length;

  if (q.isError) {
    return (
      <div className="space-y-3 p-3">
        {/* Never an empty table: "nobody has MFA" and "we could not ask" look
            identical on screen and mean opposite things. */}
        <LoadError
          what="two-factor adoption"
          error={q.error as Error}
          onRetry={() => void q.refetch()}
        />
        <StorageExportCard />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="display-heavy text-[15px] uppercase tracking-[0.05em]">
            Two-factor authentication
          </h2>
          <p className="text-sm text-muted-foreground">
            {q.isLoading
              ? "Loading…"
              : `${enrolled} of ${rows.length} accounts have an authenticator app enrolled.`}
          </p>
        </div>
        <Input
          placeholder="Search name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
      </div>

      {q.data?.factorsUnavailable && (
        <WarningLine>
          The auth service did not report factor status for any account. The column below is
          unknown, not empty — do not read it as "nobody is enrolled".
        </WarningLine>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Two-factor</th>
                  <th className="px-3 py-2">Last sign-in</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {q.isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-muted-foreground">
                      No accounts match that search.
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => (
                    <tr key={r.userId} className="border-b last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.fullName || "—"}</div>
                        <div className="text-xs text-muted-foreground">{r.email ?? "—"}</div>
                      </td>
                      <td className="px-3 py-2">
                        {q.data?.factorsUnavailable ? (
                          <Badge variant="outline">Unknown</Badge>
                        ) : r.verifiedFactors > 0 ? (
                          <Badge className="gap-1">
                            <ShieldCheck className="size-3" /> On
                          </Badge>
                        ) : r.unverifiedFactors > 0 ? (
                          <Badge variant="outline" className="gap-1">
                            <TriangleAlert className="size-3" /> Setup unfinished
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <ShieldOff className="size-3" /> Off
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {r.lastSignInAt
                          ? new Date(r.lastSignInAt).toLocaleDateString(DATE_LOCALE, US_DATE)
                          : "Never"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.verifiedFactors + r.unverifiedFactors > 0 && (
                          <Button variant="outline" size="sm" onClick={() => setConfirming(r)}>
                            Reset
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Two-factor is opt-in. Staff turn it on themselves under Security in the account menu.
      </p>

      <Dialog open={Boolean(confirming)} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset two-factor for {confirming?.email ?? "this account"}?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              This removes every authenticator factor on the account. They will sign in with their
              password alone until they set it up again.
            </p>
            <p className="font-medium text-foreground">
              Confirm you are speaking to this person by a route that is not their phone. Somebody
              asking for this is, by definition, somebody who says they have lost the device.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={resetMutation.isPending}
              onClick={() => confirming && resetMutation.mutate(confirming.userId)}
            >
              Reset two-factor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* TODO(remove after cutover): Owner-only tools for the move off Lovable. */}
      <MovingServersSection>
        <SecretTransferCard />
        <StorageExportCard />
      </MovingServersSection>
    </div>
  );
}
