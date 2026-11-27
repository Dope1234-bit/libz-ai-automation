"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, Me, Message } from "@/lib/api";
import { api, ApiError, sendMessage } from "@/lib/api";
import { getSupabase } from "@/lib/supabase/client";

type UiMessage = Pick<Message, "id" | "role" | "content" | "status"> & { model?: string | null };

const STORAGE_KEY = "jarvis.workspace";

function readStoredWorkspace(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeWorkspace(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage unavailable (private mode); the default workspace is used next time.
  }
}

export function ChatApp() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Something went wrong.");
    },
    [router],
  );

  // Load the user and pick a workspace.
  useEffect(() => {
    api
      .me()
      .then((data) => {
        setMe(data);
        const stored = readStoredWorkspace();
        const initial = data.workspaces.find((w) => w.id === stored) ?? data.workspaces[0];
        setWorkspaceId(initial?.id ?? null);
      })
      .catch(handleError);
  }, [handleError]);

  const refreshConversations = useCallback(
    (wsId: string) =>
      api
        .conversations(wsId)
        .then((r) => setConversations(r.conversations))
        .catch(handleError),
    [handleError],
  );

  useEffect(() => {
    if (!workspaceId) return;
    storeWorkspace(workspaceId);
    setActiveId(null);
    setMessages([]);
    void refreshConversations(workspaceId);
  }, [workspaceId, refreshConversations]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function openConversation(id: string) {
    abortRef.current?.abort();
    setActiveId(id);
    setSidebarOpen(false);
    setError(null);
    try {
      const data = await api.conversation(id);
      setMessages(data.messages);
    } catch (err) {
      handleError(err);
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
    setError(null);
    setSidebarOpen(false);
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || streaming || !workspaceId) return;
    setError(null);
    setDraft("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const replyId = `pending-${Date.now()}`;

    try {
      let conversationId = activeId;
      if (!conversationId) {
        conversationId = (await api.createConversation(workspaceId)).conversation.id;
        setActiveId(conversationId);
      }

      setMessages((prev) => [
        ...prev,
        { id: `user-${Date.now()}`, role: "user", content, status: "complete" },
        { id: replyId, role: "assistant", content: "", status: "partial" },
      ]);

      const update = (patch: Partial<UiMessage>) =>
        setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, ...patch } : m)));

      let text = "";
      for await (const evt of sendMessage(conversationId, content, controller.signal)) {
        if (evt.event === "model") update({ model: evt.data.model });
        else if (evt.event === "delta") {
          text += evt.data.text;
          update({ content: text });
        } else if (evt.event === "done") {
          update({
            status: evt.data.status === "partial" ? "partial" : "complete",
            id: evt.data.messageId ?? replyId,
          });
        } else if (evt.event === "error") {
          update({ status: "error" });
          setError(evt.data.message);
        }
      }
      void refreshConversations(workspaceId);
    } catch (err) {
      if (controller.signal.aborted) return;
      setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content === "")));
      handleError(err);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function signOut() {
    abortRef.current?.abort();
    await getSupabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const workspace = me?.workspaces.find((w) => w.id === workspaceId);
  const canChat = workspace && workspace.role !== "viewer";
  const activeTitle = conversations.find((c) => c.id === activeId)?.title;

  return (
    <div className={`shell-app ${sidebarOpen ? "sidebar-open" : ""}`}>
      <aside className="sidebar" aria-label="Conversations">
        <div className="sidebar-head">
          <span className="brand">Jarvis</span>
          <button
            className="btn btn-ghost icon-only mobile-only"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>

        <label className="field">
          <span className="field-label">Workspace</span>
          <select
            value={workspaceId ?? ""}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={!me}
          >
            {me?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} {w.type === "business" ? `· ${w.role}` : ""}
              </option>
            ))}
          </select>
        </label>

        <button className="btn btn-primary" onClick={newChat} disabled={!canChat}>
          + New chat
        </button>

        <nav className="conv-list">
          {conversations.length === 0 && <p className="muted small">No conversations yet.</p>}
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`conv-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => void openConversation(c.id)}
            >
              {c.title ?? "Untitled chat"}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="who">
            <span className="who-name">{me?.profile.displayName ?? me?.user.email ?? "…"}</span>
            {me?.profile.displayName && <span className="muted small">{me.user.email}</span>}
          </div>
          <button className="btn btn-ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="chat">
        <header className="chat-head">
          <button
            className="btn btn-ghost icon-only mobile-only"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
          <h1 className="chat-title">{activeTitle ?? "New chat"}</h1>
          {workspace && <span className="badge">{workspace.name}</span>}
        </header>

        <section className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty">
              <h2>How can I help{me?.profile.displayName ? `, ${me.profile.displayName}` : ""}?</h2>
              <p className="muted">
                Ask anything. Your conversations are private to you
                {workspace?.type === "business" ? ", even within this workspace" : ""}.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <article
              key={m.id}
              className={`msg msg-${m.role} ${m.status === "error" ? "msg-error" : ""}`}
            >
              <div className="msg-body">
                {m.content ||
                  (m.status === "partial" ? (
                    <span className="typing" aria-label="Jarvis is typing" />
                  ) : m.status === "error" ? (
                    "No reply."
                  ) : (
                    ""
                  ))}
              </div>
              {m.role === "assistant" && m.model && <div className="msg-meta">{m.model}</div>}
            </article>
          ))}
          <div ref={endRef} />
        </section>

        {error && (
          <p className="alert alert-error chat-alert" role="alert">
            {error}
          </p>
        )}

        <form className="composer" onSubmit={(e) => void send(e)}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={canChat ? "Message Jarvis…" : "Viewers can't chat in this workspace"}
            rows={1}
            maxLength={20_000}
            disabled={!canChat}
            aria-label="Message"
          />
          {streaming ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => abortRef.current?.abort()}
            >
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!draft.trim() || !canChat}>
              Send
            </button>
          )}
        </form>
      </main>
    </div>
  );
}
