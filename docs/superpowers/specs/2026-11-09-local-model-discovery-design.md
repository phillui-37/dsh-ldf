# LDF local model discovery and setup

Date: 2026-11-09

## Intent

Help a DSH user identify locally available model runtimes and models for LDF, then optionally download and configure a small local model after the user has chosen its runtime/model and explicitly approved that exact download.

## Goals

- Expose an on-demand, read-only DSH tool that inventories supported local model servers, installed models, and available coding-agent CLIs.
- Keep Codex, Claude Code, and OpenCode as inventory-only sources. They are not judge backends; LDF continues to use its existing OpenAI-compatible chat-completions endpoint.
- If no suitable local model is ready, have the agent ask about the user's hardware, disk budget, language and quality/speed needs, then present a specific model/runtime choice and approximate download size before asking for approval.
- After explicit approval of the exact runtime, model and format, download the model, start its local server on loopback if needed, verify that the model is exposed through the local OpenAI-compatible API, and persist `baseUrl` and `model` through DSH settings.
- Do not install Ollama, LM Studio, Python, or other runtimes automatically.

## Approaches

1. **On-demand discovery and explicit setup tools (selected):** a read-only inventory tool plus a separate setup tool that requires explicit human approval for the exact model/runtime. It uses current LDF endpoint configuration and can persist the resulting local endpoint. This meets the requested setup flow while keeping installation behind consent.
2. **Settings-only helper text:** document how to inspect and install models, but leave discovery and profile configuration manual. This is simpler, but misses the requested search and automatic setup.
3. **Use Codex/Claude Code/OpenCode as judge adapters:** this would involve distinct authentication, output and subscription behavior and would depart from the upstream LDF contract. The user chose inventory-only for these CLIs, so this is out of scope.

## Discovery behavior

- Add `ldf_discover_models`, invoked on demand rather than at plugin startup. It reports supported CLI presence, installed model identifiers, local API readiness, and errors with bounded output. It does not download models, start services, change settings, or return credential values.
- Inventory `codex`, `claude`, and `opencode` executables. `opencode models` may report the model identifiers available through OpenCode's own configuration. Report CLI/model-list availability only; do not claim that a paid subscription is active or inspect credential files directly. A CLI may use its own existing authentication internally.
- For local runtimes, inspect Ollama through its CLI/local API and LM Studio through `lms ls --json --llm` and its local OpenAI-compatible API. Use only loopback addresses and known defaults (`127.0.0.1:11434` for Ollama and `127.0.0.1:1234` for LM Studio), plus the configured `baseUrl` only when it is loopback. Do not scan arbitrary ports or probe remote endpoints.
- If the CLI exists but its service is stopped or unavailable, report that state rather than starting it during discovery. In particular, call `lms ls --json --llm` only after the LM Studio API already responds on loopback; otherwise skip CLI inventory because the CLI may try to start or connect to the LM Studio/Bionic app. Parse and return only model identifiers and small status fields, not raw process output.
- Interpret “Replicate/MLX” as Replicate plus Apple MLX: Replicate is cloud and excluded from local download/setup; MLX-compatible downloads are supported through LM Studio's `lms get --mlx` when LM Studio is installed. This is a call for review.

## User-approved setup flow

1. Discovery returns installed runtimes, available models, and any local server readiness problems.
2. If no suitable model is ready, the agent asks for hardware/disk and quality/speed needs. It presents the exact provider/model/format and an approximate download size; if size cannot be established, it says so and asks for consent that explicitly includes the unknown size.
3. Add `ldf_setup_local_model` with an allow-listed provider (`ollama` or `lmstudio`), exact model identifier, format (`auto`, `gguf`, or `mlx` where supported), and a required `confirmed: true` field. The agent must call it only after the human has approved that same runtime/model/format in the current conversation. Reject URLs, option-like model names, unknown providers and unsupported formats. Execute a fixed argument list without a shell; cap output and time, honor cancellation, and never auto-select a fuzzy model search result.
4. After the approved download, start only the selected local service on `127.0.0.1` if required, query its `/v1/models` endpoint, and identify the exact serving model ID. Persist the matching `baseUrl` and `model` with DSH's settings service. Clear the `apiKeyFile` setting reference when switching to a local server so an existing hosted credential is not sent to it; do not delete the referenced key file.
5. If a download succeeds but service startup, model verification, or profile update fails, return a partial outcome and do not claim setup completed. A downloaded model may remain on disk after a later stage fails.

## Constraints and boundaries

- LDF remains the judge only for endpoints that satisfy its current OpenAI-compatible chat-completions contract and strict JSON verdict schema.
- Supported automatic model downloads in the first version are Ollama and LM Studio. Other installed CLI/server tools may be reported, but no arbitrary installer or shell command is run. Replicate is not a local runtime.
- Discovery must be bounded, read-only and local. Setup is the only network-download path and is reachable only through the explicit confirmation tool.
- The current machine has `codex` and `opencode`; `opencode models` returned provider/model IDs. `claude`, `ollama`, and `mlx_lm` were not found on PATH. LM Studio's `lms` CLI exists, and supports `get --mlx` plus `server start --bind 127.0.0.1`, but `lms ls` reported that no running LM Studio/Bionic app or valid installation was found. No model download was attempted; this machine cannot exercise local setup until a supported runtime is available.
- A host-native DSH tool will register the discovery/setup actions. The setup action will use DSH's settings update service to persist the selected endpoint and model; it will not write profile files directly.

## Open to the builder

Confirm the exact DSH settings-service access path and tool registration schema during implementation. Keep discovery independent from the upstream skill selector. Do not add tests or run test suites unless the user asks for verification.
