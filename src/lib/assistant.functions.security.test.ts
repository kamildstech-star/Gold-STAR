import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: (data: unknown) => unknown) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        (args: { data: unknown; context: unknown }) =>
          fn({ ...args, data: validate(args.data) }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const state = vi.hoisted(() => ({
  turn: vi.fn(),
  audit: vi.fn(),
  scope: vi.fn(),
}));

vi.mock("@/lib/assistant-chat.server", () => ({ assistantTurn: state.turn }));
vi.mock("@/lib/assistant-scope.server", () => ({
  resolveAssistantScope: state.scope,
  logAssistantEvent: state.audit,
}));
vi.mock("@/lib/assistant-attachments.server", () => ({
  prepareAttachments: vi.fn(async () => []),
}));

import {
  askAssistant,
  confirmAssistantAction,
  deleteAssistantConversation,
  getAssistantConversation,
  listAssistantConversations,
} from "./assistant.functions";
import {
  activitySummary,
  assistantScopePeople,
  parseDictation,
  transcribeNote,
} from "./ai.functions";

const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function client(options?: {
  permission?: boolean;
  permissionError?: boolean;
  account?: { id: string; name: string } | null;
  accountError?: boolean;
}) {
  const account =
    options?.account === undefined ? { id: ACCOUNT_ID, name: "Verified Co" } : options.account;
  const accountIds: string[] = [];

  const supabase = {
    rpc: vi.fn(async (name: string) => {
      expect(name).toBe("effective_permissions");
      if (options?.permissionError) return { data: null, error: { message: "rpc failed" } };
      return {
        data: [{ permission_key: "ai.assistant", allowed: options?.permission !== false }],
        error: null,
      };
    }),
    from: vi.fn((table: string) => {
      if (table === "accounts") {
        const query = {
          select: () => query,
          eq: (_column: string, id: string) => {
            accountIds.push(id);
            return query;
          },
          maybeSingle: async () => ({
            data: account,
            error: options?.accountError ? { message: "hidden detail" } : null,
          }),
        };
        return query;
      }

      if (table === "assistant_conversations") {
        const query = {
          insert: () => query,
          select: () => query,
          single: async () => ({
            data: { id: "33333333-3333-4333-8333-333333333333" },
            error: null,
          }),
          update: () => query,
          eq: async () => ({ data: null, error: null }),
        };
        return query;
      }

      if (table === "assistant_messages") {
        const read = {
          eq: () => read,
          order: () => read,
          limit: async () => ({ data: [], error: null }),
        };
        return {
          select: () => read,
          insert: async () => ({ data: null, error: null }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    }),
  };

  return { supabase, accountIds };
}

function invoke(supabase: ReturnType<typeof client>["supabase"], data: Record<string, unknown>) {
  return (askAssistant as unknown as (args: unknown) => Promise<unknown>)({
    data: { question: "What happened?", ...data },
    context: { userId: USER_ID, supabase },
  });
}

beforeEach(() => {
  state.turn.mockReset().mockResolvedValue({
    reply: "Answer",
    plan: [],
    navigate: null,
    toolsUsed: [],
  });
  state.audit.mockReset();
  state.scope.mockReset().mockResolvedValue({ actorUserId: USER_ID, roles: ["sales_rep"] });
});

describe("Polaris server authorization and account context", () => {
  it("denies callers without ai.assistant before reading account data or invoking the model", async () => {
    const { supabase } = client({ permission: false });

    await expect(
      invoke(supabase, { context: { entity: "account", id: ACCOUNT_ID } }),
    ).rejects.toThrow("You do not have permission to use Polaris.");
    expect(supabase.from).not.toHaveBeenCalled();
    expect(state.turn).not.toHaveBeenCalled();
  });

  it("fails closed when effective permissions cannot be verified", async () => {
    const { supabase } = client({ permissionError: true });

    await expect(invoke(supabase, {})).rejects.toThrow("Could not verify Polaris access");
    expect(state.turn).not.toHaveBeenCalled();
  });

  it("enforces ai.assistant on conversation reads, actions, and deletion", async () => {
    const endpoints: Array<{ fn: unknown; data?: Record<string, unknown> }> = [
      { fn: listAssistantConversations },
      {
        fn: getAssistantConversation,
        data: { conversationId: "33333333-3333-4333-8333-333333333333" },
      },
      {
        fn: deleteAssistantConversation,
        data: { conversationId: "33333333-3333-4333-8333-333333333333" },
      },
      {
        fn: confirmAssistantAction,
        data: {
          plan: [
            {
              op: "update",
              summary: "Update account",
              preview: [],
            },
          ],
        },
      },
    ];

    for (const endpoint of endpoints) {
      const { supabase } = client({ permission: false });
      await expect(
        (endpoint.fn as (args: unknown) => Promise<unknown>)({
          data: endpoint.data,
          context: { userId: USER_ID, supabase },
        }),
      ).rejects.toThrow("You do not have permission to use Polaris.");
      expect(supabase.from).not.toHaveBeenCalled();
    }
  });

  it("enforces ai.assistant on the legacy AI tools endpoints", async () => {
    const endpoints: Array<{ fn: unknown; data: Record<string, unknown> }> = [
      { fn: transcribeNote, data: { audio_base64: "YXVkaW8=", mime: "audio/webm" } },
      { fn: parseDictation, data: { transcript: "Met the client today." } },
      { fn: assistantScopePeople, data: {} },
      { fn: activitySummary, data: { days: 7 } },
    ];

    for (const endpoint of endpoints) {
      const { supabase } = client({ permission: false });
      await expect(
        (endpoint.fn as (args: unknown) => Promise<unknown>)({
          data: endpoint.data,
          context: { userId: USER_ID, supabase },
        }),
      ).rejects.toThrow("You do not have permission to use Polaris.");
      expect(supabase.from).not.toHaveBeenCalled();
    }
  });

  it("derives scoped account context through the caller client and ignores spoofed pageContext", async () => {
    const { supabase, accountIds } = client();

    await invoke(supabase, {
      context: { entity: "account", id: ACCOUNT_ID },
      pageContext: 'the account record for "Spoofed Co" (account id attacker)',
    });

    expect(accountIds).toEqual([ACCOUNT_ID]);
    expect(state.turn.mock.calls[0][4]).toBe(
      `the verified account record for "Verified Co" (account id ${ACCOUNT_ID})`,
    );
    expect(state.turn.mock.calls[0][4]).not.toContain("Spoofed Co");
  });

  it("does not distinguish an RLS-hidden account from a nonexistent account", async () => {
    for (const options of [{ account: null }, { accountError: true }] as const) {
      const { supabase } = client(options);
      await expect(
        invoke(supabase, { context: { entity: "account", id: ACCOUNT_ID } }),
      ).rejects.toThrow("Account not found or unavailable.");
    }
    expect(state.turn).not.toHaveBeenCalled();
  });

  it("preserves legacy pageContext for the global assistant", async () => {
    const { supabase } = client();

    await invoke(supabase, { pageContext: "Pipeline" });

    expect(supabase.from).not.toHaveBeenCalledWith("accounts");
    expect(state.turn.mock.calls[0][4]).toBe("Pipeline");
  });

  it("rejects malformed account identifiers at the input boundary", async () => {
    const { supabase } = client();

    expect(() => invoke(supabase, { context: { entity: "account", id: "not-a-uuid" } })).toThrow();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
