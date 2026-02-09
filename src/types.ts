export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export type RunStatus = "idle" | "planning" | "executing" | "judging" | "completed" | "failed" | "stopped" | "paused";
export type WorkerStatus = "idle" | "running" | "completed" | "failed" | "merging";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number; // 1 = highest
  dependencies: string[]; // task IDs this depends on
  assignedWorker?: string;
  branch?: string;
  result?: string;
  error?: string;
  spawnedBy?: string; // judgement ID that created this task (undefined = initial plan)
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkerActivity {
  type: "tool_call" | "file_edit" | "file_create" | "bash" | "text" | "error" | "thinking";
  summary: string;
  timestamp: number;
}

export interface Worker {
  id: string;
  port: number;
  pid?: number;
  status: WorkerStatus;
  taskId?: string;
  sessionId?: string;
  logs: LogEntry[];
  activity: WorkerActivity[]; // rich activity stream
  startedAt: number;
  completedAt?: number;
}

export interface Judgement {
  id: string;
  taskId: string; // which completed/failed task triggered this
  assessment: string; // the judge's commentary
  newTaskIds: string[]; // IDs of tasks the judge spawned
  goalComplete: boolean; // did the judge declare the whole run done?
  timestamp: number;
}

export interface Run {
  id: string;
  goal: string;
  targetDir: string;
  status: RunStatus;
  analysis: string; // initial planner analysis
  tasks: Task[];
  judgements: Judgement[];
  workers: Worker[];
  maxWorkers: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error" | "debug";
  source: string; // "planner" | "worker-1" | "judge" | "system"
  message: string;
}

export type EventType =
  | "run:created"
  | "run:updated"
  | "run:completed"
  | "run:failed"
  | "task:updated"
  | "worker:created"
  | "worker:updated"
  | "worker:log"
  | "judgement:created"
  | "log";

export interface Event {
  type: EventType;
  data: unknown;
  timestamp: number;
}

export interface Skill {
  name: string;
  description: string;
  content: string; // full markdown content (after frontmatter)
  /** If true, only user can invoke (not the model automatically) */
  disableModelInvocation: boolean;
  /** If false, hidden from slash menu (only model can invoke) */
  userInvocable: boolean;
  /** Restrict which tools the worker can use when this skill is active */
  allowedTools?: string[];
  /** Path to the SKILL.md file on disk */
  filePath: string;
  /** Directory containing the skill (may have supporting files) */
  dirPath: string;
}

export interface CreateRunRequest {
  goal: string;
  targetDir: string;
  maxWorkers?: number;
}
