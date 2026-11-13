import { createFileRoute } from "@tanstack/react-router";
import { Bot, Mic } from "lucide-react";

import { AssistantDictation } from "@/components/assistant-dictation";
import { AssistantSummary } from "@/components/assistant-summary";
import { PageHeader } from "@/components/ui-density";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMyPermissions } from "@/lib/permissions";

export const Route = createFileRoute("/_authenticated/assistant")({
  component: AssistantPage,
  head: () => ({
    meta: [
      { title: "AI tools · Recovery Hub" },
      {
        name: "description",
        content:
          "Dictate field notes and get grounded activity read-outs across locations and reps.",
      },
      { property: "og:title", content: "AI tools · Recovery Hub" },
      {
        property: "og:description",
        content:
          "Voice-first note capture and real-data activity summaries for Gold Star Restoration.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function AssistantPage() {
  const { loading, allowed } = useMyPermissions();

  if (loading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (!allowed.has("ai.assistant")) {
    return (
      <div className="mx-auto max-w-lg p-4 text-sm text-muted-foreground">
        Polaris is not part of your access. Ask an administrator to enable the AI assistant
        capability.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-3 p-4">
      <PageHeader title="AI tools" subtitle="Voice notes and activity read-outs" />
      <Tabs defaultValue="dictate">
        <TabsList>
          <TabsTrigger value="dictate" className="gap-2">
            <Mic className="size-4" /> Dictate
          </TabsTrigger>
          <TabsTrigger value="summary" className="gap-2">
            <Bot className="size-4" /> Activity read-out
          </TabsTrigger>
        </TabsList>
        <TabsContent value="dictate" className="pt-4">
          <AssistantDictation />
        </TabsContent>
        <TabsContent value="summary" className="pt-4">
          <AssistantSummary />
        </TabsContent>
      </Tabs>
    </div>
  );
}
