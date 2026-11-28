"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, Message, Proposal } from "@/lib/api";
import { api, ApiError, sendMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace-context";
import {
  listenOnce,
  readAloudPreference,
  setReadAloudPreference,
  speak,
  speechInputSupported,
  speechOutputSupported,
  stopSpeaking,
  unlockAudio,
} from "@/lib/voice";
import {
  BookmarkIcon,
  CloseIcon,
  HistoryIcon,
  LiveIcon,
  PlusIcon,
  SendIcon,
  SpeakerIcon,
  StopIcon,
} from "../icons";
import { MicButton } from "../MicButton";
import { RememberDialog } from "../memory/RememberDialog";
import { Markdown } from "../Markdown";
import { ProposalCard } from "./ProposalCard";

interface ToolActivity {
  id: string;
  name: string;
  status: "running" | "done";
  label?: string;
}

type UiMessage = Pick<Message, "id" | "role" | "content" | "status"> & {
  model?: string | null;
  created_at?: string;
  tools?: ToolActivity[];
  proposals?: Proposal[];
};

/** What Sir Libz is doing while a tool runs (labels for finished tools come from the API). */
const RUNNING_LABELS: Record<string, string> = {
  search_clients: "Searching clients…",
  get_client: "Reading the client record…",
  pipeline_summary: "Checking the pipeline…",
  list_deals: "Listing deals…",
  list_tasks: "Checking tasks…",
  recent_activities: "Reading recent activity…",
  propose_task: "Preparing a task…",
  propose_activity_note: "Preparing a log entry…",
  find_prospects: "Searching Google Maps…",
  propose_lead: "Preparing a lead…",
};

/** Show each saved proposal under the reply that produced it. */
function attachProposals(messages: Message[], proposals: Proposal[]): UiMessage[] {
  const out: UiMessage[] = messages.map((m) => ({ ...m }));
  for (const proposal of proposals) {
    const target =
      out.find((m) => m.role === "assistant" && (m.created_at ?? "") >= proposal.created_at) ??
      out.filter((m) => m.role === "assistant").at(-1);
    if (target) target.proposals = [...(target.proposals ?? []), proposal];
  }
  return out;
}

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
      .then((data) => setMessages(attachProposals(data.messages, data.proposals ?? [])))
      .catch(handleError);
  }, [conversationId, handleError]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = useCallback(
    async (text?: string, opts: { live?: boolean } = {}): Promise<string> => {
      const content = (text ?? draft).trim();
      if (!content || streaming || !workspace) return "";
      setError(null);
      setDraft("");
      setStreaming(true);
      stopSpeaking();

      const controller = new AbortController();
      abortRef.current = controller;
      const replyId = `pending-${Date.now()}`;
      let reply = "";

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

        for await (const evt of sendMessage(id, content, controller.signal)) {
          if (evt.event === "model") update({ model: evt.data.model });
          else if (evt.event === "tool") {
            const activity = evt.data;
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== replyId) return m;
                const others = (m.tools ?? []).filter((t) => t.id !== activity.id);
                return { ...m, tools: [...others, activity] };
              }),
            );
          } else if (evt.event === "proposal") {
            const proposal = evt.data;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === replyId ? { ...m, proposals: [...(m.proposals ?? []), proposal] } : m,
              ),
            );
          } else if (evt.event === "delta") {
            reply += evt.data.text;
            update({ content: reply });
          } else if (evt.event === "done") {
            // Live mode speaks the reply itself (and then listens again).
            if (!opts.live && readAloudRef.current && reply) void speak(reply);
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
        if (controller.signal.aborted) return "";
        setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content === "")));
        handleError(err);
        return "";
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
      return reply;
    },
    [activeId, draft, streaming, workspace, refreshConversations, handleError],
  );

  // ------------------------------------------------------------- Live mode
  // Hands-free conversation: listen → send → Sir Libz speaks → listen again.
  const sendRef = useRef(send);
  sendRef.current = send;
  const [live, setLive] = useState<null | "listening" | "thinking" | "speaking">(null);
  const [heard, setHeard] = useState("");
  const [canLive, setCanLive] = useState(false);
  const liveRef = useRef(false);
  const listenRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    setCanLive(speechInputSupported());
    return () => {
      liveRef.current = false;
      listenRef.current?.stop();
    };
  }, []);

  async function startLive() {
    unlockAudio(); // must happen inside the tap
    setError(null);
    liveRef.current = true;
    let silentTurns = 0;
    while (liveRef.current) {
      setLive("listening");
      setHeard("");
      let said: string;
      try {
        const session = listenOnce(setHeard);
        listenRef.current = session;
        said = await session.result;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Voice input failed.");
        break;
      } finally {
        listenRef.current = null;
      }
      if (!liveRef.current) break;
      if (!said) {
        if (++silentTurns >= 3) break;
        continue;
      }
      silentTurns = 0;
      setLive("thinking");
      const reply = await sendRef.current(said, { live: true });
      if (!liveRef.current || !reply) break;
      setLive("speaking");
      await speak(reply);
    }
    liveRef.current = false;
    setLive(null);
    setHeard("");
  }

  function stopLive() {
    liveRef.current = false;
    listenRef.current?.stop();
    stopSpeaking();
    setLive(null);
  }

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
          {canLive && canChat && (
            <button
              className={`btn btn-ghost live-btn ${live ? "is-on" : ""}`}
              onClick={() => (live ? stopLive() : void startLive())}
              aria-pressed={!!live}
              aria-label={live ? "End live conversation" : "Talk live with Sir Libz"}
              title={live ? "End live conversation" : "Talk live with Sir Libz"}
            >
              <LiveIcon /> <span>{live ? "End" : "Live"}</span>
            </button>
          )}
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
              {m.tools && m.tools.length > 0 && (
                <ul className="tool-trail" aria-label="What Sir Libz checked">
                  {m.tools.map((t) => (
                    <li key={t.id} className={t.status === "running" ? "is-running" : ""}>
                      {t.status === "running"
                        ? (RUNNING_LABELS[t.name] ?? "Working…")
                        : `✓ ${t.label ?? t.name}`}
                    </li>
                  ))}
                </ul>
              )}
              <div className="msg-body">
                {m.role === "assistant" ? (
                  m.content ? (
                    <Markdown>{m.content}</Markdown>
                  ) : m.status === "partial" ? (
                    <span className="typing" aria-label="Sir Libz is thinking" />
                  ) : (
                    <span className="muted">No reply.</span>
                  )
                ) : (
                  m.content
                )}
              </div>
              {m.proposals?.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  canDecide={!!canChat}
                  onChange={(updated) =>
                    setMessages((prev) =>
                      prev.map((msg) =>
                        msg.id === m.id
                          ? {
                              ...msg,
                              proposals: (msg.proposals ?? []).map((x) =>
                                x.id === updated.id ? updated : x,
                              ),
                            }
                          : msg,
                      ),
                    )
                  }
                />
              ))}
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

        {live && (
          <div className="live-panel" role="status" aria-live="polite">
            <div className={`orb orb-sm live-orb live-${live}`} aria-hidden="true" />
            <div className="live-text">
              <p className="live-state">
                {live === "listening"
                  ? "Listening…"
                  : live === "thinking"
                    ? "Sir Libz is thinking…"
                    : "Sir Libz is speaking…"}
              </p>
              {heard && live === "listening" && <p className="muted small">“{heard}”</p>}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={stopLive}>
              End
            </button>
          </div>
        )}

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
            placeholder={canChat ? "Message Sir Libz…" : "Viewers can't chat in this workspace"}
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
            setNotice("Saved to memory. Sir Libz will use it in this workspace.");
            setTimeout(() => setNotice(null), 4000);
          }}
        />
      )}
    </div>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
