import { describe, expect, it } from "vitest";

import {
  completeMention,
  hasAssistantMention,
  mentionQueryAtCaret,
  parseAssistantMention,
} from "./chat-mention";

describe("parseAssistantMention", () => {
  it("detects @polaris and @ai anywhere in the text, case-insensitively", () => {
    expect(parseAssistantMention("@polaris give me stats")?.question).toBe("give me stats");
    expect(parseAssistantMention("hey @AI what is the SLA?")?.question).toBe(
      "hey what is the SLA?",
    );
    expect(parseAssistantMention("Can you check this @Polaris")?.question).toBe(
      "Can you check this",
    );
  });

  it("strips every mention and collapses the gap it leaves", () => {
    expect(parseAssistantMention("@polaris @ai   both?")?.question).toBe("both?");
    expect(parseAssistantMention("@polaris, restoration stats for Georgia")?.question).toBe(
      "restoration stats for Georgia",
    );
  });

  it("allows sentence punctuation after the handle", () => {
    expect(parseAssistantMention("thanks @polaris.")?.question).toBe("thanks .");
    expect(hasAssistantMention("(@ai)")).toBe(true);
  });

  it("ignores emails and domains", () => {
    expect(parseAssistantMention("mail a@polaris.com today")).toBeNull();
    expect(parseAssistantMention("see @polaris.com")).toBeNull();
    expect(parseAssistantMention("x@ai")).toBeNull();
  });

  it("ignores mid-word and longer handles", () => {
    expect(parseAssistantMention("@aim for the stars")).toBeNull();
    expect(parseAssistantMention("@polaris2")).toBeNull();
    expect(parseAssistantMention("email@ai.dev")).toBeNull();
    expect(parseAssistantMention("@@polaris")).toBeNull();
  });

  it("returns an empty question for a bare mention", () => {
    expect(parseAssistantMention("@polaris")?.question).toBe("");
  });

  it("is null for empty input", () => {
    expect(parseAssistantMention("")).toBeNull();
    expect(parseAssistantMention(null)).toBeNull();
    expect(parseAssistantMention(undefined)).toBeNull();
  });
});

describe("mentionQueryAtCaret", () => {
  it("offers a completion while a known handle is being typed", () => {
    expect(mentionQueryAtCaret("@", 1)).toBe("");
    expect(mentionQueryAtCaret("hi @po", 6)).toBe("po");
    expect(mentionQueryAtCaret("hi @A", 5)).toBe("a");
  });
  it("is null outside a mention token or once it cannot become a handle", () => {
    expect(mentionQueryAtCaret("hello", 5)).toBeNull();
    expect(mentionQueryAtCaret("a@po", 4)).toBeNull();
    expect(mentionQueryAtCaret("@polx", 5)).toBeNull();
    expect(mentionQueryAtCaret("@polaris later", 4)).toBe("pol");
    expect(mentionQueryAtCaret("@polaris later", 14)).toBeNull();
  });
});

describe("completeMention", () => {
  it("replaces the partial token and places the caret after the handle", () => {
    expect(completeMention("hi @po", 6)).toEqual({ text: "hi @polaris ", caret: 12 });
    expect(completeMention("@", 1)).toEqual({ text: "@polaris ", caret: 9 });
  });
  it("keeps text after the caret", () => {
    expect(completeMention("@po tail", 3)).toEqual({ text: "@polaris  tail", caret: 9 });
  });
  it("does nothing when the caret is not in a token", () => {
    expect(completeMention("plain", 5)).toEqual({ text: "plain", caret: 5 });
  });
});
