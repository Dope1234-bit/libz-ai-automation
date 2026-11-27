"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { Invitation, Member, SystemStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { getSupabase } from "@/lib/supabase/client";
import {
  readAloudPreference,
  setReadAloudPreference,
  speechInputSupported,
  speechOutputSupported,
} from "@/lib/voice";
import { useWorkspace } from "@/lib/workspace-context";

type AssignableRole = "admin" | "member" | "viewer";

/** Honest integration registry: only the AI provider is connected today. */
const INTEGRATIONS = [
  { name: "Google Calendar", purpose: "Scheduling and reminders" },
  { name: "Gmail", purpose: "Email triage and drafting" },
  { name: "WhatsApp Business", purpose: "Client messaging" },
  { name: "Google Drive", purpose: "Documents and knowledge" },
  { name: "Notion", purpose: "Projects and notes" },
  { name: "Slack", purpose: "Team communication" },
];

export function SettingsView() {
  const router = useRouter();
  const { me, workspace, refresh } = useWorkspace();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .status()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const flash = (message: string) => {
    setError(null);
    setNotice(message);
    setTimeout(() => setNotice(null), 4000);
  };
  const fail = (err: unknown) => {
    setNotice(null);
    setError(err instanceof Error ? err.message : "Something went wrong.");
  };

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">System</p>
        <h1>Settings</h1>
      </header>

      {notice && (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <ProfileSection
        displayName={me?.profile.displayName ?? ""}
        email={me?.user.email ?? ""}
        onSaved={async () => {
          await refresh();
          flash("Profile updated.");
        }}
        onError={fail}
      />

      {workspace && <WorkspaceSection key={workspace.id} onFlash={flash} onError={fail} />}

      <section className="panel" aria-labelledby="ai-title">
        <h2 className="panel-label" id="ai-title">
          AI core
        </h2>
        {!status ? (
          <p className="muted small">Loading…</p>
        ) : status.ai.status === "not_configured" ? (
          <p className="small">No AI provider is configured on the server.</p>
        ) : (
          <ul className="status-list">
            {status.ai.providers.map((p) => (
              <li key={p.provider}>
                <span className="dot dot-ok" />
                <span className="capitalize">{p.provider}</span>
                <span className="status-value">{p.models.join(" → ")}</span>
              </li>
            ))}
            <li>
              <span className="dot dot-idle" />
              <span>Daily limit</span>
              <span className="status-value">
                {status.limits.dailyTokenLimit.toLocaleString()} tokens
              </span>
            </li>
            <li>
              <span className="dot dot-idle" />
              <span>Rate limit</span>
              <span className="status-value">{status.limits.requestsPerMinute} messages/min</span>
            </li>
          </ul>
        )}
        <p className="muted small section-note">
          Provider keys are held on the server only and are never sent to your browser. Models are
          tried in order; if one is busy, Jarvis falls back to the next.
        </p>
      </section>

      <VoiceSection />

      <section className="panel" aria-labelledby="int-title">
        <h2 className="panel-label" id="int-title">
          Integrations
        </h2>
        <ul className="status-list">
          <li>
            <span className="dot dot-ok" />
            <span>
              AI models ({status?.ai.providers.map((p) => p.provider).join(", ") || "server"})
            </span>
            <span className="tag tag-ok">Connected</span>
          </li>
          {INTEGRATIONS.map((i) => (
            <li key={i.name}>
              <span className="dot dot-idle" />
              <span>
                {i.name} <span className="muted small">· {i.purpose}</span>
              </span>
              <span className="tag">Not connected</span>
            </li>
          ))}
        </ul>
        <p className="muted small section-note">
          App integrations arrive in Phase 3, each with explicit permissions and approval before
          Jarvis takes any action.
        </p>
      </section>

      <section className="panel" aria-labelledby="sec-title">
        <h2 className="panel-label" id="sec-title">
          Security
        </h2>
        <ul className="status-list">
          <li>
            <span className="dot dot-ok" />
            <span>Signed in as</span>
            <span className="status-value">{me?.user.email ?? "…"}</span>
          </li>
          <li>
            <span className={`dot ${me?.user.mfa ? "dot-ok" : "dot-warn"}`} />
            <span>Two-factor authentication</span>
            <span className="status-value">
              {me?.user.mfa ? "Verified this session" : "Not in use"}
            </span>
          </li>
        </ul>
        <div className="section-actions">
          <button
            className="btn btn-secondary"
            onClick={async () => {
              if (!window.confirm("Sign out of Jarvis on every device?")) return;
              await getSupabase().auth.signOut({ scope: "global" });
              router.replace("/login");
              router.refresh();
            }}
          >
            Sign out everywhere
          </button>
        </div>
      </section>
    </div>
  );
}

function ProfileSection({
  displayName,
  email,
  onSaved,
  onError,
}: {
  displayName: string;
  email: string;
  onSaved: () => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const [name, setName] = useState(displayName);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(displayName), [displayName]);

  return (
    <form
      className="panel settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api.updateProfile({ displayName: name.trim() || null });
          await onSaved();
        } catch (err) {
          onError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="panel-label">Profile</h2>
      <label>
        Your name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          autoComplete="name"
        />
      </label>
      <p className="muted small">Email: {email}</p>
      <div className="section-actions">
        <button className="btn btn-primary" disabled={busy || name.trim() === displayName}>
          {busy ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

function WorkspaceSection({
  onFlash,
  onError,
}: {
  onFlash: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const { workspace, me, refresh } = useWorkspace();
  const ws = workspace!;
  const isAdmin = ws.role === "owner" || ws.role === "admin";
  const isOwner = ws.role === "owner";
  const [name, setName] = useState(ws.name);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMembers((await api.members(ws.id)).members);
      if (isAdmin && ws.type === "business") {
        setInvites(
          (await api.invitations(ws.id)).invitations.filter((i) => !i.accepted_at && !i.revoked_at),
        );
      }
    } catch (err) {
      onError(err);
    }
  }, [ws.id, ws.type, isAdmin, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const manageable = (m: Member) =>
    m.role !== "owner" && m.userId !== me?.user.id && (isOwner || (isAdmin && m.role !== "admin"));

  return (
    <section className="panel settings-form" aria-labelledby="ws-settings-title">
      <h2 className="panel-label" id="ws-settings-title">
        Workspace · {ws.type === "business" ? "Business" : "Personal"}
      </h2>

      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.renameWorkspace(ws.id, name.trim());
            await refresh();
            onFlash("Workspace renamed.");
          } catch (err) {
            onError(err);
          }
        }}
      >
        <label className="grow">
          Workspace name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            disabled={!isAdmin}
          />
        </label>
        {isAdmin && (
          <button className="btn btn-secondary" disabled={!name.trim() || name.trim() === ws.name}>
            Rename
          </button>
        )}
      </form>
      <p className="muted small">Your role: {ws.role}</p>

      <h3 className="sub-label">Members</h3>
      {members === null ? (
        <p className="muted small">Loading…</p>
      ) : (
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.userId} className="member">
              <span className="member-name">
                {m.displayName ?? "Unnamed member"}
                {m.userId === me?.user.id && <span className="muted small"> (you)</span>}
              </span>
              {manageable(m) ? (
                <>
                  <select
                    aria-label={`Role for ${m.displayName ?? "member"}`}
                    value={m.role}
                    onChange={async (e) => {
                      try {
                        await api.setMemberRole(ws.id, m.userId, e.target.value as AssignableRole);
                        await load();
                        onFlash("Role updated.");
                      } catch (err) {
                        onError(err);
                      }
                    }}
                  >
                    {(isOwner ? ["admin", "member", "viewer"] : ["member", "viewer"]).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-ghost"
                    onClick={async () => {
                      if (
                        !window.confirm(`Remove ${m.displayName ?? "this member"} from ${ws.name}?`)
                      )
                        return;
                      try {
                        await api.removeMember(ws.id, m.userId);
                        await load();
                        onFlash("Member removed.");
                      } catch (err) {
                        onError(err);
                      }
                    }}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="tag">{m.role}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {ws.type === "personal" && (
        <p className="muted small">
          Personal workspaces are private and cannot have other members.
        </p>
      )}

      {ws.type === "business" && isAdmin && (
        <>
          <h3 className="sub-label">Invite someone</h3>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const invite = await api.createInvitation(ws.id, email.trim(), role);
                setInviteLink(`${window.location.origin}/app/invite?token=${invite.token}`);
                setEmail("");
                await load();
              } catch (err) {
                onError(err);
              }
            }}
          >
            <label className="grow">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
                {(isOwner ? ["admin", "member", "viewer"] : ["member", "viewer"]).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" disabled={!email.trim()}>
              Create invite
            </button>
          </form>

          {inviteLink && (
            <div className="invite-link">
              <p className="small">
                Share this one-time link with them. It works only for that email address (after they
                confirm it), expires in 7 days, and won’t be shown again.
              </p>
              <input
                readOnly
                value={inviteLink}
                aria-label="Invitation link"
                onFocus={(e) => e.target.select()}
              />
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(inviteLink);
                    onFlash("Invitation link copied.");
                  } catch {
                    onFlash("Copy the link manually.");
                  }
                }}
              >
                Copy link
              </button>
            </div>
          )}

          {invites.length > 0 && (
            <>
              <h3 className="sub-label">Pending invitations</h3>
              <ul className="member-list">
                {invites.map((i) => (
                  <li key={i.id} className="member">
                    <span className="member-name">
                      {i.email} <span className="muted small">· {i.role}</span>
                    </span>
                    <button
                      className="btn btn-ghost"
                      onClick={async () => {
                        try {
                          await api.revokeInvitation(ws.id, i.id);
                          await load();
                          onFlash("Invitation revoked.");
                        } catch (err) {
                          onError(err);
                        }
                      }}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function VoiceSection() {
  const [input, setInput] = useState<boolean | null>(null);
  const [output, setOutput] = useState<boolean | null>(null);
  const [readAloud, setReadAloud] = useState(false);

  useEffect(() => {
    setInput(speechInputSupported());
    setOutput(speechOutputSupported());
    setReadAloud(readAloudPreference());
  }, []);

  return (
    <section className="panel" aria-labelledby="voice-title">
      <h2 className="panel-label" id="voice-title">
        Voice
      </h2>
      <ul className="status-list">
        <li>
          <span className={`dot ${input ? "dot-ok" : "dot-idle"}`} />
          <span>Voice input (microphone)</span>
          <span className="status-value">
            {input === null ? "…" : input ? "Available" : "Not supported in this browser"}
          </span>
        </li>
        <li>
          <span className={`dot ${output ? "dot-ok" : "dot-idle"}`} />
          <span>Read replies aloud</span>
          {output ? (
            <label className="switch">
              <input
                type="checkbox"
                checked={readAloud}
                onChange={(e) => {
                  setReadAloud(e.target.checked);
                  setReadAloudPreference(e.target.checked);
                }}
              />
              <span>{readAloud ? "On" : "Off"}</span>
            </label>
          ) : (
            <span className="status-value">{output === null ? "…" : "Not supported"}</span>
          )}
        </li>
      </ul>
      <p className="muted small section-note">
        Voice uses your browser’s speech features. Speech recognition may send audio to your
        browser’s provider (for example Google in Chrome); read-aloud runs on your device. Premium
        voices are planned for a later phase.
      </p>
    </section>
  );
}
