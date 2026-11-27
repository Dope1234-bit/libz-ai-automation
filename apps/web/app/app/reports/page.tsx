import type { Metadata } from "next";
import { ReportsView } from "@/components/crm/ReportsView";

export const metadata: Metadata = { title: "Reports · Jarvis" };

export default function Page() {
  return <ReportsView />;
}
