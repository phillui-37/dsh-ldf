import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as plugin from '../src/index.js'

// Exercise the user-facing save path, including its durable patch and a fresh
// boot. Only the external judge is controlled; Settings, ConfigEditor and MCP run.
test('SettingsForms saves all LDF settings through a temporary profile and restores them on restart', { timeout: 30000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ldf-settings-')))
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'supported', evidence_ids: ['e1'], rationale: 'The evidence states the claim.' }) } }] }))
  })
  let ctx
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(home, 'package.json'), '{"name":"ldf-test-installation"}\n')
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    const config = {
      python: process.env.LDF_TEST_PYTHON || resolve('.venv/bin/python'),
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'initial-judge', dataDir: join(home, 'data'),
    }
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'system-prompt', name: 'cordis:prompt' },
      { id: 'tools', name: 'cordis:tools' },
      { id: 'executor', name: 'cordis:executor' },
      { id: 'ldf', name: 'cordis:ldf', config },
    ] }]))
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    const profile = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, prompt: SystemPrompt, tools: ToolRuntime, executor: NativeToolExecutor, ldf: plugin })
    })
    ctx = await start()
    const describe = () => ctx.settings.describe().find(row => row.ns === 'ldf')
    const fields = ['enabled', 'python', 'serverName', 'baseUrl', 'model', 'apiKeyFile', 'timeout', 'maxOutputTokens', 'reasoningEffort', 'outputMode', 'clientName', 'capture', 'captureResponse', 'dataDir', 'toolCallTimeoutMs', 'prefix', 'suffix']
    const { schema } = describe()
    assert.deepEqual(Object.keys(schema.refs[schema.uid].dict).sort(), fields.sort())
    assert.deepEqual(Object.keys(describe().value).sort(), fields)
    assert.equal(describe().value.model, 'initial-judge')

    const update = { model: 'saved-judge', prefix: 'SAVED_SETTINGS_PREFIX', timeout: 17 }
    await ctx.settings.update('ldf', update)
    assert.equal(describe().value.model, update.model)
    const patch = await readFile(profile.patchPath, 'utf8')
    assert.match(patch, /saved-judge/)
    assert.match(patch, /SAVED_SETTINGS_PREFIX/)
    await assert.rejects(ctx.settings.update('ldf', { timeout: 0 }))
    assert.equal(await readFile(profile.patchPath, 'utf8'), patch)
    assert.equal(describe().value.timeout, 17)
    await assertJudgeModel(ctx, requests, 'saved-judge', 'after-save')
    assert.ok(renderPrompt(await ctx.systemPrompt.assemble()).includes(update.prefix))

    await ctx.fiber.dispose()
    ctx = undefined
    ctx = await start()
    assert.equal(describe().value.model, update.model)
    assert.equal(describe().value.timeout, update.timeout)
    assert.equal(describe().value.prefix, update.prefix)
    await assertJudgeModel(ctx, requests, 'saved-judge', 'after-restart')
  } finally {
    if (ctx) await ctx.fiber.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(home, { recursive: true, force: true })
  }
})

async function assertJudgeModel(ctx, requests, model, id) {
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000
    const timer = setInterval(() => {
      if (ctx.tools.get('mcp__ldf__ldf_check_claim')) { clearInterval(timer); resolve() }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('LDF tool registration did not settle')) }
    }, 25)
  })
  const before = requests.length
  const output = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name: 'mcp__ldf__ldf_check_claim', arguments: JSON.stringify({ claim: 'The service is ready.', evidence: [{ id: 'e1', text: 'The service is ready.' }] }) }], signal: AbortSignal.timeout(10000) })
  assert.equal(output.results[0].result.isError, false, JSON.stringify(output.results[0].result))
  assert.match(JSON.stringify(output.results[0].result), /supported/)
  assert.equal(requests.length, before + 1)
  assert.equal(requests.at(-1).model, model)
}
