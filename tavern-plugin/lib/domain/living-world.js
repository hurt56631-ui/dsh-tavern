// An opt-in, zero-LLM world simulator. Facts, time and effects are authoritative
// only after a caller commits the returned state through Story Timeline.
// No real-time timers, network calls, generated prose or global NPC omniscience.
import { developNpcAcquaintance, eligibleNpcAid } from './living-world-social.js'
import { createLivingCase, progressLivingCase, projectLivingCases } from './living-world-cases.js'
export const LIVING_WORLD_VERSION = 1
const DAY = 1440
const ID = /^[a-z][a-z0-9_-]{0,63}$/
const MAX_PEOPLE = 500
const MAX_EVENTS = 800
const MAX_OPERATIONS = 128
const MAX_STEP_MINUTES = DAY * 30

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function fail(message, code = 'WORLD_INVALID') { const error = new Error(message); error.code = code; throw error }
function requireId(value, label = 'id') {
  if (typeof value !== 'string' || !ID.test(value)) fail(label + ' must be a stable lowercase ID')
  return value
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(label + ' out of range')
  return value
}
function requireWorld(value) {
  if (!value || value.version !== LIVING_WORLD_VERSION || typeof value.branchId !== 'string' ||
      !value.people || !value.locations || !Array.isArray(value.events) || !Array.isArray(value.pending)) {
    fail('Living world state has an unsupported schema', 'WORLD_SCHEMA')
  }
}
function person(world, id) {
  requireId(id, 'personId')
  if (!Object.hasOwn(world.people, id)) fail('Unknown person: ' + id, 'WORLD_NOT_FOUND')
  return world.people[id]
}
function nearby(world, actorId) {
  const actor = person(world, actorId)
  // Transit is not a location. Nobody in the departure town can 'talk'
  // with a traveller until the arrival task has actually been settled.
  if (!actor.alive || actor.transit) return []
  return Object.values(world.people).filter(other =>
    other.id !== actorId && other.alive && !other.transit && other.locationId === actor.locationId)
    .sort((a, b) => a.id.localeCompare(b.id))
}
function stamp(world, value) {
  const id = 'ev-' + (++world.seq)
  const event = { id, at: value.at ?? world.minute, kind: value.kind,
    actorIds: value.actorIds || [], locationId: value.locationId || '',
    visibleTo: [...new Set(value.visibleTo || [])], ...(value.factIds ? { factIds: value.factIds } : {}) }
  world.events.push(event)
  if (world.events.length > MAX_EVENTS) {
    world.events.shift()
    world.archivedEvents = (world.archivedEvents || 0) + 1
  }
  return id
}
function hash(text) {
  let number = 2166136261
  for (let i = 0; i < text.length; i++) number = Math.imul(number ^ text.charCodeAt(i), 16777619)
  return number >>> 0
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}
function mutation(world, input) {
  requireWorld(world)
  if (!input || typeof input !== 'object') fail('Missing world mutation')
  if (input.branchId !== world.branchId) fail('World branch is stale', 'WORLD_STALE')
  const key = typeof input.actionId === 'string' ? input.actionId : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,95}$/.test(key)) fail('actionId is required')
  const meaningful = { ...input }
  delete meaningful.expectedRevision
  delete meaningful.branchId
  const fingerprint = JSON.stringify(stable(meaningful))
  const seen = world.processed.find(row => row.key === key)
  if (seen) {
    if (seen.fingerprint !== fingerprint) fail('Action ID reused for another action', 'WORLD_IDEMPOTENCY_CONFLICT')
    return { next: clone(world), repeated: true, fingerprint }
  }
  if (input.expectedRevision !== world.revision) fail('World revision is stale', 'WORLD_STALE')
  const next = clone(world)
  // Old v1 save snapshots predate case records; preserve backward compatibility.
  if (!next.cases) next.cases = {}
  return { next, repeated: false, fingerprint }
}
function finish(world, input, fingerprint) {
  world.revision++
  world.processed.push({ key: input.actionId, fingerprint })
  if (world.processed.length > MAX_OPERATIONS) world.processed.splice(0, world.processed.length - MAX_OPERATIONS)
  return world
}
function routeMinutes(world, from, to) {
  if (from === to) return 60
  if (!Object.hasOwn(world.locations, from) || !Object.hasOwn(world.locations, to)) fail('Unknown route destination', 'WORLD_NO_ROUTE')
  const distance = new Map([[from, 0]])
  const visited = new Set()
  while (distance.size) {
    const candidate = [...distance.entries()].filter(([id]) => !visited.has(id))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]
    if (!candidate) break
    const [place, minutes] = candidate
    if (place === to) return minutes
    visited.add(place)
    for (const [neighbor, time] of Object.entries(world.locations[place].links)) {
      const newMinutes = minutes + time
      if (!visited.has(neighbor) && newMinutes < (distance.get(neighbor) ?? Infinity))
        distance.set(neighbor, newMinutes)
    }
  }
  fail('No route between these locations', 'WORLD_NO_ROUTE')
}
function needsQuiet(world) {
  return world.pending.some(action => action.dueAt <= world.minute)
    || Object.values(world.people).some(actor => actor.id !== world.playerId && actor.alive && actor.nextActionAt <= world.minute)
}
function knowledgeOf(world, personId, factId) {
  const knowledge = world.knowledge[personId]
  return knowledge && Object.hasOwn(knowledge, factId) ? knowledge[factId] : null
}
function shareableFacts(world, personId, factIds) {
  if (!Array.isArray(factIds) || factIds.length === 0 || factIds.length > 12) fail('Invalid factIds')
  const unique = [...new Set(factIds)]
  for (const id of unique) {
    requireId(id, 'factId')
    if (!knowledgeOf(world, personId, id)) fail('Speaker does not know this fact', 'WORLD_NOT_KNOWN')
  }
  return unique
}
function learned(world, receiver, factIds, sender, at, sourceId) {
  const list = world.knowledge[receiver]
  for (const id of factIds) {
    // A claim from someone else remains a belief, even if the original witness
    // knew it firsthand. Do not let a rumor overwrite verified knowledge.
    if (list[id]?.status === 'known') continue
    list[id] = { status: 'rumor', learnedAt: at, fromId: sender, eventId: sourceId }
  }
}

export function createLivingWorld(config) {
  if (!config || typeof config !== 'object') fail('World setup required')
  const branchId = String(config.branchId || '')
  if (!branchId || branchId.length > 160) fail('branchId required')
  const worldId = requireId(config.worldId, 'worldId')
  const minute = integer(config.minute ?? 0, 'minute', 0, Number.MAX_SAFE_INTEGER - MAX_STEP_MINUTES)
  const seed = integer(config.seed ?? 1, 'seed', 0, 0x7fffffff)
  if (!Array.isArray(config.locations) || config.locations.length < 1 || config.locations.length > 100)
    fail('Expected 1-100 locations')
  const locations = Object.create(null)
  for (const row of config.locations) {
    const id = requireId(row?.id, 'locationId')
    if (Object.hasOwn(locations, id)) fail('Duplicate location')
    locations[id] = { id, name: String(row.name || id).slice(0, 80), links: {} }
  }
  for (const row of config.locations) {
    const target = locations[row.id]
    for (const [neighbor, time] of Object.entries(row.links || {})) {
      if (!Object.hasOwn(locations, neighbor) || neighbor === row.id) fail('Invalid location link')
      target.links[neighbor] = integer(time, 'travelMinutes', 30, DAY * 30)
    }
  }
  if (!Array.isArray(config.people) || config.people.length > MAX_PEOPLE) fail('Too many NPCs')
  const people = Object.create(null)
  for (const row of config.people) {
    const id = requireId(row?.id, 'personId')
    if (Object.hasOwn(people, id)) fail('Duplicate person')
    const locationId = requireId(row.locationId, 'locationId')
    if (!Object.hasOwn(locations, locationId)) fail('Unknown location')
    const goal = row.goal ?? 'work'
    if (!['work', 'socialize', 'wander', 'idle'].includes(goal)) fail('Invalid NPC goal')
    people[id] = {
      id, name: String(row.name || id).slice(0, 80),
      locationId, goal, alive: row.alive !== false,
      energy: integer(row.energy ?? 70, 'energy', 0, 100),
      coins: integer(row.coins ?? 0, 'coins', 0, 1000000000),
      nextActionAt: integer(row.nextActionAt ?? minute + DAY, 'nextActionAt', minute, Number.MAX_SAFE_INTEGER)
    }
  }
  const playerId = config.playerId === undefined ? '' : requireId(config.playerId, 'playerId')
  if (playerId && !Object.hasOwn(people, playerId)) fail('Player character not registered')
  const knowledge = Object.fromEntries(Object.keys(people).map(id => [id, {}]))
  return {
    version: LIVING_WORLD_VERSION, worldId, branchId, revision: 0, minute, seed, playerId,
    locations, people, relations: {}, facts: {}, knowledge, cases: {},
    events: [], pending: [], processed: [], seq: 0, archivedEvents: 0, backlog: false
  }
}

// Exact, explicit commands only. A model's prose is never interpreted as a
// database write. A caller must decide which effects were truly approved.
export function commandLivingWorld(source, input) {
  const { next: world, repeated, fingerprint } = mutation(source, input)
  if (repeated) return world
  if (world.backlog) fail('Drain due world events before issuing commands', 'WORLD_BACKLOG')
  const actor = person(world, input.actorId)
  if (!actor.alive || actor.transit) fail('Actor is unavailable')
  const at = world.minute
  if (input.type === 'goal') {
    const goal = input.goal
    if (!['idle', 'work', 'socialize', 'wander'].includes(goal)) fail('Unknown NPC goal')
    if (actor.id === world.playerId) fail('Player goals are controlled by player commands')
    if (actor.caseId) fail('Investigator must finish or report the active case first')
    actor.goal = goal
    actor.nextActionAt = Math.min(actor.nextActionAt, at + 60)
    stamp(world, { kind: 'npc.goal.changed', actorIds: [actor.id], locationId: actor.locationId,
      visibleTo: [world.playerId, actor.id].filter(Boolean) })
  } else if (input.type === 'case.open') {
    if (!world.playerId || actor.id !== world.playerId)
      fail('Only the player may open a case')
    const investigator = person(world, input.investigatorId)
    if (investigator.id === actor.id || !investigator.alive || investigator.transit ||
        investigator.locationId !== actor.locationId || investigator.caseId)
      fail('Investigator must be a free NPC at the same location')
    const id = 'case_' + (++world.seq)
    const record = createLivingCase({id,kind:input.kind,title:input.title,
      creatorId:actor.id,investigatorId:investigator.id,
      locationId:actor.locationId,minute:at})
    world.cases[id] = record
    investigator.returnGoal = investigator.goal
    investigator.goal = 'investigate'
    investigator.caseId = id
    investigator.nextActionAt = Math.min(investigator.nextActionAt, at + DAY)
    stamp(world, {kind:'case.opened',actorIds:[actor.id,investigator.id],
      locationId:actor.locationId,visibleTo:[actor.id,investigator.id]})
  } else if (input.type === 'case.clue') {
    const caseId = requireId(input.caseId,'caseId')
    const record = world.cases[caseId]
    if (!record || record.creatorId !== actor.id || record.status === 'archived')
      fail('Case is unavailable')
    const investigator = person(world,record.investigatorId)
    if (!investigator.alive || investigator.transit || investigator.locationId !== actor.locationId)
      fail('Clues must be handed to the investigator in person')
    if (record.clueIds.length >= 32) fail('Case already holds the maximum number of clues')
    const text = String(input.text || '').trim()
    if (text.length < 3 || text.length > 240) fail('Clue text must contain 3–240 characters')
    const factId = 'clue_' + (++world.seq)
    world.facts[factId] = {id:factId,text,createdAt:at,sourceId:actor.id,
      visibility:'private',kind:'testimony',verification:'unverified'}
    const eventId = stamp(world, {kind:'case.clue.filed',actorIds:[actor.id,investigator.id],
      locationId:actor.locationId,visibleTo:[actor.id,investigator.id],factIds:[factId]})
    // Filing testimony is not verification. Both hear a claim, not a proven fact.
    for (const ownerId of [actor.id,investigator.id])
      world.knowledge[ownerId][factId] = {
        status:'rumor',learnedAt:at,fromId:actor.id,eventId
      }
    record.clueIds.push(factId)
    record.status = 'investigating'
    record.progress = 0
    record.reportedStatus = 'investigating'
    record.reportedProgress = 0
    if (investigator.caseId !== record.id) investigator.returnGoal = investigator.goal
    investigator.caseId = record.id
    investigator.goal = 'investigate'
    investigator.nextActionAt = Math.min(investigator.nextActionAt, at + DAY)
  } else if (input.type === 'case.report' || input.type === 'case.archive') {
    const caseId = requireId(input.caseId,'caseId')
    const record = world.cases[caseId]
    if (!record || record.creatorId !== actor.id || record.status === 'archived')
      fail('Case is unavailable')
    const investigator = person(world,record.investigatorId)
    if (!investigator.alive || investigator.transit ||
        investigator.locationId !== actor.locationId)
      fail('Case must be reviewed with the investigator in person')
    if (input.type === 'case.report') {
      // A request reveals only progress actually earned on prior game days.
      record.reportedProgress = record.progress
      record.lastReportAt = at
      if (record.status === 'awaiting_report') {
        record.status = 'awaiting_clues'
        if (investigator.caseId === record.id) {
          investigator.goal = investigator.returnGoal || 'idle'
          delete investigator.caseId
          delete investigator.returnGoal
        }
      }
      record.reportedStatus = record.status
      stamp(world, {kind:'case.reported',actorIds:[actor.id,investigator.id],
        locationId:actor.locationId,visibleTo:[actor.id,investigator.id]})
    } else {
      // Archiving explicitly means "not adjudicated"; never infer guilt.
      record.status = 'archived'
      record.reportedStatus = 'archived'
      record.archivedAt = at
      record.outcome = 'unresolved'
      if (investigator.caseId === record.id) {
        investigator.goal = investigator.returnGoal || 'idle'
        delete investigator.caseId
        delete investigator.returnGoal
      }
      stamp(world, {kind:'case.archived',actorIds:[actor.id,investigator.id],
        locationId:actor.locationId,visibleTo:[actor.id,investigator.id]})
    }
  } else if (input.type === 'fact') {
    const factId = requireId(input.factId, 'factId')
    const text = String(input.text || '').trim()
    if (!text || text.length > 240 || Object.hasOwn(world.facts, factId)) fail('Invalid or duplicate fact')
    // A factual claim is private by default. Only an explicitly declared
    // public fact can circulate through automatic social encounters.
    const visibility = input.visibility === undefined ? 'private' : input.visibility
    if (!['private','public'].includes(visibility)) fail('Invalid fact visibility')
    world.facts[factId] = { id: factId, text, createdAt: at, sourceId: actor.id, visibility }
    const eventId = stamp(world, { kind: 'fact.witnessed', actorIds: [actor.id],
      locationId: actor.locationId, visibleTo: [actor.id], factIds: [factId] })
    world.knowledge[actor.id][factId] = { status: 'known', learnedAt: at, fromId: actor.id, eventId }
  } else if (input.type === 'tell' || input.type === 'letter') {
    const recipient = person(world, input.recipientId)
    if (!recipient.alive || recipient.id === actor.id) fail('Invalid recipient')
    const factIds = shareableFacts(world, actor.id, input.factIds)
    if (input.type === 'tell') {
      if (recipient.transit || actor.locationId !== recipient.locationId) fail('Out of conversation range')
      const eventId = stamp(world, { kind: 'fact.told', actorIds: [actor.id, recipient.id],
        locationId: actor.locationId, visibleTo: [actor.id, recipient.id], factIds })
      learned(world, recipient.id, factIds, actor.id, at, eventId)
    } else {
      const travelMinutes = routeMinutes(world, actor.locationId, recipient.locationId)
      const taskId = 'job-' + (++world.seq)
      world.pending.push({ id: taskId, type: 'letter', fromId: actor.id, recipientId: recipient.id,
        destination: recipient.locationId, dueAt: at + travelMinutes, factIds })
      stamp(world, { kind: 'letter.sent', actorIds: [actor.id], locationId: actor.locationId,
        visibleTo: [actor.id], factIds })
    }
  } else if (input.type === 'route') {
    // Explicit road building is a player's world-edit command, not something
    // a random NPC can invent when wandering.
    if (actor.id !== world.playerId) fail('Only the player may confirm a route')
    const from = requireId(input.fromLocationId, 'fromLocationId')
    const to = requireId(input.toLocationId, 'toLocationId')
    const duration = integer(input.minutes, 'travelMinutes', 30, DAY * 30)
    if (!Object.hasOwn(world.locations, from) || !Object.hasOwn(world.locations, to) ||
        from === to || from.startsWith('unknown_') || to.startsWith('unknown_') ||
        from === 'unknown' || to === 'unknown') fail('Route must connect two confirmed, distinct locations')
    if (Object.hasOwn(world.locations[from].links, to) ||
        Object.hasOwn(world.locations[to].links, from)) fail('Route already exists')
    world.locations[from].links[to] = duration
    world.locations[to].links[from] = duration
    stamp(world, { kind: 'route.connected', actorIds: [actor.id],
      locationId: from, visibleTo: [actor.id] })
  } else if (input.type === 'travel') {
    const to = requireId(input.toLocationId, 'toLocationId')
    const links = world.locations[actor.locationId].links
    const minutes = Object.hasOwn(links, to) ? links[to] : null
    if (!minutes) fail('Travel requires a connected route', 'WORLD_NO_ROUTE')
    const taskId = 'job-' + (++world.seq)
    actor.transit = { from: actor.locationId, to, taskId, dueAt: at + minutes }
    world.pending.push({ id: taskId, type: 'arrival', personId: actor.id,
      destination: to, dueAt: at + minutes })
    stamp(world, { kind: 'travel.started', actorIds: [actor.id],
      locationId: actor.locationId, visibleTo: [actor.id] })
  } else fail('Unknown world command')
  return finish(world, input, fingerprint)
}

function settleTask(world, task) {
  if (task.type === 'arrival') {
    const actor = person(world, task.personId)
    if (!actor.alive || actor.transit?.taskId !== task.id) return
    actor.locationId = task.destination
    delete actor.transit
    stamp(world, { kind: 'travel.arrived', at: task.dueAt, actorIds: [actor.id],
      locationId: actor.locationId, visibleTo: [actor.id] })
  } else if (task.type === 'aid') {
    const donor = person(world, task.fromId)
    const recipient = person(world, task.recipientId)
    const relation = world.relations[donor.id]?.[recipient.id]
    if (!donor.alive || !recipient.alive || donor.transit || recipient.transit ||
        donor.locationId !== task.locationId || recipient.locationId !== task.locationId ||
        donor.coins < task.amount || !relation || relation.status !== 'friend') {
      stamp(world, { kind: 'npc.aid.cancelled', at: task.dueAt,
        actorIds: [donor.id, recipient.id], locationId: task.locationId,
        visibleTo: [donor.id, recipient.id] })
      return
    }
    donor.coins -= task.amount
    recipient.coins = Math.min(1000000000, recipient.coins + task.amount)
    relation.trust = Math.min(100, relation.trust + 2)
    relation.lastAidAt = task.dueAt
    stamp(world, { kind: 'npc.aid.completed', at: task.dueAt,
      actorIds: [donor.id, recipient.id], locationId: task.locationId,
      visibleTo: [donor.id, recipient.id] })
  } else if (task.type === 'letter') {
    const recipient = person(world, task.recipientId)
    if (!recipient.alive || recipient.transit || recipient.locationId !== task.destination) {
      stamp(world, { kind: 'letter.missed', at: task.dueAt, actorIds: [task.fromId],
        locationId: task.destination, visibleTo: [task.fromId] })
      return
    }
    const eventId = stamp(world, { kind: 'letter.delivered', at: task.dueAt,
      actorIds: [task.fromId, task.recipientId], locationId: task.destination,
      visibleTo: [recipient.id], factIds: task.factIds })
    learned(world, recipient.id, task.factIds, task.fromId, task.dueAt, eventId)
  }
}
function autonomousAction(world, actor, at) {
  // Advance the actor's personal schedule even when it is idle or travelling.
  actor.nextActionAt = at + DAY
  if (!actor.alive || actor.transit) return
  if (actor.energy < 20) {
    actor.energy = Math.min(100, actor.energy + 40)
    stamp(world, { kind: 'npc.rested', at, actorIds: [actor.id],
      locationId: actor.locationId, visibleTo: [actor.id] })
    return
  }
  if (actor.goal === 'work') {
    actor.coins = Math.min(1000000000, actor.coins + 2)
    actor.energy = Math.max(0, actor.energy - 9)
    stamp(world, { kind: 'npc.worked', at, actorIds: [actor.id],
      locationId: actor.locationId, visibleTo: [actor.id] })
  } else if (actor.goal === 'socialize') {
    const others = nearby(world, actor.id).filter(other => other.id !== world.playerId)
    if (!others.length) return
    const other = others[hash(world.seed + ':' + actor.id + ':' + at) % others.length]
    if (!world.relations[actor.id]) world.relations[actor.id] = {}
    const developed = developNpcAcquaintance(world.relations[actor.id][other.id], at)
    const relation = developed.next
    world.relations[actor.id][other.id] = relation
    actor.energy = Math.max(0, actor.energy - 2)
    const contact = stamp(world, { kind: 'npc.socialized', at,
      actorIds: [actor.id, other.id], locationId: actor.locationId,
      visibleTo: [actor.id, other.id] })
    // Make the exact contact event the source of this directional memory.
    relation.lastEventId = contact
    if (developed.becameAcquainted || developed.becameFriends)
      stamp(world, { kind: developed.becameFriends ? 'npc.friendship.formed' : 'npc.acquainted',
        at, actorIds: [actor.id, other.id], locationId: actor.locationId,
        visibleTo: [actor.id, other.id] })
    // Aid is delayed, so the recipient and donor must still be present and
    // solvent when the action actually settles. One outstanding offer per pair.
    const hasPendingAid = world.pending.some(task => task.type === 'aid' &&
      task.fromId === actor.id && task.recipientId === other.id)
    if (!hasPendingAid && eligibleNpcAid({ relation, donor: actor, recipient: other,
        minute: at, chance: hash('aid:' + world.seed + ':' + actor.id + ':' + other.id + ':' + at) })) {
      relation.lastAidAt = at // reserve a cooldown for pending offers
      world.pending.push({ id: 'job-' + (++world.seq), type: 'aid', fromId: actor.id,
        recipientId: other.id, locationId: actor.locationId, dueAt: at + 60, amount: 2 })
      stamp(world, { kind: 'npc.aid.offered', at, actorIds: [actor.id, other.id],
        locationId: actor.locationId, visibleTo: [actor.id, other.id] })
    }
    // Deterministic and intentionally conservative: one previously witnessed
    // *public* claim can be repeated per social action, with a clear source.
    // Private facts never spread just because two people met.
    const candidates = Object.keys(world.knowledge[actor.id] || {}).sort()
      .filter(id => world.facts[id]?.visibility === 'public' && !knowledgeOf(world, other.id, id))
    if (candidates.length) {
      const id = candidates[hash('rumor:'+world.seed+':'+actor.id+':'+other.id+':'+at) % candidates.length]
      const eventId = stamp(world, { kind: 'npc.rumor.shared', at,
        actorIds: [actor.id, other.id], locationId: actor.locationId,
        visibleTo: [actor.id, other.id], factIds: [id] })
      learned(world, other.id, [id], actor.id, at, eventId)
    }
  } else if (actor.goal === 'investigate') {
    const record = world.cases?.[actor.caseId]
    if (!record || record.investigatorId !== actor.id || record.status === 'archived') {
      actor.goal = actor.returnGoal || 'idle'
      delete actor.caseId
      delete actor.returnGoal
      return
    }
    // Only work at the actual case location. Travel, rumour and friendship
    // cannot materialize evidence or an unjustified verdict.
    if (actor.locationId !== record.locationId) return
    const result = progressLivingCase(record,at)
    if (!result.advanced) return
    world.cases[record.id] = result.next
    stamp(world,{kind:'case.investigated',at,actorIds:[actor.id],
      locationId:actor.locationId,visibleTo:[actor.id]})
    if (result.ready) stamp(world,{kind:'case.report.ready',at,
      actorIds:[actor.id],locationId:actor.locationId,visibleTo:[actor.id]})
  } else if (actor.goal === 'wander') {
    const routes = Object.keys(world.locations[actor.locationId].links).sort()
    if (!routes.length) return
    const to = routes[hash(world.seed + ':' + actor.id + ':' + at) % routes.length]
    const taskId = 'job-' + (++world.seq)
    const dueAt = at + world.locations[actor.locationId].links[to]
    actor.transit = { from: actor.locationId, to, taskId, dueAt }
    world.pending.push({ id: taskId, type: 'arrival', personId: actor.id,
      destination: to, dueAt })
    stamp(world, { kind: 'travel.started', at, actorIds: [actor.id],
      locationId: actor.locationId, visibleTo: [actor.id] })
  }
}
function firstDue(world, through) {
  let choice = null
  for (const job of world.pending) {
    if (job.dueAt <= through && (!choice || job.dueAt < choice.at ||
        (job.dueAt === choice.at && ('0' + job.id) < choice.key)))
      choice = { kind: 'job', key: '0' + job.id, at: job.dueAt, id: job.id }
  }
  for (const actor of Object.values(world.people)) {
    if (actor.id === world.playerId || !actor.alive || actor.nextActionAt > through) continue
    const key = '1' + actor.id
    if (!choice || actor.nextActionAt < choice.at ||
        (actor.nextActionAt === choice.at && key < choice.key))
      choice = { kind: 'npc', key, at: actor.nextActionAt, id: actor.id }
  }
  return choice
}

// Bounded, deterministic catch-up. If an action budget is hit, advance(0)
// drains the backlog before the next player command; no actions are silently lost.
export function advanceLivingWorld(source, input) {
  const { next: world, repeated, fingerprint } = mutation(source, input)
  if (repeated) return world
  const minutes = integer(input.minutes, 'minutes', 0, MAX_STEP_MINUTES)
  const budget = integer(input.budget ?? 64, 'budget', 1, 256)
  if (world.backlog && minutes !== 0) fail('Drain world backlog first', 'WORLD_BACKLOG')
  const through = world.minute + minutes
  integer(through, 'minute', 0, Number.MAX_SAFE_INTEGER - 1)
  let executed = 0
  while (executed < budget) {
    const due = firstDue(world, through)
    if (!due) break
    if (due.kind === 'job') {
      const index = world.pending.findIndex(job => job.id === due.id)
      const [task] = world.pending.splice(index, 1)
      settleTask(world, task)
    } else autonomousAction(world, world.people[due.id], due.at)
    executed++
  }
  world.minute = through
  world.backlog = needsQuiet(world)
  world.lastTick = { executed, through, backlog: world.backlog }
  return finish(world, input, fingerprint)
}

// On Story Timeline rewind, resurrect only the historical snapshot and change
// its branch ownership. Drop dedupe keys from the abandoned future branch.
export function rebaseLivingWorld(source, branchId) {
  requireWorld(source)
  if (typeof branchId !== 'string' || !branchId || branchId.length > 160) fail('branchId required')
  const world = clone(source)
  world.branchId = branchId
  world.processed = []
  return world
}

export function livingWorldView(source, personId, limit = 15) {
  requireWorld(source)
  const world = source
  const actor = person(world, personId)
  const count = integer(limit, 'limit', 1, 40)
  const known = world.knowledge[actor.id] || {}
  const facts = Object.entries(known).slice(-count).map(([id, claim]) => ({
    id, text: world.facts[id]?.text || '', status: claim.status,
    learnedAt: claim.learnedAt, fromId: claim.fromId
  }))
  const events = world.events.filter(event => event.visibleTo.includes(actor.id)).slice(-count)
    .map(event => {
      const { visibleTo, ...safe } = event
      return clone(safe)
    })
  const neighbors = nearby(world, actor.id).slice(0, count)
    .map(other => ({ id: other.id, name: other.name }))
  return clone({ minute: world.minute, self: actor, nearby: neighbors,
    relationships: world.relations[actor.id] || {}, facts, events,
    cases: projectLivingCases(world,actor.id,count), backlog: world.backlog })
}


// Build model context separately for each NPC. Never serialize global facts,
// other people's knowledge, the omniscient event log or the full roster.
// This is a local projection, not an API call and not a new game state.
export function livingWorldContext(source, viewerId, maximum = 3200) {
  const cap = integer(maximum, 'maximum', 500, 12000)
  const view = livingWorldView(source, viewerId, 30)
  const projection = {
    gameMinute: view.minute,
    character: { id: view.self.id, name: view.self.name,
      locationId: view.self.locationId, energy: view.self.energy,
      ...(view.self.transit ? { transit: view.self.transit } : {}) },
    nearby: view.nearby,
    beliefs: view.facts,
    experiencedEvents: view.events,
    relations: view.relationships,
    cases: view.cases
  }
  const prefix = '【NPC 个人已知情报；谣言不是事实；不得推断未记录的秘密】\n'
  let json = JSON.stringify(projection)
  while (prefix.length + json.length > cap) {
    if (projection.experiencedEvents.length) projection.experiencedEvents.shift()
    else if (projection.beliefs.length) projection.beliefs.shift()
    else if (projection.nearby.length) projection.nearby.pop()
    else if (Object.keys(projection.relations).length) projection.relations = {}
    else if (projection.cases.length) projection.cases.shift()
    else break
    json = JSON.stringify(projection)
  }
  if (prefix.length + json.length > cap) fail('NPC context cannot fit into the requested budget', 'WORLD_CONTEXT_BUDGET')
  return prefix + json
}


// The status sidebar is the player's view, not an omniscient state dump.
// Only already registered names and selectable *simulation policies* are shown.
// Secrets and unseen events are never copied into this projection.
export function livingWorldStatus(source, timelineRevision) {
  if (!source) return { enabled: false, timelineRevision: Number(timelineRevision) || 0 }
  requireWorld(source)
  const playerId = source.playerId
  if (!playerId || !Object.hasOwn(source.people, playerId)) fail('Living world player is missing')
  const projected = livingWorldView(source, playerId, 20)
  return {
    enabled: true, worldId: source.worldId, branchId: source.branchId,
    revision: source.revision, timelineRevision: Number(timelineRevision) || 0,
    minute: source.minute, backlog: source.backlog === true, suspended: source.suspended === true,
    people: Object.values(source.people).filter(p => p.id !== playerId).map(p => ({
      id: p.id, name: p.name, goal: p.goal, locationId: p.locationId,
      transit: p.transit ? { to:p.transit.to, dueAt:p.transit.dueAt } : null
    })),
    locations: Object.values(source.locations).filter(loc =>
      loc.id === source.people[playerId].locationId ||
      !loc.id.startsWith('unknown_') && loc.id !== 'unknown').map(loc => ({
        id: loc.id, name: loc.name,
        links: Object.entries(loc.links).map(([to, minutes]) => ({ to, minutes }))
      })),
    playerLocationId: source.people[playerId].locationId,
    playerTransit: source.people[playerId].transit || null,
    nearby: projected.nearby,
    facts: projected.facts,
    events: projected.events,
    cases: projected.cases
  }
}

// Only the player's knowledge goes to the next foreground turn; unsighted NPC
// schedules, private motivations and private facts are excluded.
export function livingWorldFrameInputs(chat) {
  if (!chat?.livingWorld || chat.livingWorld.suspended) return []
  if (!chat.livingWorld.playerId) return []
  const context = livingWorldContext(chat.livingWorld, chat.livingWorld.playerId, 2400)
  return [{kind: 'foreground.current-state', required: false,
    source: {stage:'living-world', revision:chat.livingWorld.revision},
    text: context + '\n【世界时间和 NPC 事件】此处仅为玩家已知事实。人物日常、信件和旅行由本地世界状态控制；不可替未见事件下结论。'}]
}
