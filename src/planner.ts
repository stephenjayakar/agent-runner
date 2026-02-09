import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { eventBus } from "./events.js";
import type { Task, Run, Worker, Judgement } from "./types.js";
import { getWorkerActivitySummary } from "./worker.js";
import { execSync } from "child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { loadSkills, buildSkillsContextForPlanner } from "./skills.js";

function getAnthropicClient(): Anthropic {
  return new Anthropic();
}

/** Build a snapshot of the target directory for the planner to reason about */
function getDirectorySnapshot(targetDir: string, maxDepth = 3): string {
  const lines: string[] = [];

  function walk(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(dir);
      const filtered = entries.filter(
        (e) =>
          !e.startsWith(".") &&
          e !== "node_modules" &&
          e !== "dist" &&
          e !== "build" &&
          e !== "__pycache__" &&
          e !== ".git"
      );
      for (const entry of filtered.slice(0, 50)) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          const rel = relative(targetDir, fullPath);
          if (stat.isDirectory()) {
            lines.push(`${prefix}${rel}/`);
            walk(fullPath, depth + 1, prefix);
          } else {
            const size = stat.size;
            lines.push(`${prefix}${rel} (${formatSize(size)})`);
          }
        } catch {
          // skip inaccessible files
        }
      }
    } catch {
      // skip inaccessible dirs
    }
  }

  walk(targetDir, 0, "  ");
  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Read key files that help understand the project */
function getProjectContext(targetDir: string): string {
  const contextFiles = [
    "package.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "README.md",
    "AGENTS.md",
    ".opencode/agents",
  ];

  const parts: string[] = [];
  for (const file of contextFiles) {
    const fullPath = join(targetDir, file);
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && stat.size < 10000) {
          const content = readFileSync(fullPath, "utf-8");
          parts.push(`--- ${file} ---\n${content}`);
        }
      } catch {
        // skip
      }
    }
  }

  // Check if it's a git repo
  try {
    const gitLog = execSync("git log --oneline -10", {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 5000,
    });
    parts.push(`--- Recent git history ---\n${gitLog}`);
  } catch {
    // Not a git repo or no commits
  }

  return parts.join("\n\n");
}

export async function createInitialPlan(run: Run): Promise<{ analysis: string; tasks: Task[] }> {
  const client = getAnthropicClient();

  eventBus.emit("log", {
    level: "info",
    source: "planner",
    message: `Analyzing codebase at ${run.targetDir}...`,
  });

  const dirSnapshot = getDirectorySnapshot(run.targetDir);
  const projectContext = getProjectContext(run.targetDir);

  // Load skills from the target directory
  const skills = loadSkills(run.targetDir);
  const skillsContext = buildSkillsContextForPlanner(skills);

  if (skills.length > 0) {
    eventBus.emit("log", {
      level: "info",
      source: "planner",
      message: `Found ${skills.length} skills in target directory: ${skills.map((s) => s.name).join(", ")}`,
    });
  }

  const prompt = `You are a senior software architect and project planner. You are planning work for a team of autonomous coding agents that will work IN PARALLEL on a codebase.

## Goal
${run.goal}

## Target Directory
${run.targetDir}

## Directory Structure
${dirSnapshot}

## Project Context
${projectContext}
${skillsContext ? `\n${skillsContext}\n` : ""}
## Your Task
Analyze this goal and break it into a set of INDEPENDENT tasks that can be worked on in parallel by separate coding agents. Each agent will work on its own git branch and changes will be merged.

Critical rules:
1. Tasks should be as INDEPENDENT as possible to minimize merge conflicts
2. Each task should be a focused, well-defined unit of work
3. If tasks have dependencies, mark them explicitly
4. Each task should take roughly 5-30 minutes of agent work
5. Be specific about what files to create/modify and what the expected behavior should be
6. Consider the existing codebase structure and conventions
7. Plan for a maximum of ${run.maxWorkers} parallel workers
8. If the project has skills (listed above), mention relevant skills in task descriptions so workers know to use them

Respond with a JSON object (no markdown fencing) with this exact schema:
{
  "analysis": "Brief analysis of the codebase and how to approach the goal",
  "tasks": [
    {
      "title": "Short task title",
      "description": "Detailed description of what to do, including specific files and expected behavior",
      "priority": 1,
      "dependencies": []
    }
  ]
}

The "dependencies" field should contain titles of tasks that must complete before this one can start. Keep dependencies minimal - prefer independent tasks.
Priority 1 is highest priority. Order tasks so the most foundational ones are priority 1.`;

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Parse the JSON response
  let parsed: { analysis: string; tasks: Array<{ title: string; description: string; priority: number; dependencies: string[] }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Planner did not return valid JSON: ${text.slice(0, 200)}`);
    }
    parsed = JSON.parse(jsonMatch[0]);
  }

  const tasks: Task[] = parsed.tasks.map((t, i) => ({
    id: nanoid(10),
    title: t.title,
    description: t.description,
    status: "pending" as const,
    priority: t.priority || i + 1,
    dependencies: t.dependencies || [],
    createdAt: Date.now(),
  }));

  // Resolve dependency titles to IDs
  for (const task of tasks) {
    task.dependencies = task.dependencies
      .map((depTitle) => {
        const dep = tasks.find(
          (t) => t.title.toLowerCase() === depTitle.toLowerCase()
        );
        return dep?.id;
      })
      .filter(Boolean) as string[];
  }

  eventBus.emit("log", {
    level: "info",
    source: "planner",
    message: `Plan created with ${tasks.length} tasks: ${tasks.map((t) => t.title).join(", ")}`,
  });

  return { analysis: parsed.analysis, tasks };
}

/**
 * Judge a single completed/failed task.
 * Called serially — only one judge call at a time.
 * Returns a Judgement with optional new tasks to add.
 */
export async function judgeTaskCompletion(
  run: Run,
  completedTask: Task
): Promise<{
  assessment: string;
  goalComplete: boolean;
  newTasks: Array<{ title: string; description: string; priority: number; dependencies: string[] }>;
}> {
  const client = getAnthropicClient();

  // Build context of all tasks
  const worker = run.workers.find((w) => w.taskId === completedTask.id);
  const activitySummary = worker ? getWorkerActivitySummary(worker) : "(no worker assigned)";

  const allTasksSummary = run.tasks.map((t) => {
    const icon = t.status === "completed" ? "[done]"
      : t.status === "failed" ? "[FAIL]"
      : t.status === "in_progress" ? "[running]"
      : t.status === "cancelled" ? "[cancelled]"
      : "[pending]";
    const extra = t.id === completedTask.id ? " <-- THIS TASK" : "";
    return `  ${icon} ${t.title}${t.spawnedBy ? " (follow-up)" : ""}${extra}`;
  }).join("\n");

  // Previous judgements for context
  const prevJudgements = run.judgements.map((j) => {
    const task = run.tasks.find((t) => t.id === j.taskId);
    return `- [${task?.title || j.taskId}]: ${j.assessment.slice(0, 200)}${j.newTaskIds.length > 0 ? ` (spawned ${j.newTaskIds.length} follow-up tasks)` : ""}${j.goalComplete ? " [MARKED COMPLETE]" : ""}`;
  }).join("\n");

  const pendingCount = run.tasks.filter((t) => t.status === "pending").length;
  const runningCount = run.tasks.filter((t) => t.status === "in_progress").length;
  const completedCount = run.tasks.filter((t) => t.status === "completed").length;
  const failedCount = run.tasks.filter((t) => t.status === "failed").length;

  const prompt = `You are a judge evaluating a single task result in a multi-agent coding project. Workers execute tasks in parallel, and after EACH task finishes you decide if the overall goal is met or if follow-up work is needed.

## Original Goal
${run.goal}

## Initial Analysis
${run.analysis}

## All Tasks (current state)
${allTasksSummary}

Progress: ${completedCount} completed, ${failedCount} failed, ${runningCount} still running, ${pendingCount} pending

${prevJudgements ? `## Previous Judgements\n${prevJudgements}\n` : ""}

## Task Just Completed: "${completedTask.title}"
**Status:** ${completedTask.status}
**Duration:** ${completedTask.startedAt && completedTask.completedAt ? `${Math.round((completedTask.completedAt - completedTask.startedAt) / 1000)}s` : "unknown"}
${completedTask.error ? `**Error:** ${completedTask.error}` : ""}
${completedTask.result ? `**Result:** ${completedTask.result.slice(0, 1000)}` : ""}

**Worker Activity:**
${activitySummary}

## Your Job
1. Assess what this task accomplished (or failed to accomplish)
2. Decide if the OVERALL GOAL is now complete (considering all tasks, including those still running/pending)
3. If this task failed or was incomplete, you may spawn follow-up tasks
4. Be conservative with new tasks — only spawn them if truly needed
5. Do NOT spawn tasks that duplicate already pending or running tasks

Respond with JSON (no markdown fencing):
{
  "assessment": "Brief assessment of this task's result and overall progress",
  "goalComplete": true/false,
  "newTasks": [
    {
      "title": "Follow-up task title",
      "description": "What to do",
      "priority": 1,
      "dependencies": []
    }
  ]
}

Set goalComplete=true ONLY if the overall goal is fully achieved (or close enough) AND there are no more pending/running tasks that matter. If other tasks are still running that are needed, set goalComplete=false and newTasks=[].
Set goalComplete=false if there's still meaningful work pending or running.
Keep newTasks empty ([]) unless you need to spawn specific follow-up work.`;

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  try {
    const parsed = JSON.parse(text);
    return {
      assessment: parsed.assessment || "No assessment",
      goalComplete: parsed.goalComplete ?? false,
      newTasks: parsed.newTasks || [],
    };
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        assessment: parsed.assessment || "No assessment",
        goalComplete: parsed.goalComplete ?? false,
        newTasks: parsed.newTasks || [],
      };
    }
    return {
      assessment: "Could not parse judge response",
      goalComplete: false,
      newTasks: [],
    };
  }
}
