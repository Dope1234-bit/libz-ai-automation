import type { Metadata } from "next";
import { TasksView } from "@/components/crm/TasksView";

export const metadata: Metadata = { title: "Tasks · Jarvis" };

export default function Page() {
  return <TasksView />;
}
