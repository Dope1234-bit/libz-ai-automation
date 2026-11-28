import type { Metadata } from "next";
import { ProjectsView } from "@/components/crm/ProjectsView";

export const metadata: Metadata = { title: "Projects · Sir Libz" };

export default function Page() {
  return <ProjectsView />;
}
