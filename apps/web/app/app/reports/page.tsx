import type { Metadata } from "next";
import { ReportsView } from "@/components/crm/ReportsView";

export const metadata: Metadata = { title: "Reports · Sir Libz" };

export default function Page() {
  return <ReportsView />;
}
