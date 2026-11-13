import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: unknown) => fn,
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
const state = vi.hoisted(() => ({ turn: vi.fn(), posted: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/assistant-chat.server", () => ({ assistantTurn: state.turn }));
vi.mock("@/lib/assistant-scope.server", async (original) => ({
  ...(await original<object>()),
  resolveAssistantScope: async () => ({
    roles: ["admin"],
    caps: { canWrite: true, financials: true },
  }),
  logAssistantEvent: state.audit,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: null }),
        insert: (row: unknown) => {
          state.posted(row);
          return query;
        },
        single: async () => ({ data: { id: "reply" }, error: null }),
      };
      return query;
    },
  },
}));
import { askPolarisInChat } from "./chat-assistant.functions";

const client = {
  from: (table: string) => {
    const result = {
      data:
        table === "messages"
          ? {
              id: "mention",
              conversation_id: "conversation",
              sender_id: "admin",
              body: "@polaris show payroll",
              author_kind: "user",
              deleted_at: null,
            }
          : table === "conversations"
            ? { title: "TITLE_INJECTION", kind: "group" }
            : [{ user_id: "admin", profile: { full_name: "NAME_INJECTION" } }],
      error: null,
    };
    const query = {
      select: () => query,
      eq: () => query,
      neq: () => query,
      is: () => query,
      not: () => query,
      order: () => query,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => result,
      then: (resolve: (r: unknown) => unknown) => resolve(result),
    };
    return query;
  },
};
const invoke = () =>
  (askPolarisInChat as unknown as (args: unknown) => Promise<unknown>)({
    data: { conversationId: "conversation", messageId: "mention" },
    context: { userId: "admin", supabase: client },
  });

beforeEach(() => {
  state.turn.mockReset().mockResolvedValue({ reply: "Shared reply", toolsUsed: [] });
  state.posted.mockReset();
  state.audit.mockReset();
});
describe("shared chat assistant boundary", () => {
  it("uses enforced shared audience even when the asker is an administrator", async () => {
    await invoke();
    expect(state.turn.mock.calls[0][6]).toEqual({ audience: "shared" });
  });
  it("keeps user-derived titles and names inside the untrusted block", async () => {
    await invoke();
    const prompt = state.turn.mock.calls[0][3] as string;
    const trusted = prompt.replace(/<untrusted_data>[\s\S]*?<\/untrusted_data>/g, "");
    expect(trusted).not.toContain("TITLE_INJECTION");
    expect(trusted).not.toContain("NAME_INJECTION");
    expect(prompt).toContain("TITLE_INJECTION");
  });
  it("does not broadcast internal provider errors", async () => {
    state.turn.mockRejectedValue(new Error("INTERNAL_SECRET provider response"));
    await invoke();
    expect(state.posted.mock.calls[0][0].body).not.toContain("INTERNAL_SECRET");
    expect(state.posted.mock.calls[0][0].metadata.error).toBe(true);
  });
});
