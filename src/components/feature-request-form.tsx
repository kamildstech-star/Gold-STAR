// Submit dialog for the internal suggestion board. Screenshots matter more
// than the words here, so the description field accepts a pasted image
// directly (Ctrl/Cmd+V), plus drag-and-drop and normal file picking.

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { ACCEPTED_TYPES, isImage, uploadAttachment } from "@/lib/feature-requests";
import { cn } from "@/lib/utils";

export type FrCategory = { key: string; label: string };

/** Categories come from the managed option list so admins can edit them. */
export function useFrCategories() {
  return useQuery({
    queryKey: ["feature-request-categories"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<FrCategory[]> => {
      const { data: list, error: listError } = await supabase
        .from("option_lists")
        .select("id")
        .eq("key", "feature_request_category")
        .maybeSingle();
      if (listError) throw listError;
      if (!list) return [];
      const { data, error } = await supabase
        .from("option_list_values")
        .select("key, label, sort_order, active")
        .eq("list_id", list.id)
        .eq("active", true)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []).map((v) => ({ key: v.key, label: v.label }));
    },
  });
}

export function categoryLabel(categories: FrCategory[], key: string): string {
  return categories.find((c) => c.key === key)?.label ?? key.replace(/_/g, " ");
}

type Pending = { id: string; file: File; previewUrl: string | null };

export function SuggestFeatureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { userId } = useAppContext();
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const qc = useQueryClient();
  const categories = useFrCategories();

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [category, setCategory] = React.useState<string>("");
  const [files, setFiles] = React.useState<Pending[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const descRef = React.useRef<HTMLTextAreaElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!category && categories.data && categories.data.length > 0) {
      setCategory(categories.data[0]!.key);
    }
  }, [categories.data, category]);

  const reset = () => {
    files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    setTitle("");
    setDescription("");
    setFiles([]);
  };

  const addFiles = React.useCallback((incoming: File[], inlineNote = false) => {
    const accepted = incoming.filter((f) => isImage(f.type) || f.type === "application/pdf");
    if (accepted.length === 0) return;
    setFiles((prev) => {
      const next = [
        ...prev,
        ...accepted.map((file) => ({
          id: crypto.randomUUID(),
          file,
          previewUrl: isImage(file.type) ? URL.createObjectURL(file) : null,
        })),
      ];
      if (inlineNote) {
        setDescription((d) => {
          const marker = `[Screenshot ${next.length}]`;
          return d.length === 0 ? `${marker}\n` : `${d.replace(/\s*$/, "")}\n${marker}\n`;
        });
      }
      return next;
    });
  }, []);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const pasted = items
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (pasted.length === 0) return;
    e.preventDefault();
    addFiles(pasted, true);
    toast.success(pasted.length === 1 ? "Screenshot attached" : `${pasted.length} files attached`);
  };

  const removeFile = (id: string) =>
    setFiles((prev) => {
      const hit = prev.find((f) => f.id === id);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((f) => f.id !== id);
    });

  const submit = useMutation({
    mutationKey: ["feature-requests", "create"],
    mutationFn: async () => {
      if (!userId) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("feature_requests")
        .insert({
          title: title.trim(),
          description: description.trim(),
          category: category || "other",
          submitted_by: userId,
        })
        .select("id")
        .single();
      if (error) throw error;

      if (files.length > 0) {
        const rows = [];
        for (const f of files) {
          rows.push(await uploadAttachment(data.id, userId, f.file));
        }
        const { error: attachError } = await supabase
          .from("feature_request_attachments")
          .insert(rows);
        if (attachError) throw attachError;
      }
      return data.id;
    },
    onSuccess: () => {
      toast.success("Request submitted");
      qc.invalidateQueries({ queryKey: ["feature-requests"] });
      reset();
      onOpenChange(false);
    },
    onError: (error) => toastDbError(error, { action: "submit request" }),
  });

  const canSubmit = title.trim().length > 2 && !submit.isPending && !writesDisabled;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Suggest a feature</DialogTitle>
          <DialogDescription>
            Ideas and problems from the field. Everyone at Gold Star can see the board, so check
            whether it has already been raised before adding a new one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="fr-title">What is it?</Label>
            <Input
              id="fr-title"
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary — e.g. Photo upload retries lose the job number"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fr-category">Area</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="fr-category" className="h-8">
                <SelectValue placeholder="Choose an area" />
              </SelectTrigger>
              <SelectContent>
                {(categories.data ?? []).map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fr-description">Detail</Label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(Array.from(e.dataTransfer.files));
              }}
              className={cn(
                "rounded-md border",
                dragging ? "border-primary" : "border-transparent",
              )}
            >
              <Textarea
                id="fr-description"
                ref={descRef}
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={onPaste}
                placeholder="What happens now, what should happen instead. Paste a screenshot straight into this box."
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Paste a screenshot here, drop files on this box, or attach below. Images and PDFs.
            </p>
          </div>

          {files.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {files.map((f, i) => (
                <div key={f.id} className="relative w-24">
                  <div className="grid h-20 w-24 place-items-center overflow-hidden rounded-md border bg-muted">
                    {f.previewUrl ? (
                      <img src={f.previewUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <span className="px-1 text-center text-[10px] text-muted-foreground">
                        PDF
                      </span>
                    )}
                  </div>
                  <div className="truncate pt-0.5 text-[10px] text-muted-foreground">
                    Screenshot {i + 1}
                  </div>
                  <button
                    type="button"
                    aria-label="Remove attachment"
                    onClick={() => removeFile(f.id)}
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border bg-background"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
            >
              <Paperclip className="mr-1.5 size-3.5" />
              Attach files
            </Button>
          </div>

          {writesDisabled && (
            <p className="text-[12px] text-muted-foreground">{reason ?? "Writes are disabled."}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => submit.mutate()}>
            {submit.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
