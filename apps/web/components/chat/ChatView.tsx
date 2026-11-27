"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, Message } from "@/lib/api";
import { api, ApiError, sendMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import {
  readAloudPreference,
  setReadAloudPreference,
  speak,
  speechOutputSupported,
  stopSpeaking,
} from "@/lib/voice";
import {
  BookmarkIcon,
  CloseIcon,
  HistoryIcon,
  PlusIcon,
  SendIcon,
  SpeakerIcon,
  StopIcon,
} from "../icons";
import { MicButton } from "../MicButton";
import { RememberDialog } from "../memory/RememberDialog";
import { Markdown } from "../Markdown";

type UiMessage = Pick<Message, "id" | "role" | "content" | "status"> & { model?: string | null };

export function ChatView({ conversationId }: { conversationId: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const { workspace, me } = useWorkspace();
  const [activeId, setActiveId] = useState<string | null>(conversationId);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [remembering, setRemembering] = useState<UiMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canSpeak, setCanSpeak] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const readAloudRef = useRef(false);

  useEffect(() => {
    setCanSpeak(speechOutputSupported());
    const pref = readAloudPreference();
    setReadAloud(pref);
    readAloudRef.current = pref;
    return () => stopSpeaking();
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const autoSent = useRef(false);
  const loadedWorkspace = useRef<string | null>(null);

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

  const refreshConversations = useCallback(
    (wsId: string) =>
      api
        .conversations(wsId)
        .then((r) => setConversations(r.conversations))
        .catch(handleError),
    [handleError],
  );

  // Load history for the current workspace; switching mode starts a fresh chat.
  useEffect(() => {
    if (!workspace) return;
    void refreshConversations(workspace.id);
    if (loadedWorkspace.current && loadedWorkspace.current !== workspace.id) {
      abortRef.current?.abort();
      setActiveId(null);
      setMessages([]);
      window.history.replaceState(null, "", "/app/chat");
    }
    loadedWorkspace.current = workspace.id;
  }, [workspace, refreshConversations]);

  // Open the conversation named in the URL.
  useEffect(() => {
    if (!conversationId) return;
    api
      .conversation(conversationId)
      .then((data) => setMessages(data.messages))
      .catch(handleError);
  }, [conversationId, handleError]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? draft).trim();
      if (!content || streaming || !workspace) return;
      setError(null);
      setDraft("");
      setStreaming(true);
      stopSpeaking();

      const controller = new AbortController();
      abortRef.current = controller;
      const replyId = `pending-${Date.now()}`;

      try {
        let id = activeId;
        if (!id) {
          id = (await api.createConversation(workspace.id)).conversation.id;
          setActiveId(id);
          // Update the address without remounting mid-stream.
          window.history.replaceState(null, "", `/app/chat/${id}`);
        }

        setMessages((prev) => [
          ...prev,
          { id: `user-${Date.now()}`, role: "user", content, status: "complete" },
          { id: replyId, role: "assistant", content: "", status: "partial" },
        ]);
        const update = (patch: Partial<UiMessage>) =>
          setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, ...patch } : m)));

        let reply = "";
        for await (const evt of sendMessage(id, content, controller.signal)) {
          if (evt.event === "model") update({ model: evt.data.model });
          else if (evt.event === "delta") {
            reply += evt.data.text;
            update({ content: reply });
          } else if (evt.event === "done") {
            if (readAloudRef.current && reply) speak(reply);
            update({
              status: evt.data.status === "partial" ? "partial" : "complete",
              id: evt.data.messageId ?? replyId,
            });
          } else if (evt.event === "error") {
            update({ status: "error" });
            setError(evt.data.message);
          }
        }
        void refreshConversations(workspace.id);
      } catch (err) {
        if (controller.signal.aborted) return;
        setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content === "")));
        handleError(err);
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [activeId, draft, streaming, workspace, refreshConversations, handleError],
  );

  // A prompt handed over from the Command Centre (?q=...) is sent once.
  useEffect(() => {
    const q = params.get("q");
    if (q && workspace && !conversationId && !autoSent.current) {
      autoSent.current = true;
      window.history.replaceState(null, "", "/app/chat");
      void send(q);
    }
  }, [params, workspace, conversationId, send]);

  const canChat = workspace && workspace.role !== "viewer";
  const title =
    conversations.find((c) => c.id === activeId)?.title ??
    (activeId ? "Conversation" : "New conversation");
  const firstName = me?.profile.displayName?.split(" ")[0];

  const history = (
    <div className="history">
      <Link
        href="/app/chat"
        className="btn btn-primary history-new"
        onClick={() => setHistoryOpen(false)}
      >
        <PlusIcon /> New chat
      </Link>
      <p className="panel-label">History · {workspace?.name ?? ""}</p>
      <nav className="history-list">
        {conversations.length === 0 && <p className="muted small">No conversations yet.</p>}
        {conversations.map((c) => (
          <Link
            key={c.id}
            href={`/app/chat/${c.id}`}
            className={`history-item ${c.id === activeId ? "active" : ""}`}
            onClick={() => setHistoryOpen(false)}
          >
            {c.title ?? "Untitled chat"}
          </Link>
        ))}
      </nav>
    </div>
  );

  return (
    <div className={`chat-layout ${historyOpen ? "history-open" : ""}`}>
      <aside className="chat-history panel">{history}</aside>
      {historyOpen && (
        <div className="sheet-backdrop" onClick={() => setHistoryOpen(false)} role="presentation">
          <aside
            className="sheet panel"
            onClick={(e) => e.stopPropagation()}
            aria-label="Conversation history"
          >
            <button
              className="btn btn-ghost icon-btn sheet-close"
              onClick={() => setHistoryOpen(false)}
              aria-label="Close history"
            >
              <CloseIcon />
            </button>
            {history}
          </aside>
        </div>
      )}

      <section className="chat panel">
        <header className="chat-head">
          <button
            className="btn btn-ghost icon-btn mobile-only"
            onClick={() => setHistoryOpen(true)}
            aria-label="Open history"
          >
            <HistoryIcon />
          </button>
          <h1 className="chat-title">{title}</h1>
          {canSpeak && (
            <button
              className={`btn btn-ghost icon-btn ${readAloud ? "is-on" : ""}`}
              onClick={() => {
                const next = !readAloud;
                setReadAloud(next);
                readAloudRef.current = next;
                setReadAloudPreference(next);
                if (!next) stopSpeaking();
              }}
              aria-label={readAloud ? "Stop reading replies aloud" : "Read replies aloud"}
              aria-pressed={readAloud}
              title={readAloud ? "Reading replies aloud" : "Read replies aloud"}
            >
              <SpeakerIcon />
            </button>
          )}
          <Link
            href="/app/chat"
            className="btn btn-ghost icon-btn"
            aria-label="New chat"
            title="New chat"
          >
            <PlusIcon />
          </Link>
        </header>

        <div className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="empty">
              <div className="orb orb-sm" aria-hidden="true" />
              <h2>{firstName ? `How can I help, ${firstName}?` : "How can I help?"}</h2>
              <p className="muted">
                {workspace?.type === "business"
                  ? `Business mode · ${workspace.name}. Conversations stay private to you.`
                  : "Personal mode. Your conversations are private to you."}
              </p>
            </div>
          )}
          {messages.map((m) => (
            <article
              key={m.id}
              className={`msg msg-${m.role} ${m.status === "error" ? "msg-error" : ""}`}
            >
              <div className="msg-body">
                {m.role === "assistant" ? (
                  m.content ? (
                    <Markdown>{m.content}</Markdown>
                  ) : m.status === "partial" ? (
                    <span className="typing" aria-label="Jarvis is thinking" />
                  ) : (
                    <span className="muted">No reply.</span>
                  )
                ) : (
                  m.content
                )}
              </div>
              <div className="msg-meta">
                {m.role === "assistant" && m.model && <span>{m.model}</span>}
                {m.content && m.status !== "partial" && canChat && (
                  <button
                    className="msg-action"
                    onClick={() => setRemembering(m)}
                    aria-label="Remember this message"
                  >
                    <BookmarkIcon width={14} height={14} /> Remember
                  </button>
                )}
              </div>
            </article>
          ))}
          <div ref={endRef} />
        </div>

        {notice && (
          <p className="alert alert-info chat-alert" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="alert alert-error chat-alert" role="alert">
            {error}
          </p>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
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
          <MicButton onText={setDraft} onError={setError} disabled={!canChat || streaming} />
          {streaming ? (
            <button
              type="button"
              className="btn btn-secondary icon-btn"
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-primary icon-btn"
              disabled={!draft.trim() || !canChat}
              aria-label="Send"
            >
              <SendIcon />
            </button>
          )}
        </form>
      </section>

      {remembering && workspace && (
        <RememberDialog
          workspaceId={workspace.id}
          initial={remembering.content}
          // Only persisted user messages can be cited; optimistic ids are not UUIDs.
          {...(remembering.role === "user" && UUID.test(remembering.id)
            ? { sourceMessageId: remembering.id }
            : {})}
          onClose={() => setRemembering(null)}
          onSaved={() => {
            setRemembering(null);
            setNotice("Saved to memory. Jarvis will use it in this workspace.");
            setTimeout(() => setNotice(null), 4000);
          }}
        />
      )}
    </div>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
