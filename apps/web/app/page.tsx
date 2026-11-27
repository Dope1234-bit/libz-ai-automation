import { WORKSPACE_TYPES } from "@jarvis/shared";

export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Libz AI Automation</p>
      <h1>Jarvis</h1>
      <p className="lede">
        Your personal and business AI assistant. The dashboard is under construction.
      </p>
      <ul className="tags" aria-label="Workspace types">
        {WORKSPACE_TYPES.map((type) => (
          <li key={type}>{type} workspace</li>
        ))}
      </ul>
    </main>
  );
}
