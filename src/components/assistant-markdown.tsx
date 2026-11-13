/**
 * Markdown renderer for Polaris replies.
 *
 * Text-first styling: no bubbles, comfortable line-height, theme tokens only.
 * Code and table blocks carry a copy-to-clipboard affordance.
 */
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="absolute right-2 top-2 z-10 rounded-md border bg-background/90 p-1.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-foreground focus:opacity-100"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: { children?: ReactNode } };
  return el.props ? textOf(el.props.children) : "";
}

export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="text-[14px] leading-7 text-foreground [&>*+*]:mt-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
          h2: ({ children }) => <h4 className="text-[15px] font-semibold">{children}</h4>,
          h3: ({ children }) => <h5 className="text-sm font-semibold">{children}</h5>,
          p: ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
          ul: ({ children }) => <ul className="ml-5 list-disc space-y-1.5">{children}</ul>,
          ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1.5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ children, href }) => (
            <a href={href} className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-border" />,
          code: ({ className, children, ...props }) => {
            const inline = !String(className ?? "").includes("language-");
            if (inline)
              return (
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12.5px]" {...props}>
                  {children}
                </code>
              );
            return (
              <code className="font-mono text-[12.5px] leading-6" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <div className="group relative">
              <CopyButton getText={() => textOf(children)} />
              <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3">{children}</pre>
            </div>
          ),
          table: ({ children }) => (
            <div className="group relative">
              <CopyButton getText={() => textOf(children)} />
              <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-lg border">
                <table className="w-full text-[13px]">{children}</table>
              </div>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b px-3 py-2 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-b px-3 py-2 align-top">{children}</td>,
          tr: ({ children, ...p }) => (
            <tr className={cn("last:[&>td]:border-b-0")} {...p}>
              {children}
            </tr>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
