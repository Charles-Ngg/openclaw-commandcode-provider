# openclaw-commandcode-provider

OpenClaw provider plugin for [Command Code](https://commandcode.ai) — adds Command Code models to OpenClaw through two provider surfaces that share one `COMMANDCODE_API_KEY`:

| Provider              | API surface         | Base URL                              | Example model                              |
| --------------------- | ------------------- | ------------------------------------- | ------------------------------------------ |
| `commandcode`         | OpenAI-compatible   | `https://api.commandcode.ai/provider/v1` | `commandcode/deepseek/deepseek-v4-flash` |
| `commandcode-anthropic` | Anthropic Messages | `https://api.commandcode.ai/provider` | `commandcode-anthropic/claude-sonnet-4-6` |

> OpenClaw's `anthropic-messages` transport appends `/v1` to the base URL, so the Anthropic surface points at `.../provider` (not `/provider/v1`). The OpenAI surface points at `/provider/v1` directly.

## Features

- **Live model discovery** — fetches `https://api.commandcode.ai/provider/v1/models` and projects every model into OpenClaw with correct API surface (`claude-*` → anthropic-messages, everything else → openai-completions).
- **Static enrichment** (ported from [pi-commandcode-provider](https://github.com/patlux/pi-commandcode-provider)) — reasoning flags, thinking-level maps (`low`…`max`), vision input modalities, per-model pricing, and max-output-token caps that the provider API doesn't expose.
- **Dynamic model resolution** — `resolveDynamicModel` accepts arbitrary model ids (`commandcode/<anything>`), so new upstream models work without a catalog refresh.
- **Shared auth** — one key powers both surfaces. `providerAuthAliases` maps `commandcode-anthropic` → `commandcode` auth.
- **Auth-file fallback** — when the gateway has no `COMMANDCODE_API_KEY` in env (e.g. systemd user service), the catalog also reads `~/.commandcode/auth.json`, `~/.pi/agent/auth.json`, or `~/.omp/agent/auth.json` (same resolution as pi-commandcode-provider).

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest (includes live discovery test)
```

Install locally in dev mode:

```bash
openclaw plugins install --link ./
openclaw plugins enable commandcode
openclaw gateway restart
```

## Usage

Store the API key (either `export COMMANDCODE_API_KEY=...` in the gateway env, or via an OpenClaw auth profile):

```bash
openclaw models auth paste-api-key --provider commandcode --profile-id commandcode:default
```

Then use models anywhere OpenClaw takes a model ref:

```text
commandcode/deepseek/deepseek-v4-flash
commandcode/gpt-5.6-sol
commandcode/Qwen/Qwen3.8-Max
commandcode-anthropic/claude-sonnet-4-6
commandcode-anthropic/claude-opus-4-8
```

Add model refs to `agents.defaults.models` in `~/.openclaw/openclaw.json` (the allowlist) and they become selectable/settable via `openclaw models set`.

## Plan limits

Command Code's Provider API gates models by plan (e.g. `MODEL_NOT_IN_PLAN: available in Pro and above plans`). Free/GO plans typically cover DeepSeek and selected open models; Claude/Gemini/GPT-5.6 classes need Pro or above. The plugin surfaces whatever the catalog reports — the upstream plan decides what actually runs.

## Publish

```bash
npm run validate
npm exec clawhub -- package publish .
```
