import { Calculator } from "lucide-react";

import { JobCalculatorEditor } from "@/components/job-calculator-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** The job fields the calculator is seeded from. Whatever is blank stays blank. */
export type CalculatorJobSeed = {
  id: string;
  location_id: string;
  address: string | null;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  customer_name: string | null;
};

/**
 * The job calculator as a pop-up over the job, already filled in.
 *
 * The button used to be a link to a blank page where the first thing asked
 * for was the address the job already knew. One click now opens the
 * calculator with the job's address, customer and office in place; the
 * address stays editable at the top and saving attaches the calculation to
 * this job.
 */
export function JobCalculatorDialog({
  open,
  onOpenChange,
  job,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: CalculatorJobSeed;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] w-[min(72rem,calc(100vw-1.5rem))] max-w-none gap-3 p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="size-4" /> Job calculator
          </DialogTitle>
          <DialogDescription>
            Price the work for this job. Saved estimates attach to it and appear in the rail.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open so each opening starts from the job's
            current address rather than whatever was typed last time. */}
        {open && (
          <JobCalculatorEditor
            embedded
            jobId={job.id}
            prefill={{
              locationId: job.location_id,
              address: job.address ?? "",
              addressLine2: job.address_line2 ?? "",
              locality: job.locality ?? "",
              region: job.region ?? "",
              postalCode: job.postal_code ?? "",
              customerName: job.customer_name ?? "",
            }}
            onSaved={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
