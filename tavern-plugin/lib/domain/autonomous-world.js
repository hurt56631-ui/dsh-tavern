import { createHash } from 'node:crypto'

// Optional, model-free background simulation. Never edits the canonical story or
// invents player actions. World events are reports, not settled story facts.
const INTERVALS = new Set([1, 5, 15, 30, 60])
const GAME_MINUTES = new Set([30, 60, 180, 360, 1440])
const MAX_EVENTS = 80
const MAX_ACTORS = 240
const MAX_CATCH_UP_TICKS = 12

const CHONGZHEN_CAST = [
  ['周皇后', 'palace', '照看内廷与皇室'], ['田皇贵妃', 'palace', '照料宫务与个人生活'],
  ['袁贵妃', 'palace', '维系宫内人际关系'], ['王承恩', 'palace', '处理内廷往来'],
  ['周延儒', 'court', '维护官场影响力'], ['陈演', 'court', '争取朝中支持'],
  ['孙传庭', 'army', '筹措军需与整顿部伍'], ['吴三桂', 'army', '守备边地'],
  ['李自成', 'rebel', '扩展部众和情报网络'], ['张献忠', 'rebel', '维持部伍与地方联系'],
  ['商贾', 'civilian', '寻找生意和安全的道路'], ['驿卒', 'civilian', '传递各地消息']
]
const ACTIONS = {
  palace: ['料理本职事务，与熟悉的人交换消息', '审视近日人际关系，考虑是否请人传话', '安排宫内日程，留意尚未解决的事情'],
  court: ['与同僚讨论一项尚未定论的事务', '整理消息，考虑向上递交意见', '拜访支持者，权衡朝局风险'],
  army: ['清点军需与值守安排', '与幕僚研判局势，尚未作出出兵决定', '检查军纪并准备下一次汇报'],
  rebel: ['联络部众，商议下一步打算', '派人探听各地消息', '计算粮草与行军条件，尚未发动新的战事'],
  civilian: ['为生计和日常事务奔走', '与邻里交换各地传闻', '筹备下一次出行或工作'],
  other: ['处理自己的日常事务', '与熟识人物保持往来', '酝酿个人目标的下一步行动']
}
const MESSAGES = {
  palace: '宫内传来消息：{name}正在{activity}，若有合适机会，可能遣人问候或求见。',
  court: '朝中风闻：{name}正在{activity}，有关议题仍待各方商议。',
  army: '军中通报：{name}正在{activity}，尚无已经生效的新军令。',
  rebel: '地方传闻：{name}正在{activity}；情报未经核实，不代表战果已定。',
  civilian: '有人来信：{name}近日正在{activity}，希望有机会交流近况。',
  other: '收到消息：{name}正在{activity}，并未要求你立刻作出决定。'
}


const CAST_LINE = /^〔(史实|史料有限|虚构)〕([^｜\n]{1,40})｜([^｜\n]{1,110})(?:｜([^\n]{1,220}))?$/gm

// Only designated cast-index sections are parsed as NPC definitions. Do not
// treat lorebook trigger keywords or regular prose as people.
function castFromWorldbook(chat) {
  const document = chat?.openingWorldbookSnapshot?.document
  const raw = document?.data?.character_book || document?.character_book || document
  const entries = rows(raw?.entries)
  const result = []
  for (const entry of entries.slice(0, 100)) {
    if (!entry || entry.disable === true || entry.enabled === false) continue
    const heading = text(entry.comment || entry.name)
    const content = text(entry.content)
    if (!(heading.includes('固定人物档案') || /^【[^\n]{0,90}固定人物档案】/.test(content)) || content.length > 25_000) continue
    const role = /皇家|嫔|女官|宫女|内侍|后妃/.test(heading) ? 'palace'
      : /起事|农民军/.test(heading) ? 'rebel'
      : /军事|明军|辽东/.test(heading) ? 'army'
      : /阁臣|六部|京官|衙门/.test(heading) ? 'court'
      : /清廷|边境/.test(heading) ? 'army' : 'civilian'
    CAST_LINE.lastIndex = 0
    for (const match of content.matchAll(CAST_LINE)) {
      const [, origin, name, identity, description = ''] = match
      if (name === '朱由检' || name === '崇祯皇帝') continue
      result.push({ name, identity, role, goal: description || identity, origin })
    }
  }
  return result.slice(0, MAX_ACTORS)
}

function isEmperorPlayer(chat) {
  const greeting = rows(chat?.messages).find(row => row?.greeting === true)
  const opening = text(greeting?.sourceText || greeting?.text || chat?.openingText)
  return /【当前身份[：:][^】]{0,25}(崇祯|皇帝|朱由检)/.test(opening)
}

function rows(value) {
  return Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []
}
function text(value) { return typeof value === 'string' ? value.trim() : '' }
function limited(value, length = 70) { return text(value).slice(0, length) }
function clone(value) { return structuredClone(value) }
function category(name, identity = '') {
  const combined = name + ' ' + identity
  if (/皇后|贵妃|宫女|妃嫔|选侍|内侍|宦官|女官|内廷|宫中|皇室/.test(combined)) return 'palace'
  if (/将军|军|都督|统帅|总兵|边将|提督|武将|守备|巡抚/.test(combined)) return 'army'
  if (/起义|义军|闯王|流寇|反军|叛军|部众/.test(combined)) return 'rebel'
  if (/尚书|大学士|御史|官员|朝臣|阁臣|首辅|宰相|朝廷/.test(combined)) return 'court'
  if (/商|驿|村|店|百姓|平民|农|工|书生|街/.test(combined)) return 'civilian'
  return 'other'
}
function initialActors(chat) {
  const found = new Map()
  function add(name, identity, role, goal) {
    name = limited(name, 42)
    if (!name || found.has(name) || found.size >= MAX_ACTORS) return
    role = role || category(name, identity)
    found.set(name, { id: createHash('sha256').update(name).digest('hex').slice(0, 16),
      name, role, goal: limited(goal || identity || '料理日常事务', 180),
      lastAction: '', lastTick: 0, progress: 0, planStep: 0, memory: [] })
  }
  for (const ch of rows(chat?.ledger?.npcs)) add(ch?.name, ch?.title || ch?.personality, null, ch?.desc)
  for (const ch of rows(chat?.characterDesignDocument?.characters)) {
    add(ch?.name, ch?.design?.identity || ch?.identity, null, ch?.design?.narrativeRole || ch?.narrativeRole)
  }
  for (const member of castFromWorldbook(chat)) add(member.name, member.identity, member.role, member.goal)
  const isChongzhen = /崇祯|大明末年|明末/.test(text(chat?.cardName))
  if (isChongzhen && found.size < 25) {
    for (const [name, role, goal] of CHONGZHEN_CAST) add(name, goal, role, goal)
  }
  return [...found.values()]
}
function cleanState(raw) {
  const state = raw && raw.version === 1 && typeof raw === 'object' ? clone(raw) : {}
  return {
    version: 1, enabled: state.enabled === true,
    sessionId: limited(state.sessionId, 256),
    intervalMinutes: INTERVALS.has(state.intervalMinutes) ? state.intervalMinutes : 15,
    gameMinutesPerTick: GAME_MINUTES.has(state.gameMinutesPerTick) ? state.gameMinutesPerTick : 60,
    nextAt: Number.isFinite(state.nextAt) ? state.nextAt : 0,
    lastTickAt: Number.isFinite(state.lastTickAt) ? state.lastTickAt : 0,
    tick: Number.isSafeInteger(state.tick) && state.tick >= 0 ? state.tick : 0,
    elapsedGameMinutes: Number.isSafeInteger(state.elapsedGameMinutes) && state.elapsedGameMinutes >= 0 ? state.elapsedGameMinutes : 0,
    actors: rows(state.actors).filter(row => row && text(row.name)).slice(0, MAX_ACTORS),
    events: rows(state.events).filter(row => row && text(row.id)).slice(-MAX_EVENTS),
    lastError: limited(state.lastError, 200)
  }
}
function report(state) {
  return { ...clone(state), unread: state.events.filter(event => event.readAt == null).length }
}
function eventMessage(actor) {
  return MESSAGES[actor.role]?.replace('{name}', actor.name).replace('{activity}', actor.lastAction)
    || MESSAGES.other.replace('{name}', actor.name).replace('{activity}', actor.lastAction)
}
function stepWorld(state, chat, timestamp) {
  const next = clone(state)
  const source = initialActors(chat)
  const seen = new Set(next.actors.map(ch => ch.name))
  for (const ch of source) if (!seen.has(ch.name) && next.actors.length < MAX_ACTORS) {
    next.actors.push(ch); seen.add(ch.name)
  }
  next.tick += 1
  next.elapsedGameMinutes += next.gameMinutesPerTick
  next.lastTickAt = timestamp
  next.nextAt = timestamp + next.intervalMinutes * 60_000
  const len = next.actors.length
  const acted = []
  for (let i = 0; i < Math.min(4, len); i++) {
    // Stable IDs and round-robin scheduling: no per-NPC model calls, no
    // special preference for the first character in an enormous cast.
    const actor = next.actors[(next.tick * 7 - 7 + i) % len]
    const actions = ACTIONS[actor.role] || ACTIONS.other
    actor.progress = (Number(actor.progress) || 0) + 1
    actor.planStep = ((Number(actor.planStep) || 0) % actions.length) + 1
    actor.lastAction = actions[actor.planStep - 1]
    actor.lastTick = next.tick
    actor.memory = rows(actor.memory).slice(-3).concat([{
      tick: next.tick, action: actor.lastAction, intent: actor.goal
    }])
    acted.push(actor)
  }
  // Not every off-screen action is a letter. Bound inbox pressure even if
  // the server runs all night. The player can choose whether to answer.
  if (acted.length && next.tick % 2 === 1) {
    // An ordinary outsider cannot receive an imperial consort's private
    // audience or a rebel's secret military planning as a direct message.
    const actor = acted.find(person => isEmperorPlayer(chat) || person.role === 'civilian' || person.role === 'other')
      || acted.find(person => person.role !== 'palace') || acted[0]
    next.events.push({
      id: 'tick-' + next.tick + '-' + actor.id, tick: next.tick,
      actorId: actor.id, actor: actor.name, role: actor.role,
      gameMinutes: next.elapsedGameMinutes, createdAt: timestamp,
      text: eventMessage(actor), kind: actor.role === 'civilian' || actor.role === 'other' ? 'message' : 'report',
      visibility: isEmperorPlayer(chat) ? 'court' : 'rumour',
      provisional: true, readAt: null
    })
    next.events = next.events.slice(-MAX_EVENTS)
  }
  return next
}
function contextText(state) {
  if (!state.enabled && state.events.length === 0) return ''
  const events = state.events.slice(-8)
  if (!events.length) return ''
  const recent = events.map(e => '- ' + e.actor + '：' + e.text).join('\n')
  return '【活世界·后台时间流（独立于玩家行动）】\n' +
    '玩家尚未回应以下消息。它们是角色主动活动形成的报告或传闻，不是玩家的决定，也不能视为已核定的战果、官职、财政变化。' +
    '不得代替玩家答应请求；应尊重既有正文和世界书，发生冲突时以正文确定的事实为准。\n' +
    '后台已经模拟流逝 ' + state.elapsedGameMinutes + ' 游戏分钟，累计 ' + state.tick + ' 次世界步进。' +
    '这些信息属于尚待核实的幕后活动，不得直接宣布成为历史事实。\n' +
    recent.slice(0, 3500)
}

export function createAutonomousWorld({
  read, write, list = async () => [], loadChat, isBusy = async () => false, publish = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, logger = console
}) {
  const timers = new Map()
  const queues = new Map()
  let disposed = false
  function key(sessionId) {
    if (!text(sessionId) || text(sessionId).length > 256) throw new Error('活世界需要有效的本局会话 ID')
    return 'autonomous-world/' + createHash('sha256').update(sessionId).digest('hex') + '.json'
  }
  async function readState(id) { return cleanState(await read(key(id))) }
  async function withLock(id, fn) {
    const preceding = queues.get(id) || Promise.resolve()
    const result = preceding.catch(() => {}).then(fn)
    queues.set(id, result)
    try { return await result } finally { if (queues.get(id) === result) queues.delete(id) }
  }
  function clear(id) {
    if (timers.has(id)) clearTimer(timers.get(id))
    timers.delete(id)
  }
  function arm(id, state, retryAt) {
    clear(id)
    if (disposed || !state.enabled) return
    const delay = Math.max(100, (retryAt || state.nextAt || (now() + state.intervalMinutes * 60_000)) - now())
    const timer = setTimer(() => {
      timers.delete(id)
      void tick(id).catch(error => {
        logger.warn?.('dsh-tavern: 活世界步进失败', error)
        // A corrupt save or temporary I/O failure must not spin at 100ms.
        void readState(id).then(state => arm(id, state, now() + 60_000)).catch(() => {})
      })
    }, delay)
    timer.unref?.()
    timers.set(id, timer)
  }
  async function activeChat(id) {
    const chat = await loadChat(id)
    if (!chat || !['story', 'script'].includes(chat.mode || 'story')) throw new Error('活世界只能在现有游玩对话中启用')
    return chat
  }
  async function status(id) {
    await activeChat(id)
    const state = await readState(id)
    if (state.enabled && !timers.has(id)) arm(id, state)
    return report(state)
  }
  async function configure(id, patch = {}) {
    return withLock(id, async () => {
      await activeChat(id)
      const state = await readState(id)
      if (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') throw new Error('enabled 必须为布尔值')
      if (Object.hasOwn(patch, 'intervalMinutes') && !INTERVALS.has(patch.intervalMinutes)) throw new Error('间隔只支持 1、5、15、30、60 分钟')
      if (Object.hasOwn(patch, 'gameMinutesPerTick') && !GAME_MINUTES.has(patch.gameMinutesPerTick)) throw new Error('模拟步长不受支持')
      const wasEnabled = state.enabled
      if (Object.hasOwn(patch, 'enabled')) state.enabled = patch.enabled
      if (Object.hasOwn(patch, 'intervalMinutes')) state.intervalMinutes = patch.intervalMinutes
      if (Object.hasOwn(patch, 'gameMinutesPerTick')) state.gameMinutesPerTick = patch.gameMinutesPerTick
      state.sessionId = id
      if (state.enabled && (!wasEnabled || Object.hasOwn(patch, 'intervalMinutes'))) state.nextAt = now() + state.intervalMinutes * 60_000
      if (!state.enabled) state.nextAt = 0
      await write(key(id), state)
      arm(id, state)
      publish(id)
      return report(state)
    })
  }
  async function tick(id, options = {}) {
    return withLock(id, async () => {
      const state = await readState(id)
      if (!state.enabled || disposed) { clear(id); return { ...report(state), skipped: 'disabled' } }
      if (!options.force && now() < state.nextAt) { arm(id, state); return { ...report(state), skipped: 'not_due' } }
      if (await isBusy(id)) { arm(id, state, now() + 30_000); return { ...report(state), skipped: 'game_busy' } }
      const chat = await activeChat(id)
      // Catch up a bounded number of missed intervals after restart or
      // server sleep. Never issue an unbounded burst of background work.
      const intervalMs = state.intervalMinutes * 60_000
      const behind = options.force ? 0 : Math.max(0, now() - state.nextAt)
      const count = options.force ? 1 : Math.min(MAX_CATCH_UP_TICKS, 1 + Math.floor(behind / intervalMs))
      let next = state
      for (let i = 0; i < count; i++) next = stepWorld(next, chat, now())
      next.sessionId = id
      await write(key(id), next)
      arm(id, next)
      publish(id)
      return report(next)
    })
  }
  async function markRead(id) {
    return withLock(id, async () => {
      await activeChat(id)
      const state = await readState(id)
      const at = now()
      for (const event of state.events) if (event.readAt == null) event.readAt = at
      await write(key(id), state)
      publish(id)
      return report(state)
    })
  }
  async function context(id) {
    const state = await readState(id)
    return contextText(state)
  }
  async function restore() {
    if (disposed) return { restored: 0 }
    const names = await list('autonomous-world')
    let restored = 0
    for (const file of rows(names).filter(item => item && item.directory !== true && /^[a-f0-9]{64}\.json$/.test(item.name)).slice(0, 500)) {
      if (disposed) break
      try {
        const state = cleanState(await read('autonomous-world/' + file.name))
        if (!state.enabled || !state.sessionId || key(state.sessionId) !== 'autonomous-world/' + file.name) continue
        await activeChat(state.sessionId)
        // arm() schedules a single tick when overdue; tick() performs capped
        // catch-up, without rewriting the canonical chat history.
        if (!timers.has(state.sessionId)) { arm(state.sessionId, state); restored++ }
      } catch (error) { logger.warn?.('dsh-tavern: 跳过无法恢复的活世界存档', file.name, error) }
    }
    return { restored }
  }
  function stop() {
    disposed = true
    for (const id of timers.keys()) clear(id)
  }
  return Object.freeze({ status, configure, tick, markRead, context, restore, stop })
}
