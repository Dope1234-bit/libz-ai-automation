"use client";

import Link from "next/link";
import { navFor } from "@/components/AppShell";
import { useWorkspace } from "@/lib/workspace-context";

export default function MorePage() {
  const { mode } = useWorkspace();
  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">{mode === "business" ? "Business mode" : "Personal mode"}</p>
        <h1>More</h1>
      </header>
      <nav className="panel more-list" aria-label="More sections">
        {navFor(mode).more.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className="list-link more-link">
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
