import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Images,
  LayoutTemplate,
  MoreVertical,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  applyFolderTemplate,
  buildTree,
  createFolder,
  deleteFolder,
  expandTemplate,
  flattenTree,
  foldersWithPhotos,
  parseTemplateValues,
  renameFolder,
  FOLDER_TEMPLATES,
  TEMPLATE_FOLDER_CAP,
  type FolderTemplate,
  type PhotoFolder,
} from "@/lib/photo-folders";

/** Shared by the rail's menu and its empty state, so the list cannot drift. */
function templateItems(busy: boolean, onPick: (t: FolderTemplate) => void) {
  return FOLDER_TEMPLATES.map((t) => (
    <DropdownMenuItem
      key={t.id}
      disabled={busy}
      onClick={() => onPick(t)}
      className="flex-col items-start gap-0.5"
    >
      <span>{t.name}</span>
      <span className="text-[11px] text-muted-foreground">{t.description}</span>
    </DropdownMenuItem>
  ));
}

/**
 * Folder rail for a project's photos. Drop targets accept a dragged photo or
 * the current multi-select, which is how 400 photos actually get filed.
 */
export function PhotoFolderRail({
  projectId,
  folders,
  counts,
  rootCount,
  activeFolderId,
  onSelect,
  onChanged,
  onDropPhotos,
  userId,
  disabled,
  canApplyTemplate = false,
  hideEmpty = false,
}: {
  projectId: string;
  folders: PhotoFolder[];
  counts: Record<string, number>;
  rootCount: number;
  activeFolderId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  onDropPhotos: (folderId: string | null) => void;
  userId: string | null;
  disabled: boolean;
  /** Admins only: applying a template is an office-wide convention. */
  canApplyTemplate?: boolean;
  /**
   * Show only folders that hold photos, ancestors included. Off by default:
   * the rail's other home is the album, which is where filing happens, and you
   * cannot file into a folder you cannot see.
   */
  hideEmpty?: boolean;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParent, setNewParent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState<string | "root" | null>(null);
  const [template, setTemplate] = useState<FolderTemplate | null>(null);
  /** Escape hatch out of `hideEmpty`, and where a fresh empty folder lands. */
  const [showEmpty, setShowEmpty] = useState(false);
  /*
   * On a phone the rail stacks above the grid, where a full folder tree pushes
   * every thumbnail off the screen. It collapses to a single row naming the
   * folder you are in, and closes again the moment you pick one.
   */
  const isMobile = useIsMobile();
  const [railOpen, setRailOpen] = useState(false);
  const collapsed = isMobile && !railOpen;

  // The folder being looked at counts as filled even when it is not: a rail
  // that drops the selection out from under you is worse than an empty row.
  // A room's folder always shows: it is where the next photo is about to be
  // filed, and the Rooms tab made it for exactly that.
  const filled = hideEmpty
    ? foldersWithPhotos(
        folders,
        activeFolderId ? { ...counts, [activeFolderId]: 1 } : counts,
        (f) => f.room_id != null,
      )
    : folders;
  const emptyCount = folders.length - filled.length;
  const shown = hideEmpty && !showEmpty ? filled : folders;
  const nodes = flattenTree(buildTree(shown));

  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(target ?? "root");
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      onDropPhotos(target);
    },
  });

  /** Templates that ask nothing apply straight away; the rest open the dialog. */
  const pickTemplate = (t: FolderTemplate) => {
    if (t.params?.length) setTemplate(t);
    else void applyTemplate(t, {});
  };

  const applyTemplate = async (t: FolderTemplate, answers: Record<string, string>) => {
    const plan = expandTemplate(t, answers);
    if (!plan.nodes.length) {
      toast.error("Nothing to create", {
        description: plan.omitted
          ? `The first branch alone is over the ${TEMPLATE_FOLDER_CAP}-folder limit.`
          : "Fill in what the template asks for.",
      });
      return;
    }
    setBusy(true);
    try {
      const n = await applyFolderTemplate(projectId, plan.nodes, userId);
      toast.success(
        n ? `${n} folder${n === 1 ? "" : "s"} created` : "Those folders were already there",
        {
          description: plan.omitted
            ? `${plan.omitted} more skipped — the ${TEMPLATE_FOLDER_CAP}-folder limit was reached.`
            : undefined,
        },
      );
      setTemplate(null);
      // A template makes empty folders by definition; hiding them would file
      // the whole thing straight out of sight.
      setShowEmpty(true);
      onChanged();
    } catch (e) {
      toast.error("Could not create folders", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const activeName =
    activeFolderId == null
      ? "All photos"
      : (folders.find((f) => f.id === activeFolderId)?.name ?? "Folder");
  const activeCount = activeFolderId == null ? rootCount : (counts[activeFolderId] ?? 0);

  const select = (id: string | null) => {
    setRailOpen(false);
    onSelect(id);
  };

  return (
    <div className="space-y-1">
      {isMobile && (
        <button
          type="button"
          aria-expanded={railOpen}
          onClick={() => setRailOpen((v) => !v)}
          className="flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-sm font-medium"
        >
          <Folder className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{activeName}</span>
          <span className="tabular-nums text-xs text-muted-foreground">{activeCount}</span>
          <ChevronDown
            className={cn("size-4 shrink-0 transition-transform", railOpen && "rotate-180")}
          />
        </button>
      )}
      {!collapsed && (
        <>
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Folders
            </span>
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-11 px-2 text-sm sm:h-6 sm:px-1.5 sm:text-xs"
                disabled={disabled}
                onClick={() => {
                  setNewParent(activeFolderId);
                  setNewOpen(true);
                }}
              >
                <FolderPlus className="mr-1 size-3.5" />
                New folder
              </Button>
              {canApplyTemplate && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Folder options"
                      className="size-11 sm:size-6"
                      disabled={disabled}
                    >
                      <MoreVertical className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={busy}
                      onClick={() => {
                        setNewParent(activeFolderId);
                        setNewOpen(true);
                      }}
                    >
                      <FolderPlus className="mr-2 size-4" />
                      New folder
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger disabled={busy}>
                        <LayoutTemplate className="mr-2 size-4" />
                        Templates
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-w-72">
                        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                          Merged in — folders you already have are left alone.
                        </DropdownMenuLabel>
                        {templateItems(busy, pickTemplate)}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </span>
          </div>

          <button
            {...dropProps(null)}
            onClick={() => select(null)}
            className={cn(
              "flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm sm:min-h-0",
              activeFolderId === null ? "bg-muted font-medium" : "hover:bg-muted/60",
              dragOver === "root" && "ring-1 ring-primary",
            )}
          >
            <Images className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate">All photos</span>
            <span className="tabular-nums text-xs text-muted-foreground">{rootCount}</span>
          </button>

          {shown.length === 0 ? (
            folders.length > 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                Nothing is filed into a folder yet — every folder on this job is empty. Select
                photos and drag them onto one to start.
              </p>
            ) : (
              <div className="space-y-2 px-2 py-2">
                <p className="text-[11px] text-muted-foreground">
                  No folders yet. Photos stay in All photos — that is deliberate, the shutter never
                  asks where to file. Add folders when you start assembling the claim package.
                </p>
                {canApplyTemplate && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-11 sm:h-7"
                        disabled={disabled || busy}
                      >
                        <LayoutTemplate className="mr-1.5 size-3.5" />
                        Start from a template
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-w-72">
                      {templateItems(busy, pickTemplate)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )
          ) : (
            <ul className="space-y-0.5">
              {nodes.map((n) => (
                <li key={n.id}>
                  <div
                    {...dropProps(n.id)}
                    className={cn(
                      "group flex items-center gap-1 rounded-sm pr-1",
                      activeFolderId === n.id ? "bg-muted" : "hover:bg-muted/60",
                      dragOver === n.id && "ring-1 ring-primary",
                    )}
                    style={{ paddingLeft: `${n.depth * 12}px` }}
                  >
                    <button
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm sm:min-h-0"
                      onClick={() => select(n.id)}
                    >
                      {n.depth > 0 ? (
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="flex-1 truncate">{n.name}</span>
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {counts[n.id] ?? 0}
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Folder actions"
                          className="size-11 sm:size-6 sm:opacity-0 sm:group-hover:opacity-100"
                          disabled={disabled}
                        >
                          <MoreVertical className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setNewParent(n.id);
                            setNewOpen(true);
                          }}
                        >
                          <FolderPlus className="mr-2 size-4" />
                          New subfolder
                        </DropdownMenuItem>
                        {n.room_id ? (
                          /* A room's folder follows the room list. Renaming it
                             here would be undone by the next room save while
                             it is empty, and deleting it would bring it
                             straight back — so both are done on the Rooms tab,
                             where the room itself lives. */
                          <DropdownMenuLabel className="max-w-56 text-[11px] font-normal text-muted-foreground">
                            This folder is a room on the Rooms tab. Rename or remove the room there.
                          </DropdownMenuLabel>
                        ) : (
                          <>
                            <DropdownMenuItem
                              onClick={async () => {
                                const name = window.prompt("Rename folder", n.name);
                                if (!name?.trim()) return;
                                await renameFolder(n.id, name);
                                onChanged();
                              }}
                            >
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={async () => {
                                if (
                                  !window.confirm(
                                    "Delete this folder? Photos inside it move back to the project root — nothing is deleted.",
                                  )
                                )
                                  return;
                                await deleteFolder(n.id);
                                if (activeFolderId === n.id) onSelect(null);
                                onChanged();
                              }}
                            >
                              <Trash2 className="mr-2 size-4" />
                              Delete folder
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {hideEmpty && emptyCount > 0 && (
            <button
              type="button"
              onClick={() => setShowEmpty((v) => !v)}
              className="min-h-11 w-full rounded-sm px-2 py-1 text-left text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground sm:min-h-0"
            >
              {showEmpty
                ? "Hide empty folders"
                : `Show ${emptyCount} empty folder${emptyCount === 1 ? "" : "s"}`}
            </button>
          )}
        </>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            className="h-11 text-base sm:h-8 sm:text-[13px]"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Pre-mitigation"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!newName.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await createFolder({
                    projectId,
                    name: newName,
                    parentFolderId: newParent,
                    userId,
                  });
                  // A folder is born empty, and one that vanishes the moment it
                  // is made reads as a failed save.
                  setShowEmpty(true);
                  setNewName("");
                  setNewOpen(false);
                  onChanged();
                } catch (e) {
                  toast.error("Could not create folder", {
                    description: e instanceof Error ? e.message : undefined,
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {template && (
        <TemplateDialog
          key={template.id}
          template={template}
          busy={busy}
          onCancel={() => setTemplate(null)}
          onApply={(answers) => void applyTemplate(template, answers)}
        />
      )}
    </div>
  );
}

/**
 * Renders whatever a template asks for from its param spec — no template knows
 * about this dialog and it knows about no template, which is what lets the set
 * move into a table later.
 */
function TemplateDialog({
  template,
  busy,
  onCancel,
  onApply,
}: {
  template: FolderTemplate;
  busy: boolean;
  onCancel: () => void;
  onApply: (answers: Record<string, string>) => void;
}) {
  const params = template.params ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(params.map((p) => [p.key, p.default ?? ""])),
  );

  const missing = params.some(
    (p) => p.required && !parseTemplateValues(p, answers[p.key] ?? "").length,
  );
  // Pure expansion, so the count and the sample are what will actually be made.
  const plan = expandTemplate(template, answers);
  const sample = plan.nodes
    .slice(0, 3)
    .map((n) => n.name)
    .join(", ");

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          <DialogDescription>{template.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {params.map((p, i) => (
            <div key={p.key} className="space-y-1">
              <Label htmlFor={`tpl-${p.key}`} className="text-xs">
                {p.label}
                {!p.required && <span className="ml-1 text-muted-foreground">(optional)</span>}
              </Label>
              <Input
                id={`tpl-${p.key}`}
                className="h-11 text-base sm:h-8 sm:text-[13px]"
                autoFocus={i === 0}
                inputMode={p.kind === "count" ? "numeric" : undefined}
                value={answers[p.key] ?? ""}
                placeholder={p.placeholder}
                onChange={(e) => setAnswers((a) => ({ ...a, [p.key]: e.target.value }))}
              />
              {p.help && <p className="text-[11px] text-muted-foreground">{p.help}</p>}
            </div>
          ))}

          <div className="rounded-sm border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
            {missing ? (
              <span>Fill in the required fields to see what this will create.</span>
            ) : (
              <span>
                {plan.total} folder{plan.total === 1 ? "" : "s"}
                {sample && ` — ${sample}${plan.nodes.length > 3 ? ", …" : ""}`}
              </span>
            )}
            {plan.omitted > 0 && (
              <span className="mt-1 block text-destructive">
                {plan.omitted} branch{plan.omitted === 1 ? "" : "es"} left out: the limit is{" "}
                {TEMPLATE_FOLDER_CAP} folders.
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={busy || missing || !plan.nodes.length} onClick={() => onApply(answers)}>
            Create folders
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
