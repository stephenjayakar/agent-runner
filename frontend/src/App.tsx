import React, { useState, useEffect, useRef, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ---- Types (mirrored from backend) ----
type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
type RunStatus = "idle" | "planning" | "executing" | "judging" | "completed" | "failed" | "stopped" | "paused";
type WorkerStatus = "idle" | "running" | "completed" | "failed" | "merging";

interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  dependencies: string[];
  assignedWorker?: string;
  result?: string;
  error?: string;
  spawnedBy?: string; // judgement ID that created this task
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

interface Worker {
  id: string;
  port: number;
  pid?: number;
  status: WorkerStatus;
  taskId?: string;
  sessionId?: string;
  logs: LogEntry[];
  startedAt: number;
  completedAt?: number;
}

interface Judgement {
  id: string;
  taskId: string;
  assessment: string;
  newTaskIds: string[];
  goalComplete: boolean;
  timestamp: number;
}

interface Run {
  id: string;
  goal: string;
  targetDir: string;
  status: RunStatus;
  analysis: string;
  tasks: Task[];
  judgements: Judgement[];
  workers: Worker[];
  maxWorkers: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
}

interface SSEEvent {
  type: string;
  data: any;
  timestamp: number;
}

// ---- Markdown component ----
const mdComponents: Record<string, React.FC<any>> = {
  p: ({ children }: any) => <p style={{ margin: "0 0 8px 0", lineHeight: 1.6 }}>{children}</p>,
  h1: ({ children }: any) => <h1 style={{ margin: "12px 0 8px 0", fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>{children}</h1>,
  h2: ({ children }: any) => <h2 style={{ margin: "10px 0 6px 0", fontSize: 16, fontWeight: 700, color: "#e2e8f0" }}>{children}</h2>,
  h3: ({ children }: any) => <h3 style={{ margin: "8px 0 4px 0", fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>{children}</h3>,
  ul: ({ children }: any) => <ul style={{ margin: "4px 0 8px 0", paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }: any) => <ol style={{ margin: "4px 0 8px 0", paddingLeft: 20 }}>{children}</ol>,
  li: ({ children }: any) => <li style={{ marginBottom: 2, lineHeight: 1.5 }}>{children}</li>,
  code: ({ inline, children, className }: any) =>
    inline ? (
      <code
        style={{
          padding: "1px 5px",
          backgroundColor: "#1e293b",
          borderRadius: 3,
          fontSize: "0.9em",
          fontFamily: "monospace",
          color: "#e2e8f0",
        }}
      >
        {children}
      </code>
    ) : (
      <pre
        style={{
          padding: 12,
          backgroundColor: "#020617",
          borderRadius: 6,
          border: "1px solid #1e293b",
          overflow: "auto",
          margin: "8px 0",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <code style={{ fontFamily: "monospace", color: "#e2e8f0" }}>{children}</code>
      </pre>
    ),
  pre: ({ children }: any) => <>{children}</>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#3b82f6", textDecoration: "none" }}>
      {children}
    </a>
  ),
  blockquote: ({ children }: any) => (
    <blockquote style={{ margin: "8px 0", paddingLeft: 12, borderLeft: "3px solid #334155", color: "#94a3b8" }}>
      {children}
    </blockquote>
  ),
  table: ({ children }: any) => (
    <div style={{ overflow: "auto", margin: "8px 0" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>{children}</table>
    </div>
  ),
  th: ({ children }: any) => (
    <th style={{ padding: "6px 10px", borderBottom: "2px solid #334155", textAlign: "left", color: "#e2e8f0", fontWeight: 600 }}>
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td style={{ padding: "6px 10px", borderBottom: "1px solid #1e293b", color: "#94a3b8" }}>{children}</td>
  ),
  hr: () => <hr style={{ border: "none", borderTop: "1px solid #1e293b", margin: "12px 0" }} />,
  strong: ({ children }: any) => <strong style={{ color: "#e2e8f0", fontWeight: 600 }}>{children}</strong>,
};

function Md({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {content}
    </Markdown>
  );
}

// ---- Hooks ----
function useEventSource() {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event: SSEEvent = JSON.parse(e.data);
        setEvents((prev) => [...prev.slice(-200), event]);

        if (event.type === "log" || event.type === "worker:log") {
          const logData = event.data as LogEntry;
          setLogs((prev) => [...prev.slice(-500), logData]);
        }
      } catch {
        // ignore malformed events
      }
    };

    return () => es.close();
  }, []);

  return { events, logs, connected };
}

// ---- Helpers ----
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ---- Components ----

function StatusBadge({ status, size = "sm" }: { status: string; size?: "sm" | "lg" }) {
  const colors: Record<string, string> = {
    pending: "#6b7280",
    idle: "#6b7280",
    planning: "#8b5cf6",
    executing: "#3b82f6",
    judging: "#f59e0b",
    in_progress: "#3b82f6",
    running: "#3b82f6",
    completed: "#10b981",
    failed: "#ef4444",
    cancelled: "#6b7280",
    stopped: "#f59e0b",
    paused: "#f59e0b",
    merging: "#8b5cf6",
  };

  const color = colors[status] || "#6b7280";
  const isActive = ["planning", "executing", "judging", "in_progress", "running", "merging"].includes(status);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: size === "lg" ? "4px 12px" : "2px 8px",
        borderRadius: 4,
        backgroundColor: `${color}20`,
        color,
        fontSize: size === "lg" ? 13 : 11,
        fontWeight: 600,
        fontFamily: "monospace",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        flexShrink: 0,
      }}
    >
      {isActive && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            backgroundColor: color,
            animation: "pulse 1.5s ease-in-out infinite",
          }}
        />
      )}
      {status}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "#6b7280",
    idle: "#6b7280",
    planning: "#8b5cf6",
    executing: "#3b82f6",
    judging: "#f59e0b",
    in_progress: "#3b82f6",
    running: "#3b82f6",
    completed: "#10b981",
    failed: "#ef4444",
    cancelled: "#6b7280",
    stopped: "#f59e0b",
    paused: "#f59e0b",
    merging: "#8b5cf6",
  };
  const color = colors[status] || "#6b7280";
  const isActive = ["planning", "executing", "judging", "in_progress", "running", "merging"].includes(status);

  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: color,
        flexShrink: 0,
        animation: isActive ? "pulse 1.5s ease-in-out infinite" : "none",
      }}
    />
  );
}

function NewRunForm({ onSubmit }: { onSubmit: (goal: string, targetDir: string, maxWorkers: number) => void }) {
  const [goal, setGoal] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [maxWorkers, setMaxWorkers] = useState(3);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || !targetDir.trim()) return;
    setSubmitting(true);
    await onSubmit(goal.trim(), targetDir.trim(), maxWorkers);
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <label style={{ display: "block", marginBottom: 6, color: "#94a3b8", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>
          TARGET DIRECTORY
        </label>
        <input
          type="text"
          value={targetDir}
          onChange={(e) => setTargetDir(e.target.value)}
          placeholder="/path/to/your/project"
          style={{
            width: "100%",
            padding: "10px 14px",
            backgroundColor: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 6,
            color: "#e2e8f0",
            fontSize: 14,
            fontFamily: "monospace",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>
      <div>
        <label style={{ display: "block", marginBottom: 6, color: "#94a3b8", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>
          GOAL
        </label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe what you want the agents to build or accomplish..."
          rows={4}
          style={{
            width: "100%",
            padding: "10px 14px",
            backgroundColor: "#1e293b",
            border: "1px solid #334155",
            borderRadius: 6,
            color: "#e2e8f0",
            fontSize: 14,
            fontFamily: "inherit",
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
        <div>
          <label style={{ display: "block", marginBottom: 6, color: "#94a3b8", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>
            MAX WORKERS
          </label>
          <input
            type="number"
            min={1}
            max={10}
            value={maxWorkers}
            onChange={(e) => setMaxWorkers(parseInt(e.target.value) || 3)}
            style={{
              width: 80,
              padding: "10px 14px",
              backgroundColor: "#1e293b",
              border: "1px solid #334155",
              borderRadius: 6,
              color: "#e2e8f0",
              fontSize: 14,
              fontFamily: "monospace",
              outline: "none",
            }}
          />
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="submit"
          disabled={submitting || !goal.trim() || !targetDir.trim()}
          style={{
            padding: "10px 24px",
            backgroundColor: submitting ? "#334155" : "#3b82f6",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: !goal.trim() || !targetDir.trim() ? 0.5 : 1,
          }}
        >
          {submitting ? "Starting..." : "Launch Agents"}
        </button>
      </div>
    </form>
  );
}

function TaskCard({ task, isFollowUp }: { task: Task; isFollowUp?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const duration =
    task.startedAt && task.completedAt
      ? formatDuration(task.completedAt - task.startedAt)
      : task.startedAt
        ? `${formatDuration(Date.now() - task.startedAt)}...`
        : "";

  return (
    <div
      style={{
        padding: 12,
        backgroundColor: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: 6,
        cursor: "pointer",
        borderLeft: isFollowUp ? "3px solid #f59e0b40" : undefined,
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: expanded ? 4 : 0 }}>
        <StatusBadge status={task.status} />
        <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, flex: 1 }}>{task.title}</span>
        {isFollowUp && (
          <span style={{ color: "#f59e0b", fontSize: 10, fontFamily: "monospace", letterSpacing: "0.05em" }}>
            FOLLOW-UP
          </span>
        )}
        {duration && <span style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>{duration}</span>}
      </div>
      {expanded && (
        <div style={{ marginTop: 8, color: "#94a3b8", fontSize: 13 }}>
          <Md content={task.description} />
          {task.result && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", marginBottom: 4, color: "#10b981", fontSize: 12, fontWeight: 600 }}>
                Result
              </summary>
              <div style={{ fontSize: 13, color: "#94a3b8", maxHeight: 300, overflow: "auto" }}>
                <Md content={task.result} />
              </div>
            </details>
          )}
          {task.error && (
            <pre style={{ color: "#ef4444", fontSize: 12, fontFamily: "monospace", whiteSpace: "pre-wrap", margin: "8px 0 0 0" }}>
              {task.error}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function JudgementCard({ judgement, tasks }: { judgement: Judgement; tasks: Task[] }) {
  const [expanded, setExpanded] = useState(false);
  const triggeredTask = tasks.find((t) => t.id === judgement.taskId);
  const spawnedTasks = tasks.filter((t) => judgement.newTaskIds.includes(t.id));

  return (
    <div
      style={{
        padding: 10,
        backgroundColor: "#0f172a",
        border: "1px solid #1e293b",
        borderLeft: `3px solid ${judgement.goalComplete ? "#10b981" : "#f59e0b"}`,
        borderRadius: 6,
        cursor: "pointer",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: judgement.goalComplete ? "#10b981" : "#f59e0b", fontSize: 11, fontWeight: 600, fontFamily: "monospace", letterSpacing: "0.05em" }}>
          {judgement.goalComplete ? "GOAL COMPLETE" : "JUDGE"}
        </span>
        <span style={{ color: "#64748b", fontSize: 12 }}>
          re: {triggeredTask?.title || judgement.taskId}
        </span>
        {spawnedTasks.length > 0 && (
          <span style={{ color: "#f59e0b", fontSize: 11, fontFamily: "monospace" }}>
            +{spawnedTasks.length} task{spawnedTasks.length > 1 ? "s" : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: "#475569", fontSize: 11, fontFamily: "monospace" }}>
          {formatTime(judgement.timestamp)}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, color: "#94a3b8", fontSize: 13 }}>
          <Md content={judgement.assessment} />
        </div>
      )}
    </div>
  );
}

function WorkerCard({ worker }: { worker: Worker }) {
  const [showLogs, setShowLogs] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [worker.logs.length, showLogs]);

  const duration = worker.completedAt
    ? formatDuration(worker.completedAt - worker.startedAt)
    : `${formatDuration(Date.now() - worker.startedAt)}...`;

  return (
    <div
      style={{
        padding: 12,
        backgroundColor: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StatusBadge status={worker.status} />
        <span style={{ color: "#94a3b8", fontSize: 13, fontFamily: "monospace" }}>
          :{worker.port}
        </span>
        <span style={{ color: "#64748b", fontSize: 12, fontFamily: "monospace" }}>{duration}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setShowLogs(!showLogs)}
          style={{
            padding: "2px 8px",
            backgroundColor: "transparent",
            border: "1px solid #334155",
            borderRadius: 4,
            color: "#94a3b8",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          {showLogs ? "Hide" : "Show"} Logs ({worker.logs.length})
        </button>
      </div>
      {showLogs && (
        <div
          style={{
            marginTop: 8,
            maxHeight: 200,
            overflow: "auto",
            backgroundColor: "#020617",
            borderRadius: 4,
            padding: 8,
          }}
        >
          {worker.logs.slice(-100).map((log, i) => (
            <LogLine key={i} log={log} />
          ))}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
}

function LogLine({ log }: { log: LogEntry }) {
  const levelColors: Record<string, string> = {
    info: "#94a3b8",
    warn: "#f59e0b",
    error: "#ef4444",
    debug: "#64748b",
  };

  const time = new Date(log.timestamp).toLocaleTimeString();

  return (
    <div style={{ fontSize: 12, fontFamily: "monospace", lineHeight: 1.6, color: levelColors[log.level] || "#94a3b8" }}>
      <span style={{ color: "#475569" }}>{time}</span>{" "}
      <span style={{ color: "#8b5cf6" }}>[{log.source}]</span>{" "}
      {log.message}
    </div>
  );
}

function CollapsibleGoal({ goal }: { goal: string }) {
  const [expanded, setExpanded] = useState(false);
  const LINE_LIMIT = 3;
  const lines = goal.split("\n");
  const isLong = lines.length > LINE_LIMIT;

  return (
    <div style={{ margin: "0 0 4px 0" }}>
      <h2
        style={{
          color: "#e2e8f0",
          margin: 0,
          fontSize: 18,
          whiteSpace: "pre-wrap",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: expanded ? undefined : LINE_LIMIT,
          WebkitBoxOrient: "vertical",
          lineHeight: "1.4",
        }}
      >
        {goal}
      </h2>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            background: "none",
            border: "none",
            color: "#60a5fa",
            cursor: "pointer",
            padding: "4px 0 0 0",
            fontSize: 12,
            fontFamily: "monospace",
          }}
        >
          {expanded ? "Show less" : `Show more (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

function RunView({ run, logs }: { run: Run; logs: LogEntry[] }) {
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const elapsed = run.completedAt
    ? formatDuration(run.completedAt - run.createdAt)
    : formatDuration(Date.now() - run.createdAt);

  const completedTasks = run.tasks.filter((t) => t.status === "completed").length;
  const totalTasks = run.tasks.length;
  const runningTasks = run.tasks.filter((t) => t.status === "in_progress");
  const pendingTasks = run.tasks.filter((t) => t.status === "pending");
  const finishedTasks = run.tasks.filter((t) => ["completed", "failed", "cancelled"].includes(t.status));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <StatusBadge status={run.status} size="lg" />
            <span style={{ color: "#64748b", fontSize: 13, fontFamily: "monospace" }}>
              {elapsed} | {completedTasks}/{totalTasks} tasks
            </span>
          </div>
          <CollapsibleGoal goal={run.goal} />
          <p style={{ color: "#64748b", margin: 0, fontSize: 13, fontFamily: "monospace" }}>{run.targetDir}</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {["planning", "executing", "judging"].includes(run.status) && (
            <button
              onClick={async () => {
                await fetch(`/api/runs/${run.id}/pause`, { method: "POST" });
              }}
              style={{
                padding: "8px 16px",
                backgroundColor: "#f59e0b",
                border: "none",
                borderRadius: 6,
                color: "#000",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Pause
            </button>
          )}
          {["paused", "stopped"].includes(run.status) && (
            <button
              onClick={async () => {
                await fetch(`/api/runs/${run.id}/resume`, { method: "POST" });
              }}
              style={{
                padding: "8px 16px",
                backgroundColor: "#10b981",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Resume
            </button>
          )}
          {["planning", "executing", "judging", "paused"].includes(run.status) && (
            <button
              onClick={async () => {
                await fetch(`/api/runs/${run.id}/stop`, { method: "POST" });
              }}
              style={{
                padding: "8px 16px",
                backgroundColor: "#dc2626",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Main content: 2 columns */}
      <div style={{ display: "flex", gap: 20, flex: 1, minHeight: 0 }}>
        {/* Left: Tasks + Judgements */}
        <div style={{ flex: 1, overflow: "auto" }}>
          {/* Planning spinner */}
          {run.tasks.length === 0 && run.status === "planning" && (
            <div style={{ padding: 40, textAlign: "center", color: "#64748b" }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  border: "3px solid #334155",
                  borderTopColor: "#8b5cf6",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                  margin: "0 auto 12px",
                }}
              />
              Planner is analyzing the codebase...
            </div>
          )}

          {/* Analysis */}
          {run.analysis && (
            <div
              style={{
                padding: 12,
                backgroundColor: "#0f172a",
                borderRadius: 6,
                marginBottom: 16,
                border: "1px solid #1e293b",
              }}
            >
              <span style={{ color: "#8b5cf6", fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4, letterSpacing: "0.05em" }}>
                ANALYSIS
              </span>
              <div style={{ color: "#94a3b8", fontSize: 13 }}>
                <Md content={run.analysis} />
              </div>
            </div>
          )}

          {/* Active tasks (in_progress) */}
          {runningTasks.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ color: "#3b82f6", fontSize: 12, fontWeight: 600, marginBottom: 8, letterSpacing: "0.05em" }}>
                RUNNING ({runningTasks.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {runningTasks.map((task) => (
                  <TaskCard key={task.id} task={task} isFollowUp={!!task.spawnedBy} />
                ))}
              </div>
            </div>
          )}

          {/* Pending tasks */}
          {pendingTasks.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ color: "#6b7280", fontSize: 12, fontWeight: 600, marginBottom: 8, letterSpacing: "0.05em" }}>
                PENDING ({pendingTasks.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {pendingTasks.map((task) => (
                  <TaskCard key={task.id} task={task} isFollowUp={!!task.spawnedBy} />
                ))}
              </div>
            </div>
          )}

          {/* Judgements */}
          {run.judgements.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ color: "#f59e0b", fontSize: 12, fontWeight: 600, marginBottom: 8, letterSpacing: "0.05em" }}>
                JUDGEMENTS ({run.judgements.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {run.judgements.map((j) => (
                  <JudgementCard key={j.id} judgement={j} tasks={run.tasks} />
                ))}
              </div>
            </div>
          )}

          {/* Completed/Failed tasks */}
          {finishedTasks.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, marginBottom: 8, letterSpacing: "0.05em" }}>
                COMPLETED ({finishedTasks.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {finishedTasks.map((task) => (
                  <TaskCard key={task.id} task={task} isFollowUp={!!task.spawnedBy} />
                ))}
              </div>
            </div>
          )}

          {/* Workers */}
          {run.workers.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, marginBottom: 8, letterSpacing: "0.05em" }}>
                WORKERS ({run.workers.filter((w) => w.status === "running").length} active)
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {run.workers.map((worker) => (
                  <WorkerCard key={worker.id} worker={worker} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Logs */}
        <div
          style={{
            width: 420,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#020617",
            borderRadius: 6,
            border: "1px solid #1e293b",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid #1e293b",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ color: "#94a3b8", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em" }}>LOGS</span>
            <span style={{ color: "#475569", fontSize: 12 }}>({logs.length})</span>
          </div>
          <div ref={logsContainerRef} style={{ flex: 1, overflow: "auto", padding: 8 }}>
            {logs.map((log, i) => (
              <LogLine key={i} log={log} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Sidebar run list item ----
function RunListItem({
  run,
  selected,
  onClick,
}: {
  run: Run;
  selected: boolean;
  onClick: () => void;
}) {
  const completedTasks = run.tasks.filter((t) => t.status === "completed").length;
  const totalTasks = run.tasks.length;
  const elapsed = run.completedAt
    ? formatDuration(run.completedAt - run.createdAt)
    : formatDuration(Date.now() - run.createdAt);

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 14px",
        backgroundColor: selected ? "#1e293b" : "transparent",
        border: "none",
        borderLeft: `3px solid ${selected ? "#3b82f6" : "transparent"}`,
        borderRadius: 0,
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        transition: "background-color 0.1s",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "#1e293b80";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {/* Row 1: status dot + goal */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <StatusDot status={run.status} />
        <span
          style={{
            color: selected ? "#e2e8f0" : "#94a3b8",
            fontSize: 13,
            fontWeight: selected ? 600 : 400,
            lineHeight: 1.3,
            flex: 1,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as any,
          }}
        >
          {run.goal}
        </span>
      </div>
      {/* Row 2: meta info */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 16 }}>
        <span style={{ color: "#475569", fontSize: 11, fontFamily: "monospace" }}>
          {formatDate(run.createdAt)} {formatTime(run.createdAt)}
        </span>
        <span style={{ color: "#334155" }}>|</span>
        <span style={{ color: "#475569", fontSize: 11, fontFamily: "monospace" }}>{elapsed}</span>
        {totalTasks > 0 && (
          <>
            <span style={{ color: "#334155" }}>|</span>
            <span style={{ color: "#475569", fontSize: 11, fontFamily: "monospace" }}>
              {completedTasks}/{totalTasks}
            </span>
          </>
        )}
      </div>
    </button>
  );
}

export function App() {
  const { events, logs, connected } = useEventSource();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{
    status: string;
    anthropicKeySet: boolean;
    providers?: Record<string, boolean>;
    plannerModel?: string;
    workerModel?: string;
  } | null>(null);
  const hasUserSelected = useRef(false);

  const run = runs.find((r) => r.id === selectedRunId) || null;

  // Check health + fetch existing runs on mount
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));

    fetch("/api/runs")
      .then((r) => r.json())
      .then((allRuns: Run[]) => {
        setRuns(allRuns);
        const active = allRuns.find((r) =>
          ["planning", "executing", "judging"].includes(r.status)
        );
        if (active) {
          setSelectedRunId(active.id);
        }
      })
      .catch(() => {});
  }, []);

  // Poll for run updates
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch("/api/runs");
        if (resp.ok) {
          const allRuns: Run[] = await resp.json();
          setRuns(allRuns);
        }
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleCreateRun = useCallback(async (goal: string, targetDir: string, maxWorkers: number) => {
    setError(null);
    try {
      const resp = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, targetDir, maxWorkers }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        setError(data.error || "Failed to create run");
        return;
      }
      const newRun: Run = await resp.json();
      setRuns((prev) => [newRun, ...prev]);
      setSelectedRunId(newRun.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to server");
    }
  }, []);

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "row",
        backgroundColor: "#0f172a",
        color: "#e2e8f0",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
      `}</style>

      {/* ===== Left Sidebar ===== */}
      <div
        style={{
          width: 280,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid #1e293b",
          backgroundColor: "#0b1120",
          height: "100vh",
        }}
      >
        {/* Sidebar header */}
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid #1e293b",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <h1 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>
            Agent Runner
          </h1>
          <span style={{ color: "#475569", fontSize: 11, fontFamily: "monospace" }}>v0.1.0</span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              backgroundColor: connected ? "#10b981" : "#ef4444",
              flexShrink: 0,
            }}
            title={connected ? "Connected" : "Disconnected"}
          />
        </div>

        {/* New Run button */}
        <div style={{ padding: "10px 12px 4px", flexShrink: 0 }}>
          <button
            onClick={() => {
              hasUserSelected.current = true;
              setSelectedRunId(null);
            }}
            style={{
              width: "100%",
              padding: "8px 12px",
              backgroundColor: !selectedRunId ? "#3b82f6" : "transparent",
              border: `1px solid ${!selectedRunId ? "#3b82f6" : "#334155"}`,
              borderRadius: 6,
              color: !selectedRunId ? "#fff" : "#94a3b8",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.1s",
            }}
          >
            + New Run
          </button>
        </div>

        {/* Run list */}
        <div style={{ flex: 1, overflow: "auto", paddingTop: 4 }}>
          {runs.length === 0 && (
            <div style={{ padding: "24px 16px", color: "#475569", fontSize: 13, textAlign: "center" }}>
              No runs yet
            </div>
          )}
          {runs.map((r) => (
            <RunListItem
              key={r.id}
              run={r}
              selected={selectedRunId === r.id}
              onClick={() => {
                hasUserSelected.current = true;
                setSelectedRunId(r.id);
              }}
            />
          ))}
        </div>

        {/* Sidebar footer: status */}
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid #1e293b",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: connected ? "#10b981" : "#ef4444" }}>
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                backgroundColor: connected ? "#10b981" : "#ef4444",
              }}
            />
            {connected ? "Connected" : "Disconnected"}
          </div>
          {health && (
            <div
              style={{
                fontSize: 11,
                color: "#475569",
                fontFamily: "monospace",
              }}
            >
              {health.workerModel && (
                <span style={{ color: "#94a3b8" }}>model: {health.workerModel} </span>
              )}
              {health.providers ? (
                Object.entries(health.providers).map(([name, configured]) => (
                  <span key={name} style={{ color: configured ? "#475569" : "#ef4444", marginLeft: 6 }}>
                    {name}: {configured ? "ok" : "no key"}
                  </span>
                ))
              ) : (
                <span style={{ color: health.anthropicKeySet ? "#475569" : "#ef4444" }}>
                  API Key: {health.anthropicKeySet ? "set" : "MISSING"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ===== Main Content ===== */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
        <div style={{ flex: 1, padding: 24, overflow: "auto", display: "flex", flexDirection: "column" }}>
          {!run ? (
            <div style={{ maxWidth: 640, margin: "0 auto", width: "100%", paddingTop: 20 }}>
              <div style={{ marginBottom: 32, textAlign: "center" }}>
                <h2 style={{ margin: "0 0 8px 0", fontSize: 26, fontWeight: 700, color: "#e2e8f0" }}>
                  Multi-Agent Code Runner
                </h2>
                <p style={{ color: "#64748b", fontSize: 14, margin: 0, maxWidth: 500, marginLeft: "auto", marginRight: "auto" }}>
                  Inspired by{" "}
                  <a href="https://cursor.com/blog/scaling-agents" style={{ color: "#3b82f6" }} target="_blank" rel="noopener">
                    Cursor's scaling agents
                  </a>
                  . A planner breaks your goal into tasks, then parallel workers execute them continuously.
                </p>
              </div>
              <div
                style={{
                  padding: 24,
                  backgroundColor: "#1e293b40",
                  border: "1px solid #1e293b",
                  borderRadius: 8,
                }}
              >
                <NewRunForm onSubmit={handleCreateRun} />
              </div>
              {error && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    backgroundColor: "#dc262620",
                    border: "1px solid #dc262640",
                    borderRadius: 6,
                    color: "#ef4444",
                    fontSize: 13,
                  }}
                >
                  {error}
                </div>
              )}
              {health && health.providers && !Object.values(health.providers).some(Boolean) && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    backgroundColor: "#f59e0b20",
                    border: "1px solid #f59e0b40",
                    borderRadius: 6,
                    color: "#f59e0b",
                    fontSize: 13,
                  }}
                >
                  No API keys configured. Set at least one of: ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
                </div>
              )}
              {health && !health.providers && !health.anthropicKeySet && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    backgroundColor: "#f59e0b20",
                    border: "1px solid #f59e0b40",
                    borderRadius: 6,
                    color: "#f59e0b",
                    fontSize: 13,
                  }}
                >
                  Set your ANTHROPIC_API_KEY environment variable before starting the server.
                </div>
              )}

              <div style={{ marginTop: 32, color: "#475569", fontSize: 13 }}>
                <h3 style={{ color: "#64748b", fontSize: 14, marginBottom: 12 }}>How it works</h3>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {[
                    { step: "1", title: "Plan", desc: "Claude analyzes the codebase and breaks your goal into independent tasks" },
                    { step: "2", title: "Execute", desc: "Parallel workers continuously pick up tasks as they become available" },
                    { step: "3", title: "Judge", desc: "Each completed task is judged immediately — new follow-up tasks can be spawned on the fly" },
                  ].map((item) => (
                    <div
                      key={item.step}
                      style={{
                        flex: 1,
                        minWidth: 160,
                        padding: 16,
                        backgroundColor: "#0f172a",
                        borderRadius: 6,
                        border: "1px solid #1e293b",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          width: 24,
                          height: 24,
                          lineHeight: "24px",
                          textAlign: "center",
                          borderRadius: "50%",
                          backgroundColor: "#3b82f620",
                          color: "#3b82f6",
                          fontSize: 12,
                          fontWeight: 700,
                          marginBottom: 8,
                        }}
                      >
                        {item.step}
                      </span>
                      <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{item.title}</div>
                      <div style={{ color: "#64748b", fontSize: 12, lineHeight: 1.5 }}>{item.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <RunView run={run} logs={logs} />
          )}
        </div>
      </div>
    </div>
  );
}
