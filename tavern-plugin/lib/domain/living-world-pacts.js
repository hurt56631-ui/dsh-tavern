// Deliberate relationship records. Autonomously meeting someone never creates
// alliances, romance, marriage, family, guilt or political obligations.
const TYPES = ['alliance','courtship','grievance']
const ACTIVE = new Set(['proposed','active','recorded'])
const PROPOSAL_WINDOW = 30 * 1440
function safeId(id) { return typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id) }
export function livingPactEvidence(value) {
  if (!value || typeof value !== 'object' || typeof value.quote !== 'string' ||
      value.quote.trim().length < 8 || value.quote.length > 240 ||
      !Number.isSafeInteger(value.turn) || value.turn < 0)
    throw new Error('Pact evidence must quote an existing assistant story turn')
  return { turn:value.turn, quote:value.quote.trim() }
}
export function createLivingPact({id,kind,fromId,toId,evidence,minute,fromAdult,toAdult}) {
  if (!/^pact_[0-9]+$/.test(id) || !TYPES.includes(kind) || !safeId(fromId) ||
      !safeId(toId) || fromId === toId || !Number.isSafeInteger(minute) || minute < 0)
    throw new Error('Invalid relationship proposal')
  const source=livingPactEvidence(evidence)
  if (kind === 'courtship' && (!fromAdult || !toAdult))
    throw new Error('Courtship requires confirmed adult ages for both participants')
  if (kind === 'grievance') return {
    id,kind,fromId,toId,createdAt:minute,updatedAt:minute,
    status:'recorded',evidence:source,confirmations:{},
    // The target is not automatically told that someone resents them.
    knownBy:[fromId]
  }
  return {
    id,kind,fromId,toId,createdAt:minute,updatedAt:minute,
    expiresAt:minute+PROPOSAL_WINDOW,status:'proposed',
    evidence:source,confirmations:{},knownBy:[fromId]
  }
}
export function confirmLivingPact(pact,participantId,evidence,minute) {
  if (!pact || pact.status !== 'proposed' || pact.kind === 'grievance')
    throw new Error('Relationship is not awaiting mutual confirmation')
  if (participantId !== pact.fromId && participantId !== pact.toId)
    throw new Error('Participant does not belong to this relationship')
  if (!Number.isSafeInteger(minute) || minute > pact.expiresAt)
    throw new Error('Relationship proposal has expired')
  const source=livingPactEvidence(evidence)
  if (source.quote === pact.evidence.quote ||
      Object.values(pact.confirmations).some(v=>v.quote===source.quote))
    throw new Error('A distinct story excerpt is required for each confirmation')
  if (pact.confirmations[participantId]) throw new Error('Already confirmed by this participant')
  const next={...pact,
    confirmations:{...pact.confirmations,[participantId]:source},
    knownBy:[...new Set([...pact.knownBy,participantId])],updatedAt:minute}
  const activated=Boolean(next.confirmations[next.fromId] && next.confirmations[next.toId])
  if (activated) {
    next.status='active'
    next.activatedAt=minute
  }
  return {next,activated}
}
export function endLivingPact(pact,evidence,minute) {
  if (!pact || !ACTIVE.has(pact.status)) throw new Error('Relationship already concluded')
  if (!Number.isSafeInteger(minute) || minute<pact.createdAt) throw new Error('Invalid ending time')
  const source=livingPactEvidence(evidence)
  return {...pact,status:'ended',updatedAt:minute,endedAt:minute,endEvidence:source}
}
export function expireLivingPact(pact,minute) {
  if (!pact || pact.status!=='proposed' || minute<pact.expiresAt) return pact
  return {...pact,status:'expired',updatedAt:minute}
}
// No quote/evidence body in NPC context projections. Player may consult their
// source dialogue in the original story timeline instead.
export function livingPactsFor(world,viewerId,limit=15) {
  if (!world?.pacts || typeof viewerId!=='string') return []
  return Object.values(world.pacts).filter(p=>p &&
    (viewerId===world.playerId || p.knownBy?.includes(viewerId)))
    .slice(-Math.max(1,Math.min(40,limit))).map(p=>({
      id:p.id,kind:p.kind,fromId:p.fromId,toId:p.toId,status:p.status,
      createdAt:p.createdAt,updatedAt:p.updatedAt,
      confirmedBy:Object.keys(p.confirmations||{}),
      evidenceTurn:p.evidence.turn
    }))
}
