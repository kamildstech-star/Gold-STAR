/**
 * The whole app in Español, from one place (4 Nov: "not only the job page —
 * the whole project, completely").
 *
 * Wrapping every string of 666 screens in `t()` by hand would take months and
 * a screen nobody wrapped would stay English forever. Instead the dictionary
 * is built from the source itself (`scripts/i18n/extract.mjs` pulls every
 * piece of on-screen English; the Spanish is written once and reviewed in
 * `es-ui.json`), and this module swaps the text on screen:
 *
 *   - a text node or a placeholder / title / aria-label / alt whose English is
 *     in the dictionary shows the Spanish; numbers ride through
 *     ("3 documents" → "{n} documents" → "3 documentos");
 *   - when React changes the text, the observer reads the new English and
 *     swaps again; switching back to English restores every original.
 *
 * Still no machine translation at runtime: an exact lookup in a fixed,
 * reviewed dictionary, and anything not in it stays as written.
 *
 * Never data: a field the person types into is never touched, nor anything
 * inside `[data-no-translate]` (wrap names, addresses and notes in it where a
 * value could collide with a label), `contenteditable`, code or pre.
 */

export type Dictionary = ReadonlyMap<string, string>;

const NUMBER = /[$€]?-?\d[\d,]*(?:\.\d+)?%?/g;
const ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE", "NOSCRIPT", "INPUT", "SELECT", "OPTION"]);

/** The Spanish for one piece of English, or null when the dictionary has none. */
export function lookup(dict: Dictionary, raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  if (!s || !/[A-Za-z]/.test(s)) return null;
  const hit = dict.get(s);
  if (hit != null) return hit;
  const nums = s.match(NUMBER);
  if (!nums) return null;
  const es = dict.get(s.replace(NUMBER, "{n}"));
  if (es == null) return null;
  let i = 0;
  return es.replace(/\{n\}/g, () => nums[i++] ?? "");
}

/** Keep the node's own leading and trailing spaces around the Spanish. */
function keepSpacing(raw: string, es: string): string {
  const lead = /^\s*/.exec(raw)![0];
  const trail = /\s*$/.exec(raw)![0];
  return lead + es + trail;
}

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName)) return true;
    if (e.hasAttribute("data-no-translate")) return true;
    if ((e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

type Pair = { en: string; es: string };

export function startDomTranslator(root: HTMLElement, dict: Dictionary): () => void {
  const texts = new Map<Text, Pair>();
  const attrs = new Map<Element, Map<string, Pair>>();

  const doText = (node: Text) => {
    const now = node.nodeValue ?? "";
    const had = texts.get(node);
    if (had && now === had.es) return; // our own write
    if (skipped(node.parentElement)) return;
    const es = lookup(dict, now);
    if (es == null) {
      if (had) texts.delete(node);
      return;
    }
    const out = keepSpacing(now, es);
    texts.set(node, { en: now, es: out });
    if (out !== now) node.nodeValue = out;
  };

  const doAttrs = (el: Element) => {
    for (const a of ATTRS) {
      const now = el.getAttribute(a);
      if (now == null) continue;
      const map = attrs.get(el);
      const had = map?.get(a);
      if (had && now === had.es) continue;
      if (skipped(el)) return;
      const es = lookup(dict, now);
      if (es == null) continue;
      const m = map ?? new Map<string, Pair>();
      m.set(a, { en: now, es });
      attrs.set(el, m);
      if (es !== now) el.setAttribute(a, es);
    }
  };

  const doTree = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) return doText(n as Text);
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (skipped(el)) return;
    doAttrs(el);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (x) =>
        x.nodeType === Node.ELEMENT_NODE && (SKIP_TAGS.has((x as Element).tagName) || (x as Element).hasAttribute("data-no-translate"))
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let x = walker.nextNode(); x; x = walker.nextNode()) {
      if (x.nodeType === Node.TEXT_NODE) doText(x as Text);
      else doAttrs(x as Element);
    }
  };

  // Changes arrive in bursts while React renders; handle each batch once.
  let queued = new Set<Node>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = queued;
    queued = new Set();
    for (const n of batch) if (n.isConnected) doTree(n);
    // Forget nodes React threw away.
    if (texts.size > 20000) for (const t of texts.keys()) if (!t.isConnected) texts.delete(t);
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") queued.add(r.target);
      else if (r.type === "attributes") queued.add(r.target);
      else r.addedNodes.forEach((n) => queued.add(n));
    }
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  });

  doTree(root);
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });

  return () => {
    observer.disconnect();
    for (const [node, p] of texts) if (node.isConnected && node.nodeValue === p.es) node.nodeValue = p.en;
    for (const [el, m] of attrs)
      for (const [a, p] of m) if (el.isConnected && el.getAttribute(a) === p.es) el.setAttribute(a, p.en);
    texts.clear();
    attrs.clear();
  };
}
