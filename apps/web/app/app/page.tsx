import type { Metadata } from "next";
import { CommandCentre } from "@/components/dashboard/CommandCentre";

export const metadata: Metadata = { title: "Command Centre · Sir Libz" };

export default function CommandCentrePage() {
  return <CommandCentre />;
}
