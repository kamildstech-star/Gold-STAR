/**
 * SIDEBAR MENU SEARCH — the filtering behind the "Search menu…" box
 * =================================================================
 *
 * Mark, pointing at the left rail: "needs to be a search". The box sits above
 * the groups and narrows them as you type.
 *
 * This module is free of React and says nothing about WHO may see a link. It
 * filters whatever list it is handed, and the sidebar hands it the list it is
 * already drawing — role-gated, page-access-gated, personal hides removed — so
 * a search can never surface a page the menu itself would not offer. Settings
 * pages come from `searchableSettingsPages(canOpen)`, the same list the
 * settings hub searches.
 *
 * Matching: every word typed has to appear somewhere in the item's label, its
 * group's name, or its keywords. "sales pip" finds Pipeline; "clients" finds
 * Active Clients. Results keep the order the person arranged the menu in.
 */

import {
  SETTINGS_PAGE_BY_PATH,
  searchSettingsPages,
  type SettingsPage,
} from "@/lib/admin-settings";

export type SearchableNavItem = {
  to: string;
  label: string;
  /** Extra words that should find this item (synonyms, contents). */
  keywords?: readonly string[];
};

export type SearchableNavGroup<I extends SearchableNavItem = SearchableNavItem> = {
  key: string;
  label: string;
  items: readonly I[];
};

export type NavSearchGroup<I extends SearchableNavItem = SearchableNavItem> = {
  key: string;
  label: string;
  items: I[];
};

/** Case- and accent-insensitive form used for every comparison. */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’´`]/g, "'")
    .replace(/[‐-―]/g, "-");
}

/** The words of a query, folded. An all-space query has none. */
export function queryTokens(query: string): string[] {
  return foldText(query)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Keywords a nav item borrows from the settings registry. Admin links in the
 * rail ("Scorecard and points", "Automations") are also settings pages, and
 * the registry already lists what people type when hunting for them.
 */
export function navItemKeywords(item: SearchableNavItem): readonly string[] {
  const own = item.keywords ?? [];
  const borrowed = SETTINGS_PAGE_BY_PATH.get(item.to)?.keywords ?? [];
  return borrowed.length ? [...own, ...borrowed] : own;
}

function itemMatches(item: SearchableNavItem, groupLabel: string, toks: string[]): boolean {
  const label = foldText(item.label);
  const group = foldText(groupLabel);
  const words = navItemKeywords(item).map(foldText);
  return toks.every(
    (t) => label.includes(t) || group.includes(t) || words.some((w) => w.includes(t)),
  );
}

/**
 * The groups that still have something to show for `query`, each holding only
 * its matching items, in the order given. Empty groups are dropped. An empty
 * query returns nothing — the caller shows the ordinary menu then.
 */
export function filterNavGroups<I extends SearchableNavItem>(
  groups: readonly SearchableNavGroup<I>[],
  query: string,
): NavSearchGroup<I>[] {
  const toks = queryTokens(query);
  if (toks.length === 0) return [];
  const out: NavSearchGroup<I>[] = [];
  for (const g of groups) {
    const items = g.items.filter((i) => itemMatches(i, g.label, toks));
    if (items.length > 0) out.push({ key: g.key, label: g.label, items });
  }
  return out;
}

/**
 * Settings pages for `query`, ranked the way the settings hub ranks them,
 * minus any path the menu already lists (the rail's admin links are settings
 * pages too, and a page should appear once).
 */
export function filterSettingsPages(
  query: string,
  pages: readonly SettingsPage[],
  excludePaths: ReadonlySet<string>,
  limit = 8,
): SettingsPage[] {
  if (pages.length === 0) return [];
  return searchSettingsPages(
    query,
    pages.filter((p) => !excludePaths.has(p.path)),
    limit,
  ).map((h) => h.page);
}

export type HighlightPart = { text: string; match: boolean };

/**
 * `text` split into runs that do and do not match any query word, for drawing
 * the matched letters in the result list. Overlapping words merge.
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const toks = queryTokens(query);
  if (toks.length === 0 || text.length === 0) return [{ text, match: false }];
  // Fold character by character so indices line up with the original text.
  // A character that folds to several (rare ligatures) keeps its first.
  const folded = text
    .split("")
    .map((ch) => foldText(ch).charAt(0) || ch)
    .join("");
  const hit = new Array<boolean>(text.length).fill(false);
  for (const t of toks) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(t, from);
      if (at < 0) break;
      for (let i = at; i < at + t.length && i < hit.length; i++) hit[i] = true;
      from = at + 1;
    }
  }
  const parts: HighlightPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.match === hit[i]) last.text += text[i];
    else parts.push({ text: text[i]!, match: hit[i]! });
  }
  return parts;
}
