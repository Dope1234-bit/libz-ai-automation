import type { Metadata } from "next";
import { TasksView } from "@/components/crm/TasksView";

export const metadata: Metadata = { title: "Tasks · Sir Libz" };

export default function Page() {
  return <TasksView />;
}
