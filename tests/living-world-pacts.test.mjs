import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createLivingWorld,commandLivingWorld,advanceLivingWorld,
  livingWorldView,livingWorldStatus,livingWorldFrameInputs,rebaseLivingWorld}
  from '../tavern-plugin/lib/domain/living-world.js'
import {createStoryTimeline} from '../tavern-plugin/lib/domain/story-timeline.js'
import {createLivingWorldController} from '../tavern-plugin/lib/domain/living-world-controller.js'

const basis=(turn,quote)=>({turn,quote})
function make() {
  return createLivingWorld({worldId:'dynasty',branchId:'branch_1',playerId:'player',seed:11,
    locations:[{id:'palace',name:'皇宫',links:{jiangnan:120}},
      {id:'jiangnan',name:'江南',links:{palace:120}}],
    people:[
      {id:'player',name:'皇帝',locationId:'palace',goal:'idle',verifiedAge:30},
      {id:'wang',name:'王体乾',locationId:'palace',goal:'idle',verifiedAge:35},
      {id:'minister',name:'内阁大臣',locationId:'palace',goal:'idle',verifiedAge:42},
      {id:'underage',name:'未成年家眷',locationId:'palace',goal:'idle',verifiedAge:16},
      {id:'merchant',name:'商人',locationId:'jiangnan',goal:'idle'}
    ]})
}
const cmd=(w,command)=>commandLivingWorld(w,{branchId:w.branchId,expectedRevision:w.revision,...command})
const tick=(w,minutes,id)=>advanceLivingWorld(w,{branchId:w.branchId,
  expectedRevision:w.revision,actionId:id,minutes,budget:256})
const propose=(w,kind='alliance',fromId='wang',toId='minister')=>
  cmd(w,{type:'pact.open',actorId:'player',kind,fromId,toId,
    evidence:basis(7,'王体乾向内阁大臣提出共同查访江南账目。'),actionId:'open-1'})
const pact=w=>Object.values(w.pacts)[0]

test('explicit proposal only: no instant friendship, marriage, or political obligation',()=>{
  const w=propose(make())
  assert.equal(pact(w).status,'proposed')
  assert.deepEqual(pact(w).confirmations,{})
  assert.equal(w.events.filter(e=>e.kind==='pact.proposed').length,1)
  assert.equal(w.events.some(e=>e.kind==='pact.activated'),false)
  assert.equal(w.relations.wang,undefined)
  assert.equal(livingWorldView(w,'minister').pacts.length,0)
  assert.equal(livingWorldView(w,'wang').pacts[0].status,'proposed')
  assert.equal(livingWorldStatus(w,1).pacts.length,1)
  assert.equal(livingWorldFrameInputs({livingWorld:w})[0].text.includes('共同查访江南账目'),false)
})
test('two distinct witnessed responses activate one alliance but never imply marriage',()=>{
  let w=propose(make())
  const id=pact(w).id
  w=cmd(w,{type:'pact.ack',actorId:'player',pactId:id,participantId:'wang',
    evidence:basis(8,'王体乾明确点头答应合作调查这一桩案子。'),actionId:'ack-1'})
  assert.equal(pact(w).status,'proposed')
  assert.deepEqual(Object.keys(pact(w).confirmations),['wang'])
  assert.equal(livingWorldView(w,'minister').pacts.length,0)
  assert.throws(()=>cmd(w,{type:'pact.ack',actorId:'player',pactId:id,
    participantId:'wang',evidence:basis(9,'王体乾第二次点头表示同意。'),actionId:'ack-again'}),/Already confirmed/)
  assert.throws(()=>cmd(w,{type:'pact.ack',actorId:'player',pactId:id,
    participantId:'minister',evidence:basis(9,'王体乾明确点头答应合作调查这一桩案子。'),
    actionId:'reuse'}),/distinct story excerpt/)
  w=cmd(w,{type:'pact.ack',actorId:'player',pactId:id,participantId:'minister',
    evidence:basis(9,'大臣表示已经收到承诺并愿意协助调查。'),actionId:'ack-2'})
  assert.equal(pact(w).status,'active')
  assert.equal(w.events.filter(e=>e.kind==='pact.activated').length,1)
  assert.equal(livingWorldView(w,'wang').pacts[0].status,'active')
  assert.equal(livingWorldView(w,'minister').pacts[0].status,'active')
  w=tick(w,30*1440,'month')
  assert.equal(pact(w).status,'active')
  assert.ok(!w.events.some(e=>/wedding|marriage|birth|coronation/.test(e.kind)))
})
test('courtship cannot be inferred from unknown ages or a minor; verified adults require two responses',()=>{
  let w=make()
  assert.throws(()=>propose(w,'courtship','wang','underage'),/adult ages/)
  w.people.underage.verifiedAge=null
  assert.throws(()=>propose(w,'courtship','wang','underage'),/adult ages/)
  w=propose(w,'courtship','wang','minister')
  assert.equal(pact(w).kind,'courtship')
  assert.equal(pact(w).status,'proposed')
  assert.equal(w.events.some(e=>e.kind==='pact.activated'),false)
})
test('one-sided resentment stays directional, unknown to target, and can end without forced forgiveness',()=>{
  let w=propose(make(),'grievance','wang','merchant')
  assert.equal(pact(w).status,'recorded')
  assert.equal(w.relations.wang.merchant.trust,-5)
  assert.equal(w.relations.wang.merchant.status,'rival')
  assert.equal(w.relations.merchant,undefined)
  assert.equal(livingWorldView(w,'merchant').pacts.length,0)
  assert.equal(livingWorldView(w,'merchant').events.length,0)
  w=cmd(w,{type:'pact.end',actorId:'player',pactId:pact(w).id,
    evidence:basis(12,'王体乾听过皇帝解释后收回了自己的怨言。'),actionId:'end'})
  assert.equal(pact(w).status,'ended')
  assert.equal(w.relations.wang.merchant.status,'estranged')
  assert.equal(livingWorldView(w,'merchant').pacts.length,0)
  assert.throws(()=>cmd(w,{type:'pact.end',actorId:'player',pactId:pact(w).id,
    evidence:basis(13,'王体乾再次宣布解除恩怨。'),actionId:'end2'}),/already concluded/)
})
test('both participants must be present for mutual confirmations and endings',()=>{
  let w=propose(make())
  const id=pact(w).id
  w=cmd(w,{type:'travel',actorId:'minister',toLocationId:'jiangnan',actionId:'trip'})
  assert.throws(()=>cmd(w,{type:'pact.ack',actorId:'player',pactId:id,participantId:'wang',
    evidence:basis(8,'王体乾答应结盟但大臣已经离开皇宫。'),actionId:'ack'}),/Both participants/)
  assert.throws(()=>cmd(w,{type:'pact.end',actorId:'player',pactId:id,
    evidence:basis(9,'大臣离开后传出解盟消息但无人可问。'),actionId:'end'}),/All affected parties/)
  assert.equal(pact(w).status,'proposed')
})
test('proposal expires by game clock and cannot be confirmed after deadline',()=>{
  let w=propose(make())
  w=tick(w,30*1440,'month')
  assert.equal(pact(w).status,'expired')
  assert.equal(w.events.filter(e=>e.kind==='pact.expired').length,1)
  assert.equal(livingWorldView(w,'minister').pacts.length,0)
  assert.throws(()=>cmd(w,{type:'pact.ack',actorId:'player',pactId:pact(w).id,
    participantId:'wang',evidence:basis(10,'王体乾在逾期之后才表达了同意。'),actionId:'late'}),/not awaiting/)
  assert.deepEqual(tick(propose(make()),30*1440,'month'),w)
})
test('rebase restores proposal and grievances without carrying future confirmations or secrets',()=>{
  let w=propose(make())
  const saved=structuredClone(w)
  w=cmd(w,{type:'pact.ack',actorId:'player',pactId:pact(w).id,participantId:'wang',
    evidence:basis(8,'王体乾已经明确表达同意结盟。'),actionId:'ack'})
  const restored=rebaseLivingWorld(saved,'branch_2')
  assert.equal(restored.branchId,'branch_2')
  assert.deepEqual(restored.pacts[pact(w).id].confirmations,{})
  assert.equal(restored.pacts[pact(w).id].status,'proposed')
  assert.deepEqual(restored.processed,[])
  assert.equal(w.pacts[pact(w).id].confirmations.wang.turn,8)
})
test('older living world saves can gain pacts without schema replacement',()=>{
  const legacy=make()
  delete legacy.pacts
  assert.deepEqual(livingWorldView(legacy,'player').pacts,[])
  const next=propose(legacy)
  assert.equal(Object.keys(next.pacts).length,1)
  assert.equal(legacy.pacts,undefined)
})
test('controller accepts only an exact quote from a saved assistant reply, not a typed wish',async()=>{
  let seq=0
  let chat={id:'chat',sessionId:'session',mode:'story',
    messages:[
      {role:'user',turn:1,text:'我要王体乾跟大臣结盟，现在就同意。'},
      {role:'assistant',turn:2,text:'王体乾向内阁大臣提出了联合查访江南的提议。'},
      {role:'assistant',turn:3,text:'王体乾点头说道：我愿意协助调查此事。'},
      {role:'assistant',turn:4,text:'内阁大臣回复：我也同意共同处理此事。'}],
    macroState:{userAge:'32岁'},
    ledger:{location:'乾清宫',npcs:[
      {name:'王体乾',location:'乾清宫',age:'36岁'},
      {name:'内阁大臣',location:'乾清宫',age:'45岁'}]}}
  const timeline=createStoryTimeline({id:p=>p+'_'+(++seq)})
  let busy=false
  const chats={forSession:async s=>s===chat.sessionId?structuredClone(chat):null,
    update:async(id,fn)=>{chat=fn(structuredClone(chat));return structuredClone(chat)}}
  const controller=createLivingWorldController({chats,timeline,isBusy:()=>busy})
  let state=await controller.initialize({sessionId:'session',expectedTimelineRevision:0})
  assert.equal(state.people.filter(p=>p.adultConfirmed).length,2)
  await assert.rejects(controller.pactAction({sessionId:'session',
    expectedTimelineRevision:state.timelineRevision,type:'pact.open',
    kind:'alliance',fromId:'npc_1',toId:'npc_2',actionId:'wish',
    storyQuote:'我要王体乾跟大臣结盟，现在就同意。'}),/找不到/)
  await assert.rejects(controller.pactAction({sessionId:'session',
    expectedTimelineRevision:state.timelineRevision,type:'pact.open',
    kind:'alliance',fromId:'npc_1',toId:'npc_2',actionId:'fiction',
    storyQuote:'他们从此自动成为了夫妻。'}),/找不到/)
  state=await controller.pactAction({sessionId:'session',
    expectedTimelineRevision:state.timelineRevision,type:'pact.open',
    kind:'alliance',fromId:'npc_1',toId:'npc_2',actionId:'open',
    storyQuote:'王体乾向内阁大臣提出了联合查访江南的提议。'})
  assert.equal(state.pacts.length,1)
  const id=state.pacts[0].id
  state=await controller.pactAction({sessionId:'session',
    expectedTimelineRevision:state.timelineRevision,type:'pact.ack',pactId:id,
    participantId:'npc_1',storyQuote:'王体乾点头说道：我愿意协助调查此事。',
    actionId:'wang'})
  assert.equal(state.pacts[0].status,'proposed')
  state=await controller.pactAction({sessionId:'session',
    expectedTimelineRevision:state.timelineRevision,type:'pact.ack',pactId:id,
    participantId:'npc_2',storyQuote:'内阁大臣回复：我也同意共同处理此事。',
    actionId:'minister'})
  assert.equal(state.pacts[0].status,'active')
  assert.equal(state.pacts[0].confirmedBy.length,2)
  assert.equal(chat.livingWorld.pacts[id].evidence.turn,2)
  await assert.rejects(controller.pactAction({sessionId:'session',
    expectedTimelineRevision:state.timelineRevision-1,type:'pact.end',pactId:id,
    storyQuote:'内阁大臣回复：我也同意共同处理此事。',
    actionId:'old'}),/刷新|更新/)
  busy=true
  await assert.rejects(controller.pactAction({sessionId:'session',
    expectedTimelineRevision:state.timelineRevision,type:'pact.end',pactId:id,
    storyQuote:'内阁大臣回复：我也同意共同处理此事。',
    actionId:'blocked'}),/结束/)
})
