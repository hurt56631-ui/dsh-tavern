import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createLivingWorld, commandLivingWorld} from '../tavern-plugin/lib/domain/living-world.js'
import {forkConversationChat} from '../tavern-plugin/lib/domain/conversation-fork.js'

test('forks retain only history present at chosen time and carry new branch ownership',()=>{
  const original=createLivingWorld({worldId:'x',branchId:'old-branch',playerId:'player',
    locations:[{id:'scene'}],people:[{id:'player',locationId:'scene'},{id:'npc',locationId:'scene'}]})
  const saved=commandLivingWorld(original,{branchId:'old-branch',expectedRevision:0,
    actionId:'a1',type:'fact',actorId:'npc',factId:'secret',text:'NPC 知道的秘密'})
  const src={id:'chat-old',sessionId:'session-old',mode:'story',
    timeline:{schemaVersion:1,branchId:'old-branch',revision:3,checkpoints:[]},
    livingWorld:saved,messages:[]}
  const fork=forkConversationChat(src,{chatId:'chat-new',sessionId:'session-new',id:prefix=>prefix+'-new',now:()=>100})
  assert.equal(fork.timeline.branchId,'branch-new')
  assert.equal(fork.livingWorld.branchId,'branch-new')
  assert.equal(fork.livingWorld.facts.secret.text,'NPC 知道的秘密')
  assert.deepEqual(fork.livingWorld.processed,[])
  assert.equal(fork.livingWorld.knowledge.npc.secret.status,'known')
  assert.equal(src.livingWorld.branchId,'old-branch')
  assert.equal(src.livingWorld.processed.length,1)
})
