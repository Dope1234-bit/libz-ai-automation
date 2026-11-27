import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jarvis",
  description: "Your personal and business AI assistant by Libz AI Automation.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0f" },
  ],
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
