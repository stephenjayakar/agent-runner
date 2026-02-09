import { nanoid } from "nanoid";
import { eventBus } from "./events.js";
import { createInitialPlan, judgeTaskCompletion } from "./planner.js";
import { spawnWorker, killAllWorkers, killWorkers } from "./worker.js";
import type { Run, Task, Judgement } from "./types.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const MAX_CONCURRENT_WORKERS = 10;
const SAVED_DIR = join(process.cwd(), "saved");

const runs = new Map<string, Run>();
const runAborts = new Map<string, AbortController>();

// ---- Persistence ----

function ensureSavedDir() {
  if (!existsSync(SAVED_DIR)) {
    mkdirSync(SAVED_DIR, { recursive: true });
  }
}

function saveRun(run: Run) {
  try {
    ensureSavedDir();
    const data = {
      ...run,
      // Strip large log/activity arrays for persistence - keep last 100 each
      workers: run.workers.map((w) => ({
        ...w,
        logs: w.logs.slice(-100),
        activity: w.activity.slice(-100),
      })),
    };
    writeFileSync(join(SAVED_DIR, `${run.id}.json`), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save run ${run.id}:`, err);
  }
}

function saveState() {
  for (const run of runs.values()) {
    saveRun(run);
  }
}

function loadState() {
  try {
    ensureSavedDir();
    const files = readdirSync(SAVED_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(SAVED_DIR, file), "utf-8"));

        // Migrate old format (cycles-based) to new format (flat tasks)
        let run: Run;
        if (raw.cycles && !raw.tasks) {
          // Old format — migrate
          const allTasks: Task[] = [];
          const allJudgements: Judgement[] = [];
          let analysis = "";

          for (const cycle of raw.cycles) {
            if (cycle.plan?.analysis && !analysis) {
              analysis = cycle.plan.analysis;
            }
            if (cycle.plan?.tasks) {
              allTasks.push(...cycle.plan.tasks);
            }
            if (cycle.judgement) {
              allJudgements.push({
                id: nanoid(10),
                taskId: "",
                assessment: cycle.judgement,
                newTaskIds: [],
                goalComplete: !cycle.shouldContinue,
                timestamp: cycle.completedAt || Date.now(),
              });
            }
          }

          run = {
            id: raw.id,
            goal: raw.goal,
            targetDir: raw.targetDir,
            status: raw.status,
            analysis,
            tasks: allTasks,
            judgements: allJudgements,
            workers: raw.workers || [],
            maxWorkers: raw.maxWorkers || 3,
            createdAt: raw.createdAt,
            completedAt: raw.completedAt,
            error: raw.error,
          };
        } else {
          run = raw as Run;
        }

        // Ensure fields exist
        if (!run.tasks) run.tasks = [];
        if (!run.judgements) run.judgements = [];
        if (!run.analysis) run.analysis = "";

        // Mark any in-flight runs as paused (server was restarted)
        if (["planning", "executing", "judging"].includes(run.status)) {
          run.status = "paused";
        }
        // Mark any in-flight workers as failed (processes are gone)
        for (const worker of run.workers) {
          if (worker.status === "running") {
            worker.status = "failed";
            worker.completedAt = Date.now();
          }
          if (!worker.activity) worker.activity = [];
        }
        // Mark any in-progress tasks as pending so they can be retried on resume
        for (const task of run.tasks) {
          if (task.status === "in_progress") {
            task.status = "pending";
            task.startedAt = undefined;
          }
        }
        runs.set(run.id, run);
      } catch (err) {
        console.error(`Failed to load run from ${file}:`, err);
      }
    }
    const loaded = files.length;
    const paused = Array.from(runs.values()).filter((r) => r.status === "paused").length;
    console.log(`Loaded ${loaded} runs from saved/ (${paused} paused)`);
  } catch (err) {
    console.error("Failed to load state:", err);
  }
}

// Load on startup
loadState();

// Auto-save periodically
setInterval(saveState, 10_000);

// ---- Public API ----

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function getAllRuns(): Run[] {
  return Array.from(runs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function createRun(
  goal: string,
  targetDir: string,
  maxWorkers?: number
): Promise<Run> {
  const run: Run = {
    id: nanoid(10),
    goal,
    targetDir,
    status: "idle",
    analysis: "",
    tasks: [],
    judgements: [],
    workers: [],
    maxWorkers: Math.min(maxWorkers || 3, MAX_CONCURRENT_WORKERS),
    createdAt: Date.now(),
  };

  runs.set(run.id, run);
  saveState();
  eventBus.emit("run:created", run);

  return run;
}

export async function startRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!["idle", "paused"].includes(run.status)) {
    throw new Error(`Run ${runId} is ${run.status}, can only start idle or paused runs`);
  }

  const abort = new AbortController();
  runAborts.set(runId, abort);

  try {
    await executePipeline(run, abort);
  } catch (err) {
    if (abort.signal.aborted) {
      if (run.status !== "paused") {
        run.status = "stopped";
      }
      eventBus.emit("run:updated", run);
      eventBus.emit("log", {
        level: "info",
        source: "system",
        message: run.status === "paused" ? "Run paused" : "Run stopped by user",
      });
    } else {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      eventBus.emit("run:failed", run);
      eventBus.emit("log", {
        level: "error",
        source: "system",
        message: `Run failed: ${run.error}`,
      });
    }
  } finally {
    runAborts.delete(runId);
    saveState();
  }
}

export async function stopRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  runAborts.get(runId)?.abort();
  await killWorkers(getRunningWorkerIds(run));

  for (const worker of run.workers) {
    if (worker.status === "running") {
      worker.status = "failed";
      worker.completedAt = Date.now();
    }
  }

  for (const task of run.tasks) {
    if (task.status === "in_progress") {
      task.status = "pending";
      task.startedAt = undefined;
    }
  }

  run.status = "stopped";
  run.completedAt = Date.now();
  saveState();
  eventBus.emit("run:updated", run);
}

export async function pauseRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!["planning", "executing", "judging"].includes(run.status)) {
    throw new Error(`Run ${runId} is ${run.status}, can only pause active runs`);
  }

  run.status = "paused";
  runAborts.get(runId)?.abort();
  await killWorkers(getRunningWorkerIds(run));

  for (const task of run.tasks) {
    if (task.status === "in_progress") {
      task.status = "pending";
      task.startedAt = undefined;
    }
  }

  saveState();
  eventBus.emit("run:updated", run);
  eventBus.emit("log", {
    level: "info",
    source: "system",
    message: "Run paused. Use resume to continue.",
  });
}

export async function resumeRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (!["paused", "stopped"].includes(run.status)) {
    throw new Error(`Run ${runId} is ${run.status}, can only resume paused or stopped runs`);
  }

  if (run.status === "stopped") {
    run.status = "paused";
    run.completedAt = undefined;
  }

  eventBus.emit("log", {
    level: "info",
    source: "system",
    message: `Resuming run...`,
  });

  startRun(runId).catch((err) => {
    console.error("Resume failed:", err);
  });
}

function getRunningWorkerIds(run: Run): string[] {
  return run.workers
    .filter((w) => w.status === "running")
    .map((w) => w.id);
}

// ---- Pipeline ----

async function executePipeline(run: Run, abort: AbortController): Promise<void> {
  // If resuming with existing tasks, skip planning
  const hasPendingTasks = run.tasks.some((t) => t.status === "pending");

  if (!hasPendingTasks) {
    // ---- PLANNING PHASE ----
    run.status = "planning";
    eventBus.emit("run:updated", run);
    eventBus.emit("log", {
      level: "info",
      source: "system",
      message: "Planning tasks...",
    });

    const { analysis, tasks } = await createInitialPlan(run);
    run.analysis = analysis;
    run.tasks.push(...tasks);
    saveState();
  } else {
    const pendingCount = run.tasks.filter((t) => t.status === "pending").length;
    eventBus.emit("log", {
      level: "info",
      source: "system",
      message: `Resuming with ${pendingCount} pending tasks...`,
    });
  }

  // ---- CONTINUOUS EXECUTION ----
  run.status = "executing";
  eventBus.emit("run:updated", run);

  // Track running worker promises: taskId -> Promise
  const runningTasks = new Map<string, Promise<void>>();

  // Judge queue: tasks that finished and need judging, processed one at a time
  const judgeQueue: Task[] = [];
  let judging = false;

  const processJudgeQueue = async () => {
    if (judging) return; // already processing
    judging = true;

    while (judgeQueue.length > 0) {
      if (abort.signal.aborted) break;

      const task = judgeQueue.shift()!;
      run.status = "judging";
      eventBus.emit("run:updated", run);
      eventBus.emit("log", {
        level: "info",
        source: "judge",
        message: `Evaluating task: ${task.title}`,
      });

      try {
        const result = await judgeTaskCompletion(run, task);

        // Create new tasks if the judge requested them
        const newTaskIds: string[] = [];
        if (result.newTasks && result.newTasks.length > 0) {
          const judgementId = nanoid(10);
          for (const nt of result.newTasks) {
            const newTask: Task = {
              id: nanoid(10),
              title: nt.title,
              description: nt.description,
              status: "pending",
              priority: nt.priority || 5,
              dependencies: [], // Will resolve below
              spawnedBy: judgementId,
              createdAt: Date.now(),
            };

            // Resolve dependencies (titles → IDs)
            if (nt.dependencies && nt.dependencies.length > 0) {
              newTask.dependencies = nt.dependencies
                .map((depTitle: string) => {
                  const dep = run.tasks.find(
                    (t) => t.title.toLowerCase() === depTitle.toLowerCase()
                  );
                  return dep?.id;
                })
                .filter(Boolean) as string[];
            }

            run.tasks.push(newTask);
            newTaskIds.push(newTask.id);
            eventBus.emit("task:updated", newTask);
            eventBus.emit("log", {
              level: "info",
              source: "judge",
              message: `Spawned follow-up task: ${newTask.title}`,
            });
          }

          // Record judgement with the ID we used for spawnedBy
          const judgement: Judgement = {
            id: judgementId,
            taskId: task.id,
            assessment: result.assessment,
            newTaskIds,
            goalComplete: result.goalComplete,
            timestamp: Date.now(),
          };
          run.judgements.push(judgement);
          eventBus.emit("judgement:created", judgement);
        } else {
          // No new tasks — still record the judgement
          const judgement: Judgement = {
            id: nanoid(10),
            taskId: task.id,
            assessment: result.assessment,
            newTaskIds: [],
            goalComplete: result.goalComplete,
            timestamp: Date.now(),
          };
          run.judgements.push(judgement);
          eventBus.emit("judgement:created", judgement);
        }

        eventBus.emit("log", {
          level: "info",
          source: "judge",
          message: result.assessment,
        });

        // Check if judge declared goal complete
        if (result.goalComplete) {
          // Cancel any remaining pending tasks
          for (const t of run.tasks) {
            if (t.status === "pending") {
              t.status = "cancelled";
              eventBus.emit("task:updated", t);
            }
          }

          // If no tasks are still running, complete immediately
          const stillRunning = run.tasks.some((t) => t.status === "in_progress");
          if (!stillRunning) {
            run.status = "completed";
            run.completedAt = Date.now();
            saveState();
            eventBus.emit("run:completed", run);
            eventBus.emit("log", {
              level: "info",
              source: "system",
              message: "Goal achieved! Run completed.",
            });
            judging = false;
            return;
          } else {
            eventBus.emit("log", {
              level: "info",
              source: "system",
              message: "Goal marked complete — waiting for running tasks to finish.",
            });
          }
        }

        saveState();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        eventBus.emit("log", {
          level: "error",
          source: "judge",
          message: `Judge error: ${msg}`,
        });
        // Record a failed judgement so we don't lose the info
        run.judgements.push({
          id: nanoid(10),
          taskId: task.id,
          assessment: `Judge error: ${msg}`,
          newTaskIds: [],
          goalComplete: false,
          timestamp: Date.now(),
        });
      }

      // Back to executing after judging
      if (run.status === "judging") {
        run.status = "executing";
        eventBus.emit("run:updated", run);
      }
    }

    judging = false;
  };

  // Helper: get tasks ready to execute
  const getReadyTasks = (): Task[] => {
    return run.tasks.filter((task) => {
      if (task.status !== "pending") return false;
      return task.dependencies.every((depId) => {
        const depTask = run.tasks.find((t) => t.id === depId);
        return depTask?.status === "completed";
      });
    });
  };

  // Main loop
  while (true) {
    if (abort.signal.aborted) break;

    // Check if we're done (goal marked complete + no running tasks)
    // Note: run.status can be mutated by the async judge callback
    if ((run.status as string) === "completed") break;

    // Spawn workers for ready tasks
    const readyTasks = getReadyTasks();
    for (const task of readyTasks) {
      if (runningTasks.size >= run.maxWorkers) break;
      if (abort.signal.aborted) break;

      task.status = "in_progress";
      task.startedAt = Date.now();
      eventBus.emit("task:updated", task);
      eventBus.emit("log", {
        level: "info",
        source: "system",
        message: `Starting task: ${task.title}`,
      });

      const { worker, done } = spawnWorker(task, run.targetDir);
      run.workers.push(worker);
      eventBus.emit("run:updated", run);

      const taskPromise = done.then(() => {
        // Worker finished — queue for judging
        judgeQueue.push(task);
        // Kick off judge processing (no-op if already running)
        processJudgeQueue();

        saveState();
        eventBus.emit("run:updated", run);
      });

      runningTasks.set(task.id, taskPromise);
    }

    // Handle blocked tasks (dependencies failed)
    if (runningTasks.size === 0 && getReadyTasks().length === 0) {
      const blockedTasks = run.tasks.filter((t) => t.status === "pending");
      if (blockedTasks.length > 0) {
        // Check if they're truly blocked (deps failed) vs just waiting for judge to spawn work
        const trulyBlocked = blockedTasks.filter((t) =>
          t.dependencies.some((depId) => {
            const dep = run.tasks.find((d) => d.id === depId);
            return dep && (dep.status === "failed" || dep.status === "cancelled");
          })
        );

        if (trulyBlocked.length > 0) {
          eventBus.emit("log", {
            level: "warn",
            source: "system",
            message: `${trulyBlocked.length} tasks blocked by failed dependencies. Cancelling them.`,
          });
          for (const t of trulyBlocked) {
            t.status = "cancelled";
            t.error = "Blocked by failed dependencies";
            eventBus.emit("task:updated", t);
          }
        }
      }

      // If nothing is running, nothing is pending, and judge is done — we're finished
      if (!judging && judgeQueue.length === 0) {
        const pendingLeft = run.tasks.filter((t) => t.status === "pending").length;
        if (pendingLeft === 0) {
          break; // Exit main loop
        }
      }
    }

    // Wait for any worker to finish
    if (runningTasks.size > 0) {
      await Promise.race(Array.from(runningTasks.values()));

      // Clean up completed entries from runningTasks
      for (const [taskId] of runningTasks) {
        const task = run.tasks.find((t) => t.id === taskId);
        if (task && (task.status === "completed" || task.status === "failed")) {
          runningTasks.delete(taskId);
        }
      }
    } else {
      // Nothing running — wait a bit for judge to possibly spawn new tasks
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Wait for any remaining workers
  if (runningTasks.size > 0) {
    await Promise.allSettled(Array.from(runningTasks.values()));
  }

  // Wait for judge queue to drain
  while (judging || judgeQueue.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // Final status if not already set
  const finalStatus = run.status as string;
  if (finalStatus !== "completed" && finalStatus !== "failed" && finalStatus !== "stopped" && finalStatus !== "paused") {
    run.status = "completed";
    run.completedAt = Date.now();
    saveState();
    eventBus.emit("run:completed", run);
    eventBus.emit("log", {
      level: "info",
      source: "system",
      message: "All tasks finished. Run completed.",
    });
  }
}
