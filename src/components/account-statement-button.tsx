import { useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { EmailComposer } from "@/components/email-composer";
import { Button } from "@/components/ui/button";
import { buildAccountStatementPdf, loadAccountStatement } from "@/lib/account-statement";
import { savePdfToDocuments, signedDocumentUrl } from "@/lib/pdf-actions";
import { money } from "@/lib/pdf-kit";

/**
 * FE9, 28 Oct: "Send account statement" on a customer. Builds the statement
 * (every open invoice across the customer's jobs, the payments taken, the
 * balance), files it on the account, and opens the composer with it as a
 * download link — the way an invoice goes out. Nothing is sent until Send.
 */
export function AccountStatementButton({
  accountId,
  size = "sm",
}: {
  accountId: string;
  size?: "sm" | "default";
}) {
  const app = useAppContext();
  const [busy, setBusy] = useState(false);
  const [compose, setCompose] = useState<{
    url: string;
    to: string[];
    locationId: string | null;
    vars: Record<string, string>;
  } | null>(null);

  const prepare = async () => {
    setBusy(true);
    try {
      const st = await loadAccountStatement(accountId);
      const built = await buildAccountStatementPdf(st);
      const locationId = built.locationId;
      if (!locationId) throw new Error("This customer has no office to send a statement from.");
      const docId = await savePdfToDocuments({
        bytes: built.bytes,
        filename: built.filename,
        name: built.title,
        docType: "invoice",
        locationId,
        jobId: null,
        accountId,
      });
      const url = await signedDocumentUrl(docId, {
        seconds: 60 * 60 * 24 * 30,
        why: "The link sits inside an emailed account statement; the customer opens it when they get to it and cannot sign in.",
      });
      setCompose({
        url,
        to: st.account.email ? [st.account.email] : [],
        locationId,
        vars: {
          customer_name: st.account.name ?? "",
          balance_due: money(st.totals.balance),
          open_invoices: String(st.totals.count),
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not prepare the statement.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size={size}
        onClick={() => void prepare()}
        disabled={busy || app.writesDisabled}
        title="Email this customer a statement of every open invoice, payment and the balance"
      >
        <FileSpreadsheet className="mr-1.5 size-3.5" />
        {busy ? "Preparing…" : "Send account statement"}
      </Button>
      {compose && (
        <EmailComposer
          open
          onOpenChange={(v) => !v && setCompose(null)}
          context={{
            category: "invoice",
            to: compose.to,
            accountId,
            locationId: compose.locationId,
            attachmentUrl: compose.url,
            variables: compose.vars,
          }}
        />
      )}
    </>
  );
}
