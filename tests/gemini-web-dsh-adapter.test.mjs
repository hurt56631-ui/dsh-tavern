import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createTavernGeminiAdapter,
  nativeGeminiMessages,
  geminiToolInstructions,
  interpretGeminiToolReply,
  GEMINI_WEB_PROVIDER,
  GEMINI_WEB_MODEL
} from '../tavern-plugin/lib/domain/gemini-web-dsh-adapter.js'

const text = value => ({ type: 'text', text: value })
const input = { provider: GEMINI_WEB_PROVIDER, model: GEMINI_WEB_MODEL, messages: [
  { role: 'system', content: [text('Keep character identity and background immutable.')] },
  { role: 'user', content: [text('Hello from the tavern')] }
] }
const tools = [{
  name: 'roll_dice',
  description: 'Roll one die',
  parameters: { type: 'object', properties: { sides: { type: 'integer' } }, required: ['sides'] }
}]

test('native model is discoverable without an API key', async () => {
  const adapter = createTavernGeminiAdapter({ client: { generate: async () => 'hi' } })
  assert.equal(adapter.providerInfo(GEMINI_WEB_PROVIDER).id, GEMINI_WEB_PROVIDER)
  assert.deepEqual((await adapter.listModels(GEMINI_WEB_PROVIDER)).map(x => x.id), [GEMINI_WEB_MODEL])
  assert.equal((await adapter.resolveModel(GEMINI_WEB_PROVIDER, GEMINI_WEB_MODEL)).inputModalities[0], 'text')
  await assert.rejects(adapter.resolveModel(GEMINI_WEB_PROVIDER, 'gemini-2.5-pro'), /只支持自动模型/)
})

test('preserves role instructions, background and tool responses', () => {
  const messages = nativeGeminiMessages({ ...input, messages: [
    ...input.messages,
    { role: 'assistant', content: [text('I opened the door')] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'roll_dice', arguments: '{"sides":6}', id: 'call-1' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [text('4')] },
    { role: 'user', content: [text('Continue the story')] }
  ] })
  assert.equal(messages[0].role, 'system')
  assert.ok(messages.some(x => x.content.includes('Keep character identity')))
  assert.ok(messages.some(x => x.content.includes('called_tool')))
  assert.ok(messages.some(x => x.content.includes('"result":"4"')))
  assert.equal(messages.at(-1).role, 'user')
  assert.equal(messages.at(-1).content, 'Continue the story')
})

test('rejects photos/files rather than silently ignoring them', () => {
  assert.throws(() => nativeGeminiMessages({ ...input, messages: [
    { role: 'user', content: [{ type: 'image', attachment: { id: 'a' } }] }
  ] }), /不能读取图片或附件/)
})

test('tool contract has only declared tools and rejects invented names', () => {
  assert.match(geminiToolInstructions(tools), /roll_dice/)
  assert.deepEqual(interpretGeminiToolReply('{"kind":"tool_call","name":"roll_dice","arguments":{"sides":6}}', tools),
    { kind: 'tool_call', name: 'roll_dice', arguments: '{"sides":6}' })
  assert.throws(() => interpretGeminiToolReply('{"kind":"tool_call","name":"delete_all","arguments":{}}', tools), /未声明/)
  assert.throws(() => interpretGeminiToolReply('{"kind":"tool_call","name":"roll_dice","arguments":"bad"}', tools), /JSON 对象/)
  assert.deepEqual(interpretGeminiToolReply('The tavern keeper smiles.', tools),
    { kind: 'final', content: 'The tavern keeper smiles.' })
})

test('plain text reply emits complete DSH text block and finish', async () => {
  const adapter = createTavernGeminiAdapter({ client: {
    generate: async (_messages, { onSnapshot }) => {
      onSnapshot('你好')
      onSnapshot('你好，冒险者')
      return '你好，冒险者'
    }
  } })
  const chunks = []
  for await (const chunk of adapter.stream(input)) chunks.push(chunk)
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks.filter(x => x.type === 'text-delta').map(x => x.text).join(''), '你好，冒险者')
  assert.deepEqual(chunks.at(-2).block, text('你好，冒险者'))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('tool reply streams only the approved call to DSH', async () => {
  const adapter = createTavernGeminiAdapter({ client: {
    generate: async messages => {
      assert.match(messages[0].content, /roll_dice/)
      return '{"kind":"tool_call","name":"roll_dice","arguments":{"sides":6}}'
    }
  } })
  const chunks = []
  for await (const chunk of adapter.stream({ ...input, tools })) chunks.push(chunk)
  assert.equal(chunks[0].blockType, 'tool-call')
  assert.equal(chunks[2].block.name, 'roll_dice')
  assert.equal(chunks[2].block.arguments, '{"sides":6}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('tool result enables a following reply without repeated invocation', async () => {
  const adapter = createTavernGeminiAdapter({ client: {
    generate: async messages => {
      assert.ok(messages.some(m => m.content.includes('"result":"4"')))
      return '{"kind":"final","content":"骰子点数为四，故事继续。"}'
    }
  } })
  const chunks = []
  for await (const chunk of adapter.stream({ ...input, tools, messages: [
    ...input.messages,
    { role: 'tool', content: [text('4')], toolCallId: 'call-2' },
    { role: 'user', content: [text('Describe what happened')] }
  ] })) chunks.push(chunk)
  assert.equal(chunks.find(x => x.type === 'block-end').block.text, '骰子点数为四，故事继续。')
})
