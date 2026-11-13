/**
 * "This already exists in another office" — the one line a rep sees when the
 * customer or company they are about to create is already on another office's
 * books (owner, 13 Nov: "bring back the cross-office duplicate warning").
 *
 * Nothing about the record itself: no name, contact, phone, address, job or
 * money, and nothing to click — a role does not see what it is not granted.
 * Only that a match exists and which office has it, so the rep calls that
 * office instead of making a second record.
 */
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

/** The offices to name, each once, in the order met; blanks dropped. */
export function otherOfficeNames(names: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const t = n?.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** "Baltimore", "Baltimore and NJ", "Baltimore, NJ and DC"; "another office" when unknown. */
export function officeList(names: readonly string[]): string {
  if (names.length === 0) return "another office";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function OtherOfficeNotice({
  offices,
  what,
  className,
}: {
  /** Office names that hold a match (otherOfficeNames). Renders nothing when there is no match. */
  offices: readonly string[] | null;
  what: "customer" | "company";
  className?: string;
}) {
  if (!offices) return null;
  const where = offices.length ? `another office (${officeList(offices)})` : "another office";
  return (
    <Alert variant="warning" className={className ?? "px-3 py-2"} data-other-office-notice>
      <AlertTriangle />
      <AlertDescription className="text-xs">
        This {what} may already exist in {where}. Check with that office before creating a new one.
      </AlertDescription>
    </Alert>
  );
}
