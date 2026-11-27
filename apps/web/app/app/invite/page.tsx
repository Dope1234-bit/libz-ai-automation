import type { Metadata } from "next";
import { Suspense } from "react";
import { AcceptInvite } from "@/components/settings/AcceptInvite";

export const metadata: Metadata = { title: "Invitation · Jarvis", referrer: "no-referrer" };

export default function InvitePage() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  );
}
