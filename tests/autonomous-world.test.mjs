import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutonomousWorld } from '../tavern-plugin/lib/domain/autonomous-world.js'

function setup(overrides = {}) {
  const files = overrides.files || new Map()
  const timers = new Map()
  let time = 1_000_000
  let nextTimer = 0
  let publications = 0
  const chat = { mode: 'story', cardName: '崇祯朝·群像人生穿越', ledger: { npcs: [{ name: '周皇后', title: '皇后' }] } }
  const world = createAutonomousWorld({
    read: async key => files.get(key),
    write: async (key, value) => { files.set(key, structuredClone(value)) },
    list: async prefix => [...files.keys()].filter(key => key.startsWith(prefix + '/'))
      .map(key => ({ name: key.slice(prefix.length + 1), directory: false })),
    loadChat: async () => overrides.chat || chat,
    isBusy: async () => overrides.busy === true,
    publish: () => publications++,
    now: () => time,
    setTimer: (callback, delay) => {
      const id = ++nextTimer; timers.set(id, { callback, delay }); return id
    },
    clearTimer: id => { timers.delete(id) }
  })
  return { world, files, timers, time: value => { time = value }, publications: () => publications }
}

test('disabled by default and no player input or model request', async () => {
  const { world, files, timers } = setup()
  const initial = await world.status('game-1')
  assert.equal(initial.enabled, false)
  assert.equal(initial.tick, 0)
  assert.equal(timers.size, 0)
  assert.equal(files.size, 0)
  await world.tick('game-1', { force: true })
  assert.equal(files.size, 0)
})

test('enabling is opt-in and creates one scheduled timer', async () => {
  const { world, timers, time, files } = setup()
  let result = await world.configure('game-1', { enabled: true, intervalMinutes: 5 })
  assert.equal(result.nextAt, 1_300_000)
  assert.equal(timers.size, 1)
  result = await world.tick('game-1')
  assert.equal(result.skipped, 'not_due')
  assert.equal(result.tick, 0)
  time(1_300_000)
  result = await world.tick('game-1')
  assert.equal(result.tick, 1)
  assert.ok(result.actors.some(actor => actor.name === '周皇后'))
  assert.equal(result.events.length, 1)
  assert.match(await world.context('game-1'), /周皇后/)
  assert.equal(files.size, 1)
  world.stop()
  assert.equal(timers.size, 0)
})

test('busy games do not advance; duplicate due tick does not double apply', async () => {
  const env = setup({ busy: true })
  await env.world.configure('game-1', { enabled: true, intervalMinutes: 1 })
  env.time(1_060_000)
  const state = await env.world.tick('game-1')
  assert.equal(state.skipped, 'game_busy')
  assert.equal(state.tick, 0)
  env.world.stop()
  const idle = setup()
  await idle.world.configure('game-1', { enabled: true, intervalMinutes: 1 })
  idle.time(1_060_000)
  const [a,b] = await Promise.all([idle.world.tick('game-1'),idle.world.tick('game-1')])
  assert.equal(a.tick, 1)
  assert.equal(b.skipped, 'not_due')
  assert.equal((await idle.world.status('game-1')).tick, 1)
  idle.world.stop()
})

test('event read and pause retain world records', async () => {
  const { world } = setup()
  await world.configure('game-1', { enabled: true })
  await world.tick('game-1', { force: true })
  assert.equal((await world.status('game-1')).unread, 1)
  await world.markRead('game-1')
  assert.equal((await world.status('game-1')).unread, 0)
  const paused = await world.configure('game-1', { enabled: false })
  assert.equal(paused.tick, 1)
  assert.equal((await world.tick('game-1', { force: true })).skipped, 'disabled')
  world.stop()
})

test('only story and script sessions can be configured', async () => {
  const { world } = setup({ chat: { mode: 'card', cardName: 'card' } })
  await assert.rejects(world.configure('bad', { enabled: true }), /游玩对话/)
  world.stop()
})


test('parses 150 independent NPC records from embedded Chongzhen cast sections', async () => {
  const roster = Array.from({length: 150}, (_, i) =>
    '〔虚构〕宫女' + (i + 1) + '｜内廷值守｜负责自己的差事，目标是获得安稳生活'
  ).join('\n')
  const chat = {
    mode: 'story',
    cardName: '崇祯朝·群像人生穿越',
    messages: [{role: 'assistant', greeting: true, text: '【当前身份：平民】'}],
    openingWorldbookSnapshot: { document: {
      entries: [{ enabled: true, comment: '宫女·各宫差事',
        content: '【宫女·各宫差事｜本局固定人物档案】\n' + roster }]
    }}
  }
  const env = setup({ chat })
  await env.world.configure('game-1', { enabled: true })
  const state = await env.world.tick('game-1', { force: true })
  assert.equal(state.actors.length, 150)
  assert.equal(new Set(state.actors.map(a => a.id)).size, 150)
  assert.equal(state.actors.filter(a => a.lastTick === 1).length, 4)
  assert.ok(state.actors.every(a => a.goal.includes('安稳生活')))
  // Imperial business is only a rumor to an unrelated civilian.
  assert.equal(state.events[0].visibility, 'rumour')
  const summary = await env.world.context('game-1')
  assert.match(summary, /传闻/)
  env.world.stop()
})

test('NPC plans and short memories survive ticks instead of resetting randomly', async () => {
  const env = setup()
  await env.world.configure('game-1', { enabled: true })
  await env.world.tick('game-1', { force: true })
  const later = await env.world.tick('game-1', { force: true })
  const acted = later.actors.filter(a => a.lastTick)
  assert.ok(acted.length > 4)
  assert.ok(acted.every(a => Number(a.progress) >= 1))
  assert.ok(acted.every(a => Array.isArray(a.memory) && a.memory.length <= 4))
  env.world.stop()
})

test('restart discovers persisted opted-in worlds without loading UI', async () => {
  const files = new Map()
  const first = setup({files})
  await first.world.configure('saved-session', { enabled: true, intervalMinutes: 5 })
  first.world.stop()
  const second = setup({files})
  const result = await second.world.restore()
  assert.equal(result.restored, 1)
  assert.equal(second.timers.size, 1)
  const repeated = await second.world.restore()
  assert.equal(repeated.restored, 0)
  second.time(1_300_000)
  const advanced = await second.world.tick('saved-session')
  assert.equal(advanced.tick, 1)
  second.world.stop()
})

test('offline time catch-up is bounded and takes one persistent write', async () => {
  const env = setup()
  await env.world.configure('game-1', { enabled: true, intervalMinutes: 1 })
  env.time(1_000_000 + 60_000 * 500)
  const state = await env.world.tick('game-1')
  assert.equal(state.tick, 12)
  assert.equal(state.elapsedGameMinutes, 720)
  assert.ok(state.events.length <= 80)
  assert.equal(state.nextAt, 1_000_000 + 60_000 * 501)
  env.world.stop()
})

test('only opted-in worlds restore; no new character generated for generic empty card', async () => {
  const files = new Map()
  const plain = setup({files,chat:{mode:'story',cardName:'普通人的一天'}})
  const toggled = await plain.world.configure('disabled-session', { enabled: false })
  assert.equal(toggled.enabled, false)
  await plain.world.configure('enabled-session', { enabled: true })
  let state = await plain.world.tick('enabled-session', { force: true })
  assert.equal(state.actors.length, 0)
  assert.equal(state.events.length, 0)
  plain.world.stop()
  const resumed = setup({files,chat:{mode:'story',cardName:'普通人的一天'}})
  assert.equal((await resumed.world.restore()).restored, 1)
  resumed.world.stop()
})
