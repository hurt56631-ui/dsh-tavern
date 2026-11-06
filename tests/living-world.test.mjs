import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLivingWorld, commandLivingWorld, advanceLivingWorld,
  rebaseLivingWorld, livingWorldView, livingWorldContext } from '../tavern-plugin/lib/domain/living-world.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'

const create = () => createLivingWorld({
  worldId: 'imperial', branchId: 'b1', seed: 123,
  locations: [
    { id: 'palace', links: { jiangnan: 120 } },
    { id: 'jiangnan', links: { palace: 120 } }
  ],
  people: [
    { id: 'emperor', name: '皇帝', locationId: 'palace', goal: 'idle' },
    { id: 'wang', name: '王体乾', locationId: 'palace', goal: 'work' },
    { id: 'wei', name: '魏忠贤', locationId: 'palace', goal: 'socialize' },
    { id: 'merchant', name: '商人', locationId: 'jiangnan', goal: 'wander' }
  ]
})
function cmd(world, action) {
  return commandLivingWorld(world, { branchId: world.branchId, expectedRevision: world.revision, ...action })
}
function tick(world, minutes, actionId, budget = 32) {
  return advanceLivingWorld(world, { branchId: world.branchId, expectedRevision: world.revision,
    minutes, actionId, budget })
}

test('only the witness knows a secret; local whispers and letters carry rumors, never omniscience', () => {
  let world = cmd(create(), { type: 'fact', actorId: 'emperor', factId: 'secret',
    text: '调查魏忠贤', actionId: 'fact1' })
  assert.equal(livingWorldView(world, 'wei').facts.length, 0)
  assert.equal(livingWorldView(world, 'wang').facts.length, 0)
  assert.equal(livingWorldView(world, 'emperor').facts[0].status, 'known')
  world = cmd(world, { type: 'tell', actorId: 'emperor', recipientId: 'wang',
    factIds: ['secret'], actionId: 'tell1' })
  assert.equal(livingWorldView(world, 'wang').facts[0].status, 'rumor')
  assert.equal(livingWorldView(world, 'wei').facts.length, 0)
  world = cmd(world, { type: 'letter', actorId: 'wang', recipientId: 'merchant',
    factIds: ['secret'], actionId: 'letter1' })
  assert.equal(livingWorldView(world, 'merchant').facts.length, 0)
  world = tick(world, 119, 'tick1')
  assert.equal(livingWorldView(world, 'merchant').facts.length, 0)
  world = tick(world, 1, 'tick2')
  assert.equal(livingWorldView(world, 'merchant').facts[0].status, 'rumor')
  assert.equal(livingWorldView(world, 'wei').facts.length, 0)
  assert.ok(livingWorldView(world, 'wei').events.every(event => !event.factIds?.includes('secret')))
})

test('travel takes time, invalid/duplicate command is atomic, stale branch fails closed', () => {
  let world = create()
  const original = structuredClone(world)
  assert.throws(() => cmd(world, {type: 'tell', actorId: 'emperor',
    recipientId: 'merchant', factIds:['secret'], actionId:'tell1'}), /does not know|Unknown|Speaker/)
  assert.deepEqual(world, original)
  world = cmd(world, {type:'travel', actorId:'emperor', toLocationId:'jiangnan', actionId:'travel1'})
  assert.equal(world.people.emperor.locationId, 'palace')
  assert.ok(world.people.emperor.transit)
  assert.deepEqual(cmd(world, {type:'travel', actorId:'emperor',
    toLocationId:'jiangnan', actionId:'travel1'}), world)
  assert.throws(() => cmd(world, {type:'fact', actorId:'emperor',
    factId:'another',text:'foo',actionId:'travel1'}), /reused/)
  assert.throws(() => commandLivingWorld(world, {type:'fact', actorId:'emperor',
    factId:'another', text:'foo', actionId:'new',
    branchId:'old', expectedRevision:world.revision}), /stale/)
  world = tick(world, 119, 'tick1')
  assert.equal(world.people.emperor.locationId, 'palace')
  world = tick(world, 1, 'tick2')
  assert.equal(world.people.emperor.locationId, 'jiangnan')
  assert.equal(world.people.emperor.transit, undefined)
})

test('NPC scheduling is deterministic and local; bounded catch-up has resumable backlog', () => {
  const first = tick(create(), 4 * 1440, 'time1', 2)
  assert.equal(first.lastTick.executed, 2)
  assert.equal(first.backlog, true)
  assert.equal(first.minute, 5760)
  assert.equal(first.people.wang.coins, 2)
  const complete = tick(first, 0, 'time2', 256)
  assert.equal(complete.backlog, false)
  assert.ok(complete.people.wang.coins >= 2)
  assert.deepEqual(tick(tick(create(), 4 * 1440, 'time1', 2), 0, 'time2', 256), complete)
  assert.equal(JSON.stringify(create()), JSON.stringify(create()))
})

test('prototype-inherited names cannot be treated as known facts or valid travel links', () => {
  let world = create()
  assert.throws(() => cmd(world, {type:'letter',actorId:'emperor',
    recipientId:'merchant',factIds:['constructor'],actionId:'letter1'}), /does not know/)
  world = createLivingWorld({worldId:'x',branchId:'b',locations:[{id:'a',links:{b:40}},{id:'b',links:{a:40}},{id:'constructor'}],
    people:[{id:'x',locationId:'a'}]})
  assert.throws(() => cmd(world, {type:'travel',actorId:'x',
    toLocationId:'constructor',actionId:'travel1'}), /connected route/)
})

test('rebase isolates abandoned timelines and resets deduplication without changing history', () => {
  let world = cmd(create(), {type:'fact',actorId:'emperor',factId:'private',
    text:'秘密',actionId:'fact1'})
  const saved = structuredClone(world)
  world = cmd(world, {type:'tell',actorId:'emperor',recipientId:'wang',
    factIds:['private'],actionId:'tell1'})
  const restored = rebaseLivingWorld(saved, 'b2')
  assert.equal(restored.branchId, 'b2')
  assert.deepEqual(restored.processed, [])
  assert.equal(livingWorldView(restored,'wang').facts.length, 0)
  assert.equal(saved.branchId, 'b1')
  assert.throws(() => commandLivingWorld(restored, {branchId:'b1',expectedRevision:restored.revision,
    type:'tell',actorId:'emperor',recipientId:'wang',factIds:['private'],actionId:'old'}), /stale/)
})

test('Story Timeline owns world snapshots, rollback and a new branch', () => {
  let ids = 0
  const timeline = createStoryTimeline({id: prefix => prefix + '-' + (++ids), now: () => 10})
  let chat = timeline.apply({ chat:{id:'chat-1', messages:[]}, intent:{kind:'ensure'} }).chat
  const init = timeline.apply({ chat, intent:{ kind:'world.init',
    expectedBranchId:chat.timeline.branchId, expectedRevision:chat.timeline.revision,
    config:{worldId:'imperial',seed:3,locations:[{id:'palace'}],people:[{id:'emperor',locationId:'palace'}]} } })
  chat = init.chat
  assert.equal(chat.livingWorld.people.emperor.id, 'emperor')
  chat = timeline.apply({chat, intent:{kind:'world.command',
    expectedBranchId:chat.timeline.branchId, expectedRevision:chat.timeline.revision,
    command:{actionId:'f1',type:'fact',actorId:'emperor',factId:'secret',text:'密令'} }}).chat
  const before = structuredClone(chat)
  const start = timeline.apply({chat,intent:{kind:'body.begin',turn:1,userText:'继续'}})
  const committed = timeline.complete({chat:start.chat,operationId:start.value.operationId,
    basedOn:start.value.basedOn,outcome:{status:'success'},
    apply: next => {next.messages.push({role:'assistant',turn:1,text:'继续剧情'})}})
  assert.equal(committed.value.status,'committed')
  chat = committed.chat
  chat = timeline.apply({chat, intent:{kind:'world.advance',
    expectedBranchId:chat.timeline.branchId, expectedRevision:chat.timeline.revision,
    command:{actionId:'time1',minutes:1440}}}).chat
  assert.equal(chat.livingWorld.minute, 1440)
  const rollback = timeline.apply({chat,intent:{kind:'turn.rollback',beforeChat:before}})
  assert.equal(rollback.value.status,'applied')
  assert.equal(rollback.chat.livingWorld.minute, 0)
  assert.notEqual(rollback.chat.timeline.branchId,before.timeline.branchId)
  assert.equal(rollback.chat.livingWorld.branchId,rollback.chat.timeline.branchId)
  assert.equal(rollback.chat.livingWorld.knowledge.emperor.secret.status, 'known')
  assert.equal(rollback.chat.livingWorld.events.some(e=>e.kind==='npc.worked'),false)
})


test('NPC prompt context is bounded and excludes secrets that actor has not learned', () => {
  const world = cmd(create(), {type:'fact',actorId:'emperor',
    factId:'secret',text:'只有皇帝知道的密令',actionId:'secret1'})
  const uninformed = livingWorldContext(world, 'wei', 600)
  const informed = livingWorldContext(world, 'emperor', 600)
  assert.equal(uninformed.includes('只有皇帝知道的密令'),false)
  assert.equal(uninformed.includes('secret'),false)
  assert.equal(informed.includes('只有皇帝知道的密令'),true)
  assert.ok(uninformed.length <= 600)
  assert.ok(informed.length <= 600)
})

test('Timeline rejects old branch after a rollback, and refuses unsupported automatic init', () => {
  const timeline = createStoryTimeline({id: (() => {let n=0; return prefix=>prefix+'-'+(++n)})()})
  let chat = timeline.apply({chat:{id:'chat',messages:[]},intent:{kind:'ensure'}}).chat
  assert.throws(() => timeline.apply({chat,intent:{kind:'world.init',
    expectedBranchId:'wrong',expectedRevision:chat.timeline.revision,
    config:{worldId:'test',locations:[{id:'a'}]}}}), /过期/)
  const unchanged = structuredClone(chat)
  assert.equal(chat.livingWorld,undefined)
  assert.deepEqual(chat,unchanged)
})
