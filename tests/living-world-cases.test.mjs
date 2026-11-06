import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createLivingWorld,commandLivingWorld,advanceLivingWorld,
  livingWorldStatus,livingWorldView,livingWorldFrameInputs,rebaseLivingWorld}
  from '../tavern-plugin/lib/domain/living-world.js'
import {createStoryTimeline} from '../tavern-plugin/lib/domain/story-timeline.js'
import {createLivingWorldController} from '../tavern-plugin/lib/domain/living-world-controller.js'

const create = () => createLivingWorld({
  worldId:'dynasty',branchId:'branch_1',playerId:'player',seed:11,
  locations:[
    {id:'palace',name:'乾清宫',links:{jiangnan:120}},
    {id:'jiangnan',name:'江南',links:{palace:120}}
  ],
  people:[
    {id:'player',name:'皇帝',locationId:'palace',goal:'idle'},
    {id:'wang',name:'王体乾',locationId:'palace',goal:'work'},
    {id:'wei',name:'魏忠贤',locationId:'palace',goal:'idle'},
    {id:'merchant',name:'江南商人',locationId:'jiangnan',goal:'socialize'}
  ]
})
const cmd = (world,payload) => commandLivingWorld(world,{
  branchId:world.branchId,expectedRevision:world.revision,...payload
})
const tick = (world,minutes,actionId) => advanceLivingWorld(world,{
  branchId:world.branchId,expectedRevision:world.revision,minutes,
  actionId,budget:128
})
const open = world => cmd(world,{type:'case.open',actorId:'player',
  investigatorId:'wang',kind:'corruption',title:'东厂账目疑案',actionId:'open-1'})
const caseOf = w => Object.values(w.cases)[0]

test('case creation is explicit, idempotent and never invents a crime or a verdict',()=>{
  const initial=create(), world=open(initial)
  assert.equal(Object.keys(initial.cases).length,0)
  assert.equal(caseOf(world).kind,'corruption')
  assert.equal(caseOf(world).progress,0)
  assert.equal(caseOf(world).status,'investigating')
  assert.deepEqual(world.facts,{})
  assert.equal(world.people.wang.goal,'investigate')
  assert.equal(world.people.wang.returnGoal,'work')
  assert.equal(world.events.filter(e=>e.kind==='case.opened').length,1)
  assert.deepEqual(cmd(world,{type:'case.open',actorId:'player',
    investigatorId:'wang',kind:'corruption',title:'东厂账目疑案',actionId:'open-1'}),world)
  assert.throws(()=>cmd(world,{type:'case.open',actorId:'player',investigatorId:'wei',
    kind:'theft',title:'另一宗案',actionId:'open-1'}),/reused/)
  assert.throws(()=>cmd(world,{type:'case.open',actorId:'wang',investigatorId:'wei',
    kind:'theft',title:'无授权案',actionId:'npc-fake'}),/Only the player/)
  assert.throws(()=>cmd(create(),{type:'case.open',actorId:'player',
    investigatorId:'merchant',kind:'missing',title:'远方案件',actionId:'remote'}),/same location/)
  assert.throws(()=>cmd(create(),{type:'case.open',actorId:'player',
    investigatorId:'wei',kind:'invalid',title:'案名',actionId:'bad'}),/category/)
})

test('an NPC can investigate offscreen but cannot reveal an unseen progress report',()=>{
  let world=open(create())
  world=tick(world,1440,'day1')
  assert.equal(caseOf(world).progress,1)
  assert.equal(livingWorldView(world,'player').cases[0].progress,0)
  assert.equal(livingWorldView(world,'wang').cases[0].progress,1)
  assert.equal(livingWorldStatus(world,world.revision).cases[0].status,'investigating')
  assert.equal(livingWorldFrameInputs({livingWorld:world})[0].text.includes('case.investigated'),false)
  world=tick(world,1440,'day2')
  assert.equal(caseOf(world).status,'awaiting_report')
  assert.equal(livingWorldStatus(world,1).cases[0].status,'investigating')
  assert.equal(livingWorldStatus(world,1).cases[0].progress,0)
  assert.equal(livingWorldView(world,'wang').cases[0].status,'awaiting_report')
  assert.equal(livingWorldView(world,'wei').cases.length,0)
  assert.equal(world.events.filter(e=>e.kind==='case.investigated').length,2)
  assert.ok(livingWorldView(world,'player').events.every(e=>e.kind!=='case.investigated'))
  world=cmd(world,{type:'case.report',actorId:'player',
    caseId:caseOf(world).id,actionId:'report-1'})
  assert.equal(caseOf(world).status,'awaiting_clues')
  assert.equal(livingWorldStatus(world,1).cases[0].progress,2)
  assert.equal(livingWorldStatus(world,1).cases[0].status,'awaiting_clues')
  assert.equal(world.people.wang.goal,'work')
  assert.equal(world.people.wang.caseId,undefined)
  assert.equal(world.events.at(-1).kind,'case.reported')
})

test('filed clues are unverified testimony, not invented true facts or public rumors',()=>{
  let world=open(create())
  world=cmd(world,{type:'case.clue',actorId:'player',caseId:caseOf(world).id,
    text:'账房说前日银两短缺，但尚未核对',actionId:'clue-1'})
  const record=caseOf(world)
  const clueId=record.clueIds[0]
  assert.equal(record.clueIds.length,1)
  assert.equal(world.facts[clueId].kind,'testimony')
  assert.equal(world.facts[clueId].verification,'unverified')
  assert.equal(world.facts[clueId].visibility,'private')
  assert.equal(world.knowledge.player[clueId].status,'rumor')
  assert.equal(world.knowledge.wang[clueId].status,'rumor')
  assert.equal(world.knowledge.wei[clueId],undefined)
  assert.equal(livingWorldView(world,'wei').cases.length,0)
  assert.equal(livingWorldView(world,'wei').facts.length,0)
  world=tick(world,1440,'day-1')
  world=tick(world,1440,'day-2')
  assert.equal(world.events.some(e=>e.kind==='case.solved' || e.kind==='case.arrested'),false)
  assert.equal(livingWorldView(world,'wei').facts.length,0)
  assert.equal(Object.keys(world.facts).length,1)
})

test('filing a new testimony after the report restarts the investigator without erasing history',()=>{
  let world=open(create())
  world=tick(world,2880,'days-1')
  world=cmd(world,{type:'case.report',actorId:'player',caseId:caseOf(world).id,actionId:'report'})
  assert.equal(caseOf(world).status,'awaiting_clues')
  world=cmd(world,{type:'case.clue',actorId:'player',caseId:caseOf(world).id,
    text:'驿站证人看见了一个陌生人',actionId:'clue'})
  assert.equal(caseOf(world).status,'investigating')
  assert.equal(world.people.wang.goal,'investigate')
  assert.equal(caseOf(world).progress,0)
  assert.equal(caseOf(world).reportedProgress,0)
  assert.equal(caseOf(world).clueIds.length,1)
  world=tick(world,2880,'days-2')
  assert.equal(caseOf(world).status,'awaiting_report')
})

test('cannot review a case at distance or issue remote orders; remote positions remain hidden',()=>{
  let world=open(create())
  world=cmd(world,{type:'travel',actorId:'wang',toLocationId:'jiangnan',actionId:'wang-trip'})
  assert.throws(()=>cmd(world,{type:'case.report',actorId:'player',
    caseId:caseOf(world).id,actionId:'report'}),/in person/)
  assert.throws(()=>cmd(world,{type:'case.clue',actorId:'player',caseId:caseOf(world).id,
    text:'他人证言',actionId:'clue'}),/in person/)
  const status=livingWorldStatus(world,2)
  const wang=status.people.find(p=>p.id==='wang')
  assert.equal(wang.locationId,null)
  assert.equal(wang.goal,null)
  assert.equal(wang.transit,null)
  assert.equal(status.cases[0].status,'investigating')
  assert.equal(livingWorldFrameInputs({livingWorld:world})[0].text.includes('case.investigated'),false)
  world=tick(world,1440,'day1')
  assert.equal(world.people.wang.locationId,'jiangnan')
  assert.equal(livingWorldStatus(world,3).people.find(p=>p.id==='wang').locationId,null)
})

test('archiving requires meeting the investigator; it is explicitly unresolved',()=>{
  let world=open(create())
  world=cmd(world,{type:'case.archive',actorId:'player',caseId:caseOf(world).id,actionId:'archive'})
  assert.equal(caseOf(world).outcome,'unresolved')
  assert.equal(caseOf(world).status,'archived')
  assert.equal(world.people.wang.goal,'work')
  assert.equal(livingWorldStatus(world,1).cases[0].archived,true)
  assert.throws(()=>cmd(world,{type:'case.clue',actorId:'player',caseId:caseOf(world).id,
    text:'事后修改',actionId:'late'}),/unavailable/)
  assert.throws(()=>cmd(world,{type:'case.report',actorId:'player',caseId:caseOf(world).id,
    actionId:'late-2'}),/unavailable/)
})

test('checkpoint rebase removes future testimony, reports, and case conclusions',()=>{
  const world=open(create())
  const saved=structuredClone(world)
  let future=cmd(world,{type:'case.clue',actorId:'player',caseId:caseOf(world).id,
    text:'路人猜测',actionId:'clue'})
  future=tick(future,2880,'time')
  future=cmd(future,{type:'case.archive',actorId:'player',caseId:caseOf(world).id,
    actionId:'archive'})
  const restored=rebaseLivingWorld(saved,'branch_2')
  assert.equal(restored.branchId,'branch_2')
  assert.equal(restored.cases[caseOf(world).id].status,'investigating')
  assert.equal(restored.cases[caseOf(world).id].clueIds.length,0)
  assert.equal(restored.people.wang.goal,'investigate')
  assert.equal(Object.keys(restored.facts).length,0)
  assert.equal(future.cases[caseOf(world).id].status,'archived')
  assert.deepEqual(restored.processed,[])
})

test('controller exposes case actions only in a live, revision-matched session',async()=>{
  let seq=0
  let chat={id:'chat-1',sessionId:'session-1',mode:'story',messages:[],
    ledger:{location:'皇宫',npcs:[{name:'王体乾',location:'皇宫'},{name:'魏忠贤',location:'东厂'}]}}
  const timeline=createStoryTimeline({id:p=>p+'-'+(++seq),now:()=>123})
  const chats={forSession:async id=>id===chat.sessionId?structuredClone(chat):null,
    update:async(id,fn)=>{chat=fn(structuredClone(chat));return structuredClone(chat)}}
  let busy=false
  const controller=createLivingWorldController({chats,timeline,isBusy:()=>busy})
  let status=await controller.initialize({sessionId:'session-1',expectedTimelineRevision:0})
  status=await controller.caseAction({sessionId:'session-1',
    expectedTimelineRevision:status.timelineRevision,type:'case.open',
    investigatorId:'npc_1',kind:'corruption',title:'有出处的账目疑案',actionId:'start'})
  assert.equal(status.cases.length,1)
  assert.equal(status.cases[0].progress,0)
  const caseId=status.cases[0].id
  await assert.rejects(controller.caseAction({sessionId:'session-1',
    expectedTimelineRevision:0,type:'case.report',caseId,actionId:'stale'}),/更新/)
  busy=true
  await assert.rejects(controller.caseAction({sessionId:'session-1',
    expectedTimelineRevision:status.timelineRevision,type:'case.clue',
    caseId,text:'一条证言',actionId:'blocked'}),/结束/)
  busy=false
  status=await controller.caseAction({sessionId:'session-1',
    expectedTimelineRevision:status.timelineRevision,type:'case.clue',
    caseId,text:'一条证言',actionId:'clue'})
  assert.equal(status.cases[0].clueCount,1)
  assert.equal(status.facts.length,1)
  assert.equal(status.facts[0].status,'rumor')
  assert.equal(status.people.find(p=>p.id==='npc_2').locationId,null)
  status=await controller.advance({sessionId:'session-1',
    expectedTimelineRevision:status.timelineRevision,minutes:1440,actionId:'day1'})
  assert.equal(status.cases[0].progress,0)
  status=await controller.caseAction({sessionId:'session-1',
    expectedTimelineRevision:status.timelineRevision,type:'case.report',
    caseId,actionId:'report'})
  assert.equal(status.cases[0].progress,1)
})


test('the investigator works while the player is in another province; report requires reunion',()=>{
  let world=open(create())
  world=cmd(world,{type:'travel',actorId:'player',toLocationId:'jiangnan',actionId:'leave'})
  world=tick(world,2880,'two-days')
  const caseId=caseOf(world).id
  assert.equal(world.people.player.locationId,'jiangnan')
  assert.equal(caseOf(world).status,'awaiting_report')
  assert.equal(livingWorldStatus(world,2).cases[0].progress,0)
  assert.ok(livingWorldView(world,'player').events.every(e=>e.kind!=='case.investigated'))
  assert.throws(()=>cmd(world,{type:'case.report',actorId:'player',
    caseId,actionId:'too-far'}),/in person/)
  world=cmd(world,{type:'travel',actorId:'player',toLocationId:'palace',actionId:'come-back'})
  world=tick(world,120,'arrival')
  assert.equal(world.people.player.locationId,'palace')
  world=cmd(world,{type:'case.report',actorId:'player',caseId,actionId:'debrief'})
  assert.equal(livingWorldView(world,'player').cases[0].progress,2)
  assert.equal(world.events.at(-1).kind,'case.reported')
})

test('case subsystem initializes safely for older version 1 living-world snapshots',()=>{
  const legacy=create()
  delete legacy.cases
  assert.deepEqual(livingWorldStatus(legacy,0).cases,[])
  const updated=open(legacy)
  assert.equal(Object.keys(updated.cases).length,1)
  assert.equal(legacy.cases,undefined)
  assert.equal(livingWorldStatus(updated,4).cases[0].title,'东厂账目疑案')
})

test('remote NPCs cannot receive instant goal orders or reveal live travel status',async()=>{
  let seq=0
  let chat={id:'c2',sessionId:'s2',mode:'story',messages:[],
    ledger:{location:'乾清宫',npcs:[{name:'远方官员',location:'江南'}]}}
  const timeline=createStoryTimeline({id:p=>p+'-'+(++seq)})
  const chats={forSession:async id=>id==='s2'?structuredClone(chat):null,
    update:async(key,fn)=>{chat=fn(structuredClone(chat));return structuredClone(chat)}}
  const controller=createLivingWorldController({chats,timeline,isBusy:()=>false})
  const status=await controller.initialize({sessionId:'s2',expectedTimelineRevision:0})
  assert.equal(status.people[0].locationId,null)
  assert.equal(status.people[0].goal,null)
  await assert.rejects(controller.goal({sessionId:'s2',expectedTimelineRevision:status.timelineRevision,
    npcId:'npc_1',goal:'socialize',actionId:'telepathic'}),/当面/)
  await assert.rejects(controller.caseAction({sessionId:'s2',expectedTimelineRevision:status.timelineRevision,
    type:'case.open',kind:'missing',title:'远方调查',investigatorId:'npc_1',actionId:'remote'}),/same location/)
  assert.equal(Object.keys(chat.livingWorld.cases).length,0)
})


test('a finished investigator does not burn hundreds of empty ticks during long absences',()=>{
  const seed=createLivingWorld({worldId:'small',branchId:'b1',playerId:'player',
    locations:[{id:'city'}],people:[
      {id:'player',locationId:'city',goal:'idle'},
      {id:'inspector',locationId:'city',goal:'idle'}
    ]})
  let world=cmd(seed,{type:'case.open',actorId:'player',investigatorId:'inspector',
    kind:'missing',title:'村中失踪传闻',actionId:'open'})
  world=tick(world,2880,'first-two-days')
  assert.equal(world.cases[Object.keys(world.cases)[0]].status,'awaiting_report')
  assert.equal(world.people.inspector.nextActionAt,Number.MAX_SAFE_INTEGER)
  const events=world.events.length
  world=tick(world,10080,'seven-days-more')
  assert.equal(world.backlog,false)
  assert.equal(world.lastTick.executed,0)
  assert.equal(world.events.length,events)
  world=cmd(world,{type:'case.report',actorId:'player',
    caseId:Object.keys(world.cases)[0],actionId:'ask'})
  assert.equal(world.people.inspector.goal,'idle')
  assert.ok(world.people.inspector.nextActionAt<Number.MAX_SAFE_INTEGER)
})

test('ordinary idle NPCs park after their first scheduled day, unless reassigned',()=>{
  const seed=createLivingWorld({worldId:'small',branchId:'b1',playerId:'player',
    locations:[{id:'city'}],people:[
      {id:'player',locationId:'city',goal:'idle'},
      {id:'worker',locationId:'city',goal:'idle'}
    ]})
  let world=tick(seed,1440,'first-day')
  assert.equal(world.people.worker.nextActionAt,Number.MAX_SAFE_INTEGER)
  world=tick(world,10080,'one-week')
  assert.equal(world.lastTick.executed,0)
  assert.equal(world.backlog,false)
  world=cmd(world,{type:'goal',actorId:'worker',goal:'work',actionId:'reassign'})
  assert.ok(world.people.worker.nextActionAt<Number.MAX_SAFE_INTEGER)
})
