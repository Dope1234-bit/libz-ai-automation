import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CampaignView } from "@/components/crm/CampaignView";

export const metadata: Metadata = { title: "Campaign · Sir Libz" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <CampaignView id={id} />;
}
