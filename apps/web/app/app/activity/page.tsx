import type { Metadata } from "next";
import { ActivityView } from "@/components/activity/ActivityView";

export const metadata: Metadata = { title: "Activity · Sir Libz" };

export default function ActivityPage() {
  return <ActivityView />;
}
