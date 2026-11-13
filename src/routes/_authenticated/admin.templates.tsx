import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, FileText, History, Plus, RotateCcw } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABEL, type DocumentType } from "@/lib/documents";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MERGE_FIELDS,
  MERGE_FIELD_GROUPS,
  STARTER_TEMPLATES,
  createTemplate,
  currentVersion,
  listTemplates,
  listVersions,
  publishVersion,
  tokensIn,
  type DocumentTemplate,
} from "@/lib/document-templates";

export const Route = createFileRoute("/_authenticated/admin/templates")({
  head: () => ({
    meta: [
      { title: "Contract templates — Recovery Hub" },
      {
        name: "description",
        content:
          "Versioned, immutable contract and work authorization templates with merge fields.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TemplatesPage,
});

function TemplatesPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const templatesQ = useQuery({
    queryKey: ["document-templates", app.currentLocationId],
    queryFn: () => listTemplates(app.currentLocationId),
  });

  const templates = templatesQ.data ?? [];
  const selected = templates.find((t) => t.id === selectedId) ?? null;

  const seed = useMutation({
    mutationFn: async () => {
      for (const t of STARTER_TEMPLATES) {
        await createTemplate({
          name: t.name,
          docType: t.docType,
          locationId: app.currentLocationId,
          description: t.description,
          body: t.body,
          userId: app.userId!,
        });
      }
      return STARTER_TEMPLATES.length;
    },
    onSuccess: (n) => {
      toast.success(`${n} starter templates added — edit the wording before use`);
      void qc.invalidateQueries({ queryKey: ["document-templates"] });
    },
    onError: (e) => toastDbError(e, { action: "Add starter templates" }),
  });

  return (
    <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Templates</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setNewOpen(true)}
            disabled={app.writesDisabled}
          >
            <Plus className="size-4" />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {templatesQ.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : templates.length === 0 ? (
            <div className="space-y-2 p-3">
              <p className="text-xs text-muted-foreground">
                No templates yet. A template is the wording a work authorization, direction to pay
                or completion certificate is generated from. Every change publishes a new version;
                old versions stay readable so a signed contract always resolves to the exact text
                the customer saw.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => seed.mutate()}
                disabled={seed.isPending || app.writesDisabled}
              >
                {seed.isPending ? "Adding…" : "Add starter set"}
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-muted/60 ${
                      selectedId === t.id ? "bg-muted" : ""
                    }`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{t.name}</span>
                      <Badge variant="outline" className="shrink-0">
                        v{t.current_version}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {DOCUMENT_TYPE_LABEL[t.doc_type]}
                      {t.location_id ? "" : " · all locations"}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <TemplateEditor key={selected.id} template={selected} />
      ) : (
        <Card>
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <FileText className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div>
              <div className="font-medium">Select a template</div>
              <p className="text-xs text-muted-foreground">
                Templates are versioned and append-only. Editing publishes a new version rather than
                overwriting the old one.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <NewTemplateDialog open={newOpen} onOpenChange={setNewOpen} onCreated={setSelectedId} />
    </div>
  );
}

function TemplateEditor({ template }: { template: DocumentTemplate }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diffId, setDiffId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  /** Tokens land where the author's cursor is, not at the end of the document. */
  const insertToken = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const currentQ = useQuery({
    queryKey: ["document-template-current", template.id],
    queryFn: () => currentVersion(template.id),
  });
  const versionsQ = useQuery({
    queryKey: ["document-template-versions", template.id],
    queryFn: () => listVersions(template.id),
    enabled: historyOpen,
  });

  useEffect(() => {
    if (currentQ.data) setBody(currentQ.data.body);
  }, [currentQ.data]);

  const dirty = (currentQ.data?.body ?? "") !== body;
  const used = useMemo(() => tokensIn(body), [body]);
  const known = new Set<string>(MERGE_FIELDS.map((f) => f.key as string));
  const unknown = used.filter((t) => !known.has(t));

  const publish = useMutation({
    mutationFn: () => publishVersion(template.id, body, note.trim() || null, app.userId!),
    onSuccess: (v) => {
      toast.success(`Published version ${v.version}`);
      setNote("");
      void qc.invalidateQueries({ queryKey: ["document-template-current", template.id] });
      void qc.invalidateQueries({ queryKey: ["document-template-versions", template.id] });
      void qc.invalidateQueries({ queryKey: ["document-templates"] });
    },
    onError: (e) => toastDbError(e, { action: "Publish template version" }),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">{template.name}</CardTitle>
          <div className="text-xs text-muted-foreground">
            {DOCUMENT_TYPE_LABEL[template.doc_type]} · current version {template.current_version}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
          <History className="mr-1.5 size-4" />
          History
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          ref={bodyRef}
          rows={18}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap gap-1.5">
          <span className="self-center text-[11px] text-muted-foreground">
            Insert template field:
          </span>
          {MERGE_FIELD_GROUPS.map((g) => (
            <DropdownMenu key={g.group}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-7 text-[11px]">
                  {g.group}
                  <ChevronDown className="ml-1 size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                {g.fields.map((f) => (
                  <DropdownMenuItem key={f.key} onSelect={() => insertToken(f.key)}>
                    <span className="flex-1">{f.label}</span>
                    <span className="ml-3 font-mono text-[10px] text-muted-foreground">
                      {`{{${f.key}}}`}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ))}
        </div>
        {unknown.length > 0 && (
          <p className="rounded-sm bg-destructive/10 px-2 py-1 text-xs text-destructive">
            Unknown merge fields: {unknown.join(", ")}. These will print literally on the contract.
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2 border-t pt-3">
          <div className="flex-1 min-w-[200px]">
            <Label className="text-xs">Change note</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What changed and why"
            />
          </div>
          <Button
            onClick={() => publish.mutate()}
            disabled={!dirty || publish.isPending || app.writesDisabled}
          >
            {publish.isPending ? "Publishing…" : "Publish new version"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Publishing never changes documents already generated — they stay bound to the version they
          were produced from.
        </p>
      </CardContent>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Version history — {template.name}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {(versionsQ.data ?? []).map((v) => {
              const isCurrent = v.id === currentQ.data?.id;
              return (
                <div key={v.id} className="rounded-sm border p-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">
                      Version {v.version}
                      {isCurrent ? " · current" : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(v.created_at).toLocaleString("en-US")}
                    </span>
                  </div>
                  {v.change_note && (
                    <div className="text-xs text-muted-foreground">{v.change_note}</div>
                  )}
                  <div className="mt-1 flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px]"
                      onClick={() => setDiffId(diffId === v.id ? null : v.id)}
                    >
                      {diffId === v.id ? "Hide diff" : "Diff against current"}
                    </Button>
                    {!isCurrent && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px]"
                        disabled={app.writesDisabled}
                        onClick={() => {
                          setBody(v.body);
                          setNote(`Restored version ${v.version}`);
                          setHistoryOpen(false);
                          toast.message(
                            `Version ${v.version} loaded — publish to make it the current wording.`,
                          );
                        }}
                      >
                        <RotateCcw className="mr-1 size-3" />
                        Restore
                      </Button>
                    )}
                  </div>
                  {diffId === v.id ? (
                    <pre className="mt-1 max-h-56 overflow-auto rounded-sm bg-muted/40 p-2 text-[11px]">
                      {diffLines(v.body, currentQ.data?.body ?? "").map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.kind === "added"
                              ? "text-success"
                              : line.kind === "removed"
                                ? "text-destructive line-through"
                                : "text-muted-foreground"
                          }
                        >
                          {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                          {line.text}
                        </div>
                      ))}
                    </pre>
                  ) : (
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">
                      {v.body}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function NewTemplateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [docType, setDocType] = useState<DocumentType>("work_authorization");
  const [allLocations, setAllLocations] = useState(false);

  const create = useMutation({
    mutationFn: () => {
      if (!name.trim()) throw new Error("Give the template a name.");
      return createTemplate({
        name: name.trim(),
        docType,
        locationId: allLocations ? null : app.currentLocationId,
        description: null,
        body: `${name.trim().toUpperCase()}\n\nProperty: {{property.address}}\nCustomer: {{customer.name}}\nDate: {{today}}\n\n`,
        userId: app.userId!,
      });
    },
    onSuccess: (t) => {
      toast.success("Template created");
      setName("");
      onOpenChange(false);
      onCreated(t.id);
      void qc.invalidateQueries({ queryKey: ["document-templates"] });
    },
    onError: (e) => toastDbError(e, { action: "Create template" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Document type</Label>
            <Select value={docType} onValueChange={(v) => setDocType(v as DocumentType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOCUMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {DOCUMENT_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allLocations}
              onChange={(e) => setAllLocations(e.target.checked)}
            />
            Available to every location
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || app.writesDisabled}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/**
 * Line-level diff between an old version and the current wording. Small
 * documents, so a simple LCS is both exact and cheap — the point is that a
 * reviewer can see precisely which clause moved before restoring anything.
 */
function diffLines(oldBody: string, newBody: string): DiffLine[] {
  const a = oldBody.split("\n");
  const b = newBody.split("\n");
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ kind: "removed", text: a[i++] });
  while (j < n) out.push({ kind: "added", text: b[j++] });
  return out;
}
