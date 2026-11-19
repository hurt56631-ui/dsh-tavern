import { randomUUID } from 'node:crypto'
import { createAnonymousGeminiWebClient, GeminiWebError } from './gemini-web-anonymous.js'

export const GEMINI_WEB_PROVIDER = 'gemini-web'
export const GEMINI_WEB_MODEL = 'gemini-web-auto'

// The guest protocol does not advertise context length. This is a conservative
// LOCAL estimate used to encourage earlier story compaction, not a Google claim.
const LOCAL_CONTEXT_ESTIMATE = 8192
const MAX_TOOL_DESCRIPTION = 400
const MAX_TOOL_SCHEMAS = 12000

function unsupported(message) {
  throw new GeminiWebError(message, 400)
}

function contentText(part) {
  if (!part || typeof part !== 'object') unsupported('Gemini 网页模型只能读取文本消息')
  if (part.type === 'text') return String(part.text ?? '')
  if (part.type === 'reasoning') return ''
  if (part.type === 'tool-call') {
    return JSON.stringify({ called_tool: part.name, arguments: part.arguments, call_id: part.id })
  }
  if (part.type === 'tool-addition' || part.type === 'tool-removal') return ''
  if (part.type === 'file' || part.type === 'image') {
    unsupported('匿名 Gemini Web 不能读取图片或附件，请使用文本或其他支持文件的模型')
  }
  unsupported('Gemini 网页模型不支持消息类型 ' + String(part.type))
}

export function nativeGeminiMessages(options, toolInstructions = '') {
  const source = Array.isArray(options.messages) ? options.messages : []
  const messages = []
  if (options.system) messages.push({ role: 'system', content: String(options.system) })
  if (toolInstructions) messages.push({ role: 'system', content: toolInstructions })
  for (const message of source) {
    const role = message?.role
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) {
      unsupported('不支持的 DSH 消息角色：' + String(role))
    }
    if (!Array.isArray(message?.content)) unsupported('DSH 消息格式不正确')
    const pieces = message.content.map(contentText).filter(Boolean)
    if (!pieces.length) continue
    const rendered = pieces.join('\n')
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          call_id: message.toolCallId ?? message.source?.callId ?? null,
          is_error: message.isError === true,
          result: rendered
        })
      })
    } else {
      messages.push({ role, content: rendered })
    }
  }
  return messages
}

function validatedTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  const clean = []
  const ids = new Set()
  for (const item of tools) {
    if (typeof item?.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.name)) {
      unsupported('存在无效的工具名称')
    }
    if (ids.has(item.name)) unsupported('重复工具名称：' + item.name)
    ids.add(item.name)
    clean.push({
      name: item.name,
      description: String(item.description || '').slice(0, MAX_TOOL_DESCRIPTION),
      parameters: item.parameters && typeof item.parameters === 'object'
        ? item.parameters : { type: 'object', properties: {} }
    })
  }
  if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_TOOL_SCHEMAS) {
    unsupported('当前游戏声明了过多工具，Gemini 匿名文本预算无法容纳，请减少启用的工具')
  }
  return clean
}

export function geminiToolInstructions(tools) {
  const active = validatedTools(tools)
  if (!active.length) return ''
  // This is model-side JSON emulation, NOT official Google function calling.
  // DSH validates and executes the returned tool name against its own active
  // schemas. The adapter never executes model output on its own.
  return [
    'You are in an interactive role-playing story driven by an external tool executor.',
    'The tools below are declarations, not narrative text. When you need a tool, respond with exactly one JSON object:',
    '{"kind":"tool_call","name":"exact declared tool name","arguments":{"field":"value"}}',
    'When you can answer without a tool, respond with exactly one JSON object:',
    '{"kind":"final","content":"your story reply"}',
    'Do not wrap JSON in markdown. Never invent a tool name, never claim a tool was executed without a tool result.',
    'If a tool result is present in the transcript, read it and decide whether to call another tool or write the next reply.',
    'Active tools (name, description, JSON Schema parameters):',
    JSON.stringify(active)
  ].join('\n')
}

function jsonEnvelope(text) {
  const value = String(text || '').trim()
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(value)
  const json = m ? m[1].trim() : value
  if (!json.startsWith('{')) return null
  try { return JSON.parse(json) } catch { return null }
}

export function interpretGeminiToolReply(text, tools) {
  const active = validatedTools(tools)
  if (active.length === 0) return { kind: 'final', content: String(text) }
  const parsed = jsonEnvelope(text)
  if (parsed === null) {
    if (String(text).includes('"tool_call"')) unsupported('Gemini 返回了无法解析的工具调用，请重新生成')
    // The model may produce plain prose despite the emulation instruction.
    return { kind: 'final', content: String(text).trim() }
  }
  if (parsed.kind === 'final' && typeof parsed.content === 'string') {
    return { kind: 'final', content: parsed.content }
  }
  if (parsed.kind === 'tool_call') {
    if (!active.some(item => item.name === parsed.name)) {
      unsupported('Gemini 请求了未声明的工具：' + String(parsed.name))
    }
    if (!parsed.arguments || typeof parsed.arguments !== 'object' ||
      Array.isArray(parsed.arguments) || Object.getPrototypeOf(parsed.arguments) !== Object.prototype) {
      unsupported('Gemini 工具参数必须是 JSON 对象')
    }
    return { kind: 'tool_call', name: parsed.name, arguments: JSON.stringify(parsed.arguments) }
  }
  // Unknown JSON envelopes must never masquerade as valid tool executions.
  unsupported('Gemini 返回了未知 JSON 消息格式，请重试或切换模型')
}

function* textChunks(text, finish = 'stop') {
  if (!text.trim()) unsupported('Gemini Web 返回了空回复')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: finish } }
}

async function* streamPlainText(client, messages, signal) {
  // Convert Gemini's cumulative snapshots into append-only DSH delta events.
  // A rewritten upstream snapshot cannot be safely shown as a suffix.
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let pending = []
  let awake
  let done = false
  let failure
  let emitted = ''
  const notify = () => { if (awake) { const fn = awake; awake = null; fn() } }
  function accept(snapshot) {
    if (!snapshot.startsWith(emitted)) {
      unsupported('Gemini 修改了已输出的回复内容，请重新生成')
    }
    const delta = snapshot.slice(emitted.length)
    emitted = snapshot
    if (delta) pending.push(delta)
    notify()
  }
  const request = client.generate(messages, { signal: combined, onSnapshot: accept })
    .then(text => accept(text), error => { failure = error })
    .finally(() => { done = true; notify() })
  let started = false
  try {
    while (!done || pending.length) {
      if (!pending.length) {
        await new Promise(resolve => { awake = resolve })
        continue
      }
      const delta = pending.shift()
      if (!started) {
        started = true
        yield { type: 'block-start', index: 0, blockType: 'text' }
      }
      yield { type: 'text-delta', index: 0, text: delta }
    }
    if (failure) throw failure
    if (!emitted.trim()) unsupported('Gemini Web 返回了空回复')
    yield { type: 'block-end', index: 0, block: { type: 'text', text: emitted } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } finally {
    controller.abort()
    await request
  }
}

export function createTavernGeminiAdapter({ client = createAnonymousGeminiWebClient() } = {}) {
  const adapter = {
    providerInfo(provider) { return { id: provider, name: 'Gemini Web（免费网页·匿名）' } },
    providerRetryPolicy() {
      // An ambiguous timed-out POST must NOT be retried by DSH automatically.
      return { maxAttempts: 1 }
    },
    async listModels(provider) {
      return [{ provider, id: GEMINI_WEB_MODEL, name: 'Gemini（自动，实际型号未验证）',
        description: '无需 API Key，文本优先；Google 可限流或更改协议', inputModalities: ['text'] }]
    },
    async resolveModel(provider, model, signal) {
      signal?.throwIfAborted()
      if (model !== GEMINI_WEB_MODEL && model !== 'gemini') unsupported('Gemini Web 只支持自动模型，请使用 gemini-web-auto')
      return { provider, id: model, name: 'Gemini（网页自动）', inputModalities: ['text'], context: { contextWindow: LOCAL_CONTEXT_ESTIMATE } }
    },
    async prepareCall(provider, model, signal) {
      return { model: await adapter.resolveModel(provider, model, signal), stream: opts => adapter.stream(opts) }
    },
    async *stream(options) {
      const tools = validatedTools(options.tools)
      const messages = nativeGeminiMessages(options, geminiToolInstructions(tools))
      if (!tools.length) {
        yield* streamPlainText(client, messages, options.signal)
        return
      }
      // For tool emulation buffer the candidate: partial JSON is not safe to
      // publish as either text or a callable tool.
      const text = await client.generate(messages, { signal: options.signal })
      const reply = interpretGeminiToolReply(text, tools)
      if (reply.kind === 'final') {
        yield* textChunks(reply.content)
        return
      }
      const id = 'gemini-web-' + randomUUID()
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: reply.name, argumentsDelta: reply.arguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: reply.name, arguments: reply.arguments } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  return adapter
}
