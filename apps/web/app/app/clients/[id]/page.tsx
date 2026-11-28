import type { Metadata } from "next";
import { ClientDetail } from "@/components/crm/ClientDetail";

export const metadata: Metadata = { title: "Client · Sir Libz" };

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ClientDetail id={id} />;
}
