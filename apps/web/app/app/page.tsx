import type { Metadata } from "next";
import { CommandCentre } from "@/components/dashboard/CommandCentre";

export const metadata: Metadata = { title: "Command Centre · Jarvis" };

export default function CommandCentrePage() {
  return <CommandCentre />;
}
