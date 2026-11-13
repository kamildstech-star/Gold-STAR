/**
 * Google Translate for the whole page (12 Nov).
 *
 * "The translation in GSR is not fully translating the data into Spanish. I
 * need Google translation at the same place, just keep the older one too."
 *
 * The app's own Español (src/lib/i18n) translates the app's words — labels,
 * buttons, messages — from a reviewed dictionary. It never translates DATA:
 * notes, scope lines, names of things people typed. Google's website
 * translator does the whole page, data included, so it sits beside EN | ES in
 * the top bar as a third choice.
 *
 * How it works: Google's translator reads the `googtrans` cookie
 * ("/en/es") when its script loads, and translates the page and everything
 * added to it afterwards. Turning it on or off sets the cookie and reloads,
 * which is the one reliable way to make Google start or stop.
 *
 * Two things around it:
 *  - Google's toolbar banner is hidden; the top-bar switch is the control.
 *  - Google swaps text nodes for its own <font> elements, which makes React
 *    throw when it later removes or moves a node that is no longer where it
 *    put it ("Failed to execute 'removeChild' on 'Node'"). The standard guard
 *    (React issue #11538) makes those two DOM calls tolerate it. Installed
 *    only while Google is on.
 *
 * The loader (12 Nov: "every time before the conversion there is a stay —
 * make a loader"): Google translates a moment after the text appears, so a
 * new page shows English first. While Google is on, a page change covers
 * the page's content with a spinner until Google's translation has
 * landed and gone quiet; smaller updates (a list loading, a dialog opening)
 * show a small spinner instead. Both give up after a few seconds
 * rather than hide the page if Google is slow.
 *
 * The page's text goes to Google to be translated — the person chose that by
 * pressing the button. Nothing is sent while it is off.
 */

export const GOOGLE_TRANSLATE_COOKIE = "googtrans";
export const GOOGLE_TRANSLATE_VALUE = "/en/es";
export const GOOGLE_TRANSLATE_SCRIPT =
  "https://translate.google.com/translate_a/element.js?cb=gsrGoogleTranslateInit";

/** Whether Google translation is on for this browser (read from its cookie). */
export function googleTranslateOn(cookie: string): boolean {
  return cookie
    .split(";")
    .map((c) => c.trim())
    .some((c) => c === `${GOOGLE_TRANSLATE_COOKIE}=${GOOGLE_TRANSLATE_VALUE}`);
}

/** The domains Google may have set its cookie on: the host and its parent. */
export function cookieDomains(hostname: string): string[] {
  const parts = hostname.split(".");
  const out = [hostname];
  if (parts.length > 2) out.push(`.${parts.slice(-2).join(".")}`);
  if (parts.length > 1) out.push(`.${hostname}`);
  return out;
}

/** Turn it on and reload: Google reads the cookie when its script starts. */
export function enableGoogleTranslate(): void {
  document.cookie = `${GOOGLE_TRANSLATE_COOKIE}=${GOOGLE_TRANSLATE_VALUE}; path=/; SameSite=Lax`;
  window.location.reload();
}

/** Turn it off everywhere Google may have set it, and reload to a clean page. */
export function disableGoogleTranslate(): void {
  const gone = "expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = `${GOOGLE_TRANSLATE_COOKIE}=; ${gone}`;
  for (const d of cookieDomains(window.location.hostname)) {
    document.cookie = `${GOOGLE_TRANSLATE_COOKIE}=; ${gone}; domain=${d}`;
  }
  window.location.reload();
}

let started = false;

/** Keep React working while Google rewrites text nodes (React issue #11538). */
function guardDom() {
  const proto = Node.prototype as Node & {
    __gsrGuarded?: boolean;
  };
  if (proto.__gsrGuarded) return;
  proto.__gsrGuarded = true;
  const removeChild = proto.removeChild;
  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child) as T;
  };
  const insertBefore = proto.insertBefore;
  proto.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (ref && ref.parentNode !== this) return node;
    return insertBefore.call(this, node, ref) as T;
  };
}

/** Load Google's translator once, with its banner hidden. Only call while it is on. */
export function startGoogleTranslate(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  guardDom();

  const style = document.createElement("style");
  style.setAttribute("data-google-translate", "");
  // Google's own toolbar and hover tips; the top-bar switch is the control.
  style.textContent = `
    body > .skiptranslate, .goog-te-banner-frame, #goog-gt-tt, .goog-te-balloon-frame,
    .VIpgJd-ZVi9od-ORHb-OEVmcd, .VIpgJd-ZVi9od-aZ2wEe-wOHMyf, .VIpgJd-yAWNEb-L7lbkb { display: none !important; }
    body { top: 0 !important; position: static !important; }
    font { background: none !important; box-shadow: none !important; }
    #${LOADER_ID} { position: fixed; z-index: 60; display: none; align-items: center; justify-content: center; }
    #${LOADER_ID}[data-mode="page"] { display: flex; background: color-mix(in srgb, var(--background, #fff) 92%, transparent); }
    #${LOADER_ID}[data-mode="pill"] { display: flex; pointer-events: none; }
    #${LOADER_ID} .gsr-tr-box { display: flex; align-items: center; padding: 9px; border-radius: 999px;
      background: var(--card, #fff); color: var(--foreground, #10243d); border: 1px solid var(--border, #e8eaee);
      box-shadow: 0 4px 14px rgb(0 0 0 / 0.08); font: 500 13px/1.2 system-ui, sans-serif; }
    #${LOADER_ID} .gsr-tr-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor;
      border-right-color: transparent; animation: gsr-tr-spin 0.7s linear infinite; }
    #${LOADER_ID} .gsr-tr-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    #${LOADER_ID} .gsr-tr-spin { width: 18px; height: 18px; }
    @keyframes gsr-tr-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { #${LOADER_ID} .gsr-tr-spin { animation-duration: 2s; } }
  `;
  document.head.appendChild(style);

  const host = document.createElement("div");
  host.id = "gsr-google-translate";
  host.style.display = "none";
  document.body.appendChild(host);

  const w = window as unknown as {
    gsrGoogleTranslateInit?: () => void;
    google?: {
      translate?: {
        TranslateElement: new (opts: Record<string, unknown>, id: string) => unknown;
      };
    };
  };
  w.gsrGoogleTranslateInit = () => {
    const T = w.google?.translate?.TranslateElement;
    if (T) new T({ pageLanguage: "en", includedLanguages: "es", autoDisplay: false }, host.id);
  };
  const script = document.createElement("script");
  script.src = GOOGLE_TRANSLATE_SCRIPT;
  script.async = true;
  document.body.appendChild(script);

  watchTranslation();
}

/* ------------------------------------------------------------------ */
/* The loader                                                          */
/* ------------------------------------------------------------------ */

export const LOADER_ID = "gsr-translating";

/** How long Google must be quiet before its translation counts as landed. */
const SETTLE_MS = 350;
/** The longest the loader stays: a slow Google never hides the page for long. */
const PAGE_MAX_MS = 6000;
const PILL_MAX_MS = 3000;
/** Small updates show the pill only if Google has not caught up by then. */
const PILL_DELAY_MS = 300;

/** Text worth translating: two letters in a row, not just numbers or symbols. */
export function hasWords(text: string | null | undefined): boolean {
  return /[A-Za-z]{2}/.test(text ?? "");
}

/**
 * Whether a DOM change is new English for Google to translate (not Google's
 * own <font> output, not the loader, not anything marked notranslate).
 */
export function isNewText(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return false;
  if (
    el.closest(`font, #${LOADER_ID}, .notranslate, [translate="no"], .skiptranslate, script, style`)
  )
    return false;
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "FONT") return false;
  return hasWords(node.textContent);
}

function loader(): HTMLDivElement {
  let el = document.getElementById(LOADER_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = LOADER_ID;
    el.className = "notranslate";
    el.setAttribute("translate", "no");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      // 12 Nov: the spinner alone on screen; the word is for screen readers.
      '<div class="gsr-tr-box"><span class="gsr-tr-spin" aria-hidden="true"></span><span class="gsr-tr-sr">Traduciendo…</span></div>';
    document.body.appendChild(el);
  }
  return el;
}

function show(mode: "page" | "pill") {
  const el = loader();
  if (mode === "page") {
    // Over the page's content only: the top bar and the menu are already Spanish.
    const r = document.querySelector("main")?.getBoundingClientRect();
    const top = Math.max(0, r?.top ?? 0);
    Object.assign(el.style, {
      top: `${top}px`,
      left: `${Math.max(0, r?.left ?? 0)}px`,
      width: `${r ? r.width : window.innerWidth}px`,
      height: `${Math.max(0, Math.min(window.innerHeight, r ? r.bottom : window.innerHeight) - top)}px`,
      transform: "",
    });
  } else {
    Object.assign(el.style, {
      top: "64px",
      left: "50%",
      width: "auto",
      height: "auto",
      transform: "translateX(-50%)",
    });
  }
  el.dataset.mode = mode;
}

function hide() {
  const el = document.getElementById(LOADER_ID);
  if (el) el.dataset.mode = "";
}

/**
 * Watch the page while Google is on: new English starts a wait, Google's
 * <font> output ends it once quiet. A route change waits with the content
 * covered; anything else waits with the pill, shown only if it lasts.
 */
function watchTranslation() {
  let waiting: "page" | "pill" | null = null;
  let since = 0;
  let lastGoogle = 0;
  let sawGoogle = false;
  let timer: number | null = null;

  const done = () => {
    waiting = null;
    hide();
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const tick = () => {
    if (!waiting) return done();
    const now = performance.now();
    if (sawGoogle && now - lastGoogle > SETTLE_MS) return done();
    if (now - since > (waiting === "page" ? PAGE_MAX_MS : PILL_MAX_MS)) return done();
    if (waiting === "pill" && now - since > PILL_DELAY_MS) show("pill");
  };
  const start = (mode: "page" | "pill") => {
    // A page wait is never downgraded to a pill by the page's own rendering.
    if (waiting === "page" && mode === "pill") return;
    if (!waiting || mode === "page") {
      since = performance.now();
      sawGoogle = false;
    }
    waiting = mode;
    if (mode === "page") show("page");
    if (timer === null) timer = window.setInterval(tick, 100);
  };

  new MutationObserver((records) => {
    let english = false;
    for (const r of records) {
      if (r.type === "characterData") {
        if (isNewText(r.target)) english = true;
        else if (r.target.parentElement?.closest("font")) {
          lastGoogle = performance.now();
          sawGoogle = true;
        }
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === "FONT") {
          lastGoogle = performance.now();
          sawGoogle = true;
        } else if (isNewText(n)) {
          english = true;
        }
      }
    }
    if (english) start("pill");
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // A new page: its content is covered until Google has translated it.
  let path = window.location.pathname;
  const onRoute = () => {
    const next = window.location.pathname;
    start(next !== path ? "page" : "pill");
    path = next;
  };
  for (const k of ["pushState", "replaceState"] as const) {
    const orig = history[k].bind(history);
    history[k] = (...args: Parameters<History["pushState"]>) => {
      orig(...args);
      onRoute();
    };
  }
  window.addEventListener("popstate", onRoute);

  // The first load is a new page too.
  start("page");
}
