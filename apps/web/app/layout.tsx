import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sir Libz",
  description: "Sir Libz, the Libz Enterprises manager: your business and personal AI assistant.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#05070d",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading request headers makes every page render per request, which the
  // per-request CSP nonce set in proxy.ts requires (Next applies it to its scripts).
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
