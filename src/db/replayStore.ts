import type { RoomView } from '../battle/types'
import type { BattleReplayRecord } from '../analysis/replay'

const DB_NAME = 'gto-replays'
const EVENT = 'gto-replays-changed'
const LIMIT = 1000
interface Metadata { key: 'state'; seen: Record<string, number>; deletedThrough: Record<string, number> }
const freshMetadata = (): Metadata => ({ key: 'state', seen: {}, deletedThrough: {} })
let dbPromise: Promise<IDBDatabase> | null = null
let available = true
let memory: BattleReplayRecord[] = []
let memoryMeta = freshMetadata()
const ingested = new Map<string, number>()
let channel: BroadcastChannel | null = null
function broadcast(deletedThrough?: Record<string, number>) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(EVENT))
    try { channel ??= new BroadcastChannel(EVENT); channel.postMessage({ deletedThrough }) } catch { /* same-tab events still work */ }
    if (deletedThrough) try { localStorage.setItem(`${EVENT}-clear`, JSON.stringify(deletedThrough)) } catch { /* BroadcastChannel remains available */ }
  }
}
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'))
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('hands', { keyPath: 'id' })
      request.result.createObjectStore('metadata', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(error => { dbPromise = null; throw error }) as Promise<IDBDatabase>
  return dbPromise
}
export function replayKey(instanceId: string, heroId: string) { return JSON.stringify([instanceId, heroId]) }
export function retainReplays(records: BattleReplayRecord[]): BattleReplayRecord[] {
  return [...new Map(records.map(record => [record.id, record])).values()]
    .sort((a, b) => b.hand.finishedAt - a.hand.finishedAt || b.id.localeCompare(a.id)).slice(0, LIMIT)
}
/** Explicitly project the authenticated view. Never persist room tokens or other players' cards. */
export function recordsFromRoom(room: RoomView): BattleReplayRecord[] {
  return (room.handHistory ?? []).filter(hand => hand.players.some(p => p.id === room.selfId)).map(hand => ({
    id: JSON.stringify([room.instanceId, room.selfId, hand.number]), instanceId: room.instanceId, heroId: room.selfId, savedAt: Date.now(),
    hand: { number: hand.number, finishedAt: hand.finishedAt, bigBlind: hand.bigBlind, smallBlind: hand.smallBlind,
      board: [...hand.board], boards: hand.boards.map(board => [...board]),
      players: hand.players.map(({ id, name, bot, position }) => ({ id, name, bot, position })),
      history: hand.history.map(({ playerId, street, kind, amount, allin }) => ({ playerId, street, kind, amount, allin })),
      ...(hand.myCards ? { myCards: [...hand.myCards] as [number, number] } : {}),
      delta: { ...hand.delta }, showdown: hand.showdown, runResults: hand.runResults.map(r => ({ run: r.run, board: [...r.board], winners: [...r.winners], payouts: { ...r.payouts } })),
      ...(hand.replay ? { replay: { version: 1 as const, mode: hand.replay.mode, startingStacks: { ...hand.replay.startingStacks } } } : {}) },
  }))
}
export async function saveRoomReplays(room: RoomView): Promise<void> {
  const records = recordsFromRoom(room)
  if (!records.length) return
  const key = replayKey(room.instanceId, room.selfId)
  const newest = Math.max(...records.map(r => r.hand.number))
  if (ingested.get(key) === newest && available) return
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['hands', 'metadata'], 'readwrite')
      const hands = tx.objectStore('hands'), metadata = tx.objectStore('metadata')
      const metaRequest = metadata.get('state')
      metaRequest.onsuccess = () => {
        const meta: Metadata = metaRequest.result ?? freshMetadata()
        meta.seen[key] = Math.max(meta.seen[key] ?? 0, newest)
        const allRequest = hands.getAll()
        allRequest.onsuccess = () => {
          const all = allRequest.result as BattleReplayRecord[]
          const incoming = records.filter(record => record.hand.number > (meta.deletedThrough[key] ?? 0))
          const kept = retainReplays([...all, ...incoming])
          const ids = new Set(kept.map(r => r.id)), existing = new Set(all.map(r => r.id))
          for (const record of all) if (!ids.has(record.id)) hands.delete(record.id)
          for (const record of kept) if (!existing.has(record.id)) hands.put(record)
          metadata.put(meta)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(tx.error)
    })
    available = true; ingested.set(key, newest)
    memoryMeta.seen[key] = Math.max(memoryMeta.seen[key] ?? 0, newest)
  } catch {
    available = false
    memoryMeta.seen[key] = Math.max(memoryMeta.seen[key] ?? 0, newest)
    memory = retainReplays([...memory, ...records.filter(r => r.hand.number > (memoryMeta.deletedThrough[key] ?? 0))])
  }
  broadcast()
}
export async function listReplays(): Promise<{ records: BattleReplayRecord[]; available: boolean; bytes: number }> {
  let records = memory
  try {
    const db = await openDB()
    records = await new Promise<BattleReplayRecord[]>((resolve, reject) => {
      const request = db.transaction('hands').objectStore('hands').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    records = retainReplays([...records, ...memory])
  } catch { available = false }
  return { records, available, bytes: new TextEncoder().encode(JSON.stringify(records)).length }
}
export async function clearReplays(): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['hands', 'metadata'], 'readwrite')
      const store = tx.objectStore('metadata'), request = store.get('state')
      request.onsuccess = () => {
        const meta: Metadata = request.result ?? freshMetadata()
        meta.deletedThrough = { ...meta.seen }
        memoryMeta.deletedThrough = { ...memoryMeta.deletedThrough, ...meta.deletedThrough }
        store.put(meta); tx.objectStore('hands').clear()
      }
      tx.oncomplete = () => resolve()
      tx.onerror = tx.onabort = () => reject(tx.error)
    })
  } catch (error) {
    if (typeof indexedDB !== 'undefined') throw error
  }
  for (const [key, number] of Object.entries(memoryMeta.seen)) memoryMeta.deletedThrough[key] = Math.max(memoryMeta.deletedThrough[key] ?? 0, number)
  memory = []
  broadcast(memoryMeta.deletedThrough)
}
export function subscribeReplays(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  const receive = (deletedThrough?: Record<string, number>) => {
    if (deletedThrough) {
      for (const [key, number] of Object.entries(deletedThrough)) memoryMeta.deletedThrough[key] = Math.max(memoryMeta.deletedThrough[key] ?? 0, number)
      memory = memory.filter(record => record.hand.number > (memoryMeta.deletedThrough[replayKey(record.instanceId, record.heroId)] ?? 0))
    }
    listener()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === `${EVENT}-clear` && event.newValue) try { receive(JSON.parse(event.newValue)) } catch { /* malformed external value */ }
  }
  window.addEventListener('storage', onStorage)
  let receiver: BroadcastChannel | undefined
  try { receiver = new BroadcastChannel(EVENT); receiver.onmessage = event => receive(event.data?.deletedThrough) } catch { /* localStorage events cover clears */ }
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', onStorage); receiver?.close() }
}
