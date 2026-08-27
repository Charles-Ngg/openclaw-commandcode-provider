#!/usr/bin/env node
/**
 * Syncs static Command Code model metadata from the official `command-code`
 * npm package's bundled models.md (the authoritative model catalog with
 * context windows, reasoning efforts, and per-1M-token rates).
 *
 * Usage:
 *   node scripts/sync-catalog.mjs            # uses latest published CLI
 *   node scripts/sync-catalog.mjs 1.36.0     # pin a version
 *   CC_CLI_DIR=/path/to/package node scripts/sync-catalog.mjs  # use local package
 *
 * Writes:
 *   src/commandcode-catalog.ts  (MODEL_EFFORTS, MODEL_REASONING, MODEL_INPUT_MODALITIES)
 *   src/pricing.ts              (MODEL_COSTS)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CLI_VERSION = process.argv[2] ?? "latest";
const MODELS_MD_REL = "dist/bundled/command-code-knowledge/reference/models.md";

// Models that reason on their own ("decide their own reasoning depth") but
// advertise no explicit effort list in models.md. Kept in sync with
// pi-commandcode-provider's snapshot.
const EXTRA_REASONING = [
  "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.6",
  "MiniMaxAI/MiniMax-M3",
  "tencent/hy3-paid",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "xiaomi/mimo-v2.5",
  "stepfun/Step-3.5-Flash",
];

// Manual max-output-token caps (CLI defaults; not in models.md).
const MAX_OUTPUT_TOKENS = {
  "poolside/laguna-s-2.1-free": 32_768,
  "Qwen/Qwen3.8-27B": 32_768,
  "stealth/ox-alpha": 131_072,
};

function loadModelsMd() {
  if (process.env.CC_CLI_DIR) {
    const p = join(process.env.CC_CLI_DIR, MODELS_MD_REL);
    if (!existsSync(p)) throw new Error(`models.md not found at ${p}`);
    return { version: readCliVersion(process.env.CC_CLI_DIR), text: readFileSync(p, "utf-8") };
  }
  const dir = mkdtempSync(join(tmpdir(), "cc-catalog-"));
  try {
    execSync(`npm pack command-code@${CLI_VERSION} --silent`, { cwd: dir, stdio: "pipe" });
    const tgz = execSync("ls *.tgz", { cwd: dir, encoding: "utf-8" }).trim();
    execSync(`tar xzf ${tgz}`, { cwd: dir });
    const pkgDir = join(dir, "package");
    return {
      version: readCliVersion(pkgDir),
      text: readFileSync(join(pkgDir, MODELS_MD_REL), "utf-8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readCliVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")).version;
  } catch {
    return CLI_VERSION;
  }
}

function parseContext(raw) {
  const s = raw.trim();
  if (!s || s === "—") return undefined;
  const m = s.match(/^([\d.]+)\s*([MK])$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return m[2].toUpperCase() === "M" ? Math.round(n * 1_000_000) : Math.round(n * 1_000);
}

function parsePricing(raw) {
  // $0.22/$0.66 · cache $0.007 (write $2.5)
  const m = raw.match(
    /\$([\d.]+)\s*\/\s*\$([\d.]+)\s*·\s*cache\s*\$([\d.]+)(?:\s*\(write\s*\$([\d.]+)\))?/,
  );
  if (!m) return undefined;
  return {
    input: parseFloat(m[1]),
    output: parseFloat(m[2]),
    cacheRead: parseFloat(m[3]),
    cacheWrite: m[4] ? parseFloat(m[4]) : 0,
  };
}

function bestForHasVision(bestFor) {
  return /vision|multimodal/i.test(bestFor);
}

function parseTableRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*)\s*\|/);
    if (!m) continue;
    const [, id, name, contextRaw, effortsRaw, pricingRaw, minPlan, bestFor] = m;
    rows.push({
      id,
      name: name.trim(),
      context: parseContext(contextRaw),
      efforts: effortsRaw.trim() === "—" ? [] : effortsRaw.split(",").map((s) => s.trim()).filter(Boolean),
      pricing: parsePricing(pricingRaw),
      minPlan: minPlan.trim(),
      bestFor: bestFor.trim(),
      vision: bestForHasVision(bestFor) || id.startsWith("claude-"),
    });
  }
  return rows;
}

function renderCatalog(rows, cliVersion) {
  const effortsEntries = rows
    .filter((r) => r.efforts.length > 0)
    .map((r) => `  ${JSON.stringify(r.id)}: [${r.efforts.map((e) => JSON.stringify(e)).join(", ")}],`)
    .join("\n");
  const reasoningSet = new Set(rows.filter((r) => r.efforts.length > 0).map((r) => r.id));
  for (const id of EXTRA_REASONING) reasoningSet.add(id);
  const reasoningEntries = [...reasoningSet]
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: true,`)
    .join("\n");
  const modalityEntries = rows
    .filter((r) => r.vision)
    .map((r) => `  ${JSON.stringify(r.id)}: ["text", "image"],`)
    .join("\n");
  const maxTokensEntries = Object.entries(MAX_OUTPUT_TOKENS)
    .map(([id, n]) => `  ${JSON.stringify(id)}: ${n},`)
    .join("\n");
  const contextEntries = rows
    .filter((r) => r.context !== undefined)
    .map((r) => `  ${JSON.stringify(r.id)}: ${r.context},`)
    .join("\n");

  return `/**
 * Static Command Code model metadata.
 *
 * AUTO-GENERATED by scripts/sync-catalog.mjs from command-code@${cliVersion}
 * (models.md). Do not edit manually — run \`node scripts/sync-catalog.mjs\`
 * after CLI updates to refresh.
 */

export type CommandCodeInputType = "text" | "image";
export type CommandCodeReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const MODEL_INPUT_MODALITIES: Readonly<
  Record<string, readonly CommandCodeInputType[]>
> = {
${modalityEntries || '  // (none — all models text-only)'}
};

export const MODEL_REASONING: Readonly<Record<string, true>> = {
${reasoningEntries}
};

export const MODEL_EFFORTS: Readonly<
  Record<string, readonly CommandCodeReasoningEffort[]>
> = {
${effortsEntries || '  // (none — all models decide their own reasoning depth)'}
};

export const MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
${maxTokensEntries}
};

/**
 * Known context windows (tokens) from models.md. Used as a static fallback
 * when live discovery is unavailable or the id is not in the live catalog
 * yet (resolveDynamicModel path).
 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
${contextEntries}
};
`;
}

function renderPricing(rows, cliVersion) {
  const entries = rows
    .filter((r) => r.pricing)
    .map((r) => {
      const p = r.pricing;
      const parts = [`input: ${p.input}`, `output: ${p.output}`, `cacheRead: ${p.cacheRead}`, `cacheWrite: ${p.cacheWrite}`];
      return `  ${JSON.stringify(r.id)}: { ${parts.join(", ")} },`;
    })
    .join("\n");

  return `/**
 * Command Code model pricing in USD per million tokens.
 *
 * AUTO-GENERATED by scripts/sync-catalog.mjs from command-code@${cliVersion}
 * (models.md advertised rates; promos already baked in). Do not edit manually.
 *
 * Context-dependent tiered rates (e.g. Qwen 3.7 Flash/Plus long-context
 * tiers, DeepSeek V4 time-of-day pricing) are not expressible here — add
 * them manually below if needed. The Command Code usage page remains
 * authoritative for individual requests.
 */

export interface CommandCodeModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CommandCodeModelCostTier extends CommandCodeModelCostRates {
  inputTokensAbove: number;
}

export interface CommandCodeModelCost extends CommandCodeModelCostRates {
  tiers?: readonly CommandCodeModelCostTier[];
}

export const ZERO_MODEL_COST: CommandCodeModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const MODEL_COSTS: Readonly<Record<string, CommandCodeModelCost>> = {
${entries}
};
`;
}

const { version, text } = loadModelsMd();
const rows = parseTableRows(text);
if (rows.length === 0) throw new Error("No model rows parsed from models.md");

const catalog = renderCatalog(rows, version);
const pricing = renderPricing(rows, version);

const here = new URL(".", import.meta.url);
writeFileSync(join(fileURLToPath(here), "../src/commandcode-catalog.ts"), catalog);
writeFileSync(join(fileURLToPath(here), "../src/pricing.ts"), pricing);

console.log(
  `Synced ${rows.length} models from command-code@${version} → src/commandcode-catalog.ts, src/pricing.ts`,
);
console.log(`  efforts: ${rows.filter((r) => r.efforts.length > 0).length} models`);
console.log(`  vision:  ${rows.filter((r) => r.vision).length} models`);
console.log(`  priced:  ${rows.filter((r) => r.pricing).length} models`);
