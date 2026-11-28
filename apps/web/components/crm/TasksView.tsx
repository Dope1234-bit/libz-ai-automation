"use client";

import { useCallback, useEffect, useState } from "react";
import type { Task } from "@/lib/crm";
import { crm, errorMessage, formatDue, isOverdue, TASK_PRIORITIES } from "@/lib/crm";
import { useWorkspace } from "@/lib/workspace-context";
import { CheckIcon, TrashIcon } from "../icons";

const VIEWS = [
  { id: "open", label: "Open" },
  { id: "today", label: "Today" },
  { id: "overdue", label: "Overdue" },
  { id: "done", label: "Done" },
] as const;
type View = (typeof VIEWS)[number]["id"];

export function TasksView() {
  const { workspace, mode } = useWorkspace();
  const [view, setView] = useState<View>("open");
  const [mine, setMine] = useState(false);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canWrite = workspace?.role !== "viewer";

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const query =
        view === "done"
          ? { status: "done", limit: 100 }
          : { view, limit: 200, ...(mine ? { assignee: "me" } : {}) };
      setTasks((await crm.tasks.list(workspace.id, query)).items);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load tasks."));
    }
  }, [workspace, view, mine]);

  useEffect(() => {
    setTasks(null);
    void load();
  }, [load]);

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">
          {mode === "business" ? "Business" : "Personal"} · {workspace?.name ?? "…"}
        </p>
        <h1>Tasks</h1>
        <p className="muted">
          Reminders show here and as a badge on Tasks. Push and email reminders come with the
          scheduler in a later phase.
        </p>
      </header>

      {canWrite && workspace && (
        <section className="panel">
          <TaskForm workspaceId={workspace.id} compact onSaved={() => void load()} />
        </section>
      )}

      <div className="segmented" role="tablist" aria-label="Task views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            className={`segment ${view === v.id ? "active" : ""}`}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
        {mode === "business" && view !== "done" && (
          <label className="switch">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            Mine
          </label>
        )}
      </div>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <section className="panel" aria-label="Tasks">
        {tasks === null ? (
          <p className="muted small">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="muted small">
            {view === "overdue"
              ? "Nothing overdue."
              : view === "today"
                ? "Nothing due today."
                : view === "done"
                  ? "No completed tasks yet."
                  : "No open tasks. Add one above."}
          </p>
        ) : (
          <ul className="list">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} canWrite={canWrite} onChanged={() => void load()} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function TaskRow({
  task,
  canWrite,
  onChanged,
}: {
  task: Task;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const done = task.status === "done";
  const overdue = isOverdue(task);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      window.alert(errorMessage(err, "Could not update the task."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`task ${done ? "task-done" : ""}`}>
      <button
        className={`task-check ${done ? "is-done" : ""}`}
        disabled={!canWrite || busy}
        aria-label={done ? `Reopen “${task.title}”` : `Complete “${task.title}”`}
        aria-pressed={done}
        onClick={() =>
          void run(() => crm.tasks.update(task.id, { status: done ? "open" : "done" }))
        }
      >
        {done && <CheckIcon width={14} height={14} />}
      </button>
      <div className="task-body">
        <p className="task-title">{task.title}</p>
        <p className="task-meta">
          <span className={overdue ? "task-overdue" : "muted"}>
            {overdue ? "Overdue · " : ""}
            {formatDue(task.due_at)}
          </span>
          {task.priority !== "normal" && (
            <span className={`tag priority-${task.priority}`}>{task.priority}</span>
          )}
        </p>
      </div>
      {canWrite && (
        <button
          className="btn btn-ghost icon-btn"
          aria-label={`Delete “${task.title}”`}
          title="Delete"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Delete this task?")) void run(() => crm.tasks.remove(task.id));
          }}
        >
          <TrashIcon />
        </button>
      )}
    </li>
  );
}

/** Quick add: title, optional due date/time and priority. */
export function TaskForm({
  workspaceId,
  extra,
  compact,
  onSaved,
}: {
  workspaceId: string;
  extra?: Record<string, string>;
  compact?: boolean;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await crm.tasks.create(workspaceId, {
        title: text,
        priority,
        ...(due ? { dueAt: new Date(due).toISOString() } : {}),
        ...extra,
      });
      setTitle("");
      setDue("");
      setPriority("normal");
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not add the task."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={compact ? "task-form" : "settings-form"} onSubmit={(e) => void save(e)}>
      <label className="grow">
        {compact ? "New task" : "Task"}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Follow up with Moyo Hardware"
          maxLength={300}
          required
        />
      </label>
      <label>
        Due
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      <label>
        Priority
        <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p} className="capitalize">
              {p}
            </option>
          ))}
        </select>
      </label>
      <button className="btn btn-primary" disabled={busy || !title.trim()}>
        {busy ? "Adding…" : "Add task"}
      </button>
      {error && (
        <p className="alert alert-error task-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
