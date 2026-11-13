/**
 * Bilingual work order. English and Spanish sit side by side; the Spanish
 * text is read from `translations`, so a crew phone with no signal still
 * renders it. A bilingual supervisor can correct it and the correction sticks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Languages, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { translateAndStore } from "@/lib/ai.functions";
import {
  getTranslation,
  saveCorrection,
  translationMatches,
  type StoredTranslation,
  type TranslatableEntity,
} from "@/lib/translations";

interface Props {
  entityType: TranslatableEntity;
  entityId: string;
  field?: string;
  /** The English source text. */
  text: string;
  title?: string;
  /**
   * Inside another card (Scope of work by room, 23 Oct): only the Spanish and
   * its buttons — the English is the card's own list — and it translates on
   * open when there is no current translation.
   */
  inline?: boolean;
}

export function WorkOrderTranslation({
  entityType,
  entityId,
  field = "scope",
  text,
  title = "Scope of work",
  inline = false,
}: Props) {
  const { userId } = useAppContext();
  const { disabled: writesDisabled } = useWritesDisabled();
  const translate = useServerFn(translateAndStore);

  const [stored, setStored] = useState<StoredTranslation | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStored(await getTranslation(entityType, entityId, field, "es"));
    } catch {
      setStored(null);
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, field]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setWorking(true);
    try {
      await translate({
        data: {
          entity_type: entityType,
          entity_id: entityId,
          field,
          text,
          lang: "es",
        },
      });
      await load();
    } catch (e) {
      toast.error("Translation failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setWorking(false);
    }
  };

  // Inline: pressing Translate is the request, so make it if none matches.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!inline || loading || autoTried.current || writesDisabled || !text.trim()) return;
    if (translationMatches(stored, text)) return;
    autoTried.current = true;
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inline, loading, stored, text, writesDisabled]);

  const saveEdit = async () => {
    if (!userId) return;
    setWorking(true);
    try {
      await saveCorrection({
        entityType,
        entityId,
        field,
        text: draft,
        sourceText: text,
        userId,
      });
      setEditing(false);
      await load();
      toast.success("Correction saved");
    } catch (e) {
      toast.error("Could not save the correction", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setWorking(false);
    }
  };

  // The Spanish column is only trustworthy when it was made from exactly the
  // English shown beside it. Anything else is withheld, never displayed.
  const matches = translationMatches(stored, text);
  const staleSource = !!stored && !matches;

  const spanish = (
    <>
      {loading ? (
        <p className="p-3 text-sm text-muted-foreground">Loading…</p>
      ) : editing ? (
        <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
      ) : stored && matches ? (
        <p className="whitespace-pre-wrap rounded-sm border bg-muted/30 p-3 text-sm">
          {stored.text}
        </p>
      ) : (
        <p className="rounded-sm border border-dashed p-3 text-sm text-muted-foreground">
          {stored ? "Withheld — out of date." : "Not translated yet."}
        </p>
      )}
    </>
  );
  const actions = (
    <>
      {staleSource ? (
        <p className="text-xs text-[hsl(var(--warning,38_92%_40%))]">
          The English text changed since this translation was made, so the Spanish is hidden.
          Re-translate before handing this to a crew.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" onClick={saveEdit} disabled={working}>
              <Check className="mr-1 size-4" /> Save correction
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={generate}
              disabled={working || writesDisabled || !text.trim()}
            >
              {working ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Languages className="mr-1 size-4" />
              )}
              {stored ? "Re-translate" : "Translate to Spanish"}
            </Button>
            {stored && matches ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={writesDisabled}
                onClick={() => {
                  setDraft(stored.text);
                  setEditing(true);
                }}
              >
                <Pencil className="mr-1 size-4" /> Correct
              </Button>
            ) : null}
          </>
        )}
      </div>
    </>
  );

  if (inline) {
    return (
      <div className="space-y-2 border-t pt-3" data-scope-spanish>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Español
          </p>
          {stored && matches ? (
            <Badge variant={stored.source === "human" ? "secondary" : "outline"}>
              {stored.source === "human" ? "Supervisor-corrected" : "Machine"}
            </Badge>
          ) : null}
        </div>
        {spanish}
        {actions}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="text-sm">{title} · English / Español</CardTitle>
        {stored && matches ? (
          <Badge variant={stored.source === "human" ? "secondary" : "outline"}>
            {stored.source === "human" ? "Supervisor-corrected" : "Machine"}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              English
            </p>
            <p className="whitespace-pre-wrap rounded-sm border bg-muted/30 p-3 text-sm">
              {text || "—"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Español
            </p>
            {spanish}
          </div>
        </div>

        {actions}
      </CardContent>
    </Card>
  );
}
