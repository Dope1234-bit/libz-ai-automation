import type { Metadata } from "next";
import { OutreachView } from "@/components/crm/OutreachView";

export const metadata: Metadata = { title: "Outreach · Sir Libz" };

export default function Page() {
  return <OutreachView />;
}
