import type { Metadata } from "next";
import { PipelineView } from "@/components/crm/PipelineView";

export const metadata: Metadata = { title: "Pipeline · Jarvis" };

export default function Page() {
  return <PipelineView />;
}
