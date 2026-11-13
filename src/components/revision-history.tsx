import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { History, Eye, Download, Lock, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { documentFileUrl } from "@/lib/documents";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
import {
  diffRevisions,
  listRevisions,
  syncDraftRevision,
  type RevKind,
  type Revision,
} from "@/lib/revisions";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/**
 * Version history for an estimate or invoice: who published each version, what
 * it billed, what changed against the version before it, and exactly which
 * recipient got which version. Frozen versions open the stored PDF — the same
 * file the carrier is holding.
 */
export function RevisionHistoryButton({
  kind,
  recordId,
  numberLabel,
  size = "sm",
  variant = "ghost",
  iconOnly = false,
}: {
  kind: RevKind;
  recordId: string;
  numberLabel: string;
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost";
  /** The clock alone, labelled for screen readers (the Billing boxes, T7). */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [compareTo, setCompareTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; title: string; filename: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Reading history is a good moment to catch the working version up with
      // the record — and to open v2 if the last one has already been sent.
      await syncDraftRevision(kind, recordId).catch(() => null);
      const rows = await listRevisions(kind, recordId);
      setRevisions(rows);
      setSelected((s) => s ?? rows[0]?.id ?? null);
      const ids = [...new Set(rows.map((r) => r.created_by).filter(Boolean))] as string[];
      if (ids.length) {
        const { data } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", ids);
        setNames(
          Object.fromEntries((data ?? []).map((p) => [p.user_id, p.full_name ?? "Someone"])),
        );
      }
    } catch (e: unknown) {
      toast.error(
        e && typeof e === "object" && "message" in e && typeof e.message === "string"
          ? e.message
          : "Could not load the version history",
      );
    } finally {
      setLoading(false);
    }
  }, [kind, recordId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const current = revisions.find((r) => r.id === selected) ?? null;
  const previous = useMemo(() => {
    if (!current) return null;
    if (compareTo) return revisions.find((r) => r.id === compareTo) ?? null;
    return revisions.find((r) => r.version === current.version - 1) ?? null;
  }, [current, compareTo, revisions]);

  const diff = current ? diffRevisions(previous?.snapshot ?? null, current.snapshot) : null;

  async function openStoredPdf(rev: Revision) {
    if (!rev.document_id) {
      toast.error("No stored PDF for that version — it was never sent or downloaded.");
      return;
    }
    const { data, error } = await supabase
      .from("documents")
      .select("storage_path, name")
      .eq("id", rev.document_id)
      .maybeSingle();
    if (error || !data?.storage_path) {
      toast.error("Could not find the stored file for that version.");
      return;
    }
    setPdf({
      // Same-origin and RLS-checked; see src/routes/api/documents.$id.file.ts.
      url: documentFileUrl(rev.document_id),
      title: `${numberLabel} v${rev.version}`,
      filename: `${numberLabel}-v${rev.version}.pdf`,
    });
  }

  return (
    <>
      {iconOnly ? (
        <Button
          variant={variant}
          size="icon"
          className="size-8"
          onClick={() => setOpen(true)}
          aria-label="Versions"
          title="Versions"
        >
          <History className="size-3.5" />
        </Button>
      ) : (
        <Button variant={variant} size={size} onClick={() => setOpen(true)}>
          <History className="mr-1.5 size-3.5" /> Versions
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{numberLabel} · version history</DialogTitle>
            <DialogDescription>
              Every version that has gone out is frozen. Corrections create the next version, and
              the send log below shows who received which one.
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[62vh] gap-4 overflow-y-auto md:grid-cols-[18rem_minmax(0,1fr)]">
            <div className="space-y-2">
              {loading && revisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : revisions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No versions recorded yet.</p>
              ) : (
                revisions.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setSelected(r.id);
                      setCompareTo(null);
                    }}
                    className={`w-full rounded-md border p-2 text-left text-sm transition ${
                      r.id === selected ? "border-primary bg-muted/60" : "hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">v{r.version}</span>
                      <span className="tabular-nums">{money(Number(r.total ?? 0))}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {r.frozen ? (
                        <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                          <Lock className="size-3" /> Sent
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          Working
                        </Badge>
                      )}
                      <span className="truncate">
                        {when(r.created_at)} · {names[r.created_by ?? ""] ?? "Someone"}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="space-y-3">
              {!current ? (
                <p className="text-sm text-muted-foreground">Pick a version.</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      v{current.version} · {money(Number(current.total ?? 0))}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => void openStoredPdf(current)}>
                      <Eye className="mr-1.5 size-3.5" /> View PDF
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void openStoredPdf(current)}>
                      <Download className="mr-1.5 size-3.5" /> Download
                    </Button>
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Compare with</span>
                      <Select
                        value={previous?.id ?? "none"}
                        onValueChange={(v) => setCompareTo(v === "none" ? null : v)}
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Nothing</SelectItem>
                          {revisions
                            .filter((r) => r.id !== current.id)
                            .map((r) => (
                              <SelectItem key={r.id} value={r.id}>
                                v{r.version}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {diff && (
                    <div className="rounded-md border">
                      <div className="flex items-center justify-between border-b px-3 py-2 text-sm">
                        <span className="font-medium">
                          Changes {previous ? `since v${previous.version}` : "(first version)"}
                        </span>
                        <span
                          className={`tabular-nums ${
                            diff.delta > 0
                              ? "text-destructive"
                              : diff.delta < 0
                                ? "text-emerald-700 dark:text-emerald-400"
                                : ""
                          }`}
                        >
                          {diff.delta === 0
                            ? "No change"
                            : `${diff.delta > 0 ? "+" : "−"}${money(Math.abs(diff.delta))}`}
                        </span>
                      </div>
                      <div className="divide-y text-sm">
                        {diff.lines.length === 0 ? (
                          <p className="px-3 py-2 text-muted-foreground">No line item changes.</p>
                        ) : (
                          diff.lines.map((l, i) => (
                            <div
                              key={i}
                              className="flex items-start justify-between gap-3 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <Badge
                                    variant="outline"
                                    className={`px-1.5 py-0 text-[10px] ${
                                      l.kind === "added"
                                        ? "border-emerald-500 text-emerald-700 dark:text-emerald-400"
                                        : l.kind === "removed"
                                          ? "border-destructive text-destructive"
                                          : ""
                                    }`}
                                  >
                                    {l.kind}
                                  </Badge>
                                  <span className="truncate font-medium">{l.name}</span>
                                </div>
                                {l.kind === "changed" && l.before && l.after && (
                                  <p className="mt-0.5 text-xs text-muted-foreground">
                                    {l.fields?.join(", ")} · {Number(l.before.quantity)} ×{" "}
                                    {money(Number(l.before.unit_price))} →{" "}
                                    {Number(l.after.quantity)} × {money(Number(l.after.unit_price))}
                                  </p>
                                )}
                              </div>
                              <span className="shrink-0 tabular-nums text-xs">
                                {l.delta === 0
                                  ? "—"
                                  : `${l.delta > 0 ? "+" : "−"}${money(Math.abs(l.delta))}`}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  <Separator />
                  <div>
                    <p className="mb-1 text-sm font-medium">Sent to</p>
                    {(current.sends ?? []).length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        This version has not gone to anyone yet.
                      </p>
                    ) : (
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {(current.sends ?? [])
                          .slice()
                          .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
                          .map((s) => (
                            <li key={s.id} className="flex items-center gap-1.5">
                              <Send className="size-3" />
                              <span className="text-foreground">{s.recipient ?? s.channel}</span>
                              <span>
                                · {s.channel} · {when(s.sent_at)}
                              </span>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <PdfPreviewDialog
        open={!!pdf}
        onOpenChange={(v) => !v && setPdf(null)}
        title={pdf?.title ?? ""}
        url={pdf?.url ?? null}
        filename={pdf?.filename ?? "document.pdf"}
      />
    </>
  );
}
