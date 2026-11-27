"use client";

import { useCallback, useEffect, useState } from "react";
import type { Memory, MemoryCategory } from "@/lib/api";
import { api, MEMORY_CATEGORIES } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import { PinIcon, TrashIcon } from "../icons";

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  general: "General",
  preference: "Preference",
  fact: "Fact",
  goal: "Goal",
  person: "Person",
  project: "Project",
};

export function MemoryView() {
  const { workspace } = useWorkspace();
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("general");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      setMemories((await api.memories(workspace.id)).memories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load memories.");
    }
  }, [workspace]);

  useEffect(() => {
    setMemories(null);
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !content.trim()) return;
    const text = content.trim();
    // Clear immediately so anything typed while saving is not wiped afterwards.
    setContent("");
    setBusy(true);
    setError(null);
    try {
      await api.createMemory(workspace.id, { content: text, category });
      await load();
    } catch (err) {
      setContent((current) => current || text); // give the text back on failure
      setError(err instanceof Error ? err.message : "Could not save the memory.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(m: Memory) {
    try {
      await api.updateMemory(m.id, { pinned: !m.pinned });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the memory.");
    }
  }

  async function remove(m: Memory) {
    if (!window.confirm("Delete this memory? Jarvis will no longer use it.")) return;
    try {
      await api.deleteMemory(m.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the memory.");
    }
  }

  const canWrite = workspace && workspace.role !== "viewer";

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Brain · {workspace?.name ?? "…"}</p>
        <h1>Memory</h1>
        <p className="muted">
          Things Jarvis should always know in this workspace. Only you can see your memories, and
          {workspace?.type === "business"
            ? " business memories never appear in Personal mode."
            : " personal memories never appear in Business mode."}{" "}
          Pinned memories are used first.
        </p>
      </header>

      {canWrite && (
        <form className="panel memory-form" onSubmit={(e) => void add(e)}>
          <label>
            Remember…
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="e.g. I prefer meetings after 10am, or: Our main client is Acme Corp."
              maxLength={1000}
              rows={2}
            />
          </label>
          <div className="memory-form-row">
            <label className="memory-category">
              Type
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as MemoryCategory)}
              >
                {MEMORY_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small">{content.length}/1000</span>
            <button className="btn btn-primary" disabled={busy || !content.trim()}>
              {busy ? "Saving…" : "Save memory"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel memory-list-panel" aria-label="Saved memories">
        <h2 className="panel-label">Saved memories {memories ? `· ${memories.length}` : ""}</h2>
        {memories === null ? (
          <p className="muted small">Loading…</p>
        ) : memories.length === 0 ? (
          <p className="muted small">
            No memories yet. Add one above, or tap “Remember” on any message in a chat.
          </p>
        ) : (
          <ul className="memory-list">
            {memories.map((m) => (
              <li key={m.id} className={`memory ${m.pinned ? "memory-pinned" : ""}`}>
                <div className="memory-body">
                  <p className="memory-content">{m.content}</p>
                  <p className="memory-meta">
                    <span className="tag">{CATEGORY_LABELS[m.category]}</span>
                    {m.pinned && <span className="tag tag-ok">Pinned</span>}
                    {m.source === "message" && <span className="muted small">from a chat</span>}
                  </p>
                </div>
                <div className="memory-actions">
                  <button
                    className={`btn btn-ghost icon-btn ${m.pinned ? "is-on" : ""}`}
                    onClick={() => void togglePin(m)}
                    aria-label={m.pinned ? "Unpin memory" : "Pin memory"}
                    aria-pressed={m.pinned}
                    title={m.pinned ? "Unpin" : "Pin"}
                  >
                    <PinIcon />
                  </button>
                  <button
                    className="btn btn-ghost icon-btn"
                    onClick={() => void remove(m)}
                    aria-label="Delete memory"
                    title="Delete"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
