import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const MAX_COMMAND_OUTPUT = 64 * 1024
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@-]*)*$/

function candidatePaths(command) {
  const pathExts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  const directories = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const candidates = []
  for (const directory of directories) {
    for (const extension of pathExts) candidates.push(join(directory, `${command}${extension}`))
  }
  if (command === 'lms') {
    const home = homedir()
    for (const extension of pathExts) candidates.push(join(home, '.lmstudio', 'bin', `lms${extension}`))
  }
  return [...new Set(candidates)]
}

export function findExecutable(command) {
  for (const candidate of candidatePaths(command)) {
    try {
      if (!statSync(candidate).isFile()) continue
      if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase())
      && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

export function validModelId(value, { requireNamespace = false } = {}) {
  if (typeof value !== 'string' || value.length > 200 || !MODEL_ID.test(value) || value.includes('://')) return false
  if (/^(?:https?|file|ftp):/i.test(value)) return false
  if (value.split('/').some(segment => segment === '.' || segment === '..' || segment.startsWith('-'))) return false
  if (requireNamespace && !value.includes('/')) return false
  return true
}

export function runLocalCommand(executable, args, { signal, timeoutMs = 10000, maxOutputBytes = MAX_COMMAND_OUTPUT, env = {} } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ ok: false, errorCode: 'cancelled', stdout: '', stderr: '', truncated: false })
      return
    }

    let child
    let settled = false
    let timedOut = false
    let cancelled = false
    let truncated = false
    let bytes = 0
    const stdout = []
    const stderr = []
    let timer
    let killTimer

    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
      })
    }
    const stop = () => {
      if (child && !child.killed) child.kill('SIGTERM')
      killTimer = setTimeout(() => child?.kill('SIGKILL'), 1500)
    }
    const abort = () => {
      cancelled = true
      stop()
    }
    const collect = (bucket, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - bytes)
      const part = chunk.subarray(0, remaining)
      if (part.length) bucket.push(part)
      bytes += part.length
      if (part.length !== chunk.length) truncated = true
    }

    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
      child.stdout.on('data', chunk => collect(stdout, chunk))
      child.stderr.on('data', chunk => collect(stderr, chunk))
      child.once('error', error => finish({ ok: false, errorCode: error.code || 'spawn_error', exitCode: null }))
      child.once('close', exitCode => finish({ ok: exitCode === 0 && !timedOut && !cancelled, errorCode: cancelled ? 'cancelled' : timedOut ? 'timeout' : undefined, exitCode }))
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
    } catch (error) {
      finish({ ok: false, errorCode: error.code || 'spawn_error', exitCode: null })
    }
  })
}

function cleanModelList(values) {
  if (!Array.isArray(values)) return []
  return [...new Set(values.map(value => {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return ''
    return value.id || value.name || value.model || value.modelKey || value.key || ''
  }).filter(value => typeof value === 'string' && validModelId(value)))].slice(0, 500)
}

async function readJsonBody(response) {
  const maxBytes = 1024 * 1024
  const reader = response.body?.getReader()
  if (!reader) return {}
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        const error = new Error('response_too_large')
        error.code = 'response_too_large'
        throw error
      }
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    reader.releaseLock()
  }
}

async function requestJson(url, { signal, timeoutMs = 1800 } = {}) {
  if (!isLoopbackUrl(url)) return { ok: false, errorCode: 'not_loopback', models: [] }
  const timeout = AbortSignal.timeout(timeoutMs)
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: combinedSignal, headers: { accept: 'application/json' } })
    if (!response.ok) return { ok: false, errorCode: `http_${response.status}`, models: [] }
    const body = await readJsonBody(response)
    const values = body?.data ?? body?.models ?? body?.items ?? []
    return { ok: true, models: cleanModelList(values) }
  } catch (error) {
    const errorCode = signal?.aborted ? 'cancelled' : error.code === 'response_too_large' ? 'response_too_large' : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'unavailable'
    return { ok: false, errorCode, models: [] }
  }
}

function providerRecord(name, kind, installed, ready, models = [], note = '', endpoint = '') {
  return { name, kind, installed, ready, models: cleanModelList(models), note, endpoint }
}

function parseLmsModels(stdout) {
  try {
    const body = JSON.parse(stdout)
    const items = Array.isArray(body) ? body : body?.models ?? body?.items ?? []
    return cleanModelList(items)
  } catch {
    return []
  }
}

function parseOpenCodeModels(stdout) {
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/
  return [...new Set(stdout.split(/\r?\n/).map(line => line.trim()).filter(line => pattern.test(line)))].slice(0, 500)
}

async function probeOllama(signal) {
  const result = await requestJson('http://127.0.0.1:11434/api/tags', { signal })
  return { ...result, endpoint: 'http://127.0.0.1:11434/v1' }
}

async function probeLmStudio(signal) {
  const result = await requestJson('http://127.0.0.1:1234/v1/models', { signal })
  return { ...result, endpoint: 'http://127.0.0.1:1234/v1' }
}

export async function probeOpenAiEndpoint(baseUrl, signal) {
  if (!isLoopbackUrl(baseUrl)) return { ok: false, errorCode: 'not_loopback', models: [] }
  const normalized = `${baseUrl.replace(/\/+$/, '')}/models`
  return requestJson(normalized, { signal })
}

export async function discoverLocalModels({ baseUrl = '', signal } = {}) {
  const providers = []
  const cliNames = ['codex', 'claude', 'opencode', 'ollama', 'lms', 'mlx_lm', 'replicate']
  const commands = Object.fromEntries(cliNames.map(name => [name, findExecutable(name)]))

  for (const name of ['codex', 'claude']) {
    providers.push(providerRecord(name, 'agent-cli', Boolean(commands[name]), Boolean(commands[name]), [], commands[name]
      ? 'CLI found; authentication and subscription status are not checked.'
      : 'CLI not found on PATH.'))
  }

  if (commands.opencode) {
    const result = await runLocalCommand(commands.opencode, ['models'], { signal, timeoutMs: 10000 })
    const note = !result.ok
      ? result.errorCode === 'timeout' ? 'Model inventory command timed out.' : 'CLI found; model inventory is unavailable.'
      : `Model identifiers are from OpenCode CLI inventory; this does not prove a paid subscription is active.${result.truncated ? ' Output was truncated; the list may be incomplete.' : ''}`
    providers.push(providerRecord('opencode', 'agent-cli', true, result.ok, result.ok ? parseOpenCodeModels(result.stdout) : [], note))
  } else {
    providers.push(providerRecord('opencode', 'agent-cli', false, false, [], 'CLI not found on PATH.'))
  }

  const ollama = await probeOllama(signal)
  providers.push(providerRecord('ollama', 'local-runtime', Boolean(commands.ollama) || ollama.ok, ollama.ok, ollama.models,
    ollama.ok ? 'Local API is responding on loopback.' : commands.ollama ? 'CLI found; local API at 127.0.0.1:11434 is unavailable.' : 'CLI not found; local API is unavailable.', ollama.endpoint))

  const lmStudioApi = await probeLmStudio(signal)
  let lmStudioCliModels = []
  let lmStudioInventoryReady = false
  let lmStudioInventoryTruncated = false
  if (commands.lms && lmStudioApi.ok) {
    const result = await runLocalCommand(commands.lms, ['ls', '--json', '--llm'], { signal, timeoutMs: 10000 })
    lmStudioInventoryReady = result.ok
    lmStudioInventoryTruncated = result.truncated
    if (result.ok) lmStudioCliModels = parseLmsModels(result.stdout)
  }
  const lmStudioModels = [...new Set([...lmStudioCliModels, ...lmStudioApi.models])]
  const lmStudioNote = lmStudioApi.ok
    ? lmStudioInventoryReady
      ? `LM Studio model inventory and local API are available.${lmStudioInventoryTruncated ? ' CLI output was truncated; the list may be incomplete.' : ''}`
      : 'Local API is responding; CLI inventory was unavailable.'
    : commands.lms ? 'LM Studio CLI found; API is unavailable, so discovery skipped CLI inventory to avoid starting services.' : 'LM Studio CLI not found; local API is unavailable.'
  providers.push(providerRecord('lmstudio', 'local-runtime', Boolean(commands.lms) || lmStudioApi.ok, lmStudioApi.ok, lmStudioModels, lmStudioNote, lmStudioApi.endpoint))

  providers.push(providerRecord('mlx_lm', 'local-runtime', Boolean(commands.mlx_lm), false, [], commands.mlx_lm
    ? 'CLI found; no standardized local model inventory was queried.' : 'MLX-LM CLI not found on PATH.'))
  providers.push(providerRecord('replicate', 'cloud-cli', Boolean(commands.replicate), false, [], commands.replicate
    ? 'Cloud CLI found; excluded from local model setup.' : 'CLI not found on PATH; Replicate is not a local runtime.'))

  if (isLoopbackUrl(baseUrl)) {
    const endpoint = await probeOpenAiEndpoint(baseUrl, signal)
    providers.push(providerRecord('configured-local-endpoint', 'local-server', true, endpoint.ok, endpoint.models, endpoint.ok
      ? 'Configured loopback endpoint is responding.' : 'Configured loopback endpoint is unavailable.', new URL(baseUrl).origin))
  }

  return { status: signal?.aborted ? 'cancelled' : 'complete', providers }
}
