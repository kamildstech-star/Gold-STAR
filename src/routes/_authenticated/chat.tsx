import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { ChatList } from "@/components/chat/chat-list";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({
    meta: [
      { title: "Chat — Recovery Hub" },
      {
        name: "description",
        content:
          "Internal messaging for Gold Star Restoration: voice notes, photos, and shared records with your team.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ChatLayout,
});

function ChatLayout() {
  const params = useParams({ strict: false }) as {
    conversationId?: string;
  };
  const hasConv = !!params.conversationId;

  return (
    <div className="h-full">
      <div className="grid h-full grid-cols-1 md:grid-cols-[320px_1fr]">
        {/* Left rail: hidden on mobile when a conversation is open */}
        <aside className={cn("min-h-0 border-r bg-card", hasConv ? "hidden md:block" : "block")}>
          <ChatList />
        </aside>
        <section className={cn("min-h-0 bg-background", !hasConv && "hidden md:block")}>
          <Outlet />
        </section>
      </div>
    </div>
  );
}
