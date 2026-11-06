// Case files do not establish that a crime occurred or that a suspect is
// guilty. They are explicit player-created investigative tasks with finite,
// reproducible progress. Testimony stays unverified until later corroboration.
export const LIVING_CASE_KINDS = Object.freeze(['missing', 'theft', 'corruption', 'death', 'other'])
const CASE_STATUSES = new Set(['investigating', 'awaiting_report', 'awaiting_clues', 'archived'])

export function createLivingCase({id, kind, title, creatorId, investigatorId, locationId, minute}) {
  if (typeof id !== 'string' || !/^case_[0-9]+$/.test(id)) throw Error('Invalid case ID')
  if (!LIVING_CASE_KINDS.includes(kind)) throw Error('Unknown case category')
  if (typeof title !== 'string' || title.trim().length < 2 || title.trim().length > 80)
    throw Error('Case title must have 2–80 characters')
  if (!Number.isSafeInteger(minute) || minute < 0) throw Error('Invalid case time')
  return {
    id, kind, title:title.trim(), creatorId, investigatorId, locationId,
    openedAt:minute, status:'investigating',
    progress:0, reportedProgress:0, reportedStatus:'investigating',
    clueIds:[], lastInvestigatedAt:null, lastReportAt:null
  }
}

// The investigator's offline activity NEVER invents a witness, a clue,
// a culprit, an arrest, or a verdict. Progress here means effort, not truth.
export function progressLivingCase(current, minute) {
  if (!current || current.status !== 'investigating') return { next: current, advanced:false, ready:false }
  const next = {...current, progress:Math.min(2, current.progress + 1), lastInvestigatedAt:minute}
  const ready = next.progress >= 2
  if (ready) next.status = 'awaiting_report'
  return { next, advanced:true, ready }
}

// A case's private progress is invisible to its creator until the investigator
// reports it in person; do not accidentally leak it via status or prompt data.
export function projectLivingCases(world, viewerId, limit = 12) {
  if (!world || !world.cases || typeof viewerId !== 'string') return []
  const rows = Object.values(world.cases).filter(c =>
    c && CASE_STATUSES.has(c.status) &&
    (c.creatorId === viewerId || c.investigatorId === viewerId))
  return rows.slice(-Math.max(1,Math.min(80,limit))).map(record => {
    const investigator = record.investigatorId === viewerId
    return {
      id:record.id, kind:record.kind, title:record.title,
      investigatorId:record.investigatorId, locationId:record.locationId,
      openedAt:record.openedAt,
      status: investigator ? record.status : record.reportedStatus,
      progress: investigator ? record.progress : record.reportedProgress,
      clueCount:Array.isArray(record.clueIds) ? record.clueIds.length : 0,
      lastReportAt:record.lastReportAt,
      archived:record.status === 'archived'
    }
  })
}
