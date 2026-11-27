import type { Metadata } from "next";
import { ClientsView } from "@/components/crm/ClientsView";

export const metadata: Metadata = { title: "Clients · Jarvis" };

export default function Page() {
  return <ClientsView />;
}
