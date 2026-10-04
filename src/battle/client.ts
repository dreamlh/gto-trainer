import { getLanguage } from './i18n'
import type { RoomCommand, RoomSession, RoomView } from './types'

const SESSION_KEY = 'gto.battle.session.v1'
function english() { return getLanguage() === 'en' }
const message = (zh: string, en: string) => english() ? en : zh

export class BattleApiError extends Error {
  constructor(message: string, public status: number, public finalRoom?: RoomView) {
    super(message)
    this.name = 'BattleApiError'
  }
}

export function savedSession(): RoomSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null')
    if (value && typeof value.code === 'string' && typeof value.playerId === 'string' && typeof value.token === 'string') return value
  } catch { /* Private browsing can disable storage. The live room still works. */ }
  return null
}

export function saveSession(session: RoomSession | null) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else sessionStorage.removeItem(SESSION_KEY)
  } catch { /* The user can keep playing without persistence. */ }
}

async function request<T>(path: string, options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timeout = window.setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        'Accept-Language': english() ? 'en' : 'zh',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new BattleApiError(
      typeof payload?.error === 'string' ? (english() && typeof payload.errorEn === 'string' ? payload.errorEn : payload.error) : response.status === 404
        ? message('未找到房间，或对战服务尚未启动。请检查房间码与服务状态。', 'Room not found, or the Private Table service is unavailable. Check the room code.')
        : message('请求未完成，请稍后重试。', 'The request failed. Please try again.'),
      response.status,
      payload?.room,
    )
    if (!payload) throw new BattleApiError(message('对战服务暂时不可用，请稍后重试。', 'The Private Table service is unavailable. Please try again.'), 503)
    return payload as T
  } catch (error) {
    if (error instanceof BattleApiError) throw error
    throw new BattleApiError(message('暂时无法连接对战服务，请检查网络后重试。', 'Unable to connect. Check your connection and try again.'), 0)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** A zero actionSeconds value creates a table with unlimited human action time. */
export function createRoom(name: string, capacity: number, initialStack = 100, options: { actionSeconds?: number; mode?: 'cash' | 'tournament'; blindIntervalMinutes?: number; registrationRaises?: number } = {}) {
  return request<{ session: RoomSession; room: RoomView }>('/api/rooms', { method: 'POST', body: { name, capacity, initialStack, ...options } })
}

export function joinRoom(code: string, name: string) {
  return request<{ session: RoomSession; room: RoomView }>(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: { name } })
}

export function getRoom(session: RoomSession, signal?: AbortSignal) {
  return request<{ room: RoomView }>(`/api/rooms/${encodeURIComponent(session.code)}`, { token: session.token, signal })
}

export function sendCommand(session: RoomSession, command: RoomCommand) {
  return request<{ room?: RoomView; left?: boolean; receipt?: RoomSession }>(`/api/rooms/${encodeURIComponent(session.code)}/command`, {
    method: 'POST', token: session.token, body: command,
  })
}
