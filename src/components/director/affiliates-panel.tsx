import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { EmptyLine, LoadError } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastDbError } from "@/lib/db-errors";
import { useWritesDisabled } from "@/components/app-context";
import {
  fetchAffiliateReferrals,
  fetchAffiliates,
  markReferralPaid,
  money,
  owedFor,
  saveAffiliate,
  saveReferral,
  type AffiliateRep,
} from "@/lib/director";

/**
 * Outside / affiliate salespeople. Paid on referral, never on payroll, so they
 * are tracked apart from employee headcount and employee cost lines.
 */
export function AffiliatesPanel() {
  const qc = useQueryClient();
  const { disabled: writesDisabled } = useWritesDisabled();
  const reps = useQuery({ queryKey: ["affiliate-reps"], queryFn: fetchAffiliates });
  const refs = useQuery({ queryKey: ["affiliate-referrals"], queryFn: fetchAffiliateReferrals });

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    full_name: "",
    company: "",
    email: "",
    phone: "",
    payout_terms: "",
    commission_rate: "",
  });
  const [refFor, setRefFor] = React.useState<AffiliateRep | null>(null);
  const [refForm, setRefForm] = React.useState({ description: "", amount_owed: "" });

  const addRep = useMutation({
    mutationFn: () =>
      saveAffiliate({
        full_name: form.full_name.trim(),
        company: form.company.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        payout_terms: form.payout_terms.trim() || null,
        commission_rate: form.commission_rate ? Number(form.commission_rate) : null,
      }),
    onSuccess: () => {
      toast.success("Affiliate added");
      setOpen(false);
      setForm({
        full_name: "",
        company: "",
        email: "",
        phone: "",
        payout_terms: "",
        commission_rate: "",
      });
      qc.invalidateQueries({ queryKey: ["affiliate-reps"] });
    },
    onError: (e) => toastDbError(e, { action: "save affiliate" }),
  });

  const addRef = useMutation({
    mutationFn: () =>
      saveReferral({
        affiliate_id: refFor!.id,
        description: refForm.description.trim() || null,
        amount_owed: refForm.amount_owed ? Number(refForm.amount_owed) : null,
      }),
    onSuccess: () => {
      toast.success("Referral logged");
      setRefFor(null);
      setRefForm({ description: "", amount_owed: "" });
      qc.invalidateQueries({ queryKey: ["affiliate-referrals"] });
    },
    onError: (e) => toastDbError(e, { action: "log referral" }),
  });

  const pay = useMutation({
    mutationFn: (id: string) => markReferralPaid(id),
    onSuccess: () => {
      toast.success("Marked paid");
      qc.invalidateQueries({ queryKey: ["affiliate-referrals"] });
    },
    onError: (e) => toastDbError(e, { action: "mark referral paid" }),
  });

  if (reps.isError)
    return <LoadError what="affiliates" error={reps.error} onRetry={() => void reps.refetch()} />;

  const rows = reps.data ?? [];
  const referrals = refs.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">
          Outside reps, paid per referral. Never counted in employee headcount or salary cost.
        </p>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={writesDisabled}>
              <Plus className="size-3.5" /> Affiliate
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New affiliate rep</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              {(
                [
                  ["full_name", "Name"],
                  ["company", "Company"],
                  ["email", "Email"],
                  ["phone", "Phone"],
                  ["payout_terms", "Payout terms"],
                  ["commission_rate", "Commission rate (%)"],
                ] as const
              ).map(([k, label]) => (
                <div key={k} className="grid gap-1">
                  <Label htmlFor={k}>{label}</Label>
                  <Input
                    id={k}
                    value={form[k]}
                    onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button
                onClick={() => addRep.mutate()}
                disabled={!form.full_name.trim() || addRep.isPending || writesDisabled}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Affiliate</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Terms</TableHead>
              <TableHead className="text-right">Referrals</TableHead>
              <TableHead className="text-right">Owed</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const mine = referrals.filter((x) => x.affiliate_id === r.id);
              const owed = owedFor(r.id, referrals);
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-semibold">
                    {r.full_name}
                    {r.status !== "active" && (
                      <Badge variant="outline" className="ml-2">
                        {r.status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.company ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.payout_terms ?? (r.commission_rate != null ? `${r.commission_rate}%` : "—")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{mine.length}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">
                    {money(owed)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={writesDisabled}
                      onClick={() => setRefFor(r)}
                    >
                      Log referral
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <EmptyLine>No affiliate reps yet.</EmptyLine>
      )}

      {referrals.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-[12px] font-bold uppercase tracking-wide text-muted-foreground">
            Referrals
          </h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Referred</TableHead>
                <TableHead>Affiliate</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="text-right">Owed</TableHead>
                <TableHead className="text-right">Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {referrals.map((x) => (
                <TableRow key={x.id}>
                  <TableCell className="tabular-nums">{x.referred_on}</TableCell>
                  <TableCell>
                    {rows.find((r) => r.id === x.affiliate_id)?.full_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{x.description ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {x.amount_owed == null ? "—" : money(Number(x.amount_owed))}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={x.status === "paid" ? "success" : "warning"}>{x.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {x.status !== "paid" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={writesDisabled}
                        onClick={() => pay.mutate(x.id)}
                      >
                        Mark paid
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!refFor} onOpenChange={(v) => !v && setRefFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log referral — {refFor?.full_name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="ref-desc">What they referred</Label>
              <Input
                id="ref-desc"
                value={refForm.description}
                onChange={(e) => setRefForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="ref-amt">Amount owed</Label>
              <NumberInput
                id="ref-amt"
                decimals={2}
                value={refForm.amount_owed}
                onValueChange={(_, clean) => setRefForm((f) => ({ ...f, amount_owed: clean }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => addRef.mutate()} disabled={addRef.isPending || writesDisabled}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
