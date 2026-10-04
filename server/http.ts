import { englishError } from './errors'
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}
export function failure(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message, errorEn: englishError(error.message) }, error.status)
  console.error('Battle request failed', error instanceof Error ? error.message : 'unknown error')
  return json({ error: '房间服务暂时不可用，请稍后重试', errorEn: 'The room service is temporarily unavailable. Try again shortly.' }, 500)
}
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, '请使用 JSON 请求')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, '缺少请求内容')
  let bytes = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > 4096) { await reader.cancel(); throw new HttpError(413, '请求内容过长') }
    chunks.push(value)
  }
  const data = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
  try {
    const value = JSON.parse(new TextDecoder().decode(data))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch { throw new HttpError(400, '请求内容无效') }
}
export function playerName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, '请输入昵称')
  const name = value.normalize('NFKC').trim()
  if (!name || [...name].length > 16 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, '昵称需为 1–16 个可见字符')
  return name
}
/** Public identity matching; internal player IDs remain stable and opaque. */
export const nicknameKey = (name: string): string => name.normalize('NFKC').trim().toLowerCase()
