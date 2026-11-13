import type * as React from "react";
import { useState } from "react";
import { Files, Folder, FolderPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DocumentFolder } from "@/lib/documents";

/**
 * David, on the call: "you have it in folders, but … I can't even create new
 * documents over here. It's not letting me create new documents, new folders."
 *
 * The rail and the name box used to live inside documents-panel.tsx, which is
 * only ever mounted on a job, an account or a prospect record — so the whole
 * folder feature was invisible from the Documents page in the sidebar, which
 * is where he was looking. They are lifted out here, unchanged, so the page
 * and the record panel are literally the same rail rather than two that drift.
 *
 * Documents and photos file into different tables, so this stays its own rail
 * rather than a shared one — the photo rail's shape, none of its queries.
 */
export function DocumentFolderRail({
  nodes,
  counts,
  rootCount,
  active,
  disabled,
  onSelect,
  onDropDocument,
  onNew,
  onRename,
  onDelete,
  className,
  variant = "list",
}: {
  nodes: (DocumentFolder & { depth: number })[];
  counts: Record<string, number>;
  rootCount: number;
  active: string | null;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onDropDocument: (folderId: string | null, documentId: string) => void;
  onNew: (parent: string | null) => void;
  onRename: (folder: DocumentFolder) => void;
  onDelete: (folder: DocumentFolder) => void;
  className?: string;
  /**
   * `tiles` draws the folders as a wrapping grid of icons instead of a column
   * of text. David, 16 Sep: the documents screen was "one long downward list",
   * and the folder rail was half of that length. Same folders, same counts,
   * same drag target and same actions menu — it is the shape that changes.
   */
  variant?: "list" | "tiles";
}) {
  const [dragOver, setDragOver] = useState<string | "root" | null>(null);

  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(target ?? "root");
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const id = e.dataTransfer.getData("text/document-id");
      if (id) onDropDocument(target, id);
    },
  });

  if (variant === "tiles") {
    return (
      <div className={cn("space-y-2", className)}>
        <div className="flex flex-wrap gap-2">
          <FolderTile
            {...dropProps(null)}
            label="All documents"
            count={rootCount}
            active={active === null}
            over={dragOver === "root"}
            icon={<Files className="size-5" />}
            onClick={() => onSelect(null)}
          />
          {nodes.map((n) => (
            <FolderTile
              key={n.id}
              {...dropProps(n.id)}
              label={n.name}
              count={counts[n.id] ?? 0}
              active={active === n.id}
              over={dragOver === n.id}
              icon={<Folder className="size-5" />}
              onClick={() => onSelect(n.id)}
              menu={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute right-0.5 top-0.5 size-6 opacity-0 group-hover:opacity-100"
                      aria-label={`Actions for ${n.name}`}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={disabled} onClick={() => onNew(n.id)}>
                      <FolderPlus className="mr-2 size-4" />
                      New subfolder
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={disabled} onClick={() => onRename(n)}>
                      <Pencil className="mr-2 size-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={disabled} onClick={() => onDelete(n)}>
                      <Trash2 className="mr-2 size-4" />
                      Delete folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onNew(active)}
            className="flex size-[4.5rem] flex-col items-center justify-center gap-1 rounded-md border border-dashed text-[11px] text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
          >
            <FolderPlus className="size-5" />
            New
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("w-44 shrink-0 space-y-0.5", className)}>
      <button
        {...dropProps(null)}
        onClick={() => onSelect(null)}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
          active === null ? "bg-muted font-medium" : "hover:bg-muted/60",
          dragOver === "root" && "ring-1 ring-primary",
        )}
      >
        <Files className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">All documents</span>
        <span className="tabular-nums text-xs text-muted-foreground">{rootCount}</span>
      </button>

      {nodes.map((n) => (
        <div
          key={n.id}
          {...dropProps(n.id)}
          className={cn(
            "group flex items-center rounded-sm pr-0.5",
            active === n.id ? "bg-muted" : "hover:bg-muted/60",
            dragOver === n.id && "ring-1 ring-primary",
          )}
          style={{ paddingLeft: `${n.depth * 10}px` }}
        >
          <button
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
            onClick={() => onSelect(n.id)}
          >
            <Folder className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">{n.name}</span>
            <span className="tabular-nums text-xs text-muted-foreground">{counts[n.id] ?? 0}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 opacity-0 group-hover:opacity-100"
                aria-label={`Actions for ${n.name}`}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={disabled} onClick={() => onNew(n.id)}>
                <FolderPlus className="mr-2 size-4" />
                New subfolder
              </DropdownMenuItem>
              <DropdownMenuItem disabled={disabled} onClick={() => onRename(n)}>
                <Pencil className="mr-2 size-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={disabled} onClick={() => onDelete(n)}>
                <Trash2 className="mr-2 size-4" />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}

      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-full justify-start px-2 text-xs"
        disabled={disabled}
        onClick={() => onNew(active)}
      >
        <FolderPlus className="mr-1.5 size-3.5" />
        New folder
      </Button>
    </div>
  );
}

/** What a folder is being called, for both "New folder" and "Rename". */
export type FolderDialogState =
  { mode: "new"; parent: string | null } | { mode: "rename"; folder: DocumentFolder };

export function DocumentFolderDialog({
  state,
  name,
  onNameChange,
  onCancel,
  onSubmit,
  disabled,
}: {
  state: FolderDialogState | null;
  name: string;
  onNameChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** Writes off, or a save already in flight. */
  disabled: boolean;
}) {
  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{state?.mode === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          placeholder="Carrier correspondence"
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={disabled || !name.trim()} onClick={onSubmit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One folder as an icon tile: the name, how many documents are filed in it, and
 * the same actions menu the list row carries. Also a drop target, so dragging a
 * document onto a tile files it exactly as dropping it on a row did.
 */
function FolderTile({
  label,
  count,
  active,
  over,
  icon,
  onClick,
  menu,
  ...drop
}: {
  label: string;
  count: number;
  active: boolean;
  over: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  menu?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...drop}
      className={cn(
        "group relative size-[4.5rem] rounded-md border",
        active ? "border-primary bg-muted" : "hover:bg-muted/60",
        over && "ring-1 ring-primary",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={label}
        className="flex size-full flex-col items-center justify-center gap-1 px-1 text-center"
      >
        <span className="text-muted-foreground">{icon}</span>
        <span className="line-clamp-2 w-full break-words text-[11px] leading-tight">{label}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
      </button>
      {menu}
    </div>
  );
}
