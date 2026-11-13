/**
 * Pure helpers behind the prospect layout — no React, no Supabase, so the
 * arithmetic the header, the stage line and the contact popup rely on can be
 * pinned by tests rather than eyeballed.
 */
import type { StageTone } from "@/lib/stage-tone";

/** The person a rep would actually ring: the primary, else the first known. */
export function primaryContact<T extends { is_primary: boolean }>(contacts: T[]): T | null {
  return contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;
}

/**
 * What to print beside a contact's name: their decision role when it is one
 * the desk labels, else their job title, else nothing.
 */
export function contactRoleLabel(
  contact: { decision_role: string | null; title: string | null },
  roleLabels: Record<string, string>,
): string | null {
  const role = contact.decision_role ? roleLabels[contact.decision_role] : undefined;
  return role ?? contact.title ?? null;
}

/** Whole days since a stage change, never negative; null when never moved. */
export function daysInStage(changedAt: string | null, now: number = Date.now()): number | null {
  if (!changedAt) return null;
  const then = new Date(changedAt).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

export type StageState = "done" | "current" | "todo";

/** Where each numbered step sits relative to the current one. */
export function stageState(index: number, currentIndex: number): StageState {
  if (currentIndex < 0) return "todo";
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "current";
  return "todo";
}

/**
 * The filled portion of the thin stage rail, as percentages of its width.
 *
 * Every step owns an equal column and its marker sits at that column's
 * centre, so the rail runs from the first marker to the current one. Off the
 * path (no current stage, or a close-out stage) nothing is filled.
 */
export function railFill(currentIndex: number, count: number): { left: number; width: number } {
  if (count <= 0 || currentIndex < 0 || currentIndex >= count) return { left: 0, width: 0 };
  const centre = (i: number) => ((i + 0.5) / count) * 100;
  const left = centre(0);
  return { left, width: Math.max(0, centre(currentIndex) - left) };
}

/**
 * The whole rail, first marker centre to last, as percentages of its width.
 * A coloured line that ran past the end markers would read as a stage that
 * is not there.
 */
export function railSpan(count: number): { left: number; width: number } {
  if (count <= 0) return { left: 0, width: 0 };
  const centre = (i: number) => ((i + 0.5) / count) * 100;
  return { left: centre(0), width: Math.max(0, centre(count - 1) - centre(0)) };
}

/**
 * How the thin rail is coloured — each stage in its OWN tone now.
 *
 * Mark first: "this thin line needs color to it, just grayed out since it's
 * not the active section." Then, of the one-gold result: "the colors here in
 * the pipeline aren't exciting." Both are kept. Every stage is drawn in its
 * tone from `stageTone` (lib/stage-tone.ts): the road already travelled is a
 * gradient through the stages it passed, the current stage is a solid pill in
 * its colour, and the road ahead is still those colours, faded — not yet
 * reached rather than plain grey. The rail's colours are inline gradients
 * (`stageGradient`); these are the strengths. Tokens only; no hex.
 */
export const RAIL_TONE = {
  /** The whole span, every stage's colour, faded: the road ahead. */
  track: "opacity-25",
  /** First stage to the current one, at full strength. */
  passed: "opacity-100",
} as const;

/** Marker and label classes for a step, by where it sits, in its own tone. */
export function railTone(
  state: StageState,
  tone: Pick<StageTone, "dot">,
): { dot: string; label: string } {
  if (state === "done") {
    return { dot: tone.dot, label: "text-foreground/80 group-hover:text-foreground" };
  }
  if (state === "current") {
    return { dot: tone.dot, label: "text-foreground" };
  }
  return {
    dot: `${tone.dot} opacity-30 group-hover:opacity-100`,
    label: "text-muted-foreground group-hover:text-foreground",
  };
}

/**
 * The rail is the road to the win; the close-out stages — No Service Needed,
 * Ghosted — are outcomes beside it. The full record draws them as the last
 * chevrons of its path, and Mark wants them on the prospect rail too ("these
 * are missing from prospect"), so they come back as stages of their own after
 * the forward steps, whatever their sort order says, and inactive stages are
 * dropped from both. Nothing is written here: a click on either kind hands
 * off to the same MoveDialog.
 */
export function partitionStages<T extends { is_active: boolean; is_lost: boolean }>(
  stages: readonly T[],
): { steps: T[]; outcomes: T[] } {
  const active = stages.filter((s) => s.is_active);
  return {
    steps: active.filter((s) => !s.is_lost),
    outcomes: active.filter((s) => s.is_lost),
  };
}

/**
 * How a close-out stage is drawn on the rail: the same marker-and-label as a
 * forward step, in its own tone (No Service Needed slate, Ghosted rose) but
 * faded until hovered, after a hairline gap and on a dashed line, so it reads
 * as an exit, not the next step. On the stage it is a solid pill like any
 * other current stage.
 */
export function closeOutTone(tone: Pick<StageTone, "dot" | "groupHoverText">): {
  dot: string;
  label: string;
} {
  return {
    dot: `${tone.dot} opacity-40 group-hover:opacity-100`,
    label: `text-muted-foreground ${tone.groupHoverText}`,
  };
}

/** The dashed line between the close-outs: neutral, since it joins two hues. */
export const CLOSE_OUT_TRACK = "border-muted-foreground/35";

/** One line of address for a popup, from whatever parts are filled in. */
export function formatAddress(parts: {
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}): string | null {
  const town = [parts.city, parts.state].filter(Boolean).join(", ");
  const tail = [town, parts.postal_code].filter(Boolean).join(" ");
  const line = [parts.address_line1, tail].filter(Boolean).join(", ");
  return line || null;
}

/** A website value as typed by a rep, made into something a browser will open. */
export function websiteHref(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}
