/**
 * Polaris — the system-wide assistant panel.
 *
 * The panel is deliberately thin: it renders what the server returned and
 * nothing more. All retrieval and permission logic lives server-side in
 * `assistant-chat.server.ts` / `assistant-tools.server.ts`, running under the
 * signed-in user's own database client, so the UI can never widen access.
 * Any write the assistant suggests appears here as a compact confirm card in
 * the conversation that the user must approve before it executes.
 * Attachments follow the same rule: the type and size checks here are a
 * courtesy, and the server re-runs both against the real bytes.
 */
import { useServerFn } from "@tanstack/react-start";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowUp,
  ChevronRight,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AI_CREDITS_USED_EVENT } from "@/components/ai-credits-chip";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { PolarisMark } from "@/components/polaris-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  type AttachmentMeta,
  attachmentKind,
  attachmentRejection,
  formatBytes,
} from "@/lib/assistant-attachments";
import {
  askAssistant,
  confirmAssistantAction,
  deleteAssistantConversation,
  getAssistantConversation,
  listAssistantConversations,
} from "@/lib/assistant.functions";
import { cn } from "@/lib/utils";

const OPEN_POLARIS_EVENT = "recovery-hub:open-polaris";

type OpenPolarisEvent = CustomEvent<{ trigger: HTMLElement | null }>;

function requestPolarisOpen(trigger: HTMLElement | null) {
  window.dispatchEvent(new CustomEvent(OPEN_POLARIS_EVENT, { detail: { trigger } }));
}

type Step = {
  op: string;
  entity?: string;
  summary: string;
  preview: Array<{ label: string; value: string }>;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: AttachmentMeta[];
  /** Text revealed so far while streaming; undefined once fully shown. */
  streamed?: number;
  /** Set on a reply while it streams, so the reveal finds it by id. */
  streamId?: string;
  plan?: Step[] | null;
  navigate?: { path: string; label: string } | null;
  done?: boolean;
  results?: Array<{ ok: boolean; message: string }>;
};

const SUGGESTIONS = [
  "What's overdue on my plate?",
  "How does the pipeline look right now?",
  "Which compliance certificates expire in the next 30 days?",
  "Summarize everything on job GS-",
];

/** Human label for the current page, given to the model as context. */
function pageLabel(pathname: string) {
  const clean = pathname.replace(/^\//, "");
  if (!clean) return "the dashboard";
  return `the ${clean.split("/").join(" › ")} page`;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/** A file being carried by a drag or a paste, rather than by a picker. */
function hasFiles(e: { dataTransfer: DataTransfer | null }) {
  return Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files"));
}

function AttachmentChip({
  name,
  mime,
  size,
  onRemove,
}: {
  name: string;
  mime: string;
  size: number;
  onRemove?: () => void;
}) {
  const Icon = mime.startsWith("image/") ? ImageIcon : FileText;
  return (
    <span className="flex max-w-[15rem] items-center gap-1.5 rounded-lg border bg-muted/50 py-1 pl-2 pr-1 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(size)}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </span>
  );
}

export function AssistantPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const { fullName } = useAppContext();
  const firstName = (fullName ?? "").trim().split(/\s+/)[0] || "there";

  const ask = useServerFn(askAssistant);
  const confirm = useServerFn(confirmAssistantAction);
  const listConvos = useServerFn(listAssistantConversations);
  const getConvo = useServerFn(getAssistantConversation);
  const removeConvo = useServerFn(deleteAssistantConversation);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; title: string; updated_at: string }>>(
    [],
  );
  const [showHistory, setShowHistory] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => taRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    listConvos()
      .then((rows) => setHistory(rows as typeof history))
      .catch(() => undefined);
  }, [open, listConvos]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  // Auto-grow the composer.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input, open]);

  /**
   * Reveal an assistant reply progressively so it reads as it arrives.
   *
   * The reply is found by its streamId, never by a position worked out inside
   * a setMessages updater: React may run that updater later, and the position
   * was then still 0, so the reveal filled the user's first question while the
   * new reply stayed at 0 characters — Polaris answered and showed nothing
   * (11 Nov). An empty reply is shown in full at once.
   */
  function stream(id: string, text: string) {
    const total = text.length;
    let shown = 0;
    const tick = () => {
      shown = Math.min(total, shown + Math.max(2, Math.round(total / 90)));
      const done = shown >= total;
      setMessages((m) =>
        m.map((msg) =>
          msg.streamId === id
            ? { ...msg, streamed: done ? undefined : shown, streamId: done ? undefined : id }
            : msg,
        ),
      );
      if (!done) setTimeout(tick, 16);
    };
    tick();
  }

  /**
   * The same rules the server enforces, applied early so the user is told
   * before a 10 MB upload rather than after it.
   */
  function addFiles(incoming: FileList | File[] | null) {
    const list = Array.from(incoming ?? []);
    if (list.length === 0) return;
    // Built outside the state updater: an updater can run twice, and a toast
    // shown twice reads as two separate rejections.
    const next = [...files];
    for (const file of list) {
      if (next.length >= MAX_ATTACHMENTS) {
        toast.error(`Polaris takes up to ${MAX_ATTACHMENTS} files at a time.`);
        break;
      }
      const rejection = attachmentRejection(file);
      if (rejection) {
        toast.error(rejection);
        continue;
      }
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      next.push(file);
    }
    setFiles(next);
  }

  async function send(text: string) {
    const question = text.trim();
    const attached = files;
    if ((!question && attached.length === 0) || busy) return;
    setInput("");
    setFiles([]);
    setMessages((m) => [
      ...m,
      {
        role: "user",
        content: question,
        attachments: attached.map((f) => ({
          name: f.name,
          mime: f.type,
          kind: attachmentKind(f.type, f.name) ?? "text",
          size_bytes: f.size,
        })),
      },
    ]);
    setBusy(true);
    try {
      const encoded = await Promise.all(
        attached.map(async (f) => ({
          name: f.name,
          mime: f.type,
          data_base64: await toBase64(f),
        })),
      );
      const res = await ask({
        data: {
          question,
          conversationId,
          pageContext: pageLabel(pathname),
          ...(encoded.length ? { attachments: encoded } : {}),
        },
      });
      setConversationId(res.conversationId);
      const streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const reply = typeof res.reply === "string" ? res.reply : "";
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: reply,
          streamed: 0,
          streamId,
          plan: (res.plan as Step[] | undefined) ?? null,
          navigate: res.navigate ?? null,
        },
      ]);
      stream(streamId, reply);
      // The server charged this turn before answering: refresh the credits chip.
      window.dispatchEvent(new Event(AI_CREDITS_USED_EVENT));
      listConvos()
        .then((rows) => setHistory(rows as typeof history))
        .catch(() => undefined);
    } catch (err) {
      const message = (err as Error).message || "Polaris could not answer.";
      setMessages((m) => [...m, { role: "assistant", content: message }]);
      toast.error(message);
      // Hand the files back rather than making them find them again.
      if (attached.length) setFiles(attached);
    } finally {
      setBusy(false);
    }
  }

  async function runPlan(index: number, plan: Step[]) {
    setConfirming(true);
    try {
      const res = (await confirm({ data: { plan } as never })) as {
        ok: boolean;
        path?: string;
        results: Array<{ ok: boolean; message: string }>;
      };
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) toast.error(failed.map((r) => r.message).join(" · "));
      else toast.success(res.results.map((r) => r.message).join(" · "));
      setMessages((m) =>
        m.map((msg, i) =>
          i === index ? { ...msg, done: res.ok, plan: null, results: res.results } : msg,
        ),
      );
      if (res.ok && res.path) navigate({ to: res.path as never, search: {} as never });
    } catch (err) {
      toast.error((err as Error).message || "Could not complete that action.");
    } finally {
      setConfirming(false);
    }
  }

  async function openConversation(id: string) {
    setShowHistory(false);
    setConversationId(id);
    const rows = (await getConvo({ data: { conversationId: id } })) as Array<{
      role: string;
      content: string;
      meta: {
        plan?: Step[] | null;
        navigate?: { path: string; label: string } | null;
        attachments?: AttachmentMeta[];
      } | null;
    }>;
    setMessages(
      rows.map((r) => ({
        role: r.role === "assistant" ? "assistant" : "user",
        content: r.content,
        attachments: r.meta?.attachments ?? undefined,
        plan: r.meta?.plan ?? null,
        navigate: r.meta?.navigate ?? null,
      })),
    );
  }

  function newConversation() {
    setConversationId(null);
    setMessages([]);
    setFiles([]);
    setShowHistory(false);
  }

  return (
    <>
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby="polaris-panel-title"
        aria-hidden={!open}
        className={cn(
          "fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] z-50 flex h-[72svh] max-h-[36rem] min-h-0 flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl",
          "md:inset-x-auto md:bottom-4 md:right-4 md:h-[min(36rem,calc(100svh-2rem))] md:max-h-none md:w-[min(25rem,calc(100vw-2rem))]",
          !open && "hidden",
        )}
        // Only file drags are intercepted, and only inside the panel — a drag
        // aimed at the page keeps its default behaviour.
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/80 text-sm font-medium">
            Drop to attach to Polaris
          </div>
        )}
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5 sm:px-4">
          <PolarisMark className="size-5" />
          <h2 id="polaris-panel-title" className="flex-1 text-[15px] font-semibold tracking-tight">
            Polaris
          </h2>
          <Button variant="ghost" size="sm" onClick={newConversation} className="gap-1">
            <Plus className="size-4" /> New
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowHistory((v) => !v)}
            aria-pressed={showHistory}
          >
            History
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label="Close Polaris"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </header>

        {showHistory ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 p-3">
              {history.length === 0 && (
                <p className="p-3 text-sm text-muted-foreground">No past conversations yet.</p>
              )}
              {history.map((h) => (
                <div key={h.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openConversation(h.id)}
                    className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
                  >
                    <span className="line-clamp-1">{h.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(h.updated_at).toLocaleString("en-US")}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete conversation"
                    onClick={async () => {
                      await removeConvo({ data: { conversationId: h.id } });
                      setHistory((rows) => rows.filter((r) => r.id !== h.id));
                      if (conversationId === h.id) newConversation();
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="w-full space-y-5 px-4 py-4">
              {messages.length === 0 && (
                <div className="space-y-4 pt-2">
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <PolarisMark className="size-6" />
                      <h2 className="text-xl font-semibold tracking-tight">Hello, {firstName}</h2>
                    </div>
                    <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      Gold Star AI
                    </p>
                  </div>
                  <p className="text-[14px] leading-7 text-muted-foreground">
                    Ask about any record you have access to: jobs, accounts, pipeline, chase,
                    compliance, billing. I only ever see what your own permissions allow, and any
                    change I suggest waits for your confirmation.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => send(s)}
                        className="rounded-full border px-3.5 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((m, i) => (
                <div key={i} className={cn(m.role === "user" && "flex justify-end")}>
                  {m.role === "user" ? (
                    <div className="flex max-w-[85%] flex-col items-end gap-1.5">
                      {m.attachments && m.attachments.length > 0 && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {m.attachments.map((a, ai) => (
                            <AttachmentChip
                              key={ai}
                              name={a.name}
                              mime={a.mime}
                              size={a.size_bytes}
                            />
                          ))}
                        </div>
                      )}
                      {m.content && (
                        <div className="whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-[14px] leading-6">
                          {m.content}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <AssistantMarkdown
                        content={
                          m.streamed === undefined ? m.content : m.content.slice(0, m.streamed)
                        }
                      />

                      {m.plan && m.plan.length > 0 && (
                        <div className="rounded-xl border bg-card p-4 shadow-sm">
                          <div className="flex items-center gap-2">
                            <PolarisMark className="size-4" />
                            <span className="text-sm font-medium">
                              {m.plan.length === 1
                                ? m.plan[0]!.summary
                                : `${m.plan.length} changes to confirm`}
                            </span>
                          </div>
                          <ol className="mt-3 space-y-3">
                            {m.plan.map((step, si) => (
                              <li key={si} className="border-l-2 border-border pl-3">
                                {m.plan!.length > 1 && (
                                  <p className="text-xs font-medium">
                                    {si + 1}. {step.summary}
                                  </p>
                                )}
                                <dl className="mt-1 space-y-1 text-xs">
                                  {step.preview.map((row) => (
                                    <div key={row.label} className="flex gap-2">
                                      <dt className="w-20 shrink-0 text-muted-foreground">
                                        {row.label}
                                      </dt>
                                      <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                                        {row.value}
                                      </dd>
                                    </div>
                                  ))}
                                </dl>
                              </li>
                            ))}
                          </ol>
                          {writesDisabled ? (
                            <p className="mt-3 text-xs text-muted-foreground">{reason}</p>
                          ) : (
                            <div className="mt-4 flex gap-2">
                              <Button
                                size="sm"
                                disabled={confirming}
                                onClick={() => runPlan(i, m.plan as Step[])}
                              >
                                {confirming && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                                {m.plan.length > 1 ? `Confirm all ${m.plan.length}` : "Confirm"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setMessages((prev) =>
                                    prev.map((msg, idx) =>
                                      idx === i ? { ...msg, plan: null } : msg,
                                    ),
                                  )
                                }
                              >
                                Cancel
                              </Button>
                            </div>
                          )}
                        </div>
                      )}

                      {m.results && (
                        <ul className="space-y-1 text-xs">
                          {m.results.map((r, ri) => (
                            <li
                              key={ri}
                              className={r.ok ? "text-muted-foreground" : "text-destructive"}
                            >
                              {r.ok ? "✓" : "✕"} {r.message}
                            </li>
                          ))}
                        </ul>
                      )}

                      {m.done && <Badge variant="secondary">Done · via Polaris</Badge>}

                      {m.navigate && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          onClick={() => {
                            onOpenChange(false);
                            navigate({ to: m.navigate!.path as never, search: {} as never });
                          }}
                        >
                          {m.navigate.label} <ChevronRight className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {busy && (
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <PolarisMark className="size-4 animate-pulse" />
                  <span className="animate-pulse">Thinking…</span>
                </div>
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>
        )}

        <div className="shrink-0 border-t bg-background px-3 py-3 sm:px-4">
          <div className="w-full">
            <div className="relative rounded-2xl border bg-card shadow-sm transition focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/20">
              {files.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                  {files.map((f, fi) => (
                    <AttachmentChip
                      key={`${f.name}-${fi}`}
                      name={f.name}
                      mime={f.type}
                      size={f.size}
                      onRemove={() => setFiles((prev) => prev.filter((_, i) => i !== fi))}
                    />
                  ))}
                </div>
              )}
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  if (!e.clipboardData?.files?.length) return;
                  e.preventDefault();
                  addFiles(e.clipboardData.files);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                placeholder="Ask Polaris anything, or say what you want done…"
                className="max-h-[200px] w-full resize-none bg-transparent px-4 py-3 pr-20 text-[14px] leading-6 outline-none placeholder:text-muted-foreground"
              />
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Attach a file"
                disabled={busy || files.length >= MAX_ATTACHMENTS}
                onClick={() => fileRef.current?.click()}
                className="absolute bottom-2 right-11 size-8 rounded-full text-muted-foreground"
              >
                <Paperclip className="size-4" />
              </Button>
              <Button
                size="icon"
                aria-label="Send"
                disabled={busy || (!input.trim() && files.length === 0)}
                onClick={() => send(input)}
                className="absolute bottom-2 right-2 size-8 rounded-full"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </div>
            <p className="mt-2 hidden text-center text-[11px] text-muted-foreground sm:block">
              Polaris only sees what your permissions allow. Attach photos, PDFs or CSVs. They stay
              private to you. Enter to send, Shift+Enter for a new line.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

/** Polaris in the top bar, on the right: the sparkles icon and its name.
 * Desktop only; phones keep the floating button. */
export function AssistantHeaderButton() {
  return (
    <button
      type="button"
      onClick={(event) => requestPolarisOpen(event.currentTarget)}
      aria-label="Open Polaris"
      title="Polaris"
      className="hidden h-8 shrink-0 items-center gap-1 rounded-md px-2 transition hover:bg-accent md:inline-flex"
    >
      <Sparkles className="size-5 text-[var(--brand-gold-text)]" aria-hidden />
      <span className="notranslate text-[11px] font-medium text-foreground" translate="no">
        Polaris
      </span>
    </button>
  );
}

/** One app-level host owns the conversation, even while the panel is closed. */
export function AssistantPanelHost() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const openPanel = (event: Event) => {
      triggerRef.current = (event as OpenPolarisEvent).detail?.trigger ?? null;
      setOpen(true);
    };
    window.addEventListener(OPEN_POLARIS_EVENT, openPanel);
    return () => window.removeEventListener(OPEN_POLARIS_EVENT, openPanel);
  }, []);

  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (next) return;
    requestAnimationFrame(() => {
      const target = triggerRef.current;
      if (target?.isConnected) target.focus();
      else mobileTriggerRef.current?.focus();
    });
  }, []);

  return (
    <>
      <button
        ref={mobileTriggerRef}
        type="button"
        onClick={(event) => requestPolarisOpen(event.currentTarget)}
        aria-label="Open Polaris"
        title="Polaris"
        data-polaris-fab
        className={cn(
          "fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] right-3 z-40 grid size-12 place-items-center rounded-full border bg-background shadow-lg transition hover:bg-accent md:hidden",
          open && "hidden",
        )}
      >
        <PolarisMark className="size-5" />
      </button>
      <AssistantPanel open={open} onOpenChange={changeOpen} />
    </>
  );
}
