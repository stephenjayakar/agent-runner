/**
 * Centralized model configuration for the agent runner.
 *
 * Switch models by setting the MODEL environment variable.
 * Examples:
 *   MODEL=claude-opus-4-6          (Anthropic, default)
 *   MODEL=claude-sonnet-4-20250514      (Anthropic)
 *   MODEL=gemini-2.5-pro           (Google)
 *   MODEL=gemini-2.5-flash         (Google)
 *
 * You can also override the planner and worker models independently:
 *   PLANNER_MODEL=gemini-2.5-pro
 *   WORKER_MODEL=claude-sonnet-4-20250514
 *
 * Required env vars depending on which provider you use:
 *   ANTHROPIC_API_KEY   - for Claude models
 *   GOOGLE_GENERATIVE_AI_API_KEY - for Gemini models
 */

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// ---- Provider detection ----

type Provider = "anthropic" | "google";

function detectProvider(modelId: string): Provider {
  if (modelId.startsWith("gemini")) return "google";
  if (modelId.startsWith("claude")) return "anthropic";

  // Fallback: check if it looks like a known pattern
  if (modelId.includes("gemini")) return "google";
  if (modelId.includes("claude") || modelId.includes("anthropic")) return "anthropic";

  // Default to anthropic
  return "anthropic";
}

// ---- Model resolution ----

function resolveModel(modelId: string): LanguageModel {
  const provider = detectProvider(modelId);

  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "google":
      return google(modelId);
    default:
      throw new Error(`Unknown provider for model: ${modelId}`);
  }
}

// ---- Default model IDs ----

const DEFAULT_MODEL = "claude-opus-4-6";

export function getDefaultModelId(): string {
  return process.env.MODEL || DEFAULT_MODEL;
}

export function getPlannerModelId(): string {
  return process.env.PLANNER_MODEL || getDefaultModelId();
}

export function getWorkerModelId(): string {
  return process.env.WORKER_MODEL || getDefaultModelId();
}

// ---- Public API ----

/** Get the LanguageModel instance for the planner (planning + judging) */
export function getPlannerModel(): LanguageModel {
  return resolveModel(getPlannerModelId());
}

/** Get the LanguageModel instance for workers (agentic tool loop) */
export function getWorkerModel(): LanguageModel {
  return resolveModel(getWorkerModelId());
}

/** Get a model by explicit ID */
export function getModel(modelId: string): LanguageModel {
  return resolveModel(modelId);
}

/** Get provider name for a model ID */
export function getProviderName(modelId: string): string {
  return detectProvider(modelId);
}

/** Check which API keys are configured */
export function getConfiguredProviders(): Record<string, boolean> {
  return {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    google: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  };
}

/** Get a summary of model configuration for display */
export function getModelConfigSummary(): string {
  const plannerModel = getPlannerModelId();
  const workerModel = getWorkerModelId();
  const providers = getConfiguredProviders();

  const lines = [
    `Planner model: ${plannerModel} (${detectProvider(plannerModel)})`,
    `Worker model:  ${workerModel} (${detectProvider(workerModel)})`,
    `API keys: ${Object.entries(providers).map(([k, v]) => `${k}=${v ? "set" : "NOT SET"}`).join(", ")}`,
  ];

  return lines.join("\n");
}
