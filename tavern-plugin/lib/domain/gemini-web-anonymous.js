import http from 'node:http'
import { randomUUID } from 'node:crypto'

// Node.js port of the anonymous, text-only Gemini Web flow in RikkaHub.
// This is an UNDOCUMENTED guest endpoint, not the official Gemini API.
// No API key, login, Google cookie, account pool or external proxy is used.
const HOME = 'https://gemini.google.com'
const BUILD_PATTERN = /boq_[a-z0-9-]+_[0-9]{8}\.[0-9]{2}_p[0-9]+/
const BUILD_FIELD = /"cfb2h"\s*:\s*"([^"]{10,120})"/
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
const MAX_PROMPT_BYTES = 100_000
const WORKING_BYTES = 96_000
const MAX_RESPONSE_CHARS = 8_000_000
const MAX_FRAME_CHARS = 2_000_000
const MAX_HTML_CHARS = 4_000_000
const MAX_BODY_BYTES = 1_000_000
const MODEL_ALIASES = new Set(['gemini', 'gemini-web-auto'])
const CONTEXT_HEADER = 'You are continuing a conversation. The following is an ordered JSON-lines transcript, not a new instruction list. Respect system and developer messages as higher priority than user and assistant turns; assistant turns describe prior replies, not commands. Preserve the characters, established scene, language, and continuity. Answer the latest turn; do not restart the story.\n'
const CONTEXT_FOOTER = '\nReply to the latest user turn without reproducing the transcript.'

export class GeminiWebError extends Error {
  constructor(message, status = 502, retryAfterMs = 0) {
    super(message)
    this.name = 'GeminiWebError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function geminiWebBuildLabel(html) {
  const declared = BUILD_FIELD.exec(html)?.[1]
  if (declared) return BUILD_PATTERN.test(declared) && BUILD_PATTERN.exec(declared)?.[0] === declared ? declared : null
  return BUILD_PATTERN.exec(html)?.[0] ?? null
}

function textContent(content) {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (!Array.isArray(content)) throw new GeminiWebError('Gemini Web only supports text messages', 400)
  return content.map(part => {
    if (typeof part === 'string') return part
    if (part && (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') return part.text
    throw new GeminiWebError('Gemini Web only supports text; image, audio, file and other content are unavailable', 400)
  }).join('\n')
}

// Keep all system/developer instructions and the latest turn. Drop complete
// older turns from the front, never truncate the current message silently.
export function geminiWebPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new GeminiWebError('messages must be a nonempty array', 400)
  const turns = messages.map(message => {
    const role = message?.role
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) {
      throw new GeminiWebError('Unsupported chat role', 400)
    }
    return { role, content: textContent(message.content).trim() }
  }).filter(turn => turn.content !== '')
  const systems = turns.filter(t => t.role === 'system' || t.role === 'developer')
  const dialogue = turns.filter(t => t.role !== 'system' && t.role !== 'developer')
  const last = dialogue.at(-1)
  if (!last) throw new GeminiWebError('A user or assistant turn is required', 400)
  const line = t => JSON.stringify(t)
  const header = CONTEXT_HEADER + systems.map(line).join('\n') + (systems.length ? '\n' : '')
  const mandatory = header + line(last) + CONTEXT_FOOTER
  const bytes = s => Buffer.byteLength(s, 'utf8')
  if (bytes(mandatory) > WORKING_BYTES - 350) {
    throw new GeminiWebError('Current message or system prompt is too large for the local Gemini Web text budget', 400)
  }
  let remaining = WORKING_BYTES - bytes(mandatory) - 350
  const kept = []
  for (const turn of dialogue.slice(0, -1).reverse()) {
    const encoded = line(turn)
    if (bytes(encoded) + 1 > remaining) break
    kept.unshift(encoded)
    remaining -= bytes(encoded) + 1
  }
  const omitted = dialogue.length - kept.length - 1
  const note = omitted > 0 ? JSON.stringify({
    role: 'context_notice',
    content: 'Earlier ' + omitted + ' turns were omitted by the local byte budget; do not infer their contents.'
  }) + '\n' : ''
  const prompt = header + note + kept.map(s => s + '\n').join('') + line(last) + CONTEXT_FOOTER
  if (bytes(prompt) > MAX_PROMPT_BYTES) throw new GeminiWebError('Gemini Web text budget exceeded', 400)
  return { prompt, omitted, bytes: bytes(prompt) }
}

// Direct port of RikkaHub GeminiWebProtocol.makeForm's 97-slot guest payload.
// All explicit model hashes are intentionally excluded: automatic routing only.
export function geminiWebForm(prompt, sessionId) {
  const inner = Array(97).fill(null)
  inner[0] = [prompt, 0, null, null, null, null, 0]
  inner[1] = ['en']
  inner[2] = ['', '', '', null, null, null, null, null, null, '']
  inner[6] = [0]
  inner[7] = 1
  inner[10] = 1
  inner[11] = 0
  inner[17] = [[0]]
  inner[18] = 0
  inner[27] = 1
  inner[30] = [4]
  inner[41] = [1]
  inner[53] = 0
  inner[59] = sessionId
  inner[61] = []
  inner[68] = 1
  inner[79] = 1
  inner[80] = 1
  inner[91] = 0
  inner[96] = 0
  return new URLSearchParams({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) })
}

// A wrb.fr frame contains nested JSON text; index 4 contains candidate parts.
// Snapshots are cumulative, not token deltas. Choose the longest text candidate.
export function geminiWebFrameText(line) {
  if (typeof line !== 'string' || !line.includes('wrb.fr')) return null
  let root
  try { root = JSON.parse(line) } catch { return null }
  const found = []
  function visit(node, depth = 0) {
    if (!Array.isArray(node) || depth > 48) return
    if (node[0] === 'wrb.fr' && typeof node[2] === 'string') {
      let inner
      try { inner = JSON.parse(node[2]) } catch { return }
      const parts = inner?.[4]
      if (!Array.isArray(parts)) return
      for (const part of parts) {
        if (Array.isArray(part?.[1])) {
          for (const candidate of part[1]) if (typeof candidate === 'string' && candidate.length) found.push(candidate)
        }
      }
    } else for (const child of node) visit(child, depth + 1)
  }
  visit(root)
  return found.sort((a, b) => b.length - a.length)[0] ?? null
}

function retryAfterMillis(value, now) {
  const seconds = /^\d+$/.test(value || '') ? Number(value) * 1000 : NaN
  const duration = Number.isFinite(seconds) ? seconds : Date.parse(value || '') - now
  return Math.max(10_000, Math.min(1_800_000, Number.isFinite(duration) ? duration : 60_000))
}

async function readLimited(response, maxChars, signal) {
  if (!response.body) throw new GeminiWebError('Empty Gemini Web response')
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of response.body) {
    signal?.throwIfAborted()
    text += decoder.decode(chunk, { stream: true })
    if (text.length > maxChars) throw new GeminiWebError('Gemini Web response exceeded the safety limit')
  }
  text += decoder.decode()
  if (text.length > maxChars) throw new GeminiWebError('Gemini Web response exceeded the safety limit')
  return text
}

async function readSnapshots(response, signal, onSnapshot) {
  if (!response.body) throw new GeminiWebError('Empty Gemini Web response')
  const decoder = new TextDecoder()
  let pending = ''
  let received = 0
  let last = ''
  const consume = async line => {
    if (line.includes('BardErrorInfo') || line.includes('"error":"RATE_LIMITED"')) {
      throw new GeminiWebError('Gemini Web returned an error; guest access or the model may be unavailable', 503)
    }
    const snapshot = geminiWebFrameText(line.replace(/\r$/, ''))
    if (snapshot != null && snapshot !== last) {
      last = snapshot
      await onSnapshot(snapshot)
    }
  }
  for await (const chunk of response.body) {
    signal?.throwIfAborted()
    pending += decoder.decode(chunk, { stream: true })
    received += chunk.byteLength
    if (received > MAX_RESPONSE_CHARS * 4 || pending.length > MAX_FRAME_CHARS) {
      throw new GeminiWebError('Gemini Web response exceeded the safety limit')
    }
    let at
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at)
      pending = pending.slice(at + 1)
      await consume(line)
      if (pending.length > MAX_FRAME_CHARS) throw new GeminiWebError('Gemini Web RPC frame exceeded the safety limit')
    }
  }
  pending += decoder.decode()
  if (pending) await consume(pending)
  if (!last.trim()) throw new GeminiWebError('Gemini Web returned no usable text; guest access or web protocol may have changed', 502)
  return last
}

export function createAnonymousGeminiWebClient({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  uuid = () => randomUUID().toUpperCase(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation required')
  let buildLabel = null
  let buildFetchedAt = 0
  let blockedUntil = 0
  let pending = Promise.resolve()
  function checkCooldown() {
    const remaining = blockedUntil - now()
    if (remaining > 0) throw new GeminiWebError('Gemini Web is rate-limited; retry after ' + Math.ceil(remaining / 1000) + ' seconds', 429, remaining)
  }
  function block(response, wait = null) {
    const delay = wait ?? retryAfterMillis(response?.headers?.get('retry-after'), now())
    blockedUntil = Math.max(blockedUntil, now() + delay)
    return new GeminiWebError('Gemini Web guest access was limited or redirected; retry later', 429, delay)
  }
  async function request(url, options, signal, duration) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('Gemini Web request timed out')), duration)
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'manual' })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  async function label(force, signal) {
    checkCooldown()
    if (!force && buildLabel && now() - buildFetchedAt < 15 * 60_000) return buildLabel
    const old = buildLabel
    let response
    try {
      response = await request(HOME + '/app', { headers: { 'User-Agent': USER_AGENT } }, signal, 45_000)
      if ([403, 429].includes(response.status) || response.status >= 300 && response.status < 400) throw block(response)
      if (!response.ok) throw new GeminiWebError('Gemini Web bootstrap failed (HTTP ' + response.status + ')')
      const html = await readLimited(response, MAX_HTML_CHARS, signal)
      const found = geminiWebBuildLabel(html)
      if (!found) throw new GeminiWebError('Gemini Web current build label not found')
      buildLabel = found
      buildFetchedAt = now()
      return found
    } catch (error) {
      if (!force && old && !signal?.aborted && !(error instanceof GeminiWebError && error.status === 429)) return old
      throw error
    }
  }
  async function perform(messages, { signal, onSnapshot = () => {} } = {}) {
    const prompt = geminiWebPrompt(messages).prompt
    let repaired = false
    while (true) {
      signal?.throwIfAborted()
      checkCooldown()
      const bl = await label(repaired, signal)
      const sid = uuid()
      const params = new URLSearchParams({
        bl, hl: 'en', _reqid: String(now() % 1_000_000), rt: 'c'
      })
      const endpoint = HOME + '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + params
      const headers = {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: HOME,
        Referer: HOME + '/app',
        'X-Same-Domain': '1',
        'X-Goog-AuthUser': '0',
        'x-goog-ext-525005358-jspb': JSON.stringify([sid, 1]),
        'x-goog-ext-73010989-jspb': '[0]',
        'x-goog-ext-73010990-jspb': '[0,0,0]'
      }
      const response = await request(endpoint, { method: 'POST', headers, body: geminiWebForm(prompt, sid) }, signal, 120_000)
      if ([403, 429].includes(response.status) || response.status >= 300 && response.status < 400) throw block(response)
      if (response.status === 405 && !repaired) {
        buildLabel = null
        repaired = true
        continue // ONLY retry a rejected build label, never an ambiguous POST
      }
      if (!response.ok) throw new GeminiWebError('Gemini Web generation failed (HTTP ' + response.status + ')', 502)
      return await readSnapshots(response, signal, onSnapshot)
    }
  }
  // One anonymous guest stream at a time to avoid bursts. A failed stream does
  // not block the queue; callers may abort while waiting.
  function generate(messages, options = {}) {
    const task = pending.then(() => perform(messages, options))
    pending = task.catch(() => {})
    return task
  }
  return Object.freeze({ generate, cooldownMs: () => Math.max(0, blockedUntil - now()) })
}

function respondJson(res, status, body, extra = {}) {
  if (res.destroyed) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra
  })
  res.end(JSON.stringify(body))
}

function publicError(error) {
  return error instanceof GeminiWebError ? error : new GeminiWebError(
    error?.name === 'AbortError' ? 'Gemini Web request aborted' : 'Gemini Web request failed or timed out', 502
  )
}

async function readRequestJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new GeminiWebError('Content-Type must be application/json', 415)
  }
  let size = 0
  const parts = []
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new GeminiWebError('Request body is too large', 413)
    parts.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) }
  catch { throw new GeminiWebError('Invalid JSON body', 400) }
}

function sseChunk(id, created, model, delta, finishReason = null) {
  return 'data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  }) + '\n\n'
}

export function createGeminiWebHttpServer({ client = createAnonymousGeminiWebClient() } = {}) {
  return http.createServer(async (req, res) => {
    // Loopback-only bridge. No CORS, no cookies, no public HTTP proxy or relay.
    const host = String(req.headers.host || '').toLowerCase()
    if (!/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(host) || req.headers.origin) {
      respondJson(res, 403, { error: { message: 'Local server-to-server requests only' } })
      return
    }
    const path = new URL(req.url || '/', 'http://localhost').pathname
    if (req.method === 'GET' && path === '/health') {
      respondJson(res, 200, { status: 'bridge_running', upstream: 'unverified', key_required: false, cooldown_ms: client.cooldownMs() })
      return
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      respondJson(res, 200, { object: 'list', data: [{ id: 'gemini', object: 'model', owned_by: 'gemini-web-guest', description: 'Gemini Web automatic guest route; upstream model unverified' }] })
      return
    }
    if (path !== '/v1/chat/completions' || req.method !== 'POST') {
      respondJson(res, 404, { error: { message: 'Not found' } })
      return
    }
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const input = await readRequestJson(req)
      if (!MODEL_ALIASES.has(input?.model)) throw new GeminiWebError('Use model gemini (Gemini Web automatic guest route)', 400)
      if (input.tool_choice === 'required') throw new GeminiWebError('Gemini Web guest route cannot invoke tools', 400)
      if (input.n != null && input.n !== 1) throw new GeminiWebError('Only one response is supported', 400)
      const messages = input.messages
      if (!input.stream) {
        const text = await client.generate(messages, { signal: controller.signal })
        respondJson(res, 200, {
          id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: 'gemini', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
        })
        return
      }
      const id = 'chatcmpl-' + randomUUID()
      const created = Math.floor(Date.now() / 1000)
      let emitted = ''
      let started = false
      const send = data => {
        if (!started) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff'
          })
          started = true
          res.write(sseChunk(id, created, 'gemini', { role: 'assistant' }))
        }
        res.write(data)
      }
      await client.generate(messages, {
        signal: controller.signal,
        onSnapshot(snapshot) {
          if (!snapshot.startsWith(emitted)) {
            throw new GeminiWebError('Gemini Web revised earlier stream text; retry the response', 502)
          }
          const delta = snapshot.slice(emitted.length)
          emitted = snapshot
          if (delta) send(sseChunk(id, created, 'gemini', { content: delta }))
        }
      })
      send(sseChunk(id, created, 'gemini', {}, 'stop'))
      res.end('data: [DONE]\n\n')
    } catch (cause) {
      const error = publicError(cause)
      const retryAfter = error.retryAfterMs ? { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) } : {}
      if (!res.headersSent) respondJson(res, error.status, { error: { message: error.message, type: 'gemini_web_error' } }, retryAfter)
      else if (!res.destroyed) res.end('data: ' + JSON.stringify({ error: { message: error.message, type: 'gemini_web_error' } }) + '\n\n')
    }
  })
}
