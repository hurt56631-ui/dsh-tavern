import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutonomousWorld } from '../tavern-plugin/lib/domain/autonomous-world.js'

function setup(overrides = {}) {
  const files = new Map()
  const timers = new Map()
  let time = 1_000_000
  let nextTimer = 0
  let publications = 0
  const chat = { mode: 'story', cardName: '崇祯朝·群像人生穿越', ledger: { npcs: [{ name: '周皇后', title: '皇后' }] } }
  const world = createAutonomousWorld({
    read: async key => files.get(key),
    write: async (key, value) => { files.set(key, structuredClone(value)) },
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
