import { addStats, emptyStats } from './stats'
import type { PlayerStats, RoomView } from './types'
import { saveRoomReplays } from '../db/replayStore'

// Keep the original key so existing browser history can migrate in place.
const KEY = 'gto.battle.profile.v1'
const EVENT = 'gto-battle-profile-change'
interface Snapshot { instanceId: string; playerId: string; stats: PlayerStats; revision: number; baseline: PlayerStats; baselineRevision: number }
interface ProfileStore { version: 2; snapshots: Snapshot[] }
let cache: ProfileStore | null = null
let storageAvailable = true
const emptyStore = (): ProfileStore => ({ version: 2, snapshots: [] })

function validStats(value: unknown): value is PlayerStats {
  if (!value || typeof value !== 'object') return false
  return (Object.keys(emptyStats()) as (keyof PlayerStats)[]).every(key => {
    const number = (value as PlayerStats)[key]
    return typeof number === 'number' && Number.isFinite(number) && (key === 'netBB' || (number >= 0 && Number.isInteger(number)))
  })
}

function parseStore(raw: string | null): ProfileStore {
  if (!raw) return emptyStore()
  const stored = JSON.parse(raw) as ProfileStore
  if (![1, 2].includes(stored.version) || !Array.isArray(stored.snapshots)) throw new Error('Invalid battle profile')
  return { version: 2, snapshots: stored.snapshots.filter(snapshot =>
    snapshot && typeof snapshot.instanceId === 'string' && typeof snapshot.playerId === 'string' && validStats(snapshot.stats)
  ).map(snapshot => ({ ...snapshot, revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : 0,
    baseline: validStats(snapshot.baseline) ? snapshot.baseline : emptyStats(), baselineRevision: Number.isSafeInteger(snapshot.baselineRevision) ? snapshot.baselineRevision : 0 })) }
}

function readStored(): ProfileStore {
  try { return parseStore(localStorage.getItem(KEY)) }
  catch { storageAvailable = false; return emptyStore() }
}

function mergeStores(...stores: (ProfileStore | null)[]): ProfileStore {
  const snapshots = new Map<string, Snapshot>()
  for (const store of stores) for (const snapshot of store?.snapshots ?? []) {
    const key = JSON.stringify([snapshot.instanceId, snapshot.playerId])
    const previous = snapshots.get(key)
    if (!previous) snapshots.set(key, { ...snapshot })
    else {
      // Baselines are persistent tombstones, merged independently of live totals.
      // An old tab's larger totals must never erase a clear performed elsewhere.
      if (snapshot.stats.hands > previous.stats.hands || (snapshot.stats.hands === previous.stats.hands && snapshot.revision > previous.revision)) {
        previous.stats = snapshot.stats
        previous.revision = snapshot.revision
      }
      if (snapshot.baseline.hands > previous.baseline.hands || (snapshot.baseline.hands === previous.baseline.hands && snapshot.baselineRevision > previous.baselineRevision)) {
        previous.baseline = snapshot.baseline
        previous.baselineRevision = snapshot.baselineRevision
      }
    }
  }
  return { version: 2, snapshots: [...snapshots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, snapshot]) => snapshot) }
}

function mergedStore(): ProfileStore {
  cache = mergeStores(readStored(), cache)
  return cache
}

function persist(store: ProfileStore): void {
  cache = store
  try {
    const value = JSON.stringify(store)
    if (localStorage.getItem(KEY) !== value) localStorage.setItem(KEY, value)
    storageAvailable = true
  } catch { storageAvailable = false }
}

function notify(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}

/** Snapshot cumulative server totals. Polls, reconnects and ID reuse are idempotent. */
export function saveBattleProfile(room: RoomView): boolean {
  void saveRoomReplays(room)
  const self = room.players.find(player => player.id === room.selfId && !player.bot)
  if (!self || !validStats(self.stats) || !room.instanceId) return storageAvailable
  const stored = mergedStore()
  const previous = stored.snapshots.find(snapshot => snapshot.instanceId === room.instanceId && snapshot.playerId === room.selfId)
  const revision = Number.isSafeInteger(room.revision) ? room.revision : 0
  let changed = false
  if (self.stats.hands > (previous?.stats.hands ?? 0) || (previous && self.stats.hands === previous.stats.hands && revision > previous.revision)) {
    if (previous) {
      previous.stats = { ...self.stats }
      previous.revision = revision
      // A corrected score for an already-cleared hand belongs to the baseline,
      // so its adjustment cannot reappear when the next new hand is completed.
      if (self.stats.hands === previous.baseline.hands && revision > previous.baselineRevision) {
        previous.baseline = { ...self.stats }
        previous.baselineRevision = revision
      }
    } else stored.snapshots.push({ instanceId: room.instanceId, playerId: room.selfId, stats: { ...self.stats }, revision, baseline: emptyStats(), baselineRevision: 0 })
    changed = true
  }
  const wasAvailable = storageAvailable
  persist(mergeStores(stored))
  if (changed || wasAvailable !== storageAvailable) notify()
  return storageAvailable
}

function sinceClear(snapshot: Snapshot): PlayerStats {
  if (snapshot.stats.hands <= snapshot.baseline.hands) return emptyStats()
  const stats = emptyStats()
  for (const key of Object.keys(stats) as (keyof PlayerStats)[]) {
    const delta = snapshot.stats[key] - snapshot.baseline[key]
    stats[key] = key === 'netBB' ? delta : Math.max(0, delta)
  }
  return stats
}

export function loadBattleProfile(): { stats: PlayerStats; profiles: number; storageAvailable: boolean } {
  const entries = mergedStore().snapshots.map(sinceClear).filter(stats => stats.hands > 0)
  return { stats: entries.reduce(addStats, emptyStats()), profiles: entries.length, storageAvailable }
}

export function subscribeBattleProfile(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) {
      // Include the event payload: another tab may already have overwritten that
      // write. Reconcile retained baselines back to storage, then refresh this UI.
      let incoming: ProfileStore | null = null
      try { incoming = parseStore(event.newValue) } catch { /* Ignore malformed external writes. */ }
      persist(mergeStores(readStored(), incoming, cache))
      listener()
    }
  }
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** Clear personal history only; preserve a baseline for every room/player. */
export function clearBattleProfile(): void {
  const stored = mergedStore()
  for (const snapshot of stored.snapshots) {
    if (snapshot.stats.hands >= snapshot.baseline.hands) {
      snapshot.baseline = { ...snapshot.stats }
      snapshot.baselineRevision = snapshot.revision
    }
  }
  persist(stored)
  notify()
}
