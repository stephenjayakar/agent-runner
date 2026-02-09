import Anthropic from "@anthropic-ai/sdk";
import { execSync, exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";

const execAsync = promisify(exec);
import { join, relative, resolve, dirname } from "path";
import { mkdirSync } from "fs";
import { nanoid } from "nanoid";
import { eventBus } from "./events.js";
import type { Worker, Task, LogEntry, WorkerActivity, Skill } from "./types.js";
import { loadSkills, buildSkillsSummary, getSkillContent } from "./skills.js";

// ---- Constants ----
const MODEL = "claude-opus-4-6";
const MAX_TOKENS = 16384;
const MAX_TOOL_RESULT_CHARS = 60000;
const MAX_STEPS = 200; // hard limit on agentic loop steps
const MAX_FILE_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_RESULTS = 100;

// ---- Worker management ----
interface WorkerInstance {
  worker: Worker;
  abortController: AbortController;
  targetDir: string;
}

const activeWorkers = new Map<string, WorkerInstance>();

function addLog(worker: Worker, level: LogEntry["level"], message: string) {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    source: `worker-${worker.id.slice(0, 6)}`,
    message,
  };
  worker.logs.push(entry);
  if (worker.logs.length > 500) {
    worker.logs = worker.logs.slice(-500);
  }
  eventBus.emit("worker:log", { workerId: worker.id, ...entry });
}

function addActivity(worker: Worker, type: WorkerActivity["type"], summary: string) {
  const activity: WorkerActivity = { type, summary, timestamp: Date.now() };
  worker.activity.push(activity);
  if (worker.activity.length > 200) {
    worker.activity = worker.activity.slice(-200);
  }
  addLog(worker, "info", `[${type}] ${summary}`);
}

// =====================================================================
// Tool Definitions for Claude
// =====================================================================

const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "bash",
    description: `Execute a bash command in the project directory. The command runs with a 120-second timeout.
Use this for: running builds, tests, git commands, installing packages, checking file existence, and any shell operations.
Do NOT use this for reading file contents (use the read tool), writing files (use the write tool), or editing files (use the edit tool).
Commands run in the project root directory.`,
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds (default 120000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: `Read a file from the filesystem. Returns file contents with line numbers.
- The filePath must be an absolute path
- By default reads up to 2000 lines from the beginning
- Use offset and limit for pagination on large files
- Lines longer than 2000 characters are truncated
- Can read any text file in the project`,
    input_schema: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file to read",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (0-based)",
        },
        limit: {
          type: "number",
          description: "Number of lines to read (default 2000)",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "write",
    description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does.
- The filePath must be an absolute path
- Creates parent directories automatically
- Use this to create new files
- ALWAYS prefer editing existing files with the edit tool instead of rewriting the entire file`,
    input_schema: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file to write",
        },
        content: {
          type: "string",
          description: "The full content to write to the file",
        },
      },
      required: ["filePath", "content"],
    },
  },
  {
    name: "edit",
    description: `Perform exact string replacement in a file. Finds oldString in the file and replaces it with newString.
- Both oldString and newString must be provided and must be different
- oldString must match exactly (including whitespace and indentation)
- The edit will fail if oldString is not found, or if it's found multiple times (provide more context to make it unique)
- Use replaceAll: true to replace ALL occurrences`,
    input_schema: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file to edit",
        },
        oldString: {
          type: "string",
          description: "The exact string to find and replace",
        },
        newString: {
          type: "string",
          description: "The replacement string",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences (default false)",
        },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
  {
    name: "glob",
    description: `Find files matching a glob pattern. Returns matching file paths sorted by modification time.
- Supports patterns like "**/*.ts", "src/**/*.cpp", "*.json"
- Returns up to 200 results
- Use this to find files by name pattern`,
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files",
        },
        path: {
          type: "string",
          description: "Directory to search in (defaults to project root)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: `Search file contents using a regular expression. Returns file paths and line numbers of matches.
- Uses ripgrep for fast searching
- Supports full regex syntax
- Filter by file pattern with the include parameter (e.g., "*.ts", "*.{cpp,h}")
- Returns up to 100 results sorted by modification time`,
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory to search in (defaults to project root)",
        },
        include: {
          type: "string",
          description: "File pattern to include (e.g., '*.ts', '*.{cpp,h}')",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "skill",
    description: `Load a skill by name. Skills provide domain-specific instructions, workflows, and conventions for particular tasks.
Use this when you need specialized guidance for a task. The skill content will be returned as instructions for you to follow.
Available skills are listed in the system prompt.`,
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The name of the skill to load",
        },
      },
      required: ["name"],
    },
  },
];

// =====================================================================
// Tool Execution
// =====================================================================

async function executeBash(
  args: { command: string; timeout?: number },
  cwd: string
): Promise<string> {
  const timeout = args.timeout || 120_000;
  try {
    const { stdout } = await execAsync(args.command, {
      cwd,
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, TERM: "dumb" },
    });
    const output = stdout || "(no output)";
    return output.length > MAX_TOOL_RESULT_CHARS
      ? output.slice(0, MAX_TOOL_RESULT_CHARS) + "\n... (truncated)"
      : output;
  } catch (err: any) {
    const stdout = err.stdout || "";
    const stderr = err.stderr || "";
    const code = err.status ?? err.code ?? "unknown";
    const combined = `Exit code: ${code}\n${stdout}\n${stderr}`.trim();
    return combined.length > MAX_TOOL_RESULT_CHARS
      ? combined.slice(0, MAX_TOOL_RESULT_CHARS) + "\n... (truncated)"
      : combined;
  }
}

function executeRead(
  args: { filePath: string; offset?: number; limit?: number },
  _cwd: string
): string {
  const filePath = args.filePath;
  if (!existsSync(filePath)) {
    return `Error: File not found: ${filePath}`;
  }
  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return `Error: ${filePath} is a directory, not a file`;
    }
    if (stat.size > 5 * 1024 * 1024) {
      return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use offset/limit to read portions.`;
    }
    const content = readFileSync(filePath, "utf-8");
    const allLines = content.split("\n");
    const offset = args.offset || 0;
    const limit = args.limit || MAX_FILE_LINES;
    const lines = allLines.slice(offset, offset + limit);
    const numbered = lines.map((line, i) => {
      const lineNum = String(offset + i + 1).padStart(5, " ");
      const truncated =
        line.length > MAX_LINE_CHARS
          ? line.slice(0, MAX_LINE_CHARS) + "..."
          : line;
      return `${lineNum}| ${truncated}`;
    });
    let result = numbered.join("\n");
    if (offset + limit < allLines.length) {
      result += `\n\n(File has ${allLines.length} total lines. Showing lines ${offset + 1}-${offset + lines.length}. Use offset parameter to read more.)`;
    }
    return result;
  } catch (err: any) {
    return `Error reading file: ${err.message}`;
  }
}

function executeWrite(
  args: { filePath: string; content: string },
  _cwd: string
): string {
  try {
    const dir = dirname(args.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(args.filePath, args.content, "utf-8");
    return `File written successfully: ${args.filePath} (${args.content.length} chars)`;
  } catch (err: any) {
    return `Error writing file: ${err.message}`;
  }
}

function executeEdit(
  args: {
    filePath: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  },
  _cwd: string
): string {
  if (!existsSync(args.filePath)) {
    return `Error: File not found: ${args.filePath}`;
  }
  try {
    let content = readFileSync(args.filePath, "utf-8");
    if (args.oldString === args.newString) {
      return "Error: oldString and newString are identical";
    }

    if (args.replaceAll) {
      if (!content.includes(args.oldString)) {
        return `Error: oldString not found in ${args.filePath}`;
      }
      const count = content.split(args.oldString).length - 1;
      content = content.split(args.oldString).join(args.newString);
      writeFileSync(args.filePath, content, "utf-8");
      return `Replaced ${count} occurrence(s) in ${args.filePath}`;
    }

    const firstIdx = content.indexOf(args.oldString);
    if (firstIdx === -1) {
      return `Error: oldString not found in ${args.filePath}. Make sure the string matches exactly, including whitespace and indentation.`;
    }
    const lastIdx = content.lastIndexOf(args.oldString);
    if (firstIdx !== lastIdx) {
      return `Error: oldString found multiple times in ${args.filePath}. Provide more surrounding context to make it unique, or use replaceAll: true.`;
    }
    content =
      content.slice(0, firstIdx) +
      args.newString +
      content.slice(firstIdx + args.oldString.length);
    writeFileSync(args.filePath, content, "utf-8");
    return `Edit applied to ${args.filePath}`;
  } catch (err: any) {
    return `Error editing file: ${err.message}`;
  }
}

async function executeGlob(
  args: { pattern: string; path?: string },
  cwd: string
): Promise<string> {
  const searchDir = args.path || cwd;
  try {
    // Use ripgrep --files with glob
    const { stdout } = await execAsync(
      `rg --files --glob '${args.pattern}' --sort modified 2>/dev/null | head -${MAX_GLOB_RESULTS}`,
      {
        cwd: searchDir,
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }
    );
    const files = stdout.trim();
    if (!files) return "No files found matching pattern.";
    return files;
  } catch {
    // Fallback: try find command
    try {
      const { stdout } = await execAsync(
        `find . -name '${args.pattern}' -type f 2>/dev/null | head -${MAX_GLOB_RESULTS}`,
        {
          cwd: searchDir,
          encoding: "utf-8",
          timeout: 30_000,
        }
      );
      return stdout.trim() || "No files found matching pattern.";
    } catch {
      return "No files found matching pattern.";
    }
  }
}

async function executeGrep(
  args: { pattern: string; path?: string; include?: string },
  cwd: string
): Promise<string> {
  const searchDir = args.path || cwd;
  try {
    let cmd = `rg --line-number --no-heading --sort modified`;
    if (args.include) {
      cmd += ` --glob '${args.include}'`;
    }
    cmd += ` '${args.pattern.replace(/'/g, "'\\''")}'`;
    cmd += ` 2>/dev/null | head -${MAX_GREP_RESULTS * 5}`;
    const { stdout } = await execAsync(cmd, {
      cwd: searchDir,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = stdout.trim();
    if (!output) return "No matches found.";
    return output.length > MAX_TOOL_RESULT_CHARS
      ? output.slice(0, MAX_TOOL_RESULT_CHARS) + "\n... (truncated)"
      : output;
  } catch {
    return "No matches found.";
  }
}

function executeSkill(
  args: { name: string },
  skills: Skill[]
): string {
  const content = getSkillContent(skills, args.name);
  if (content === null) {
    const available = skills.map((s) => s.name).join(", ");
    return `Error: Skill "${args.name}" not found. Available skills: ${available || "(none)"}`;
  }
  return `# Skill: ${args.name}\n\n${content}`;
}

async function executeTool(
  name: string,
  args: Record<string, any>,
  cwd: string,
  skills: Skill[]
): Promise<string> {
  switch (name) {
    case "bash":
      return executeBash(args as any, cwd);
    case "read":
      return executeRead(args as any, cwd);
    case "write":
      return executeWrite(args as any, cwd);
    case "edit":
      return executeEdit(args as any, cwd);
    case "glob":
      return executeGlob(args as any, cwd);
    case "grep":
      return executeGrep(args as any, cwd);
    case "skill":
      return executeSkill(args as any, skills);
    default:
      return `Unknown tool: ${name}`;
  }
}

// =====================================================================
// Agentic Loop
// =====================================================================

async function runAgentLoop(
  worker: Worker,
  task: Task,
  targetDir: string,
  signal: AbortSignal
): Promise<string> {
  const client = new Anthropic();

  // Load skills from the target directory
  const skills = loadSkills(targetDir);
  if (skills.length > 0) {
    addLog(worker, "info", `Loaded ${skills.length} skills: ${skills.map((s) => s.name).join(", ")}`);
  }

  // Build system prompt (includes skill descriptions)
  const systemPrompt = buildSystemPrompt(targetDir, skills);

  // Build initial user message
  const userMessage = `You are a worker agent completing a specific task in a larger project. Focus ONLY on this task and do it thoroughly.

## Task: ${task.title}

${task.description}

## Important Instructions
1. Make all necessary changes to complete this task fully
2. Test your changes if possible (run builds, linters, etc.)
3. Be thorough - this task should be COMPLETE when you're done
4. Do not modify files outside the scope of this task unless absolutely necessary
5. If you encounter issues, work through them - don't give up easily
6. All file paths must be absolute paths

Begin working on this task now.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let totalSteps = 0;
  let lastTextResponse = "";

  while (totalSteps < MAX_STEPS) {
    if (signal.aborted) throw new Error("Aborted");
    totalSteps++;

    addLog(worker, "info", `Agent step ${totalSteps}...`);

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: toolDefinitions,
        messages,
      });
    } catch (err: any) {
      // Handle rate limiting with retry
      if (err.status === 429 || err.error?.type === "rate_limit_error") {
        const retryAfter = parseInt(err.headers?.["retry-after"] || "30", 10);
        addLog(worker, "warn", `Rate limited. Retrying in ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      // Handle overloaded
      if (err.status === 529) {
        addLog(worker, "warn", "API overloaded. Retrying in 30s...");
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      throw err;
    }

    // Process the response
    const assistantContent: Anthropic.ContentBlock[] = response.content;

    // Add the assistant message to conversation
    messages.push({ role: "assistant", content: assistantContent });

    // Check for text blocks
    for (const block of assistantContent) {
      if (block.type === "text") {
        lastTextResponse = block.text;
        if (block.text.length > 20) {
          addActivity(worker, "text", block.text.slice(0, 200));
        }
      }
    }

    // Check if we should stop
    if (response.stop_reason === "end_turn") {
      addLog(worker, "info", `Agent finished after ${totalSteps} steps (end_turn)`);
      break;
    }

    // Execute tool calls
    const toolUseBlocks = assistantContent.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      addLog(worker, "info", `Agent finished after ${totalSteps} steps (no tool calls)`);
      break;
    }

    // Execute all tool calls and build results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      if (signal.aborted) throw new Error("Aborted");

      const toolName = toolUse.name;
      const toolArgs = toolUse.input as Record<string, any>;

      // Log the tool call
      if (toolName === "bash") {
        addActivity(worker, "bash", `$ ${String(toolArgs.command || "").slice(0, 150)}`);
      } else if (toolName === "write") {
        addActivity(worker, "file_create", `Create: ${toolArgs.filePath}`);
      } else if (toolName === "edit") {
        addActivity(worker, "file_edit", `Edit: ${toolArgs.filePath}`);
      } else if (toolName === "read") {
        addActivity(worker, "tool_call", `read: ${toolArgs.filePath}`);
      } else {
        addActivity(
          worker,
          "tool_call",
          `${toolName}: ${JSON.stringify(toolArgs).slice(0, 100)}`
        );
      }

      // Execute the tool
      let result: string;
      try {
        result = await executeTool(toolName, toolArgs, targetDir, skills);
      } catch (err: any) {
        result = `Tool execution error: ${err.message}`;
        addActivity(worker, "error", `${toolName} error: ${err.message.slice(0, 150)}`);
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Add tool results to conversation
    messages.push({ role: "user", content: toolResults });
  }

  if (totalSteps >= MAX_STEPS) {
    addLog(worker, "warn", `Agent hit step limit (${MAX_STEPS})`);
  }

  return lastTextResponse || `Task completed after ${totalSteps} steps`;
}

function buildSystemPrompt(targetDir: string, skills: Skill[] = []): string {
  // Get basic project info
  let projectInfo = `Working directory: ${targetDir}\n`;

  // Try to get git info
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    projectInfo += `Git branch: ${branch}\n`;
  } catch {
    // Not a git repo
  }

  // Try to read a project context file
  const contextFiles = ["AGENTS.md", "CLAUDE.md", "RTX_PLAN.md"];
  let extraContext = "";
  for (const cf of contextFiles) {
    const path = join(targetDir, cf);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        if (content.length < 50000) {
          extraContext += `\n--- ${cf} ---\n${content}\n`;
        }
      } catch {
        // ignore
      }
    }
  }

  // Build skills summary
  const skillsSummary = buildSkillsSummary(skills);

  return `You are a senior software engineer working autonomously on a coding task. You have access to tools for reading, writing, editing files, running bash commands, and searching the codebase.

## Environment
${projectInfo}
Platform: ${process.platform}
Date: ${new Date().toISOString().split("T")[0]}

## Rules
- All file paths must be ABSOLUTE paths (starting with /)
- Read files before editing them so you understand the current content
- When creating new files, use the write tool
- When modifying existing files, prefer the edit tool (search-replace) over rewriting the entire file
- Test your changes when possible
- Be thorough and complete - do not leave partial implementations
- If a task involves creating C/C++/TypeScript files, write proper, complete, compilable code
- Do NOT ask questions or request clarification - make reasonable decisions and proceed
- Do NOT use placeholder comments like "// TODO: implement" - write actual implementations
- If you need to search the codebase, use glob and grep tools
- If skills are available, use the skill tool to load relevant skills before starting work. Skills contain domain-specific instructions and conventions.
${extraContext ? `\n## Project Context\n${extraContext}` : ""}
${skillsSummary ? `\n${skillsSummary}` : ""}`;
}

// =====================================================================
// Public API (same interface as old worker.ts)
// =====================================================================

export function spawnWorker(
  task: Task,
  targetDir: string
): { worker: Worker; done: Promise<void> } {
  const worker: Worker = {
    id: nanoid(10),
    port: 0, // No port needed - runs in-process
    status: "running",
    taskId: task.id,
    logs: [],
    activity: [],
    startedAt: Date.now(),
  };

  const abortController = new AbortController();
  const instance: WorkerInstance = {
    worker,
    abortController,
    targetDir,
  };
  activeWorkers.set(worker.id, instance);

  eventBus.emit("worker:created", worker);
  addLog(worker, "info", `Worker spawned for task: ${task.title} (in-process, model: ${MODEL})`);

  const done = (async () => {
    try {
      const result = await runAgentLoop(
        worker,
        task,
        targetDir,
        abortController.signal
      );

      worker.status = "completed";
      worker.completedAt = Date.now();
      task.result = result;
      task.status = "completed";
      task.completedAt = Date.now();

      addLog(worker, "info", "Task completed successfully");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      worker.status = "failed";
      worker.completedAt = Date.now();
      task.status = "failed";
      task.error = errorMsg;
      task.completedAt = Date.now();

      addLog(worker, "error", `Worker failed: ${errorMsg}`);
    }

    eventBus.emit("worker:updated", worker);
    eventBus.emit("task:updated", task);
  })();

  return { worker, done };
}

/** Kill a worker (abort the agentic loop) */
export async function killWorker(workerId: string): Promise<void> {
  const instance = activeWorkers.get(workerId);
  if (!instance) return;
  instance.abortController.abort();
  activeWorkers.delete(workerId);
}

/** Kill all active workers */
export async function killAllWorkers(): Promise<void> {
  const ids = Array.from(activeWorkers.keys());
  await Promise.all(ids.map(killWorker));
}

/** Kill only workers belonging to a specific set of worker IDs */
export async function killWorkers(workerIds: string[]): Promise<void> {
  await Promise.all(workerIds.map(killWorker));
}

/** Get all active worker instances */
export function getActiveWorkers(): Worker[] {
  return Array.from(activeWorkers.values()).map((i) => i.worker);
}

/** Get a worker's activity summary for the planner/judge */
export function getWorkerActivitySummary(worker: Worker): string {
  if (worker.activity.length === 0) {
    return "(no activity recorded)";
  }

  const fileEdits = worker.activity.filter(
    (a) => a.type === "file_edit" || a.type === "file_create"
  );
  const bashCmds = worker.activity.filter((a) => a.type === "bash");
  const errors = worker.activity.filter((a) => a.type === "error");

  const lines: string[] = [];
  lines.push(`${worker.activity.length} total actions`);

  if (fileEdits.length > 0) {
    lines.push(`Files touched (${fileEdits.length}):`);
    const files = [...new Set(fileEdits.map((a) => a.summary))];
    for (const f of files.slice(0, 20)) {
      lines.push(`  ${f}`);
    }
    if (files.length > 20) lines.push(`  ... and ${files.length - 20} more`);
  }

  if (bashCmds.length > 0) {
    lines.push(`Commands run (${bashCmds.length}):`);
    for (const cmd of bashCmds.slice(-10)) {
      lines.push(`  ${cmd.summary.slice(0, 120)}`);
    }
  }

  if (errors.length > 0) {
    lines.push(`Errors (${errors.length}):`);
    for (const err of errors.slice(-5)) {
      lines.push(`  ${err.summary.slice(0, 150)}`);
    }
  }

  const recentText = worker.activity
    .filter((a) => a.type === "text")
    .slice(-3);
  if (recentText.length > 0) {
    lines.push("Recent agent output:");
    for (const t of recentText) {
      lines.push(`  "${t.summary.slice(0, 150)}"`);
    }
  }

  return lines.join("\n");
}
