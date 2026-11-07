import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLivingWorld, commandLivingWorld, advanceLivingWorld,
  livingWorldView, livingWorldFrameInputs
} from '../tavern-plugin/lib/domain/living-world.js'

function create() {
  return createLivingWorld({
    worldId:'town',branchId:'branch-a',playerId:'player',seed:7,
    locations:[{id:'town',links:{road:60}},{id:'road',links:{town:60}}],
    people:[
      {id:'player',locationId:'town',goal:'idle'},
      {id:'alice',locationId:'town',goal:'socialize'},
      {id:'bob',locationId:'town',goal:'socialize'}
    ]
  })
}
function command(state, action) {
  return commandLivingWorld(state,{branchId:state.branchId,expectedRevision:state.revision,...action})
}
function advance(state, minutes, actionId) {
  return advanceLivingWorld(state,{branchId:state.branchId,expectedRevision:state.revision,
    minutes,actionId,budget:128})
}

test('public social encounters can be witnessed but private dialogue stays private',()=>{
  let world=create()
  world=command(world,{type:'fact',actorId:'alice',factId:'private_plan',
    text:'秘密：今晚从东门离开',visibility:'private',actionId:'secret-1'})
  world=advance(world,1440,'day-1')
  const seen=livingWorldView(world,'player')
  assert.ok(seen.events.some(event=>event.kind==='npc.socialized'))
  assert.equal(seen.facts.some(f=>f.id==='private_plan'),false)
  assert.equal(seen.events.some(event=>event.factIds?.includes('private_plan')),false)
  assert.equal(livingWorldFrameInputs({livingWorld:world})[0].text.includes('今晚从东门离开'),false)
})

test('the player cannot witness a distant encounter or one during travel',()=>{
  let world=create()
  world=command(world,{type:'travel',actorId:'player',toLocationId:'road',actionId:'go-1'})
  world=advance(world,1,'minute-1')
  assert.equal(livingWorldView(world,'player').nearby.length,0)
  world=advance(world,1439,'rest-of-day')
  const seen=livingWorldView(world,'player')
  assert.equal(seen.nearby.length,0)
  assert.equal(seen.events.some(event=>event.kind==='npc.socialized'),false)
  assert.equal(world.people.player.locationId,'road')
})

test('player is not accidentally scheduled as an autonomous NPC',()=>{
  const world=advance(create(),7*1440,'week-1')
  assert.equal(world.people.player.coins,0)
  assert.equal(world.people.player.energy,70)
  assert.equal(world.events.some(event=>event.kind==='npc.worked' && event.actorIds.includes('player')),false)
})
