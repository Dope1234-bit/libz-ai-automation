import type { Metadata } from "next";
import { ProjectsView } from "@/components/crm/ProjectsView";

export const metadata: Metadata = { title: "Projects · Jarvis" };

export default function Page() {
  return <ProjectsView />;
}
