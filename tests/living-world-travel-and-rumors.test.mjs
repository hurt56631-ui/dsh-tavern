import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLivingWorld, commandLivingWorld, advanceLivingWorld,
  livingWorldView, livingWorldStatus, livingWorldFrameInputs } from '../tavern-plugin/lib/domain/living-world.js'
import { createLivingWorldController } from '../tavern-plugin/lib/domain/living-world-controller.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'

const setup = (overrides={}) => createLivingWorld({
  worldId:'dynasty',branchId:'branch1',playerId:'player',seed:3,
  locations:[{id:'palace',name:'乾清宫'},{id:'jiangnan',name:'江南'}],
  people:[
    {id:'player',locationId:'palace',goal:'idle'},
    {id:'wang',locationId:'palace',goal:'socialize',nextActionAt:1440},
    {id:'wei',locationId:'palace',goal:'idle'},
    {id:'merchant',locationId:'jiangnan',goal:'idle'}
  ],
  ...overrides
})
const act=(w,props)=>commandLivingWorld(w,{branchId:w.branchId,expectedRevision:w.revision,...props})
const advance=(w,minutes,actionId)=>advanceLivingWorld(w,{
  branchId:w.branchId,expectedRevision:w.revision,minutes,actionId,budget:128
})
test('roads are explicit, bidirectional and cannot connect unknown identities',()=>{
  let w=setup()
  assert.throws(()=>act(w,{type:'travel',actorId:'player',toLocationId:'jiangnan',actionId:'trip1'}),/connected route/)
  assert.throws(()=>act(w,{type:'route',actorId:'wei',fromLocationId:'palace',toLocationId:'jiangnan',minutes:120,actionId:'road1'}),/Only the player/)
  assert.throws(()=>act(w,{type:'route',actorId:'player',fromLocationId:'palace',toLocationId:'jiangnan',minutes:1,actionId:'road1'}),/out of range/)
  w=act(w,{type:'route',actorId:'player',fromLocationId:'palace',toLocationId:'jiangnan',minutes:240,actionId:'road1'})
  assert.equal(w.locations.palace.links.jiangnan,240)
  assert.equal(w.locations.jiangnan.links.palace,240)
  assert.throws(()=>act(w,{type:'route',actorId:'player',fromLocationId:'palace',toLocationId:'jiangnan',minutes:240,actionId:'road2'}),/already exists/)
  assert.equal(w.minute,0)
})
test('player travel occurs only after travel time, with no actions while in transit',()=>{
  let w=act(setup(),{type:'route',actorId:'player',fromLocationId:'palace',toLocationId:'jiangnan',minutes:240,actionId:'road'})
  w=act(w,{type:'travel',actorId:'player',toLocationId:'jiangnan',actionId:'departure'})
  assert.equal(w.people.player.locationId,'palace')
  assert.equal(livingWorldStatus(w,4).nearby.length,0)
  assert.ok(w.people.player.transit)
  assert.throws(()=>act(w,{type:'fact',actorId:'player',factId:'f',text:'unknown',actionId:'f1'}),/unavailable/)
  w=advance(w,239,'t1')
  assert.equal(w.people.player.locationId,'palace')
  w=advance(w,1,'t2')
  assert.equal(w.people.player.locationId,'jiangnan')
  assert.equal(w.people.player.transit,undefined)
  assert.deepEqual(livingWorldStatus(w,5).nearby.map(p=>p.id),['merchant'])
})
test('private secrets stay private even during repeated NPC social activity',()=>{
  let w=act(setup(),{type:'fact',actorId:'wang',factId:'secret',text:'秘密抓捕令',actionId:'private'})
  w=advance(w,1440,'time1')
  assert.equal(livingWorldView(w,'wei').facts.length,0)
  assert.equal(livingWorldView(w,'player').facts.length,0)
  assert.equal(livingWorldFrameInputs({livingWorld:w})[0].text.includes('秘密抓捕令'),false)
  assert.ok(!w.events.some(e=>e.kind==='npc.rumor.shared'))
})
test('only explicitly public facts spread locally, with witness and rumor status preserved',()=>{
  let w=act(setup(),{type:'fact',actorId:'wang',factId:'market_open',text:'江南集市开张',visibility:'public',actionId:'public'})
  w=advance(w,1440,'time2')
  const rumor=w.events.find(e=>e.kind==='npc.rumor.shared')
  assert.ok(rumor)
  const hearer=rumor.actorIds[1]
  assert.equal(livingWorldView(w,hearer).facts.find(f=>f.id==='market_open').status,'rumor')
  assert.equal(livingWorldView(w,'wang').facts.find(f=>f.id==='market_open').status,'known')
  assert.equal(livingWorldView(w,'merchant').facts.length,0)
  assert.deepEqual(advance(act(setup(),{type:'fact',actorId:'wang',factId:'market_open',text:'江南集市开张',visibility:'public',actionId:'public'}),1440,'time2'),w)
})
test('controller travel and route mutation are rejected on stale session state',async()=>{
  let id=0
  let chat={id:'chat',sessionId:'session',mode:'story',messages:[],ledger:{location:'乾清宫',npcs:[
    {name:'王体乾',location:'乾清宫'},{name:'江南商人',location:'江南'}
  ]}}
  const timeline=createStoryTimeline({id:p=>p+'_'+(++id),now:()=>100})
  const chats={
    forSession:async session=>session==='session'?structuredClone(chat):null,
    update:async(key,fn)=>{chat=fn(structuredClone(chat));return structuredClone(chat)}
  }
  const ctl=createLivingWorldController({chats,timeline,isBusy:()=>false})
  const started=await ctl.initialize({sessionId:'session',expectedTimelineRevision:0})
  const route=await ctl.route({sessionId:'session',expectedTimelineRevision:started.timelineRevision,
    fromLocationId:'scene',toLocationId:'loc_1',minutes:240,actionId:'road1'})
  assert.equal(route.locations.find(l=>l.id==='scene').links[0].to,'loc_1')
  await assert.rejects(ctl.travel({sessionId:'session',expectedTimelineRevision:started.timelineRevision,
    toLocationId:'loc_1',actionId:'old'}),/更新/)
  const trip=await ctl.travel({sessionId:'session',expectedTimelineRevision:route.timelineRevision,
    toLocationId:'loc_1',actionId:'trip1'})
  assert.equal(trip.playerLocationId,'scene')
  assert.ok(trip.playerTransit)
  const arrived=await ctl.advance({sessionId:'session',expectedTimelineRevision:trip.timelineRevision,
    minutes:240,actionId:'time3'})
  assert.equal(arrived.playerLocationId,'loc_1')
  assert.equal(arrived.playerTransit,null)
})
