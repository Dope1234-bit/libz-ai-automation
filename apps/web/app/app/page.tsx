import type { Metadata } from "next";
import { ChatApp } from "./chat-app";

export const metadata: Metadata = { title: "Jarvis" };

// Access is enforced by proxy.ts (redirects signed-out users) and by the API.
export default function AppPage() {
  return <ChatApp />;
}
