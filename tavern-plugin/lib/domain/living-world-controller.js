import { livingWorldStatus } from './living-world.js'

const GOALS = new Set(['idle', 'work', 'socialize', 'wander'])
const MINUTES = new Set([0, 60, 1440, 10080])

// This is an opt-in, player-operated entry into the real saved Story Timeline.
// No wall-clock simulations, no per-NPC AI calls and no automatic clock changes.
// Never write a world while the model or background settlement owns the save.
export function createLivingWorldController({ chats, timeline, isBusy }) {
  async function change(sessionId, expectedTimelineRevision, makeIntent) {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('请选择游玩对话')
    const chat = await chats.forSession(sessionId)
    if (!chat || !['story', 'script'].includes(chat.mode || 'story'))
      throw new Error('当前没有游玩对话')
    if (!Number.isSafeInteger(expectedTimelineRevision) || expectedTimelineRevision < 0)
      throw new Error('缺少世界状态版本，请重新打开状态栏')
    const saved = await chats.update(chat.id, current => {
      if (!current || current.sessionId !== sessionId) throw new Error('游玩会话已切换')
      if (isBusy(current) || ['pending', 'running', 'waiting-runtime'].includes(current.settleStatus))
        throw new Error('正文或后台结算尚未结束，请稍后操作')
      // Inspect inside the atomic update, not using a previously captured Chat.
      const normalized = timeline.apply({chat:current,intent:{kind:'ensure'}}).chat
      const timelineState = timeline.inspect({chat:normalized})
      if (timelineState.revision !== expectedTimelineRevision)
        throw new Error('世界状态已经更新，请刷新后再操作')
      const intent = makeIntent(normalized, timelineState)
      return timeline.apply({chat:normalized,intent}).chat
    }, {source:'living-world.manual'})
    return livingWorldStatus(saved.livingWorld, saved.timeline?.revision)
  }

  // Seed from *existing* player-maintained ledger names. No invented
  // relationships, biographies, destinations, secrets or NPC goals.
  function seedFromLedger(current) {
    const registered = (Array.isArray(current.ledger?.npcs) ? current.ledger.npcs : [])
      .map(row => String(row?.name || '').trim()).filter(Boolean)
    const names = [...new Set(registered)].slice(0, 24)
    const place = String(current.ledger?.location || current.ledger?.locationPath?.at(-1) || '当前场景').slice(0, 80)
    const playerName = String(current.macroState?.userName || '你').slice(0, 80)
    return {worldId:'game',playerId:'player',minute:0,seed:1,
      locations:[{id:'scene',name:place,links:{}}],
      people:[{id:'player',name:playerName,goal:'idle',locationId:'scene'},
        ...names.map((name,i)=>({id:'npc_'+(i+1),name,goal:'idle',locationId:'scene'}))]}
  }
  async function initialize({sessionId, expectedTimelineRevision}) {
    return change(sessionId, expectedTimelineRevision, (current,timelineState) => {
      if (current.livingWorld) throw new Error('这局游戏已经开启活世界')
      return {kind:'world.init',expectedBranchId:timelineState.branchId,
        expectedRevision:timelineState.revision,config:seedFromLedger(current)}
    })
  }
  async function reset({sessionId, expectedTimelineRevision}) {
    return change(sessionId, expectedTimelineRevision, (current,timelineState) => {
      if (!current.livingWorld?.suspended) throw new Error('活世界并未暂停，不需要重建')
      return {kind:'world.reset',expectedBranchId:timelineState.branchId,
        expectedRevision:timelineState.revision,config:seedFromLedger(current)}
    })
  }
  async function advance({sessionId, expectedTimelineRevision, minutes, actionId}) {
    if (!MINUTES.has(minutes)) throw new Error('可推进一小时、一天或七天，或继续处理待办')
    return change(sessionId, expectedTimelineRevision, (current,timelineState) => {
      if (!current.livingWorld) throw new Error('请先开启活世界')
      if (current.livingWorld.backlog && minutes !== 0)
        throw new Error('请先结算未完成的世界事件')
      const id = String(actionId || '')
      if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(id)) throw new Error('操作编号无效')
      return {kind:'world.advance',expectedBranchId:timelineState.branchId,
        expectedRevision:timelineState.revision, command:{actionId:id,minutes,budget:128}}
    })
  }
  async function goal({sessionId, expectedTimelineRevision, npcId, goal, actionId}) {
    if (!GOALS.has(goal)) throw new Error('不支持的 NPC 行动目标')
    return change(sessionId, expectedTimelineRevision, (current,timelineState) => {
      const world = current.livingWorld
      if (!world) throw new Error('请先开启活世界')
      if (world.backlog) throw new Error('请先结算未完成的世界事件')
      if (!world.people || !Object.hasOwn(world.people,npcId) || npcId === world.playerId)
        throw new Error('找不到这个 NPC')
      const id = String(actionId || '')
      if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(id)) throw new Error('操作编号无效')
      return {kind:'world.command',expectedBranchId:timelineState.branchId,
        expectedRevision:timelineState.revision,
        command:{actionId:id,type:'goal',actorId:npcId,goal}}
    })
  }
  return Object.freeze({initialize,reset,advance,goal})
}
