// TODO(remove after cutover): temporary, for moving the app off Lovable to
// Vercel. Delete with the rest of the secret transfer (see the header of
// src/lib/secret-transfer.ts).
/**
 * The Owner's "Transfer secrets to new host" card. Check first (which names
 * this server has, and where they would go), then type TRANSFER and press
 * Transfer. The card is shown to owners only, but the server function is the
 * gate; hiding it here is tidiness, not security.
 *
 * Nothing on this card ever holds a value: the server answers with names,
 * true/false and per-name statuses. Plain calls rather than useMutation so
 * the View As mutation guard and the cache have nothing to say about it.
 */
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { WarningLine } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  SECRET_TRANSFER_EXPIRES_AT,
  TRANSFER_CONFIRM_WORD,
  TRANSFER_ENABLED_ENV,
  transferStatusLabel,
  type SecretTransferCheck,
  type SecretTransferRun,
} from "@/lib/secret-transfer";
import { checkSecretTransfer, runSecretTransfer } from "@/lib/secret-transfer.functions";

export function SecretTransferCard() {
  const app = useAppContext();
  const check = useServerFn(checkSecretTransfer);
  const transfer = useServerFn(runSecretTransfer);
  const [checked, setChecked] = useState<SecretTransferCheck | null>(null);
  const [ran, setRan] = useState<SecretTransferRun | null>(null);
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState<"check" | "transfer" | null>(null);

  if (!app.roles.includes("owner")) return null;

  async function runCheck() {
    setPending("check");
    try {
      setChecked(await check());
    } catch (e) {
      toast.error("Check failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(null);
    }
  }

  async function runTransfer() {
    setPending("transfer");
    try {
      const result = await transfer({ data: { confirm } });
      setRan(result);
      setConfirm("");
      const { copied, missing, failed } = result.counts;
      const summary = `${copied} copied, ${missing} missing on this server, ${failed} failed.`;
      if (failed > 0) toast.error("Transfer finished with failures", { description: summary });
      else toast.success("Transfer finished", { description: summary });
    } catch (e) {
      toast.error("Transfer refused", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPending(null);
    }
  }

  const present = checked?.rows.filter((r) => r.present).length ?? 0;
  const armed = confirm.trim() === TRANSFER_CONFIRM_WORD;

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div>
          <h3 className="text-sm font-semibold">Transfer secrets to new host</h3>
          <p className="text-sm text-muted-foreground">
            Copies a fixed list of this server&apos;s secrets straight to the new host (Vercel,
            Production, stored as Sensitive). No value is ever shown here, logged or saved — only
            each name&apos;s status comes back. Temporary: removed after the move.
          </p>
          <p className="text-xs text-muted-foreground">
            Off unless the server has {TRANSFER_ENABLED_ENV}=1, and off for good from{" "}
            {SECRET_TRANSFER_EXPIRES_AT.slice(0, 10)} whatever that says.
          </p>
        </div>

        <Button
          variant="outline"
          disabled={pending !== null || app.isImpersonating}
          onClick={() => void runCheck()}
        >
          <KeyRound className="size-4" />
          {pending === "check" ? "Checking…" : "Check"}
        </Button>
        {app.isImpersonating && (
          <p className="text-xs text-muted-foreground">Disabled while View As is on.</p>
        )}

        {checked && (
          <div className="space-y-2">
            <p className="text-sm">
              Target: Vercel team <span className="font-medium">{checked.target.teamName}</span> (
              {checked.target.teamSlug}), project{" "}
              <span className="font-medium">{checked.target.projectName}</span>,{" "}
              {checked.target.environment}. {present} of {checked.rows.length} names are set on this
              server.
            </p>
            {!checked.tokenConfigured && (
              <WarningLine>
                VERCEL_TRANSFER_TOKEN is not set on this server, so Transfer will refuse. Add it in
                Lovable&apos;s Secrets, then Check again.
              </WarningLine>
            )}
            {!checked.auditRecorded && (
              <WarningLine>The audit row for this check could not be completed.</WarningLine>
            )}
            <NameTable
              rows={checked.rows.map((r) => ({
                name: r.name,
                label: r.present ? "set" : "missing on this server",
                tone: r.present ? "ok" : "muted",
              }))}
            />
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                Not copied, on purpose ({checked.excluded.length})
              </summary>
              <ul className="mt-1 space-y-0.5">
                {checked.excluded.map((e) => (
                  <li key={e.name}>
                    <span className="font-mono">{e.name}</span> — {e.why}
                  </li>
                ))}
              </ul>
            </details>

            <div className="space-y-2 border-t pt-3">
              <label className="block text-sm" htmlFor="secret-transfer-confirm">
                Type <span className="font-mono font-semibold">{TRANSFER_CONFIRM_WORD}</span> to
                send the values above to Vercel. Existing variables with the same names are
                overwritten.
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="secret-transfer-confirm"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-40 font-mono"
                />
                <Button
                  variant="destructive"
                  disabled={!armed || pending !== null || app.isImpersonating}
                  onClick={() => void runTransfer()}
                >
                  {pending === "transfer" ? "Transferring…" : "Transfer"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {ran && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-sm">
              Last run: {ran.counts.copied} copied, {ran.counts.missing} missing on this server,{" "}
              {ran.counts.failed} failed.
            </p>
            {!ran.auditRecorded && (
              <WarningLine>The audit row for this run could not be completed.</WarningLine>
            )}
            <NameTable
              rows={ran.rows.map((r) => ({
                name: r.name,
                label: transferStatusLabel(r),
                tone: r.status === "copied" ? "ok" : r.status === "failed" ? "bad" : "muted",
              }))}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NameTable({
  rows,
}: {
  rows: { name: string; label: string; tone: "ok" | "bad" | "muted" }[];
}) {
  return (
    <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-[11px] uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b last:border-0">
              <td className="px-3 py-1.5 font-mono text-xs">{r.name}</td>
              <td className="px-3 py-1.5">
                <Badge
                  variant={
                    r.tone === "ok" ? "default" : r.tone === "bad" ? "destructive" : "outline"
                  }
                >
                  {r.label}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
