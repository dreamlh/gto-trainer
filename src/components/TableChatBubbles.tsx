import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { RoomView } from '../battle/types'
import { placeChatBubble, TableChatTracker, type ChatRect, type TableChatMessage } from '../battle/tableChat'
import { useTableChatEnabled } from '../battle/tableChatSettings'
import { useLanguage } from '../battle/i18n'
import { playerDisplayName } from '../battle/presentation'
import { ChatMessageContent } from './ChatSticker'
import '../battle/table-chat.css'

export function TableChatBubbles({ room, active }: { room: RoomView; active: boolean }) {
  const { t } = useLanguage()
  const enabled = useTableChatEnabled()
  const tracker = useRef(new TableChatTracker())
  const [messages, setMessages] = useState<TableChatMessage[]>([])
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const layer = useRef<HTMLDivElement>(null)
  const [positions, setPositions] = useState<Record<string, CSSProperties>>({})
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  useEffect(() => {
    const update = () => setMessages(tracker.current.update(room, enabled && active && visible, Date.now()))
    update(); const timer = window.setInterval(update, 500)
    return () => window.clearInterval(timer)
  }, [room, enabled, active, visible])
  useLayoutEffect(() => {
    const node = layer.current, table = node?.parentElement
    if (!node || !table || !messages.length) return
    const measure = () => {
      const bounds = table.getBoundingClientRect()
      const rect = (element: Element): ChatRect => {
        const r = element.getBoundingClientRect(); return { x: r.left - bounds.left, y: r.top - bounds.top, width: r.width, height: r.height }
      }
      const obstacles = [...table.querySelectorAll('.battle-seat, .battle-table-center, .battle-seat-bet')].map(rect)
      const next: Record<string, CSSProperties> = {}
      for (const message of messages) {
        const seat = table.querySelector(`.battle-seat[data-seat="${message.seat + 1}"]`)
        const bubble = [...node.children].find(child => (child as HTMLElement).dataset.message === message.id)
        if (!seat || !bubble) continue
        const anchor = rect(seat), size = bubble.getBoundingClientRect()
        const placed = placeChatBubble(bounds, anchor, size, obstacles)
        obstacles.push(placed)
        const fromX = anchor.x + anchor.width / 2 - placed.x - placed.width / 2
        const fromY = anchor.y + anchor.height / 2 - placed.y - placed.height / 2
        const horizontal = Math.abs(fromX) > Math.abs(fromY)
        next[message.id] = { left: placed.x, top: placed.y, visibility: 'visible',
          '--tail-x': horizontal ? fromX > 0 ? '100%' : '0%' : `${Math.max(12, Math.min(placed.width - 12, placed.width / 2 + fromX))}px`,
          '--tail-y': horizontal ? `${Math.max(10, Math.min(placed.height - 10, placed.height / 2 + fromY))}px` : fromY > 0 ? '100%' : '0%' } as CSSProperties
      }
      setPositions(next)
    }
    measure(); const observer = new ResizeObserver(measure); observer.observe(table)
    for (const seat of table.querySelectorAll('.battle-seat')) observer.observe(seat)
    return () => observer.disconnect()
  }, [messages])
  if (!enabled || !active || !visible) return null
  return <div className="table-chat-layer" ref={layer} aria-live="polite" aria-atomic="false">
    {messages.map(message => {
      const player = room.players.find(p => p.id === message.playerId)
      const name = player ? playerDisplayName(player, t) : ''
      return <div className="table-chat-bubble" key={message.id} data-message={message.id} data-player={message.playerId}
        style={positions[message.id] ?? { visibility: 'hidden' }} aria-label={t(`${name} 的聊天消息`, `Chat from ${name}`)}>
        <span className="table-chat-content"><ChatMessageContent text={message.text} /></span>
      </div>
    })}
  </div>
}
