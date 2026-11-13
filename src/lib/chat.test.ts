import { describe, expect, it } from "vitest";

import {
  attachmentFileName,
  formatBytes,
  groupMessages,
  isItemMessage,
  itemLabel,
  threadNotes,
  type Message,
} from "./chat";

const msg = (over: Partial<Message> & Pick<Message, "id" | "sender_id" | "sent_at">): Message => ({
  author_kind: "user",
  body: null,
  conversation_id: "c",
  deleted_at: null,
  edited_at: null,
  is_demo: false,
  metadata: {},
  reply_to_message_id: null,
  shared_record_id: null,
  shared_record_type: null,
  ...over,
});

describe("groupMessages", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 8, 3, 12, 0, s)).toISOString();

  it("stacks same-sender messages sent close together", () => {
    const g = groupMessages([
      msg({ id: "1", sender_id: "u1", sent_at: t(0) }),
      msg({ id: "2", sender_id: "u1", sent_at: t(30) }),
      msg({ id: "3", sender_id: "u2", sent_at: t(40) }),
    ]);
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([["1", "2"], ["3"]]);
  });

  it("keeps a Polaris answer out of the asker's stack despite the shared sender_id", () => {
    const g = groupMessages([
      msg({ id: "q", sender_id: "u1", sent_at: t(0), body: "@polaris hi" }),
      msg({ id: "a", sender_id: "u1", sent_at: t(5), author_kind: "assistant", body: "Hello" }),
      msg({ id: "f", sender_id: "u1", sent_at: t(10), body: "thanks" }),
    ]);
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([["q"], ["a"], ["f"]]);
  });
});

type M = { id: string; reply_to_message_id: string | null };
const m = (id: string, replyTo: string | null = null): M => ({
  id,
  reply_to_message_id: replyTo,
});

describe("threadNotes", () => {
  const items = new Set(["file1", "file2"]);
  const isItem = (x: M) => items.has(x.id);

  it("nests a run of replies directly after a file under it", () => {
    const { notesByItem, noteIds } = threadNotes(
      [m("a"), m("file1"), m("n1", "file1"), m("n2", "file1"), m("b")],
      isItem,
    );
    expect(notesByItem.get("file1")?.map((x) => x.id)).toEqual(["n1", "n2"]);
    expect([...noteIds]).toEqual(["n1", "n2"]);
    expect(notesByItem.has("a")).toBe(false);
  });

  it("closes the thread at the first unrelated message", () => {
    const { notesByItem, noteIds } = threadNotes(
      [m("file1"), m("n1", "file1"), m("chat"), m("late", "file1")],
      isItem,
    );
    expect(notesByItem.get("file1")?.map((x) => x.id)).toEqual(["n1"]);
    // A reply that arrives after other chat stays a normal quoted reply.
    expect(noteIds.has("late")).toBe(false);
  });

  it("does not nest a reply to a non-item, or a reply to a different item", () => {
    const { noteIds } = threadNotes(
      [m("plain"), m("r", "plain"), m("file1"), m("file2"), m("x", "file1")],
      isItem,
    );
    expect(noteIds.size).toBe(0);
  });

  it("never treats an item as a note, even when it replies to the open item", () => {
    const { notesByItem, noteIds } = threadNotes(
      [m("file1"), m("file2", "file1"), m("n", "file2")],
      isItem,
    );
    expect(noteIds.has("file2")).toBe(false);
    expect(notesByItem.get("file2")?.map((x) => x.id)).toEqual(["n"]);
  });

  it("handles an empty stream", () => {
    const { notesByItem, noteIds } = threadNotes([], isItem);
    expect(notesByItem.size).toBe(0);
    expect(noteIds.size).toBe(0);
  });
});

describe("isItemMessage", () => {
  const base = { deleted_at: null, shared_record_type: null, shared_record_id: null };
  it("counts files, images and shared records, but not voice notes", () => {
    expect(isItemMessage(base, [{ kind: "file" }])).toBe(true);
    expect(isItemMessage(base, [{ kind: "image" }])).toBe(true);
    expect(isItemMessage(base, [{ kind: "audio" }])).toBe(false);
    expect(isItemMessage(base, [])).toBe(false);
    expect(isItemMessage({ ...base, shared_record_type: "job", shared_record_id: "j1" }, [])).toBe(
      true,
    );
  });
  it("is false once the message is deleted", () => {
    expect(isItemMessage({ ...base, deleted_at: "2026-09-03T00:00:00Z" }, [{ kind: "file" }])).toBe(
      false,
    );
  });
});

describe("attachmentFileName", () => {
  it("strips the conversation/message prefix and the uuid", () => {
    expect(attachmentFileName("conv/msg/3f2504e0-4f89-11d3-9a0c-0305e82c3301-Site photo.jpg")).toBe(
      "Site photo.jpg",
    );
  });
  it("leaves names without a uuid alone", () => {
    expect(attachmentFileName("conv/msg/voice.webm")).toBe("voice.webm");
    expect(attachmentFileName("plain.pdf")).toBe("plain.pdf");
  });
});

describe("formatBytes", () => {
  it("formats across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });
  it("is empty for unknown sizes", () => {
    expect(formatBytes(null)).toBe("");
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe("itemLabel", () => {
  it("prefers the file name, then the record body, then a generic record label", () => {
    expect(
      itemLabel({ shared_record_type: null, body: null }, [
        { kind: "file", storage_path: "c/m/3f2504e0-4f89-11d3-9a0c-0305e82c3301-quote.pdf" },
      ]),
    ).toBe("quote.pdf");
    expect(itemLabel({ shared_record_type: "job", body: "Shared job: J-100" }, [])).toBe(
      "Shared job: J-100",
    );
    expect(itemLabel({ shared_record_type: "account", body: null }, [])).toBe("Shared account");
    expect(itemLabel({ shared_record_type: null, body: " hi " }, [])).toBe("hi");
  });
});
