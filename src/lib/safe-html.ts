import DOMPurify from "dompurify";

/** Plain text must be escaped before it is placed in an HTML body or attribute. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

export function textToEmailHtml(value: string): string {
  return escapeHtml(value)
    .split(/\r?\n\r?\n/)
    .map((p) => `<p>${p.replace(/\r?\n/g, "<br/>")}</p>`)
    .join("");
}

/** Formatting supported by the editor, without active content or remote images. */
export function sanitizeEditorHtml(value: string): string {
  // The editor is hydrated in the browser. Never parse untrusted markup into an
  // active DOM during SSR or fall back to unsanitized HTML.
  if (typeof window === "undefined") return escapeHtml(value);
  return DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [
      "p",
      "div",
      "br",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "ul",
      "ol",
      "li",
      "blockquote",
      "a",
      "span",
    ],
    ALLOWED_ATTR: ["href", "title", "class", "contenteditable"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|tel:|#)/i,
  });
}

/**
 * HTML that came from OUTSIDE the app — an Outlook message body through
 * Graph, a forwarded email, any future integration that hands us markup.
 *
 * THE ONE SEAM for it (the external-access review: "any HTML the app renders
 * from external sources goes through one sanitizer"). Wider than the editor's
 * list, because real email uses tables and headings, and stricter where email
 * is dangerous:
 *   - no scripts, handlers, forms, frames, objects, SVG or MathML (DOMPurify);
 *   - no `style` attributes: CSS can load remote URLs and overlay the page;
 *   - no remote images: an <img> pointing off-site is a read receipt for the
 *     sender and a tracking pixel for anyone. Inline data: and cid: images
 *     (attachments) are kept; everything else is dropped;
 *   - links only to http(s), mailto and tel, and every one opens in a new tab
 *     with no opener and no referrer.
 * Its own DOMPurify instance, so the link hook never touches the editor's.
 * During SSR it returns escaped text — never unsanitized markup.
 */
let externalPurifier: ReturnType<typeof DOMPurify> | null = null;

function purifierForExternal(): ReturnType<typeof DOMPurify> {
  if (externalPurifier) return externalPurifier;
  const p = DOMPurify(window);
  p.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    if (node.nodeName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!/^(?:data:image\/(?:png|gif|jpe?g|webp);|cid:)/i.test(src)) node.remove();
    }
  });
  externalPurifier = p;
  return p;
}

export function sanitizeExternalHtml(value: string): string {
  if (typeof window === "undefined") return escapeHtml(value);
  return purifierForExternal().sanitize(value, {
    ALLOWED_TAGS: [
      "p",
      "div",
      "span",
      "br",
      "hr",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "small",
      "sub",
      "sup",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "caption",
      "colgroup",
      "col",
      "a",
      "img",
    ],
    ALLOWED_ATTR: [
      "href",
      "title",
      "alt",
      "src",
      "width",
      "height",
      "colspan",
      "rowspan",
      "align",
      "target",
      "rel",
    ],
    // Plain values, not URLs. With a custom URI pattern DOMPurify would
    // otherwise test these against it too and drop a table's colspan.
    ADD_URI_SAFE_ATTR: ["colspan", "rowspan", "width", "height", "align", "alt", "title"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|tel:|#|cid:|data:image\/(?:png|gif|jpe?g|webp);)/i,
  });
}
