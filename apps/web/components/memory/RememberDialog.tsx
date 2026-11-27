"use client";

import { useState } from "react";
import type { MemoryCategory } from "@/lib/api";
import { api, MEMORY_CATEGORIES } from "@/lib/api";

/** Save (an edited version of) a chat message as a memory in the current workspace. */
export function RememberDialog({
  workspaceId,
  initial,
  sourceMessageId,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  initial: string;
  /** Only the user's own saved messages can be cited as a source. */
  sourceMessageId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState(initial.slice(0, 1000));
  const [category, setCategory] = useState<MemoryCategory>("fact");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remember-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.createMemory(workspaceId, {
              content: content.trim(),
              category,
              ...(sourceMessageId ? { sourceMessageId } : {}),
            });
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save the memory.");
            setBusy(false);
          }
        }}
      >
        <p className="eyebrow">Memory</p>
        <h2 id="remember-title">Remember this</h2>
        <p className="muted small">Edit it into a short note Jarvis should always know here.</p>
        <label>
          Note
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            maxLength={1000}
            required
            autoFocus
          />
        </label>
        <label>
          Type
          <select value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c[0]!.toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !content.trim()}>
            {busy ? "Saving…" : "Save memory"}
          </button>
        </div>
      </form>
    </div>
  );
}
