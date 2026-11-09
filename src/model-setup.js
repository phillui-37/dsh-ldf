import { spawn } from 'node:child_process'
import { findExecutable, isLoopbackUrl, probeOpenAiEndpoint, runLocalCommand, validModelId } from './local-models.js'

const OLLAMA_URL = 'http://127.0.0.1:11434/v1'
const LMSTUDIO_URL = 'http://127.0.0.1:1234/v1'
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000
const MODEL_ID_MAX = 200

function outcome(status, provider, model, baseUrl, downloaded, configured, apiKeyFileCleared, message) {
  return { status, provider, model, baseUrl, downloaded, configured, apiKeyFileCleared, message }
}

function validOllamaModel(value) {
  return typeof value === 'string'
    && value.length <= MODEL_ID_MAX
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
    && value.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.startsWith('-'))
}

function lmStudioAlias(model) {
  const suffix = model.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80)
  return `ldf-${suffix || 'local-model'}`
}

function wait(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve(true)
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(false)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function waitForModel(baseUrl, expectedModel, signal, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  do {
    const result = await probeOpenAiEndpoint(baseUrl, signal)
    if (result.ok && result.models.includes(expectedModel)) return { ok: true }
    if (signal?.aborted) return { ok: false, errorCode: 'cancelled' }
    if (Date.now() >= deadline) return { ok: false, errorCode: 'model_not_visible' }
    if (!await wait(700, signal)) return { ok: false, errorCode: 'cancelled' }
  } while (Date.now() < deadline)
  return { ok: false, errorCode: 'model_not_visible' }
}

async function startOllama(executable, signal) {
  const firstProbe = await probeOpenAiEndpoint(OLLAMA_URL, signal)
  if (firstProbe.ok) return { ok: true, running: true }
  if (signal?.aborted) return { ok: false, errorCode: 'cancelled' }

  let child
  try {
    child = spawn(executable, ['serve'], {
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' },
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    return { ok: false, errorCode: 'server_start_failed' }
  }

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      child.kill('SIGTERM')
      return { ok: false, errorCode: 'cancelled' }
    }
    const probe = await probeOpenAiEndpoint(OLLAMA_URL, signal)
    if (probe.ok) return { ok: true, running: true }
    if (!await wait(500, signal)) {
      child.kill('SIGTERM')
      return { ok: false, errorCode: 'cancelled' }
    }
  }
  child.kill('SIGTERM')
  return { ok: false, errorCode: 'server_start_failed' }
}

async function runSetupCommand(executable, args, signal, env) {
  return runLocalCommand(executable, args, {
    signal,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: 128 * 1024,
    env,
  })
}

function commandFailure(result, provider, serviceStarted) {
  const serviceNote = serviceStarted ? ` The ${provider} service remains running on loopback.` : ''
  if (result.errorCode === 'cancelled') return `Setup was cancelled. A partial model download may remain on disk.${serviceNote}`
  if (result.errorCode === 'timeout') return `The model command timed out. A partial model download may remain on disk.${serviceNote}`
  return `The local model command failed; a partial download may remain on disk. Check that ${provider} is installed and running.${serviceNote}`
}

export async function setupLocalModel(args, { signal, updateSettings } = {}) {
  const provider = args?.provider
  const model = args?.model
  const format = args?.format
  if (args?.confirmed !== true) {
    return outcome('confirmation_required', provider || '', model || '', '', false, false, false,
      'No download or settings change was made. Ask the user to approve the exact runtime, model and format first.')
  }
  if (!['ollama', 'lmstudio'].includes(provider)) {
    return outcome('rejected', String(provider || ''), String(model || ''), '', false, false, false, 'Unsupported provider.')
  }
  if (!['auto', 'gguf', 'mlx'].includes(format)) {
    return outcome('rejected', provider, String(model || ''), '', false, false, false, 'Unsupported model format.')
  }
  if (provider === 'ollama' && format !== 'auto') {
    return outcome('rejected', provider, String(model || ''), '', false, false, false, 'Ollama format must be auto; GGUF and MLX are LM Studio formats.')
  }
  if (provider === 'ollama' ? !validOllamaModel(model) : !validModelId(model, { requireNamespace: true }) || model.length > MODEL_ID_MAX) {
    return outcome('rejected', provider, String(model || ''), '', false, false, false, 'Model must be an exact provider identifier, not a search phrase or URL.')
  }
  if (signal?.aborted) {
    return outcome('cancelled', provider, model, '', false, false, false, 'Setup was cancelled before any action began.')
  }

  const commandName = provider === 'ollama' ? 'ollama' : 'lms'
  const executable = findExecutable(commandName)
  if (!executable) {
    return outcome('runtime_unavailable', provider, model, '', false, false, false, `${commandName} was not found. Install the runtime manually, then run discovery again.`)
  }

  const baseUrl = provider === 'ollama' ? OLLAMA_URL : LMSTUDIO_URL
  if (!isLoopbackUrl(baseUrl)) {
    return outcome('rejected', provider, model, '', false, false, false, 'The selected server endpoint is not loopback.')
  }

  if (provider === 'ollama') {
    const server = await startOllama(executable, signal)
    if (!server.ok) {
      return outcome(server.errorCode === 'cancelled' ? 'cancelled' : 'runtime_unavailable', provider, model, baseUrl, false, false, false,
        'Could not start the Ollama service on loopback. No model was downloaded or settings changed.')
    }
    const pulled = await runSetupCommand(executable, ['pull', model], signal, { OLLAMA_HOST: '127.0.0.1:11434' })
    if (!pulled.ok) {
      return outcome('partial', provider, model, baseUrl, false, false, false, commandFailure(pulled, 'Ollama', server.running))
    }
    const verified = await waitForModel(baseUrl, model, signal)
    if (!verified.ok) {
      return outcome('partial', provider, model, baseUrl, true, false, false, `Model download completed, but the local OpenAI-compatible API did not expose that exact model. Settings were unchanged.${server.running ? ' Ollama remains running on loopback.' : ''}`)
    }
    try {
      if (typeof updateSettings !== 'function') throw new Error('settings service unavailable')
      await updateSettings({ baseUrl, model, apiKeyFile: '' })
    } catch {
      return outcome('partial', provider, model, baseUrl, true, false, false, `Model is ready locally, but LDF settings could not be saved. Settings were not changed.${server.running ? ' Ollama remains running on loopback.' : ''}`)
    }
    return outcome('configured', provider, model, baseUrl, true, true, true, 'Model is ready and LDF settings now use the loopback Ollama endpoint. The API-key path was cleared; the referenced file was not deleted.')
  }

  const serverProbe = await probeOpenAiEndpoint(baseUrl, signal)
  let lmStudioServerRunning = serverProbe.ok
  if (!serverProbe.ok) {
    const started = await runSetupCommand(executable, ['server', 'start', '--port', '1234', '--bind', '127.0.0.1'], signal)
    if (!started.ok) {
      return outcome(started.errorCode === 'cancelled' ? 'cancelled' : 'runtime_unavailable', provider, model, baseUrl, false, false, false,
        'LM Studio could not start its local server. Open or install the LM Studio app, then retry. No model was downloaded or settings changed.')
    }
    lmStudioServerRunning = true
  }

  const getArgs = ['get', '--yes']
  if (format === 'gguf') getArgs.push('--gguf')
  if (format === 'mlx') getArgs.push('--mlx')
  getArgs.push(model)
  const downloaded = await runSetupCommand(executable, getArgs, signal)
  if (!downloaded.ok) {
    return outcome('partial', provider, model, baseUrl, false, false, false, commandFailure(downloaded, 'LM Studio', lmStudioServerRunning))
  }

  const identifier = lmStudioAlias(model)
  const loaded = await runSetupCommand(executable, ['load', '--auto', '--yes', '--identifier', identifier, model], signal)
  if (!loaded.ok) {
    return outcome('partial', provider, model, baseUrl, true, false, false,
      `Model downloaded, but LM Studio could not load it for the local server. LDF settings were unchanged.${lmStudioServerRunning ? ' The LM Studio server remains running on loopback.' : ''}`)
  }
  const verified = await waitForModel(baseUrl, identifier, signal)
  if (!verified.ok) {
    return outcome('partial', provider, model, baseUrl, true, false, false, `Model downloaded and load was requested, but the local API did not expose the configured identifier. LDF settings were unchanged.${lmStudioServerRunning ? ' The LM Studio server remains running on loopback.' : ''}`)
  }
  try {
    if (typeof updateSettings !== 'function') throw new Error('settings service unavailable')
    await updateSettings({ baseUrl, model: identifier, apiKeyFile: '' })
  } catch {
    return outcome('partial', provider, model, baseUrl, true, false, false, `Model is ready locally, but LDF settings could not be saved. Settings were unchanged.${lmStudioServerRunning ? ' The LM Studio server remains running on loopback.' : ''}`)
  }
  return outcome('configured', provider, model, baseUrl, true, true, true, `Model is loaded as ${identifier}, and LDF settings now use the loopback LM Studio endpoint. The API-key path was cleared; the referenced file was not deleted.`)
}
