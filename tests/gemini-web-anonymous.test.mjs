import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  createAnonymousGeminiWebClient, createGeminiWebHttpServer,
  geminiWebBuildLabel, geminiWebForm, geminiWebFrameText, geminiWebPrompt,
  GeminiWebError
} from '../tavern-plugin/lib/domain/gemini-web-anonymous.js'

const LABEL = 'boq_test-service_20261119.01_p1'
function frame(text) {
  const inner = Array(43).fill(null)
  inner[4] = [[null, [text]]]
  return JSON.stringify([['wrb.fr', 'F.x', JSON.stringify(inner)]])
}
function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers })
}
test('extracts current Gemini Web build label; no hard-coded model name', () => {
  assert.equal(geminiWebBuildLabel('{"cfb2h":"' + LABEL + '"}'), LABEL)
  assert.equal(geminiWebBuildLabel('{"cfb2h":"invalid"}'), null)
  assert.equal(geminiWebBuildLabel('... ' + LABEL + ' ...'), LABEL)
})
test('encodes a 97-slot guest request matching RikkaHub routing', () => {
  const form = geminiWebForm('hello', 'S1')
  const [nullSlot, encoded] = JSON.parse(form.get('f.req'))
  assert.equal(nullSlot, null)
  const inner = JSON.parse(encoded)
  assert.equal(inner.length, 97)
  assert.equal(inner[0][0], 'hello')
  assert.equal(inner[59], 'S1')
  assert.equal(inner[79], 1)
})
test('extracts candidate text from nested RPC frames', () => {
  assert.equal(geminiWebFrameText(frame('hello')), 'hello')
  assert.equal(geminiWebFrameText('this is not an RPC frame'), null)
})
test('preserves system instructions and current turn; rejects non-text parts', () => {
  const prepared = geminiWebPrompt([
    { role: 'system', content: 'Stay in character.' },
    { role: 'user', content: 'Previous dialogue' },
    { role: 'assistant', content: 'We are in a tavern.' },
    { role: 'user', content: [{ type: 'text', text: 'Continue.' }] }
  ])
  assert.match(prepared.prompt, /Stay in character/)
  assert.match(prepared.prompt, /We are in a tavern/)
  assert.match(prepared.prompt, /Continue\./)
  assert.throws(() => geminiWebPrompt([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png' } }] }]), GeminiWebError)
})
test('guest generation uses official website without key or cookies', async () => {
  const calls = []
  const client = createAnonymousGeminiWebClient({
    uuid: () => 'FIXTURE',
    now: () => 123,
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), opts })
      if (calls.length === 1) return response('{"cfb2h":"' + LABEL + '"}')
      return response(')]}' + '\n' + frame('Hel') + '\n' + frame('Hello there!') + '\n')
    }
  })
  const snapshots = []
  const text = await client.generate([{ role: 'user', content: 'hello' }], { onSnapshot: s => snapshots.push(s) })
  assert.equal(text, 'Hello there!')
  assert.deepEqual(snapshots, ['Hel', 'Hello there!'])
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1].url).host, 'gemini.google.com')
  assert.equal(calls[1].opts.headers.Cookie, undefined)
  assert.equal(calls[1].opts.headers.Authorization, undefined)
})
test('403 enters cooldown without silently replaying generation POST', async () => {
  let now = 1000
  let calls = 0
  const client = createAnonymousGeminiWebClient({
    now: () => now,
    fetchImpl: async () => {
      calls++
      return calls === 1 ? response('{"cfb2h":"' + LABEL + '"}') : response('forbidden', 403, { 'Retry-After': '120' })
    }
  })
  await assert.rejects(client.generate([{ role: 'user', content: 'hello' }]), { status: 429 })
  await assert.rejects(client.generate([{ role: 'user', content: 'hello' }]), { status: 429 })
  assert.equal(calls, 2)
  assert.equal(client.cooldownMs(), 120000)
  now += 120001
  assert.equal(client.cooldownMs(), 0)
})
test('OpenAI compatible health, catalog, completion and streaming', async t => {
  const fakeClient = {
    cooldownMs: () => 0,
    generate: async (_, { onSnapshot } = {}) => {
      if (onSnapshot) {
        onSnapshot('Hi')
        onSnapshot('Hi friend')
      }
      return 'Hi friend'
    }
  }
  const server = createGeminiWebHttpServer({ client: fakeClient })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port
  assert.equal((await (await fetch(base + '/health')).json()).status, 'bridge_running')
  const catalog = await (await fetch(base + '/v1/models')).json()
  assert.equal(catalog.data[0].id, 'gemini')
  const body = { model: 'gemini', messages: [{ role: 'user', content: 'hello' }] }
  const completion = await (await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })).json()
  assert.equal(completion.choices[0].message.content, 'Hi friend')
  const stream = await (await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true })
  })).text()
  assert.match(stream, /chat\.completion\.chunk/)
  const deltas = stream.split('\n').filter(line => line.startsWith('data: {'))
    .map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || '').join('')
  assert.equal(deltas, 'Hi friend')
  assert.match(stream, /data: \[DONE\]/)
  const badModel = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: 'gemini-pro-made-up' })
  })
  assert.equal(badModel.status, 400)
})
