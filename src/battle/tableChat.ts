import type { ChatMessage, RoomView } from './types'

export interface TableChatMessage extends ChatMessage { expiresAt: number; seat: number }
/** Only newly observed live messages become bubbles. History is acknowledged on every reset. */
export class TableChatTracker {
  private instance = ''
  private live = false
  private seen = new Set<string>()
  private messages = new Map<string, TableChatMessage>()
  update(room: RoomView | null, live: boolean, now: number): TableChatMessage[] {
    if (!room) { this.instance = ''; this.live = false; this.seen.clear(); this.messages.clear(); return [] }
    const reset = this.instance !== room.instanceId || !live || !this.live
    if (reset) this.messages.clear()
    else for (const message of room.chat) {
      if (this.seen.has(message.id)) continue
      const seat = room.seats.indexOf(message.playerId)
      if (seat < 0) continue
      this.messages.set(message.playerId, { ...message, seat, expiresAt: now + 7000 })
    }
    this.instance = room.instanceId; this.live = live
    this.seen = new Set(room.chat.map(message => message.id))
    for (const [id, message] of this.messages) if (message.expiresAt <= now || room.seats[message.seat] !== id) this.messages.delete(id)
    return [...this.messages.values()]
  }
}

export interface ChatRect { x: number; y: number; width: number; height: number }
const overlap = (a: ChatRect, b: ChatRect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
export function placeChatBubble(bounds: { width: number; height: number }, seat: ChatRect, size: { width: number; height: number }, obstacles: ChatRect[]): ChatRect {
  const gap = bounds.width < 400 ? 3 : 7
  const cx = seat.x + seat.width / 2, cy = seat.y + seat.height / 2
  const dimensions = { width: size.width, height: size.height }
  const candidates: ChatRect[] = []
  for (const shift of [0, -30, 30, -65, 65]) {
    candidates.push({ ...dimensions, x: seat.x + seat.width + gap, y: cy - size.height / 2 + shift },
      { ...dimensions, x: seat.x - size.width - gap, y: cy - size.height / 2 + shift },
      { ...dimensions, x: cx - size.width / 2 + shift, y: seat.y - size.height - gap },
      { ...dimensions, x: cx - size.width / 2 + shift, y: seat.y + seat.height + gap })
  }
  // Include the edges of available gaps on compact tables, where fixed offsets
  // alone can unnecessarily cover the board between two nearby seats.
  const xs = new Set([seat.x - size.width - gap, cx - size.width / 2, seat.x + seat.width + gap])
  const ys = new Set([seat.y - size.height - gap, cy - size.height / 2, seat.y + seat.height + gap])
  for (const obstacle of obstacles) {
    xs.add(obstacle.x - size.width - gap); xs.add(obstacle.x + obstacle.width + gap)
    ys.add(obstacle.y - size.height - gap); ys.add(obstacle.y + obstacle.height + gap)
  }
  for (const x of xs) for (const y of ys) candidates.push({ ...dimensions, x, y })
  const clamp = (rect: ChatRect) => ({ ...rect, x: Math.max(4, Math.min(bounds.width - rect.width - 4, rect.x)), y: Math.max(4, Math.min(bounds.height - rect.height - 4, rect.y)) })
  const cost = (rect: ChatRect) => obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle) * 100, 0)
    + Math.hypot(rect.x + rect.width / 2 - cx, rect.y + rect.height / 2 - cy)
  return candidates.map(clamp).sort((a, b) => cost(a) - cost(b))[0]
}
