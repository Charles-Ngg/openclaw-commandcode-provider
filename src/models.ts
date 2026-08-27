/**
 * Command Code model discovery and enrichment.
 *
 * Fetches the live model catalog from Command Code's Provider API and maps it
 * into OpenClaw `ModelDefinitionConfig` rows, enriched with static metadata
 * ported from pi-commandcode-provider.
 */

import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

import {
  MODEL_CONTEXT_WINDOWS,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_REASONING,
} from "./commandcode-catalog.ts";
import { MODEL_COSTS, ZERO_MODEL_COST } from "./pricing.ts";

export const DEFAULT_PROVIDER_API_BASE = "https://api.commandcode.ai/provider/v1";
export const DEFAULT_MODELS_URL = `${DEFAULT_PROVIDER_API_BASE}/models`;
export const DEFAULT_MODELS_TIMEOUT_MS = 10_000;

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

export type CommandCodeApi = "openai-completions" | "anthropic-messages";

const TEXT_INPUT_ONLY = ["text"] as const;

export function apiForModelId(id: string): CommandCodeApi {
  return id.startsWith("claude-") ? "anthropic-messages" : "openai-completions";
}

/**
 * OpenClaw's anthropic-messages transport appends `/v1` to the base URL
 * (unless it already ends with `/v1`). Command Code exposes the Anthropic
 * surface at `https://api.commandcode.ai/provider`, so strip a trailing
 * `/v1` that is meant for the OpenAI-compatible surface.
 */
export function baseUrlForModel(apiBase: string, api: CommandCodeApi): string {
  const normalized = apiBase.replace(/\/+$/g, "");
  if (api !== "anthropic-messages") return normalized;
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

export function inputModalitiesForModel(
  modelId: string,
): readonly ("text" | "image")[] {
  return MODEL_INPUT_MODALITIES[modelId] ?? TEXT_INPUT_ONLY;
}

function isReasoningModel(modelId: string): boolean {
  return MODEL_REASONING[modelId] === true;
}

function maxOutputTokensForModel(modelId: string, contextLength: number): number {
  return Math.min(contextLength, MODEL_MAX_OUTPUT_TOKENS[modelId] ?? DEFAULT_MAX_OUTPUT_TOKENS);
}

/**
 * Maps Command Code reasoning efforts to OpenClaw thinking levels
 * (`low`/`medium`/`high`/`xhigh`/`max`). Unknown efforts become `null`.
 */
export function thinkingLevelMapForModel(
  modelId: string,
): ModelDefinitionConfig["thinkingLevelMap"] {
  const efforts = MODEL_EFFORTS[modelId];
  if (!efforts) return undefined;
  const levels = ["low", "medium", "high", "xhigh", "max"] as const;
  const map: NonNullable<ModelDefinitionConfig["thinkingLevelMap"]> = {};
  for (const level of levels) {
    map[level] = efforts.includes(level) ? level : null;
  }
  return map;
}

export interface RawCommandCodeModel {
  id: string;
  name: string;
  context_length: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string`);
  }
  return value;
}

function positiveNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${key} to be a positive number`);
  }
  return value;
}

export function commandCodeModelsFromApiResponse(
  value: unknown,
): readonly RawCommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected models response to be an object");
  if (value.object !== "list") throw new Error("Expected models response object to be 'list'");
  const data = value.data;
  if (!Array.isArray(data)) throw new Error("Expected models response data to be an array");

  return data.map((entry) => {
    if (!isRecord(entry)) throw new Error("Expected model entry to be an object");
    return {
      id: stringField(entry, "id"),
      name: stringField(entry, "name"),
      context_length: positiveNumberField(entry, "context_length"),
    };
  });
}

/**
 * Static context window fallback for ids not present in the live catalog
 * (dynamic model resolution path). Prefers the live/known value.
 */
export function contextWindowForModel(modelId: string): number | undefined {
  return MODEL_CONTEXT_WINDOWS[modelId];
}

export function toModelDefinition(model: RawCommandCodeModel): ModelDefinitionConfig {
  const thinkingLevelMap = thinkingLevelMapForModel(model.id);
  return {
    id: model.id,
    name: `${model.name} (Command Code)`,
    api: apiForModelId(model.id),
    baseUrl: baseUrlForModel(DEFAULT_PROVIDER_API_BASE, apiForModelId(model.id)),
    reasoning: isReasoningModel(model.id),
    input: [...inputModalitiesForModel(model.id)],
    cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
    contextWindow: model.context_length,
    maxTokens: maxOutputTokensForModel(model.id, model.context_length),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}
export async function fetchCommandCodeModels(options: {
  url?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<readonly RawCommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL;
  const timeoutMs =
    options.timeoutMs !== undefined &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_MODELS_TIMEOUT_MS;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  let settled = false;

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (onExternalAbort && options.signal) {
      options.signal.removeEventListener("abort", onExternalAbort);
    }
  };

  try {
    const body: unknown = await new Promise((resolve, reject) => {
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveOnce = (value: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      if (options.signal?.aborted) {
        rejectOnce(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      onExternalAbort = () =>
        rejectOnce(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      options.signal?.addEventListener("abort", onExternalAbort, { once: true });
      timer = setTimeout(
        () => rejectOnce(new Error(`Command Code model discovery timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(
              `Failed to fetch Command Code models: ${response.status} ${response.statusText}`,
            );
          }
          return response.json();
        })
        .then(resolveOnce, rejectOnce);
    });

    const models = commandCodeModelsFromApiResponse(body);
    if (models.length === 0) {
      throw new Error("Command Code returned an empty model catalog");
    }
    return models;
  } finally {
    cleanup();
    controller.abort();
  }
}
