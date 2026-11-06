import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLivingWorld, livingWorldStatus, livingWorldFrameInputs } from '../tavern-plugin/lib/domain/living-world.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createLivingWorldController } from '../tavern-plugin/lib/domain/living-world-controller.js'

function setup() {
  let id = 0
  let chat = {id:'chat-1',sessionId:'session-1',mode:'story',messages:[],
    macroState:{userName:'皇帝'},ledger:{location:'乾清宫',npcs:[{name:'王体乾'},{name:'魏忠贤'}]}}
  const timeline = createStoryTimeline({id:prefix=>prefix+'-'+(++id),now:()=>100})
  let busy = false
  const chats = {
    forSession: async session => session === chat.sessionId ? structuredClone(chat) : null,
    update: async (chatId,mutation) => {
      if (chatId !== chat.id) throw new Error('unknown chat')
      chat = mutation(structuredClone(chat))
      return structuredClone(chat)
    }
  }
  const controller = createLivingWorldController({chats,timeline,isBusy:()=>busy})
  return {controller,timeline,get:()=>chat,setBusy:value=>{busy=value}}
}
test('opt-in world starts from existing ledger, no invented NPC goals and no extra world time',async()=>{
  const fixture=setup()
  const before=fixture.get()
  assert.equal(livingWorldStatus(before.livingWorld,0).enabled,false)
  const world=await fixture.controller.initialize({sessionId:'session-1',expectedTimelineRevision:0})
  assert.equal(world.enabled,true)
  assert.equal(world.people.length,2)
  assert.deepEqual(world.people.map(x=>x.name),['王体乾','魏忠贤'])
  assert.ok(world.people.every(x=>x.goal==='idle'))
  assert.equal(world.minute,0)
  assert.equal(fixture.get().livingWorld.playerId,'player')
  assert.equal(fixture.get().livingWorld.locations.scene.name,'乾清宫')
})
test('selected NPC works with locally simulated passage of time',async()=>{
  const f=setup()
  const start=await f.controller.initialize({sessionId:'session-1',expectedTimelineRevision:0})
  const goal=await f.controller.goal({sessionId:'session-1',expectedTimelineRevision:start.timelineRevision,
    npcId:'npc_1',goal:'work',actionId:'set-1'})
  const after=await f.controller.advance({sessionId:'session-1',
    expectedTimelineRevision:goal.timelineRevision,minutes:1440,actionId:'skip-1'})
  assert.equal(after.minute,1440)
  assert.ok(f.get().livingWorld.people.npc_1.coins>0)
  assert.equal(after.people[0].name,'王体乾')
  assert.equal(after.facts.length,0)
})
test('cannot change world while background work is active or with a stale revision',async()=>{
  const f=setup();f.setBusy(true)
  await assert.rejects(f.controller.initialize({sessionId:'session-1',expectedTimelineRevision:0}),/等待|结束/)
  assert.equal(f.get().livingWorld,undefined)
  f.setBusy(false)
  const start=await f.controller.initialize({sessionId:'session-1',expectedTimelineRevision:0})
  await assert.rejects(f.controller.advance({sessionId:'session-1',
    expectedTimelineRevision:0,minutes:1440,actionId:'x1'}),/更新|刷新/)
  assert.equal(f.get().livingWorld.minute,0)
  await assert.rejects(f.controller.goal({sessionId:'session-1',
    expectedTimelineRevision:start.timelineRevision,npcId:'player',
    goal:'work',actionId:'x2'}),/NPC/)
})
test('unregistered and inactive world never emit an invented world prompt',()=>{
  assert.deepEqual(livingWorldFrameInputs({}),[])
  assert.deepEqual(livingWorldFrameInputs({livingWorld:null}),[])
})
test('per-player frame does not expose other NPC secret witness',()=>{
  const world=createLivingWorld({worldId:'x',branchId:'b',playerId:'player',locations:[{id:'scene'}],
    people:[{id:'player',locationId:'scene'},{id:'npc',locationId:'scene'}]})
  world.facts.secret={id:'secret',text:'密令：不可公开'}
  world.knowledge.npc.secret={status:'known',learnedAt:0,fromId:'npc'}
  const frame=livingWorldFrameInputs({livingWorld:world})
  assert.equal(frame.length,1)
  assert.equal(frame[0].text.includes('不可公开'),false)
  const view=livingWorldStatus(world,4)
  assert.equal(view.facts.length,0)
  assert.equal(view.events.length,0)
  assert.equal(view.timelineRevision,4)
  assert.equal('knowledge' in view,false)
})
