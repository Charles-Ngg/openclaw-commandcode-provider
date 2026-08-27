/**
 * Command Code provider plugin for OpenClaw.
 *
 * Exposes two provider surfaces sharing one `COMMANDCODE_API_KEY`:
 *
 * - `commandcode`            → OpenAI-compatible `/provider/v1` endpoint
 * - `commandcode-anthropic`  → Anthropic Messages `/provider` endpoint
 *                              (OpenClaw appends `/v1` to the base URL)
 *
 * Model discovery fetches the live catalog from
 * `https://api.commandcode.ai/provider/v1/models` and enriches each model with
 * static reasoning/effort/vision/pricing metadata.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  apiForModelId,
  contextWindowForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  fetchCommandCodeModels,
  toModelDefinition,
} from "./models.ts";

const PLUGIN_ID = "commandcode";
const PROVIDER_OPENAI = PLUGIN_ID;
const PROVIDER_ANTHROPIC = "commandcode-anthropic";
const DEFAULT_MODEL_REF = "commandcode/deepseek/deepseek-v4-flash";

function splitModels(models: readonly ModelDefinitionConfig[]): {
  openai: ModelDefinitionConfig[];
  anthropic: ModelDefinitionConfig[];
} {
  const openai: ModelDefinitionConfig[] = [];
  const anthropic: ModelDefinitionConfig[] = [];
  for (const model of models) {
    if (apiForModelId(model.id) === "anthropic-messages") {
      anthropic.push(model);
    } else {
      openai.push(model);
    }
  }
  return { openai, anthropic };
}

function buildOpenAiProvider(models: readonly ModelDefinitionConfig[]): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: DEFAULT_PROVIDER_API_BASE,
    models: [...models],
  };
}

function buildAnthropicProvider(models: readonly ModelDefinitionConfig[]): ModelProviderConfig {
  return {
    api: "anthropic-messages",
    // OpenClaw's anthropic transport appends `/v1` to the base URL.
    baseUrl: baseUrlForApi(DEFAULT_PROVIDER_API_BASE, "anthropic-messages"),
    models: [...models],
  };
}

function baseUrlForApi(apiBase: string, api: "openai-completions" | "anthropic-messages"): string {
  const normalized = apiBase.replace(/\/+$/g, "");
  if (api !== "anthropic-messages") return normalized;
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

/**
 * Fallback credential lookup for environments where the gateway has no
 * COMMANDCODE_API_KEY in its env (e.g. systemd user services). Mirrors
 * pi-commandcode-provider's auth resolution: reads ~/.commandcode/auth.json
 * or ~/.pi/agent/auth.json (also ~/.omp/agent/auth.json).
 */
function commandCodeApiKeyFromAuthFiles(home: string = homedir()): string | undefined {
  const paths = [
    join(home, ".commandcode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      for (const key of ["commandcode", "command-code"]) {
        const credential = record[key];
        if (typeof credential !== "object" || credential === null) continue;
        const entry = credential as Record<string, unknown>;
        if (entry.type === "oauth" && typeof entry.access === "string") return entry.access;
        if (typeof entry.key === "string" && entry.key.length > 0) return entry.key;
        if (typeof entry.access === "string") return entry.access;
      }
    } catch {
      // Unreadable auth file; fall through.
    }
  }
  return undefined;
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Command Code",
  description: "Add Command Code models to OpenClaw.",
  register(api) {
    api.registerProvider({
      id: PROVIDER_OPENAI,
      label: "Command Code",
      docsPath: "/providers/commandcode",
      envVars: ["COMMANDCODE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_OPENAI,
          methodId: "api-key",
          label: "Command Code API key",
          hint: "API key from commandcode.ai",
          optionKey: "commandcodeApiKey",
          flagName: "--commandcode-api-key",
          envVar: "COMMANDCODE_API_KEY",
          promptMessage: "Enter your Command Code API key",
          defaultModel: DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_OPENAI, PROVIDER_ANTHROPIC],
          noteTitle: "Command Code",
          noteMessage:
            "One API key powers both commandcode/* and commandcode-anthropic/* models.",
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey =
            ctx.resolveProviderApiKey(PROVIDER_OPENAI).apiKey ?? commandCodeApiKeyFromAuthFiles();
          if (!apiKey) return null;

          const models = (await fetchCommandCodeModels()).map(toModelDefinition);
          const { openai, anthropic } = splitModels(models);

          return {
            providers: {
              [PROVIDER_OPENAI]: { ...buildOpenAiProvider(openai), apiKey },
              [PROVIDER_ANTHROPIC]: { ...buildAnthropicProvider(anthropic), apiKey },
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => {
        const api = apiForModelId(ctx.modelId);
        const baseUrl = baseUrlForApi(DEFAULT_PROVIDER_API_BASE, api);
        const contextWindow = contextWindowForModel(ctx.modelId) ?? 128_000;
        return {
          id: ctx.modelId,
          name: ctx.modelId,
          provider: api === "anthropic-messages" ? PROVIDER_ANTHROPIC : PROVIDER_OPENAI,
          api,
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: Math.min(contextWindow, 65_536),
        };
      },
    });
  },
});
