import Link from "next/link";

export default function HomePage() {
  return (
    <main className="landing">
      <p className="eyebrow">Libz Enterprises Manager</p>
      <h1>Sir Libz</h1>
      <p className="lede">
        Your personal and business AI assistant. Private conversations, secure workspaces, and the
        AI models you choose.
      </p>
      <div className="actions">
        <Link className="btn btn-primary" href="/app">
          Open Sir Libz
        </Link>
        <Link className="btn btn-secondary" href="/login">
          Sign in
        </Link>
      </div>
    </main>
  );
}
