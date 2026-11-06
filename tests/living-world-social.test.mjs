import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLivingWorld, advanceLivingWorld, commandLivingWorld,
  livingWorldFrameInputs, livingWorldView, rebaseLivingWorld } from '../tavern-plugin/lib/domain/living-world.js'

const make = (seed = 1, partnerCoins = 0) => createLivingWorld({
  worldId:'court',branchId:'branch-a',playerId:'player',seed,
  locations:[{id:'court',links:{}}],people:[
    {id:'player',locationId:'court',goal:'idle'},
    {id:'wang',locationId:'court',goal:'socialize',coins:30,nextActionAt:1440},
    {id:'wei',locationId:'court',goal:'idle',coins:partnerCoins}
  ]})
const tick = (world,minutes,id,budget=128) => advanceLivingWorld(world,{
  branchId:world.branchId,expectedRevision:world.revision,
  actionId:id,minutes,budget
})
const act = (world,props) => commandLivingWorld(world,{
  branchId:world.branchId,expectedRevision:world.revision,...props
})

test('NPCs meet other NPCs, never autonomously act on behalf of the nearby player',()=>{
  const w=tick(make(),1440,'day1')
  assert.deepEqual(Object.keys(w.relations.wang),['wei'])
  assert.equal(w.relations.wang.wei.contacts,1)
  assert.equal(w.relations.wang.wei.status,'acquaintance')
  assert.equal(w.relations.wei,undefined)
  assert.equal(livingWorldView(w,'player').events.some(e=>e.kind==='npc.socialized'),false)
  assert.equal(livingWorldFrameInputs({livingWorld:w})[0].text.includes('npc.socialized'),false)
  const contact=w.events.find(e=>e.kind==='npc.socialized')
  assert.equal(w.relations.wang.wei.lastEventId,contact.id)
})

test('friendship grows slowly with evidence, no automatic romance or marriage',()=>{
  let w=make()
  for(let day=1;day<=5;day++)w=tick(w,1440,'day'+day)
  const relation=w.relations.wang.wei
  assert.equal(relation.contacts,5)
  assert.equal(relation.trust,5)
  assert.equal(relation.status,'friend')
  assert.equal(w.events.filter(e=>e.kind==='npc.acquainted').length,1)
  assert.equal(w.events.filter(e=>e.kind==='npc.friendship.formed').length,1)
  assert.equal(w.events.some(e=>/romance|marriage/.test(e.kind)),false)
  assert.equal(w.relations.wei,undefined)
  assert.equal(livingWorldView(w,'player').relationships.wang,undefined)
})

test('helping a needy friend is conditional and delayed, not a teleporting free gift',()=>{
  let offered
  for(let seed=0;seed<80;seed++){
    let w=make(seed)
    w.relations.wang={wei:{trust:10,contacts:10,status:'friend'}}
    w=tick(w,1440,'day1')
    if(w.pending.some(job=>job.type==='aid')){offered=w;break}
  }
  assert.ok(offered,'at least one deterministic seed must offer help')
  const pending=offered.pending.find(job=>job.type==='aid')
  assert.equal(pending.amount,2)
  assert.equal(offered.people.wang.coins,30)
  assert.equal(offered.people.wei.coins,0)
  let completed=tick(offered,60,'finish')
  assert.equal(completed.pending.some(job=>job.type==='aid'),false)
  assert.equal(completed.people.wang.coins,28)
  assert.equal(completed.people.wei.coins,2)
  assert.equal(completed.events.filter(e=>e.kind==='npc.aid.completed').length,1)
  assert.equal(completed.relations.wang.wei.trust,13)
  assert.deepEqual(tick(offered,60,'finish'),completed)
})

test('aid is cancelled when either participant leaves before delivery, no money is lost',()=>{
  let offered
  for(let seed=0;seed<80;seed++){
    let w=make(seed)
    w.relations.wang={wei:{trust:10,contacts:10,status:'friend'}}
    w=tick(w,1440,'day1')
    if(w.pending.some(job=>job.type==='aid')){offered=w;break}
  }
  assert.ok(offered)
  const altered=structuredClone(offered)
  altered.people.wei.locationId='away'
  const after=tick(altered,60,'finish')
  assert.equal(after.people.wang.coins,30)
  assert.equal(after.events.filter(e=>e.kind==='npc.aid.cancelled').length,1)
  assert.equal(after.events.some(e=>e.kind==='npc.aid.completed'),false)
})

test('a private secret does not leak through new friendship or mutual aid',()=>{
  let w=act(make(),{type:'fact',actorId:'wang',factId:'private_order',
    text:'皇帝秘密口谕',actionId:'fact'})
  for(let d=1;d<=7;d++)w=tick(w,1440,'day'+d)
  assert.equal(livingWorldView(w,'wei').facts.some(f=>f.id==='private_order'),false)
  assert.equal(livingWorldView(w,'player').facts.some(f=>f.id==='private_order'),false)
  assert.equal(livingWorldFrameInputs({livingWorld:w})[0].text.includes('秘密口谕'),false)
})

test('branch rebase rolls back future relationship growth and aid with the snapshot',()=>{
  let w=make()
  w=tick(w,1440,'day1')
  const saved=structuredClone(w)
  for(let d=2;d<=6;d++)w=tick(w,1440,'day'+d)
  const restored=rebaseLivingWorld(saved,'branch-b')
  assert.equal(restored.relations.wang.wei.contacts,1)
  assert.equal(restored.branchId,'branch-b')
  assert.deepEqual(restored.processed,[])
  assert.equal(restored.events.some(e=>e.kind==='npc.friendship.formed'),false)
  assert.equal(w.relations.wang.wei.contacts,6)
})
