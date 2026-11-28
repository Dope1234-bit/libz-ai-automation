import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";

// Access is enforced by proxy.ts (signed-out users are redirected) and by the API.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
