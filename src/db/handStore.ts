import type { HandRecord } from '../game/session'

// 牌局历史存储：IndexedDB（不可用时退回内存 + 提示）

const DB_NAME = 'gto-v2'
const STORE = 'hands'

let dbPromise: Promise<IDBDatabase | null> | null = null
const memory: HandRecord[] = []
let memoryOnly = false

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      memoryOnly = true
      resolve(null)
      return
    }
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' })
          os.createIndex('ts', 'ts')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        memoryOnly = true
        resolve(null)
      }
    } catch {
      memoryOnly = true
      resolve(null)
    }
  })
  return dbPromise
}

export function isMemoryOnly(): boolean {
  return memoryOnly
}

export async function saveHand(r: HandRecord): Promise<void> {
  const db = await openDB()
  if (!db) {
    memory.push(r)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(r)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function listHands(fromTs: number, toTs: number): Promise<HandRecord[]> {
  const db = await openDB()
  if (!db) return memory.filter((r) => r.ts >= fromTs && r.ts <= toTs)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const idx = tx.objectStore(STORE).index('ts')
    const out: HandRecord[] = []
    const req = idx.openCursor(IDBKeyRange.bound(fromTs, toTs))
    req.onsuccess = () => {
      const cur = req.result
      if (cur) {
        out.push(cur.value as HandRecord)
        cur.continue()
      } else {
        resolve(out)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

export async function countHands(): Promise<number> {
  const db = await openDB()
  if (!db) return memory.length
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function clearHands(): Promise<void> {
  const db = await openDB()
  memory.length = 0
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// 请求持久存储（尽力而为）
export function requestPersistence(): void {
  try {
    void navigator.storage?.persist?.()
  } catch {
    /* 忽略 */
  }
}
