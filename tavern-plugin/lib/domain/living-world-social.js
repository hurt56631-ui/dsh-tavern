// Pure, deterministic and intentionally small NPC relationship transitions.
// Emotional states are directional: one person gaining trust does not force
// their partner to reciprocate, nor does it imply romance, consent or marriage.
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0))
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

export function developNpcAcquaintance(previous, minute) {
  const old = previous && typeof previous === 'object' ? previous : {}
  const oldTrust = clamp(old.trust, -100, 100)
  const oldContacts = count(old.contacts)
  const contacts = Math.min(oldContacts + 1, 9999)
  const trust = Math.min(100, oldTrust + 1)
  // Do not overrule separately adjudicated hostility or a durable rivalry.
  const priorStatus = ['rival', 'estranged', 'friend', 'acquaintance'].includes(old.status)
    ? old.status : oldContacts > 0 ? 'acquaintance' : 'stranger'
  const status = priorStatus === 'rival' || priorStatus === 'estranged'
    ? priorStatus : contacts >= 5 && trust >= 5 ? 'friend' : 'acquaintance'
  return {
    next: { ...old, trust, contacts, status, lastMetAt: minute },
    becameAcquainted: priorStatus === 'stranger' && status === 'acquaintance',
    becameFriends: priorStatus !== 'friend' && status === 'friend',
  }
}

// Only a person who can afford it may offer small, reversible help to a
// needy acquaintance. We do not let a formula create romantic proposals,
// weddings, crimes, political conspiracies, births, deaths or new "facts".
export function eligibleNpcAid({ relation, donor, recipient, minute, chance }) {
  if (!relation || relation.status !== 'friend' || relation.trust < 5) return false
  if (!donor || !recipient || !donor.alive || !recipient.alive ||
      donor.transit || recipient.transit || donor.locationId !== recipient.locationId) return false
  if (!(donor.coins >= 10 && recipient.coins <= 2)) return false
  if (Number.isSafeInteger(relation.lastAidAt) && minute - relation.lastAidAt < 14 * 1440) return false
  return Number.isSafeInteger(chance) && chance % 3 === 0
}
