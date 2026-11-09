import { fileURLToPath } from 'node:url'
import { delimiter, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

export const name = 'ldf'
export const inject = ['tools']
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
      ctx.effect(() => prompt.section({ name: 'ldf.prefix', order: 800, text: values.prefix }), 'ldf.prefix')
      ctx.effect(() => prompt.section({ name: 'ldf.suffix', order: 801, text: values.suffix }), 'ldf.suffix')
    }
    await ctx.plugin(McpClient, processConfig(values))
  },
}

export async function apply(ctx, config) {
  const snapshot = () => Object.fromEntries(Object.entries(config).map(([key, ref]) => [key, ref.get()]))
  const child = ctx.plugin(runtime, snapshot())
  let pending = Promise.resolve()
  ctx.on('loader/volatile-update', () => {
    const values = snapshot()
    pending = pending.catch(() => {}).then(() => child.update(values))
    return pending
  })
  await child
}
