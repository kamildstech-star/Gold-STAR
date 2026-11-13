/**
 * Polaris, scoped to one account.
 *
 * This is a surface, not a second assistant: it calls the same `askAssistant`
 * / `confirmAssistantAction` server functions the Polaris sheet uses, so
 * retrieval, RLS, the money rule and the confirm-before-write gate are the
 * ones already enforced server-side. The only thing added is page context
 * naming this account, so "summarise it" means this record.
 *
 * It is small until it is used. Mark: "and smaller." Idle, the card is one
 * header line, the input and the three quick asks — no transcript area and
 * no intro paragraph taking a column's height to say nothing. The bounded,
 * scrollable transcript opens above the input the moment a question is
 * sent, and closes again with the account.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sparkles, User } from "lucide-react";
import { toast } from "sonner";

import { AssistantMarkdown } from "@/components/assistant-markdown";
import { PolarisMark } from "@/components/polaris-mark";
import { useWritesDisabled } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { askAssistant, confirmAssistantAction } from "@/lib/assistant.functions";
import { cn } from "@/lib/utils";

type Step = {
  op: string;
  entity?: string;
  summary: string;
  preview: Array<{ label: string; value: string }>;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Wall-clock the message appeared, for the transcript header. */
  at?: string;
  plan?: Step[] | null;
  results?: Array<{ ok: boolean; message: string }>;
};

/** The three things a rep opens a deal to ask for. */
const QUICK_ACTIONS = [
  {
    label: "Summarize account",
    ask: "Summarize this account: where the deal stands, who we know there, and what happened lately.",
  },
  {
    label: "Draft follow-up email",
    ask: "Draft a follow-up email to the primary contact based on the latest account activity.",
  },
  {
    label: "Prepare for call",
    ask: "Prepare me for a call: what to open with, what is outstanding, and what to ask for.",
  },
] as const;

export function PolarisAccountPanel({
  accountId,
  accountName,
  className,
}: {
  accountId: string;
  accountName: string;
  className?: string;
}) {
  const ask = useServerFn(askAssistant);
  const confirm = useServerFn(confirmAssistantAction);
  const { disabled: writesDisabled, reason } = useWritesDisabled();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const stamp = useCallback(
    () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    [],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const accountGeneration = useRef(0);

  /** A different account is a different conversation. */
  useEffect(() => {
    accountGeneration.current += 1;
    setMessages([]);
    setConversationId(null);
    setInput("");
    setBusy(false);
  }, [accountId]);

  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, busy]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const generation = accountGeneration.current;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: question, at: stamp() }]);
    setBusy(true);
    try {
      const res = await ask({
        data: {
          question,
          conversationId,
          context: { entity: "account", id: accountId },
        },
      });
      if (generation !== accountGeneration.current) return;
      setConversationId(res.conversationId);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: res.reply,
          plan: (res.plan as Step[] | undefined) ?? null,
          at: stamp(),
        },
      ]);
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      const message = (err as Error).message || "Polaris could not answer.";
      setMessages((m) => [...m, { role: "assistant", content: message, at: stamp() }]);
      toast.error(message);
    } finally {
      if (generation === accountGeneration.current) setBusy(false);
    }
  }

  async function runPlan(index: number, plan: Step[]) {
    setConfirming(true);
    try {
      const res = (await confirm({ data: { plan } as never })) as {
        ok: boolean;
        results: Array<{ ok: boolean; message: string }>;
      };
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) toast.error(failed.map((r) => r.message).join(" · "));
      else toast.success(res.results.map((r) => r.message).join(" · "));
      setMessages((m) =>
        m.map((msg, i) => (i === index ? { ...msg, plan: null, results: res.results } : msg)),
      );
    } catch (err) {
      toast.error((err as Error).message || "Could not complete that action.");
    } finally {
      setConfirming(false);
    }
  }

  /** A conversation is in progress: show the transcript above the input. */
  const active = messages.length > 0 || busy;

  return (
    <section
      className={cn(
        /*
          AI content reads as AI: the panel is drawn in the AI tone (indigo,
          used for nothing else on the record), including the star. Mark's
          "the colors here in the pipeline aren't exciting" was partly this
          card being the same gold as the deal's own stage and CTA.
        */
        "flex min-h-0 flex-col overflow-hidden rounded-xl border border-ai/25 border-t-[3px] border-t-ai bg-card [--polaris-mark:var(--ai)]",
        active && "max-h-[min(28rem,80svh)]",
        className,
      )}
    >
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2 sm:px-4">
        <PolarisMark className="size-6 shrink-0" />
        <h2 className="text-[15px] font-bold leading-none tracking-tight">Polaris</h2>
        <span className="shrink-0 rounded-full bg-ai-soft px-2 py-0.5 text-[10px] font-semibold text-ai-text">
          AI Assistant
        </span>
        <p
          className="min-w-0 truncate text-[11.5px] text-muted-foreground"
          title="Ask about this account. Changes always wait for confirmation."
        >
          · Ask about this account · changes wait for confirmation
        </p>
      </header>

      {/*
        The transcript. Always in the tree so the live region exists before
        the first answer lands; it takes no room until there is one.
      */}
      <div
        aria-live="polite"
        className={cn(
          "min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4",
          !active && "hidden",
        )}
      >
        {messages.map((m, i) => (
          <div key={i} className={cn(m.role === "user" && "flex justify-end")}>
            {m.role === "user" ? (
              <div className="w-full max-w-[92%] rounded-lg bg-muted/70 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <User className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-[13.5px] font-semibold">You</span>
                  {m.at && (
                    <span className="ml-auto text-[12.5px] text-muted-foreground">{m.at}</span>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5">
                  {m.content}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-lg border border-ai/25 bg-ai-soft px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <PolarisMark className="size-4 shrink-0" />
                    <span className="text-[13.5px] font-semibold">Polaris</span>
                    {m.at && (
                      <span className="ml-auto text-[12.5px] text-muted-foreground">{m.at}</span>
                    )}
                  </div>
                  <div className="mt-1 text-[13px] leading-5">
                    <AssistantMarkdown content={m.content} />
                  </div>
                </div>

                {m.plan && m.plan.length > 0 && (
                  <div className="rounded-lg border bg-background p-3">
                    <div className="flex items-center gap-2">
                      <PolarisMark className="size-4" />
                      <span className="text-[13px] font-medium">
                        {m.plan.length === 1
                          ? m.plan[0]!.summary
                          : `${m.plan.length} changes to confirm`}
                      </span>
                    </div>
                    <ol className="mt-3 space-y-3">
                      {m.plan.map((step, si) => (
                        <li key={si} className="border-l-2 border-border pl-3">
                          {m.plan!.length > 1 && (
                            <p className="text-[12px] font-medium">
                              {si + 1}. {step.summary}
                            </p>
                          )}
                          <dl className="mt-1 space-y-1 text-[12px]">
                            {step.preview.map((row) => (
                              <div key={row.label} className="flex gap-2">
                                <dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
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
                      <p className="mt-3 text-[12px] text-muted-foreground">{reason}</p>
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
                              prev.map((msg, idx) => (idx === i ? { ...msg, plan: null } : msg)),
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
                  <ul className="space-y-1 text-[12px]">
                    {m.results.map((r, ri) => (
                      <li key={ri} className={r.ok ? "text-muted-foreground" : "text-destructive"}>
                        {r.ok ? "✓" : "✕"} {r.message}
                      </li>
                    ))}
                  </ul>
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

      <div className={cn("shrink-0 space-y-2 px-3 py-2.5 sm:px-4", active && "border-t")}>
        <div className="relative rounded-xl border bg-background transition focus-within:border-ai/50 focus-within:ring-2 focus-within:ring-ai/20">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={`Ask what happened at ${accountName}, who to call, or what is outstanding…`}
            className="min-h-11 max-h-24 w-full resize-none bg-transparent px-3 py-2.5 pr-24 text-[13px] leading-5 outline-none placeholder:text-muted-foreground sm:min-h-10 sm:py-2"
          />
          <Button
            aria-label="Send"
            disabled={busy || !input.trim()}
            onClick={() => send(input)}
            className="absolute bottom-1 right-1 h-9 gap-1.5 rounded-lg bg-ai px-3 text-[13px] font-semibold text-ai-fg hover:bg-ai/90 sm:h-8"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Send
          </Button>
        </div>

        <div className="flex flex-nowrap gap-1.5 overflow-x-auto pb-0.5">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              disabled={busy}
              onClick={() => send(a.ask)}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-ai/35 px-3 py-1.5 text-[11.5px] font-medium text-ai-text transition hover:bg-ai/10 disabled:opacity-50 sm:min-h-9"
            >
              <Sparkles className="size-3.5 shrink-0" />
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
