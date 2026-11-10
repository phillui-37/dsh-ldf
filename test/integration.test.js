import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as plugin from '../src/index.js'

// Contract: native Loader settings must reach the real upstream stdio process;
// changing namespace/enable must remove old registrations and prompt sections.
// The HTTP server is a controlled external provider, not a replacement for LDF.
test('real Loader + native MCP + upstream judge + live settings and disposal', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(resolve('.ldf-test-'))
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, body: JSON.parse(body) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'supported', evidence_ids: ['e1'], rationale: 'The supplied evidence states the claim.' }) } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('settings', { update: async () => { throw new Error('Unexpected settings update during MCP integration test') } })
    ctx.loader.builtins.ldf = plugin
    const config = { python: process.env.LDF_TEST_PYTHON || resolve('.venv/bin/python'), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-judge', dataDir, prefix: 'PREFIX_CHECK', suffix: 'SUFFIX_CHECK' }
    const id = await ctx.loader.create({ name: 'cordis:ldf', config })
    const entry = ctx.loader.resolve(id)
    await entry.fiber.await()
    assert.ok(ctx.tools.get('mcp__ldf__ldf_check_claim'))
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    assert.ok(prompt.includes('PREFIX_CHECK') && prompt.includes('SUFFIX_CHECK'))
    const output = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'integration-1', name: 'mcp__ldf__ldf_check_claim', arguments: JSON.stringify({ claim: 'The service is ready.', evidence: [{ id: 'e1', text: 'The service is ready.' }] }) }], signal: AbortSignal.timeout(10000) })
    assert.equal(output.results[0].result.isError, false)
    assert.match(JSON.stringify(output.results[0].result), /supported/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/v1/chat/completions')
    assert.equal(requests[0].body.model, 'fixture-judge')
    await entry.update({ config: { ...config, serverName: 'changed', prefix: 'UPDATED_PREFIX' } })
    await waitFor(() => ctx.tools.get('mcp__changed__ldf_check_claim'))
    assert.equal(ctx.tools.get('mcp__ldf__ldf_check_claim'), undefined)
    assert.ok(renderPrompt(await ctx.systemPrompt.assemble()).includes('UPDATED_PREFIX'))
    await entry.update({ config: { ...config, enabled: false } })
    await waitFor(() => !ctx.tools.get('mcp__changed__ldf_check_claim'))
    assert.ok(!renderPrompt(await ctx.systemPrompt.assemble()).includes('UPDATED_PREFIX'))
  } finally {
    await ctx.fiber.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  }
})

function waitFor(check) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve() }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('plugin update did not settle')) }
    }, 25)
  })
}
