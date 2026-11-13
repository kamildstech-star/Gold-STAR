/**
 * Scanning a conference badge on the quick path.
 *
 * The honest scope of this, stated up front because getting it wrong would be
 * worse than not having it: what a badge encodes is a vendor's private
 * business. One show hands out a QR code holding a URL, the next a PDF417 with
 * a delimited blob, the one after that an attendee number that means nothing
 * without the organiser's export. Guessing at those formats would put invented
 * names and companies onto real leads. So this reads the code and hands the
 * string on verbatim. The one exception is a badge that carries an open
 * standard — a vCard or MECARD, which the MFO Summit badges did — and that is
 * `badge-payload.ts`'s job, not this sheet's: the caller decides what to do
 * with a decoded contact card versus an attendee id.
 *
 * The camera, the decode loop, the permission failures and their wording now
 * live in `CodeScanDialog`, which is this component's own body extracted when
 * supplies needed the same scanner for a shelf bin. Only the words differ. The
 * widened format list still reaches only devices with a native
 * `BarcodeDetector`. Everywhere else, iPhones included, the JavaScript path
 * reads QR and Code 128 — jsQR joined the loop after three printed
 * business-card QR codes failed in a row on Melly's 17 Sep call. The remaining
 * badge symbologies (PDF417, Data Matrix, Aztec) still need a native reader,
 * which is why the note below says so and why typing the number is always
 * offered.
 */
import { CodeScanDialog } from "@/components/code-scan-dialog";

export function BadgeScanSheet({
  open,
  onOpenChange,
  onScanned,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The raw string the code carried. Nothing has interpreted it. */
  onScanned: (raw: string) => void;
}) {
  return (
    <CodeScanDialog
      open={open}
      onOpenChange={onOpenChange}
      onScanned={onScanned}
      title="Scan their badge"
      description="A badge with a contact card on it fills the lead in. Anything else is kept as-is for the review pass — nothing guesses a name out of an attendee number."
      manualLabel="Or type what is printed on it"
      manualPlaceholder="Badge or booth number"
      dismissLabel="Skip the badge"
      fallbackNote="This device has no built-in barcode reader, so QR and Code 128 are read in software — hold the badge still a moment longer. Other badge formats need typing in."
    />
  );
}
