import { failure, HttpError, json, readBody } from './http'
export { BattleRoom } from './room'

export interface Env { ROOMS: DurableObjectNamespace; ASSETS: Fetcher }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function roomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), n => ALPHABET[n % 32]).join('')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    try {
      const origin = request.headers.get('Origin')
      if (origin && origin !== url.origin) throw new HttpError(403, '请从本站发起请求')
      if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true })
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const body = await readBody(request)
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = roomCode()
          const room = env.ROOMS.get(env.ROOMS.idFromName(code))
          const response = await room.fetch(new Request(`https://room.internal/${code}/create`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          }))
          if (response.status !== 409) return response
        }
        throw new HttpError(503, '房间创建繁忙，请重试')
      }
      const match = url.pathname.match(/^\/api\/rooms\/([A-HJ-NP-Z2-9]{8})(\/(join|command))?$/)
      if (!match) throw new HttpError(404, '房间地址无效')
      const [, code, , operation] = match
      const method = operation ? 'POST' : 'GET'
      if (request.method !== method) throw new HttpError(405, '请求方法无效')
      const room = env.ROOMS.get(env.ROOMS.idFromName(code))
      return await room.fetch(new Request(`https://room.internal/${code}/${operation ?? 'view'}`, request))
    } catch (error) { return failure(error) }
  },
}
