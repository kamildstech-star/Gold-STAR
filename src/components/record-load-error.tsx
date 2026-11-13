import { ShieldAlert, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isAccessError, describeRecordLoad, logRecordLoad } from "@/lib/db-errors";

/**
 * One honest failure state for record panels and detail pages.
 *
 * The rule: only say "no access" when the error actually says so (42501,
 * row-level security, or a missing single row we had reason to expect).
 * Everything else reports what really happened — a malformed query must not
 * send anyone chasing RLS policies that are working fine.
 */
export function RecordLoadError({
  error,
  record,
  table,
  id,
  onRetry,
  compact,
}: {
  error: unknown;
  record: string;
  table: string;
  id?: string | null;
  onRetry?: () => void;
  compact?: boolean;
}) {
  logRecordLoad(error, { record, table, id });
  const access = isAccessError(error);
  const message = describeRecordLoad(error, { record });

  if (compact) {
    return (
      <div className="p-3 text-[12px]">
        <p className="text-muted-foreground">{message}</p>
        {onRetry && (
          <Button size="sm" variant="outline" className="mt-2 h-7 text-[12px]" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="p-3">
      <Alert variant="destructive">
        {access ? <ShieldAlert className="size-4" /> : <TriangleAlert className="size-4" />}
        <AlertTitle>
          {access ? `Can't open this ${record}` : `Couldn't load this ${record}`}
        </AlertTitle>
        <AlertDescription>
          <p>{message}</p>
          {onRetry && (
            <Button size="sm" variant="outline" className="mt-2 h-7 text-[12px]" onClick={onRetry}>
              Retry
            </Button>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}
