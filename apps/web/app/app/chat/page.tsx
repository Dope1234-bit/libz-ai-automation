import type { Metadata } from "next";
import { Suspense } from "react";
import { ChatView } from "@/components/chat/ChatView";

export const metadata: Metadata = { title: "Chat · Jarvis" };

export default function ChatPage() {
  return (
    <Suspense>
      <ChatView conversationId={null} />
    </Suspense>
  );
}
