import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { eventBus } from "./events.js";
import { createRun, startRun, stopRun, pauseRun, resumeRun, getRun, getAllRuns } from "./orchestrator.js";
import { getActiveWorkers, killAllWorkers } from "./worker.js";
import type { CreateRunRequest } from "./types.js";
import { existsSync } from "fs";
import { resolve } from "path";
import { getConfiguredProviders, getPlannerModelId, getWorkerModelId, getModelConfigSummary } from "./model.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3111", 10);

app.use(cors());
app.use(express.json());

// Serve static frontend in production
app.use(express.static("dist/frontend"));

// ---- SSE Events ----
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const clientId = nanoid(8);
  eventBus.addClient(clientId, res);

  // Send recent events to catch up
  const recent = eventBus.getRecentEvents(50);
  for (const event of recent) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ type: "connected", data: { clientId }, timestamp: Date.now() })}\n\n`);
});

// ---- Runs ----
app.post("/api/runs", async (req, res) => {
  try {
    const body = req.body as CreateRunRequest;

    if (!body.goal || !body.targetDir) {
      res.status(400).json({ error: "goal and targetDir are required" });
      return;
    }

    const targetDir = resolve(body.targetDir);
    if (!existsSync(targetDir)) {
      res.status(400).json({ error: `Directory does not exist: ${targetDir}` });
      return;
    }

    const run = await createRun(body.goal, targetDir, body.maxWorkers);

    // Start the run in the background
    startRun(run.id).catch((err) => {
      console.error("Run failed:", err);
    });

    res.json(run);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json(getAllRuns());
});

app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(run);
});

app.post("/api/runs/:id/stop", async (req, res) => {
  try {
    await stopRun(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/runs/:id/pause", async (req, res) => {
  try {
    await pauseRun(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/runs/:id/resume", async (req, res) => {
  try {
    await resumeRun(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---- Workers ----
app.get("/api/workers", (_req, res) => {
  res.json(getActiveWorkers());
});

// ---- Health ----
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "0.1.0",
    providers: getConfiguredProviders(),
    plannerModel: getPlannerModelId(),
    workerModel: getWorkerModelId(),
    // Backward compat for frontend
    anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ---- Cleanup ----
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await killAllWorkers();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await killAllWorkers();
  process.exit(0);
});

app.listen(PORT, () => {
  const providers = getConfiguredProviders();
  const providerStatus = Object.entries(providers)
    .map(([name, configured]) => `  ║  ${name.padEnd(12)}: ${configured ? "configured" : "NOT SET"}`)
    .map(line => line.padEnd(44) + "║")
    .join("\n");

  console.log(`
  ╔══════════════════════════════════════════╗
  ║          Agent Runner v0.1.0             ║
  ║                                          ║
  ║  Backend:  http://localhost:${PORT}         ║
  ║  Frontend: http://localhost:5173         ║
  ║                                          ║
  ║  Models:                                 ║
  ║  Planner: ${getPlannerModelId().padEnd(29)}║
  ║  Worker:  ${getWorkerModelId().padEnd(29)}║
  ║                                          ║
  ║  Providers:                              ║
${providerStatus}
  ╚══════════════════════════════════════════╝
  `);
});
