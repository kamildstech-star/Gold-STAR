import { createFileRoute } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";

export const Route = createFileRoute("/_authenticated/chat/")({
  component: ChatEmpty,
});

function ChatEmpty() {
  return (
    <div className="p-3 text-[13px] text-muted-foreground">
      Select a conversation, or start a new one.
    </div>
  );
}
