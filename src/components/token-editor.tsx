/**
 * Rich-text template editor with merge-key insertion.
 *
 * Tokens are inserted as highlighted, non-editable chips so an author can see
 * at a glance which parts of the letter are filled by the job — and cannot
 * accidentally break "{Job.JobNumber}" into "{Job.JobNumbe r}" mid-word.
 */
import { useEffect, useRef } from "react";
import { Bold, Italic, List, Underline } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MergeKeyPicker } from "@/components/merge-key-picker";
import type { MergeData } from "@/lib/merge-keys";
import { cn } from "@/lib/utils";
import { sanitizeEditorHtml } from "@/lib/safe-html";

const TOKEN_CLASS =
  "mk-token rounded bg-primary/10 px-1 py-[1px] font-medium text-primary ring-1 ring-primary/25";

/** Wraps bare {Key} text in highlight chips so pasted templates light up too. */
export function highlightTokens(html: string) {
  const safe = sanitizeEditorHtml(html);
  if (typeof document === "undefined") return safe;
  const template = document.createElement("template");
  template.innerHTML = safe;
  template.content.querySelectorAll("span.mk-token").forEach((chip) => {
    chip.className = TOKEN_CLASS;
    chip.setAttribute("contenteditable", "false");
  });
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest(".mk-token")) continue;
    // The double form first, so an engine field like {{order_lines}} becomes
    // one chip rather than a brace, a chip and another brace.
    const pattern = /\{\{[A-Za-z][A-Za-z0-9_.]*\}\}|\{[A-Za-z][A-Za-z0-9_.]*\}/g;
    const text = node.data;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      fragment.append(text.slice(offset, match.index));
      const chip = document.createElement("span");
      chip.className = TOKEN_CLASS;
      chip.setAttribute("contenteditable", "false");
      chip.textContent = match[0];
      fragment.append(chip);
      offset = match.index + match[0].length;
    }
    if (offset) {
      fragment.append(text.slice(offset));
      node.replaceWith(fragment);
    }
  }
  return template.innerHTML;
}

/** Editor HTML → send-ready HTML: chips become plain {Key} text. */
export function stripTokenMarkup(html: string) {
  html = sanitizeEditorHtml(html);
  if (typeof document === "undefined") {
    return html.replace(/<span[^>]*class="[^"]*mk-token[^"]*"[^>]*>(.*?)<\/span>/g, "$1");
  }
  const el = document.createElement("div");
  el.innerHTML = html;
  el.querySelectorAll("span.mk-token").forEach((n) => {
    n.replaceWith(document.createTextNode(n.textContent ?? ""));
  });
  return el.innerHTML;
}

export function htmlToText(html: string) {
  if (typeof document === "undefined") return html.replace(/<[^>]+>/g, " ");
  const el = document.createElement("div");
  el.innerHTML = sanitizeEditorHtml(html).replace(/<(br|\/p|\/div)[^>]*>/g, "\n");
  return el.textContent ?? "";
}

export function TokenEditor({
  value,
  onChange,
  placeholder,
  className,
  minHeight = 260,
  sample,
  extraTokens,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: number;
  /** Resolved values for a real record, shown beside each key in the picker. */
  sample?: MergeData;
  /**
   * The fields ONE template may use, offered as click-to-insert chips beside
   * the global picker. The email engine sets this per template key: a vendor
   * order has no customer name, and offering all 620 catalogue keys is how an
   * author ends up inserting one that will never resolve.
   */
  extraTokens?: { token: string; label: string }[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Only push external value in when the editor is not the source of truth,
  // otherwise every keystroke would reset the caret to the start.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = highlightTokens(value || "");
    if (el.innerHTML !== next && document.activeElement !== el) el.innerHTML = next;
  }, [value]);

  const emit = () => {
    if (ref.current) onChange(sanitizeEditorHtml(ref.current.innerHTML));
  };

  const exec = (cmd: string) => {
    ref.current?.focus();
    document.execCommand(cmd);
    emit();
  };

  const insertToken = (key: string, braces: 1 | 2 = 1) => {
    if (!/^[A-Za-z][A-Za-z0-9_. ]*$/.test(key)) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    const text = braces === 2 ? `{{${key}}}` : `{${key}}`;
    const chip = `<span class="${TOKEN_CLASS}" contenteditable="false">${text}</span>&nbsp;`;
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      document.execCommand("insertHTML", false, chip);
    } else {
      el.innerHTML += chip;
    }
    emit();
  };

  return (
    <div className={cn("rounded-md border bg-background", className)}>
      <div className="flex flex-wrap items-center gap-1 border-b px-1.5 py-1">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => exec("bold")}
        >
          <Bold className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => exec("italic")}
        >
          <Italic className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => exec("underline")}
        >
          <Underline className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => exec("insertUnorderedList")}
        >
          <List className="size-3.5" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border" />
        {/* Arity-guarded: the picker must never supply the braces argument. */}
        <MergeKeyPicker onInsert={(k) => insertToken(k)} sample={sample} />
      </div>
      {extraTokens?.length ? (
        <div className="flex flex-wrap items-center gap-1 border-b px-1.5 py-1">
          <span className="mr-1 text-[11px] text-muted-foreground">Insert:</span>
          {extraTokens.map((f) => (
            <Button
              key={f.token}
              type="button"
              size="sm"
              variant="outline"
              title={f.label}
              className="h-6 px-1.5 font-mono text-[10px]"
              onClick={() => insertToken(f.token, 2)}
            >
              {`{{${f.token}}}`}
            </Button>
          ))}
        </div>
      ) : null}
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label="Email body"
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={emit}
        onPaste={(event) => {
          event.preventDefault();
          const html = event.clipboardData.getData("text/html");
          if (html) document.execCommand("insertHTML", false, sanitizeEditorHtml(html));
          else document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
          emit();
        }}
        onDrop={(event) => event.preventDefault()}
        className="prose-sm max-w-none px-3 py-2 text-sm outline-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]"
        style={{ minHeight }}
      />
    </div>
  );
}
