import { createFileRoute } from "@tanstack/react-router";

import { ChatWindow } from "@/components/chat/chat-window";

export const Route = createFileRoute("/_authenticated/chat/$conversationId")({
  component: ChatConversation,
});

function ChatConversation() {
  const { conversationId } = Route.useParams();
  return <ChatWindow key={conversationId} conversationId={conversationId} />;
}
