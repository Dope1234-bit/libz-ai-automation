import type { Metadata } from "next";
import { ProspectsView } from "@/components/crm/ProspectsView";

export const metadata: Metadata = { title: "Prospects · Sir Libz" };

export default function Page() {
  return <ProspectsView />;
}
