import { fileURLToPath } from 'node:url'
import { delimiter, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { findInstalledSkill, warnSkillFallback } from './skill.js'
import { discoverLocalModels } from './local-models.js'
import { setupLocalModel } from './model-setup.js'

export const name = 'ldf'
export const inject = ['tools', 'settings']
const root = fileURLToPath(new URL('../', import.meta.url))
export const defaultPrefix = 'Use Local Decision Framework for uncertain factual claims when the verdict could change your next action. Supply a bounded claim and relevant evidence with stable IDs. Treat cited judgments as evidence checks; abstention or provider errors leave the claim unresolved. Do not use LDF to prove causality, complete coverage, authority, or readiness. Skip obvious facts and arithmetic.'

// Volatile fields are the native DSH settings-form contribution. The loader
// commits all values before emitting loader/volatile-update.
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  python: z.string().default('python3').volatile(),
  serverName: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).default('ldf').volatile(),
  baseUrl: z.string().default('http://127.0.0.1:11434/v1').volatile(),
  model: z.string().default('qwen3:8b').volatile(),
  apiKeyFile: z.string().default('').volatile(),
  timeout: z.number().min(1).max(300).default(30).volatile(),
  maxOutputTokens: z.number().step(1).min(1).max(8192).default(1200).volatile(),
  reasoningEffort: z.string().default('').volatile(),
  outputMode: z.union(['json_schema', 'json_object', 'plain']).default('json_object').volatile(),
  clientName: z.string().pattern(/^\S+$/).default('dsh').volatile(),
  capture: z.boolean().default(false).volatile(),
  captureResponse: z.boolean().default(false).volatile(),
  dataDir: z.string().default('').volatile(),
  toolCallTimeoutMs: z.number().step(1).min(1000).default(60000).volatile(),
  followUpstreamSkill: z.boolean().default(false).description('Use the matching installed upstream SKILL.md as the only plugin prompt guidance when available. This cannot disable a skill loaded independently by DSH.').volatile(),
  prefix: z.string().role('textarea').default(defaultPrefix).volatile(),
  suffix: z.string().role('textarea').default('').volatile(),
})

/** Translate UI settings to the upstream process contract; upstream stays unmodified. */
export function processConfig(values) {
  const env = {
    PYTHONPATH: [resolve(root, 'upstream/src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
    LDF_BASE_URL: values.baseUrl,
    LDF_MODEL: values.model,
    LDF_TIMEOUT: String(values.timeout),
    LDF_MAX_OUTPUT_TOKENS: String(values.maxOutputTokens),
    LDF_REASONING_EFFORT: values.reasoningEffort,
    LDF_OUTPUT_MODE: values.outputMode,
    LDF_CLIENT_NAME: values.clientName,
    LDF_CAPTURE: values.capture ? '1' : '0',
    LDF_CAPTURE_RESPONSE: values.captureResponse ? '1' : '0',
  }
  if (values.apiKeyFile) env.LDF_API_KEY_FILE = values.apiKeyFile
  if (values.dataDir) env.LDF_DATA_DIR = values.dataDir
  return {
    transport: 'stdio', serverName: values.serverName, command: values.python,
    args: ['-m', 'ldf.mcp_server'], cwd: root, env,
    toolCallTimeoutMs: values.toolCallTimeoutMs, failOnStartupError: false,
  }
}

// A real child fiber owns both native MCP and prompt contributions. Its ordinary
// config update performs Cordis disposal/restart, including transport shutdown.
const runtime = {
  name: 'ldf-runtime', inject: ['tools'],
  async apply(ctx, values) {
    if (!values.enabled) return
    const prompt = ctx.get('systemPrompt')
    if (prompt) {
      const upstreamSkill = values.followUpstreamSkill ? findInstalledSkill('ldf-check-claim') : null
      if (upstreamSkill?.status === 'found') {
        ctx.effect(() => prompt.section({ name: 'ldf.skill', order: 800, text: upstreamSkill.content, interpolate: false }), 'ldf.skill')
      } else {
        if (upstreamSkill) warnSkillFallback('dsh-ldf', upstreamSkill)
        ctx.effect(() => prompt.section({ name: 'ldf.prefix', order: 800, text: values.prefix }), 'ldf.prefix')
        ctx.effect(() => prompt.section({ name: 'ldf.suffix', order: 801, text: values.suffix }), 'ldf.suffix')
      }
    }
    await ctx.plugin(McpClient, processConfig(values))
  },
}

const discoveryOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    providers: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          installed: { type: 'boolean', required: true },
          ready: { type: 'boolean', required: true },
          models: { type: 'array', items: { type: 'string' }, required: true },
          note: { type: 'string', required: true },
          endpoint: { type: 'string', required: true },
        },
      },
    },
  },
}

const setupOutputSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    baseUrl: { type: 'string', required: true },
    downloaded: { type: 'boolean', required: true },
    configured: { type: 'boolean', required: true },
    apiKeyFileCleared: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
  },
}

function registerLocalModelTools(ctx, snapshot) {
  const discovery = defineTool({
    name: 'ldf_discover_models',
    description: 'Read-only inventory of local model runtimes/models and coding-agent CLI model lists. Only probes loopback/default local endpoints and the configured endpoint when it is loopback. Does not inspect credential files, start services, download models, or change settings. CLI presence does not prove a subscription is active.',
    parameters: {},
    output: {
      schema: discoveryOutputSchema,
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    isConcurrencySafe: () => true,
    execute: (_args, exec) => discoverLocalModels({ baseUrl: snapshot().baseUrl, signal: exec.signal }),
  })

  const setup = defineTool({
    name: 'ldf_setup_local_model',
    description: 'Downloads and configures one exact local model using Ollama or LM Studio. Only call after the human explicitly approves this exact provider, model identifier and format in the current conversation; first ask for their hardware, disk, language and speed/quality needs and show an approximate download size, or say clearly when it is unknown. Requires confirmed=true. Starts services only on 127.0.0.1, uses fixed argv without a shell, updates LDF baseUrl/model and clears only the apiKeyFile setting path (never deletes the key file).',
    parameters: {
      provider: { type: 'string', enum: ['ollama', 'lmstudio'], required: true },
      model: { type: 'string', required: true, description: 'Exact provider model identifier; never a search phrase or URL.' },
      format: { type: 'string', enum: ['auto', 'gguf', 'mlx'], required: true },
      confirmed: { type: 'boolean', required: true, description: 'Set true only after the human explicitly approved this exact provider/model/format.' },
    },
    output: {
      schema: setupOutputSchema,
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    isConcurrencySafe: () => false,
    execute: (args, exec) => setupLocalModel(args, {
      signal: exec.signal,
      updateSettings: patch => ctx.settings.update('ldf', patch),
    }),
  })

  const disposeDiscovery = ctx.tools.register(discovery)
  const disposeSetup = ctx.tools.register(setup)
  return () => {
    disposeSetup?.()
    disposeDiscovery?.()
  }
}

export async function apply(ctx, config) {
  const snapshot = () => Object.fromEntries(Object.entries(config).map(([key, ref]) => [key, ref.get()]))
  let disposeModelTools
  const syncModelTools = enabled => {
    if (enabled && !disposeModelTools) disposeModelTools = registerLocalModelTools(ctx, snapshot)
    else if (!enabled && disposeModelTools) {
      disposeModelTools()
      disposeModelTools = undefined
    }
  }
  syncModelTools(snapshot().enabled)
  ctx.effect(() => () => {
    disposeModelTools?.()
    disposeModelTools = undefined
  }, 'ldf.localModelTools()')

  const child = ctx.plugin(runtime, snapshot())
  let pending = Promise.resolve()
  ctx.on('loader/volatile-update', () => {
    const values = snapshot()
    syncModelTools(values.enabled)
    pending = pending.catch(() => {}).then(() => child.update(values))
    return pending
  })
  await child
}
