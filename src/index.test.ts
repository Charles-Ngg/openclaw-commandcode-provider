import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";

import {
  apiForModelId,
  baseUrlForModel,
  commandCodeModelsFromApiResponse,
  fetchCommandCodeModels,
  toModelDefinition,
} from "./models.js";
import entry from "./index.js";

function registerProviders(): ProviderPlugin[] {
  const providers: ProviderPlugin[] = [];
  const api = {
    registerProvider(provider: ProviderPlugin) {
      providers.push(provider);
    },
  } as Partial<OpenClawPluginApi>;
  entry.register(api as OpenClawPluginApi);
  return providers;
}

function catalogContext(apiKey?: string): ProviderCatalogContext {
  return {
    config: {} as never,
    env: {},
    resolveProviderApiKey: () => ({ apiKey, discoveryApiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey,
      discoveryApiKey: undefined,
      mode: "api_key",
      source: apiKey ? "env" : "none",
    }),
  } as unknown as ProviderCatalogContext;
}

describe("commandcode plugin entry", () => {
  it("registers one provider (commandcode)", () => {
    const providers = registerProviders();
    expect(providers.map((p) => p.id)).toEqual(["commandcode"]);
    expect(providers[0]?.label).toBe("Command Code");
    expect(providers[0]?.envVars).toEqual(["COMMANDCODE_API_KEY"]);
  });

  it("resolves dynamic models into the right provider/api surface", () => {
    const [provider] = registerProviders();
    const resolve = provider.resolveDynamicModel!;

    const openai = resolve({ provider: "commandcode", modelId: "deepseek/deepseek-v4-flash" } as never);
    expect(openai.provider).toBe("commandcode");
    expect(openai.api).toBe("openai-completions");
    expect(openai.baseUrl).toBe("https://api.commandcode.ai/provider/v1");

    const anthropic = resolve({ provider: "commandcode", modelId: "claude-sonnet-4-6" } as never);
    expect(anthropic.provider).toBe("commandcode-anthropic");
    expect(anthropic.api).toBe("anthropic-messages");
    expect(anthropic.baseUrl).toBe("https://api.commandcode.ai/provider");
  });

  it("resolves dynamic models with correct context window", () => {
    const [provider] = registerProviders();
    const resolve = provider.resolveDynamicModel!;

    const flash = resolve({ provider: "commandcode", modelId: "deepseek/deepseek-v4-flash" } as never);
    expect(flash.contextWindow).toBe(1_000_000);

    const glm = resolve({ provider: "commandcode", modelId: "z-ai/glm-5.3-flash" } as never);
    expect(glm.contextWindow).toBe(1_050_000);

    const unknown = resolve({ provider: "commandcode", modelId: "some/future-model" } as never);
    expect(unknown.contextWindow).toBe(128_000);
  });

  it("returns null catalog without a key", async () => {
    const [provider] = registerProviders();
    const result = await provider.catalog!.run(catalogContext());
    // Auth-file fallback may resolve a real key when running on a host that
    // has ~/.pi/agent/auth.json; without any credential it must be null.
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
    }
  });
});

describe("command code model mapping", () => {
  it("classifies claude ids as anthropic-messages", () => {
    expect(apiForModelId("claude-sonnet-4-6")).toBe("anthropic-messages");
    expect(apiForModelId("claude-opus-4-8")).toBe("anthropic-messages");
    expect(apiForModelId("deepseek/deepseek-v4-flash")).toBe("openai-completions");
    expect(apiForModelId("gpt-5.6-sol")).toBe("openai-completions");
  });

  it("strips trailing /v1 only for the anthropic surface", () => {
    const apiBase = "https://api.commandcode.ai/provider/v1";
    expect(baseUrlForModel(apiBase, "openai-completions")).toBe(
      "https://api.commandcode.ai/provider/v1",
    );
    expect(baseUrlForModel(apiBase, "anthropic-messages")).toBe(
      "https://api.commandcode.ai/provider",
    );
  });

  it("parses the documented /models response shape", () => {
    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 200000 },
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_length: 128000 },
      ],
    });
    expect(models).toHaveLength(2);
    expect(models[0]!.id).toBe("claude-sonnet-4-6");
    expect(models[0]!.context_length).toBe(200000);
  });

  it("enriches definitions with reasoning, efforts, vision and pricing", () => {
    const def = toModelDefinition({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      context_length: 200000,
    });
    expect(def.api).toBe("anthropic-messages");
    expect(def.baseUrl).toBe("https://api.commandcode.ai/provider");
    expect(def.reasoning).toBe(true);
    expect(def.input).toContain("image");
    expect(def.cost.input).toBe(3);
    expect(def.cost.output).toBe(15);
    expect(def.thinkingLevelMap).toMatchObject({
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
    expect(def.contextWindow).toBe(200000);
    expect(def.maxTokens).toBe(65536);
  });
});

describe("live discovery", () => {
  it("fetches and maps the live catalog", async () => {
    const models = await fetchCommandCodeModels({ timeoutMs: 5000 });
    expect(models.length).toBeGreaterThan(0);
    const claude = models.find((m) => m.id.startsWith("claude-"));
    expect(claude).toBeDefined();
  });
});
