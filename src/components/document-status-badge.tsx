import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  DOCUMENT_SIGNATURE_COLUMNS,
  countWaitingSignatures,
  treatDocumentStatus,
  type DocumentSignatureFacts,
} from "@/lib/document-status";

/**
 * The one signature-status indicator. Every list of documents renders this and
 * nothing else, so a document cannot show "unsigned" on the job and "sent" on
 * the global list.
 *
 * Red and green are the commonest colour-blind confusion, so the colour is the
 * last thing that carries the state here: there is always a word, always an
 * icon of a different shape per state, and the whole sentence is on the
 * element as both `title` and screen-reader text.
 */
export function DocumentStatusBadge({
  doc,
  className,
  now,
}: {
  doc: DocumentSignatureFacts;
  className?: string;
  /** Injectable clock, for tests and stable stories. */
  now?: number;
}) {
  const t = treatDocumentStatus(doc, now);
  const Icon = t.icon;
  return (
    <Badge className={cn("gap-1", t.className, className)} title={t.description}>
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{t.label}</span>
      {t.age && <span className="shrink-0 tracking-normal opacity-80">· {t.age}</span>}
      <span className="sr-only"> — {t.description}</span>
    </Badge>
  );
}

/**
 * How many of a job's documents are still owed a signature, for the Documents
 * tab label.
 *
 * `count` is null when the read failed or has not landed. A failed read must
 * not render as "0 unsigned" — that is a clean bill of health this hook cannot
 * give, and it is exactly the bug this codebase keeps re-growing.
 */
export function useJobUnsignedCount(jobId: string): {
  count: number | null;
  error: string | null;
  reload: () => void;
} {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const select = (cols: string) =>
      supabase.from("documents").select(cols).eq("job_id", jobId).limit(500);

    let res = await select(`status, doc_type, created_at, ${DOCUMENT_SIGNATURE_COLUMNS}`);
    // The signature timestamps ship in a migration that may not be applied on
    // every environment; without them the status alone still answers the
    // question, just without the age.
    if (res.error && isMissingSchema(res.error)) res = await select("status, doc_type, created_at");
    if (res.error) {
      setCount(null);
      setError(res.error.message);
      return;
    }
    setError(null);
    setCount(countWaitingSignatures((res.data ?? []) as unknown as DocumentSignatureFacts[]));
  }, [jobId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { count, error, reload: () => void reload() };
}
