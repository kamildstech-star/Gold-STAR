import { describe, expect, it, vi } from "vitest";

import { undoableDelete } from "./undoable-delete";

const make = (commit = vi.fn(async () => {})) => {
  const restore = vi.fn();
  const onError = vi.fn();
  return { u: undoableDelete({ commit, restore, onError }), commit, restore, onError };
};

describe("undoableDelete", () => {
  it("does nothing until the window closes", () => {
    const { u, commit, restore } = make();
    expect(u.state()).toBe("pending");
    expect(commit).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("deletes once when the window closes, however many times it is told", async () => {
    const { u, commit } = make();
    await Promise.all([u.settle(), u.settle()]);
    await u.settle();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(u.state()).toBe("committed");
  });

  it("Undo inside the window keeps the row and never sends the delete", async () => {
    const { u, commit, restore } = make();
    expect(u.undo()).toBe(true);
    // The toast closing after Undo (sonner fires its own close) changes nothing.
    await u.settle();
    expect(commit).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(u.state()).toBe("undone");
  });

  it("refuses Undo once the delete has started", async () => {
    let finish!: () => void;
    const { u, restore } = make(vi.fn(() => new Promise<void>((r) => (finish = r))));
    const running = u.settle();
    expect(u.state()).toBe("committing");
    expect(u.undo()).toBe(false);
    finish();
    await running;
    expect(u.undo()).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  });

  it("puts the row back and reports when the delete fails", async () => {
    const boom = new Error("permission denied");
    const { u, restore, onError } = make(
      vi.fn(async () => {
        throw boom;
      }),
    );
    await u.settle();
    expect(u.state()).toBe("failed");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    // And it does not try again on a second close.
    await u.settle();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
