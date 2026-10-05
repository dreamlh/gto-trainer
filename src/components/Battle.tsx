import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { BattleApiError, createRoom, getRoom, joinRoom, savedSession, saveSession, sendCommand } from '../battle/client'
import type { HandView, RoomCommand, RoomPlayer, RoomSession, RoomView } from '../battle/types'
import { useLanguage } from '../battle/i18n'
import { saveBattleProfile } from '../battle/localStats'
import { BattleStats } from './BattleStats'
import { BattleActions } from './BattleActions'
import { PokerDialog as BattleDialog } from './PokerDialog'
import { usePokerTableViewport } from './usePokerTableViewport'
import { BattleRoomSettings, BattleSpectatorSharing, BattleStandIcon } from './BattleRoomSettings'
import { BattleAtmosphere } from './BattleAtmosphere'
import { TableChatBubbles } from './TableChatBubbles'
import { BattleRules } from './BattleRules'
import { BattleHandLog } from './BattleHandLog'
import type { OpenAnalysis } from '../analysis/types'
import { ChatMessageContent } from './ChatSticker'
import type { ChatEmojiPickerState } from './ChatEmojiPicker'
import { ChatComposer, type ChatComposerHandle } from './ChatComposer'
import { battleResultSummary, playerDisplayName, handPosition, playerActionLabel, playerShowdownLabel } from '../battle/presentation'
import { CardFace } from './CardFace'
import { PokerHoleCard } from './PokerHoleCard'
import { PokerSeatContent } from './PokerSeatContent'
import { PokerPayoutEffect } from './PokerPayoutEffect'
import { tableSeatLayout } from '../poker/tableLayout'
import { holeCardOrder } from '../poker/holeCardOrder'
import { winningCards } from '../battle/winningCards'
import '../battle/winning-cards.css'
import { useBattleVisuals } from './useBattleVisuals'
import { useBattleChipLayout } from './useBattleChipLayout'
import '../battle/battle.css'
import '../battle/effects.css'

const bb = (value: number) => Number(value.toFixed(2)).toLocaleString('en-GB')
const signed = (value: number) => `${value > 0 ? '+' : ''}${bb(value)}`
type Translate = (zh: string, en: string) => string
type Command = (command: RoomCommand) => Promise<void>
const streets: Record<string, [string, string]> = { preflop: ['翻前', 'Preflop'], flop: ['翻牌', 'Flop'], turn: ['转牌', 'Turn'], river: ['河牌', 'River'] }
const translated = (map: Record<string, [string, string]>, key: string, t: Translate) => map[key] ? t(...map[key]) : key
function initialNickname() { try { return (localStorage.getItem('gto.battle.nickname') || '').slice(0, 16) } catch { return '' } }
function roomFromUrl() { return new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase() ?? '' }
function inviteLink(code: string) { const url = new URL(window.location.href); url.search = ''; url.hash = ''; url.searchParams.set('room', code); return url.toString() }
function useNow() { const [now, setNow] = useState(Date.now()); useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id) }, []); return now }
function CardBack() { const { t } = useLanguage(); return <span className="battle-card-back" aria-label={t('未公开的底牌', 'Hidden hole card')}>♠</span> }

function positionDescription(position: string, t: Translate) {
  const descriptions: Record<string, [string, string]> = { BTN: ['庄位', 'Button'], SB: ['小盲位', 'Small blind'], BB: ['大盲位', 'Big blind'], 'BTN / SB': ['单挑：庄位兼小盲', 'Heads-up: button and small blind'], UTG: ['枪口位', 'Under the gun'], HJ: ['劫位', 'Hijack'], CO: ['关煞位', 'Cutoff'] }
  return descriptions[position] ? t(...descriptions[position]) : position
}

function BattleSeat({ room, seat, viewSeat, player, showdownBoard, onOpen, busy, onCommand, visuals, winner, winningHole, onFocusWinner }: { room: RoomView; seat: number; viewSeat: number; player?: RoomPlayer; showdownBoard: readonly number[] | null; onOpen: () => void; busy: boolean; onCommand: Command; visuals: ReturnType<typeof useBattleVisuals>; winner: boolean; winningHole?: ReadonlySet<number>; onFocusWinner: (id: string | null) => void }) {
  const { t } = useLanguage()
  const hand = room.hand
  const state = hand?.players.find(p => p.id === player?.id)
  const handKey = `${room.instanceId}:${hand?.number}`
  const actionMotion = player ? visuals?.actions[player.id] : undefined
  const dealOrder = Math.max(0, hand?.players.findIndex(p => p.id === player?.id) ?? 0)
  const self = player?.id === room.selfId
  const acting = !!player && hand?.toAct === player.id && !hand.finished
  const layout = tableSeatLayout(room.capacity, viewSeat)
  const { angle } = layout
  const style = { '--seat-x': `${layout.x}%`, '--seat-y': `${layout.y}%`, '--bet-x': `${layout.betX}%`, '--bet-y': `${layout.betY}%`, '--bet-from-x': `${Math.cos(angle) * 24}px`, '--bet-from-y': `${Math.sin(angle) * 24}px` } as CSSProperties
  const settling = room.settlementAt != null
  const settled = !!hand?.finished && !settling
  const delta = settled && player ? hand?.delta?.[player.id] : undefined
  const wager = settled ? delta : state?.streetBet
  const showWager = wager !== undefined && (settled ? wager !== 0 : wager > 0)
  const reserving = room.players.find(p => p.id === room.reservations[seat])
  const removingSeat = room.pendingSeatRemovals?.includes(seat) ?? false
  const pending = player?.pendingRemoval || player?.pendingSeat !== null && player?.seat === null
  const name = player ? playerDisplayName(player, t) : ''
  const actual = room.players.find(member => member.id === room.seats[seat])
  const host = room.hostId === room.selfId
  const myReservation = reserving?.id === room.selfId
  const tournamentLocked = room.mode === 'tournament' && room.started
  const unit = room.mode === 'tournament' ? t('筹码', 'chips') : 'BB'
  const admissionOpen = !tournamentLocked || !!room.tournament?.registrationOpen
  const selfEntered = !!room.tournament?.entrantIds.includes(room.selfId)
  const canSit = !removingSeat && admissionOpen && !(tournamentLocked && selfEntered) && !reserving && (!actual || !tournamentLocked && (actual.bot || actual.leaving))
  const standing = room.players.find(member => member.id === room.selfId)?.seat == null
  const canAdd = !removingSeat && admissionOpen && host && !reserving && (!actual || !tournamentLocked && actual.pendingRemoval)
  const canCancel = myReservation && !tournamentLocked
  const sitLabel = room.hand && (!room.hand.finished || room.settlementAt != null) ? t('预约', 'Reserve') : t('入座', 'Sit')
  const position = player && hand ? handPosition(hand, player.id) : ''
  const stackLabel = player ? bb(settled ? player.stack : state?.stack ?? player.stack) : ''
  const actionLabel = player ? playerActionLabel(hand, player.id, t) : null
  const handRank = player ? playerShowdownLabel(hand, player.id, showdownBoard, t) : null
  const tournamentLabel = player?.tournamentStatus === 'rebuy' ? t('等待重购', 'Awaiting rebuy') : player?.tournamentStatus === 'winner' ? t('冠军', 'Winner') : player?.tournamentStatus === 'eliminated' ? t(`第 ${player.tournamentPlace} 名 · 淘汰`, `#${player.tournamentPlace} · Out`) : player?.tournamentStatus === 'forfeited' ? t('已弃赛', 'Forfeited') : null
  const status = !player ? '' : player.awayUntil != null ? t('临时离开', 'Away') : player.pendingRemoval ? t('待移除', 'Leaving next') : pending ? t('下手加入', 'Next hand') : player.leaving ? t('已离桌', 'Left') : state?.folded ? t('已弃牌', 'Folded') : state?.allin ? t('全下', 'All-in') : player.sittingOut ? t('观战', 'Sitting out') : player.entryStatus === 'waiting' && !state ? t('等大盲', 'Wait for BB') : !state && room.started ? t('下一手', 'Next hand') : !player.bot && !player.connected ? t('离线', 'Offline') : ''
  return <>
    <div className={`battle-seat ${self ? 'battle-seat-self' : ''} ${acting && player?.awayUntil == null ? 'battle-seat-acting' : ''} ${player?.awayUntil != null ? 'battle-seat-away' : ''} ${state?.folded ? 'battle-seat-folded' : ''} ${pending ? 'battle-seat-pending' : ''} ${!player ? 'battle-seat-vacant' : ''} ${winner ? 'battle-seat-winner' : ''}`} style={style} data-seat={seat + 1} onMouseEnter={() => onFocusWinner(winner && player ? player.id : null)} onMouseLeave={() => onFocusWinner(null)} onFocus={() => onFocusWinner(winner && player ? player.id : null)} onBlur={() => onFocusWinner(null)}>
      {player ? <button className="battle-seat-target" onClick={onOpen} aria-label={t(`${name}，座位 ${seat + 1}，查看数据与座位操作`, `${name}, seat ${seat + 1}, view stats and seat options`)}>
        <PokerSeatContent
          cardsClassName={state?.folded && !hand?.finished ? 'battle-cards-folded' : ''}
          cards={state && holeCardOrder(state.cards).map((index, displayIndex) => <span key={`${handKey}:${player.id}:${index}`} className={`battle-hole-motion ${visuals?.deal ? 'is-dealt' : ''}`} style={{ '--deal-delay': `${(dealOrder + index * (hand?.players.length ?? 1)) * 24}ms`, '--deal-x': `${-Math.cos(angle) * 70}px`, '--deal-y': `${-Math.sin(angle) * 48}px` } as CSSProperties}>
            <PokerHoleCard card={state.cards?.[index] ?? null} index={displayIndex} back={<CardBack />} publiclyShown={room.revealed[player.id]?.includes(index)} winning={state.cards?.[index] != null && winningHole?.has(state.cards[index]!)} />
          </span>)}
          name={name} stack={stackLabel} unit={unit} position={position ?? ''} positionTitle={position ? positionDescription(position, t) : undefined} dealer={player.id === hand?.dealerId}
          winnerLabel={winner ? t('获胜', 'WIN') : undefined}
          statusClassName={`${acting ? 'is-acting' : ''} ${actionLabel ? 'has-action' : ''} ${handRank ? 'is-hand-rank' : ''}`}
          statusTitle={handRank ? [handRank, tournamentLabel].filter(Boolean).join(' · ') : tournamentLabel ?? actionLabel ?? status}
          status={<span key={acting ? 'acting' : actionMotion?.key ?? 'status'} className={actionMotion && !acting ? 'battle-action-motion' : undefined} data-kind={actionMotion?.kind}>{handRank ?? tournamentLabel ?? (player?.awayUntil != null ? t('临时离开', 'Away') : acting ? t('行动中', 'Acting') : actionLabel || status || '\u00a0')}</span>}
        />
      </button> : <div className="battle-empty-seat-group">
        {host && room.capacity > 2 && !reserving && <button type="button" className="battle-remove-seat" disabled={busy || removingSeat} aria-label={t(`删除空座 ${seat + 1}`, `Remove empty seat ${seat + 1}`)} title={removingSeat ? t('本手结束后删除', 'Removing after this hand') : t('删除空座', 'Remove empty seat')} onClick={() => void onCommand({ type: 'remove-seat', seat, capacity: room.capacity })}>×</button>}
        <button className="battle-empty-seat" disabled={busy || !(canSit || canCancel)} onClick={() => void onCommand(canCancel ? { type: 'cancel-seat' } : { type: 'sit', seat })} aria-label={canCancel ? t(`取消预约座位 ${seat + 1}`, `Cancel reservation for seat ${seat + 1}`) : t(`${sitLabel}座位 ${seat + 1}`, `${sitLabel} seat ${seat + 1}`)}><span>{canCancel ? '−' : canSit ? '＋' : '—'}</span><small>{reserving ? myReservation ? tournamentLocked ? t('已报名', 'Registered') : t('取消预约', 'Cancel') : t('已预约', 'Reserved') : !admissionOpen ? t('报名截止', 'Entry closed') : `${sitLabel} ${seat + 1}`}</small></button>
        {canAdd && <button className="battle-seat-bot-add" disabled={busy} aria-label={t(`在座位 ${seat + 1} 添加电脑`, `Add Bot at seat ${seat + 1}`)} onClick={() => void onCommand({ type: 'add-bot', seat })}>＋ {t('电脑', 'Bot')}</button>}
        {removingSeat && <small className="battle-seat-removing">{t('待删除', 'Removing')}</small>}
      </div>}
      {self && player.awayUntil != null && <button type="button" className="battle-seat-return" disabled={busy} onClick={() => void onCommand({ type: 'away', away: false })}>{t('取消暂离', 'Return')}</button>}
      {player && canSit && standing && <button className="battle-seat-direct" disabled={busy} aria-label={t(`${sitLabel}座位 ${seat + 1}`, `${sitLabel} seat ${seat + 1}`)} onClick={() => void onCommand({ type: 'sit', seat })}>{sitLabel}</button>}
      {canCancel && player && <button className="battle-seat-direct battle-seat-cancel" disabled={busy} aria-label={t(`取消预约座位 ${seat + 1}`, `Cancel reservation for seat ${seat + 1}`)} onClick={() => void onCommand({ type: 'cancel-seat' })}>{t('取消', 'Cancel')}</button>}
      {reserving && !myReservation && reserving.id !== player?.id && <span className="battle-reservation" title={playerDisplayName(reserving, t)}>{t('已预约', 'Reserved')}</span>}

    </div>
    {player && showWager && <span className={`battle-seat-bet ${settled ? (wager! > 0 ? 'battle-positive' : 'battle-negative') : ''}`} style={style} data-seat={seat + 1} aria-label={t(`${name}，${settled ? '本手盈亏' : '本轮下注'} ${bb(wager!)} ${unit}`, `${name}, ${settled ? 'hand result' : 'round bet'} ${bb(wager!)} ${unit}`)} title={t(`${name}：${bb(wager!)} ${unit}`, `${name}: ${bb(wager!)} ${unit}`)}>
      <span key={`${handKey}:${hand?.street}:${settled ? 'result' : wager}`} className={!settled && visuals?.betKeys.has(`${player.id}:${hand?.street}:${state?.streetBet}`) ? 'battle-bet-motion' : undefined}>
        <i className="battle-chip-icon" aria-hidden="true" />{settled ? signed(wager!) : bb(wager!)}
      </span>
    </span>}
  </>
}

function playerAtSeat(room: RoomView, seat: number): RoomPlayer | undefined {
  const handPlayer = room.hand && (!room.hand.finished || room.settlementAt != null) ? room.hand.players.find(player => player.seat === seat) : undefined
  const seated = room.players.find(player => player.id === (handPlayer?.id ?? room.seats[seat]))
  return seated ?? room.players.find(player => player.bot && player.id === room.reservations[seat])
}

function memberStatus(player: RoomPlayer, t: Translate): string {
  if (player.tournamentStatus === 'rebuy') return `${player.seat != null ? t(`座位 ${player.seat + 1}`, `Seat ${player.seat + 1}`) : t('等待重购', 'Awaiting rebuy')}${player.seat != null ? t(' · 等待重购', ' · Awaiting rebuy') : ''}`
  if (player.tournamentStatus === 'winner') return t('冠军', 'Winner')
  if (player.tournamentStatus === 'eliminated') return t(`第 ${player.tournamentPlace} 名 · 已淘汰`, `#${player.tournamentPlace} · Eliminated`)
  if (player.tournamentStatus === 'forfeited') return t('已弃赛', 'Forfeited')
  if (player.leaving) return t('已离开', 'Left')
  const sitting = player.seat !== null
  const state = sitting ? t(`座位 ${player.seat! + 1}`, `Seat ${player.seat! + 1}`) : t('观战', 'Spectating')
  if (player.awayUntil != null) return `${state} · ${t('临时离开', 'Away')}`
  if (player.pendingRemoval) return `${state} · ${t('待移除', 'Removal queued')}`
  if (player.pendingSeat !== null) return player.bot && !sitting ? t(`待添加 · 座位 ${player.pendingSeat + 1}`, `Adding · Seat ${player.pendingSeat + 1}`) : `${state} · ${t(`预约座位 ${player.pendingSeat + 1}`, `Reserving seat ${player.pendingSeat + 1}`)}`
  if (sitting && player.sittingOut) return `${state} · ${t('暂停', 'Sitting out')}`
  if (sitting && player.entryStatus === 'waiting') return `${state} · ${t('等待大盲', 'Waiting for BB')}`
  if (!player.connected && !player.bot) return `${state} · ${t('离线', 'Offline')}`
  return state
}

const ChatEmojiPicker = lazy(() => import('./ChatEmojiPicker'))
function RoomChat({ room, busy, onCommand }: { room: RoomView; busy: boolean; onCommand: Command }) {
  const { t, language } = useLanguage()
  const [text, setText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiSelection, setEmojiSelection] = useState<ChatEmojiPickerState>({ tab: 'stickers', category: 'Smileys & Emotion', page: 0, stickerPage: 0 })
  const input = useRef<ChatComposerHandle>(null)
  const picker = useRef<HTMLDivElement>(null)
  const messages = useRef<HTMLDivElement>(null)
  useEffect(() => { if (messages.current) messages.current.scrollTop = messages.current.scrollHeight }, [room.chat.length])
  useEffect(() => {
    if (!emojiOpen) return
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !picker.current?.contains(event.target)) setEmojiOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [emojiOpen])
  const insertEmoji = (emoji: string) => {
    if (!input.current?.insert(emoji)) return
    setEmojiOpen(false)
  }
  const submit = async () => { if (busy || !text.trim()) return; const value = text.trim(); setText(''); setEmojiOpen(false); await onCommand({ type: 'chat', text: value }) }
  return <div className="battle-chat">
    <div className="battle-chat-messages" ref={messages} aria-live="polite">{!room.chat.length && <p className="battle-empty-note">{t('尚无聊天消息', 'No messages yet')}</p>}{room.chat.map(message => <div className={`battle-chat-message ${message.playerId === room.selfId ? 'battle-chat-own' : ''}`} key={message.id}><div><strong>{message.name}</strong><time>{new Date(message.ts).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</time></div><p><ChatMessageContent text={message.text} /></p></div>)}</div>
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <ChatComposer ref={input} value={text} onChange={setText} onSubmit={() => void submit()} onEscape={() => setEmojiOpen(false)} />
      <div className="battle-chat-toolbar"><div className="battle-chat-emoji" ref={picker} onKeyDown={event => { if (event.key === 'Escape') { setEmojiOpen(false); input.current?.focus() } }}>
        <button type="button" className="battle-emoji-toggle" aria-label={t('选择表情', 'Choose emoji')} aria-expanded={emojiOpen} aria-controls={emojiOpen ? 'battle-emoji-picker' : undefined} onClick={() => setEmojiOpen(open => !open)}>☺</button>
        {emojiOpen && <div id="battle-emoji-picker" className="battle-emoji-picker" role="group" aria-label={t('表情', 'Emoji')}><Suspense fallback={<p role="status">{t('加载表情…', 'Loading emoji…')}</p>}><ChatEmojiPicker selection={emojiSelection} onSelectionChange={setEmojiSelection} onSelect={insertEmoji} remaining={300 - text.length + (input.current?.selectedLength() ?? 0)} /></Suspense></div>}
      </div><span>{text.length}/300</span><button className="battle-button battle-button-gold" type="submit" disabled={busy || !text.trim()}>{t('发送', 'Send')}</button></div>
    </form>
  </div>
}

function trackFinalReceipt(receipt: RoomSession, handNumber: number) {
  const expires = Date.now() + 5 * 60_000
  const poll = async () => {
    if (Date.now() > expires) return
    try {
      const { room } = await getRoom(receipt)
      saveBattleProfile(room)
      if (!room.hand || room.hand.number !== handNumber || room.hand.finished && room.settlementAt == null && room.hand.delta != null) return
    } catch (error) {
      if (error instanceof BattleApiError && error.finalRoom) saveBattleProfile(error.finalRoom)
      if (error instanceof BattleApiError && [401, 404, 410].includes(error.status)) return
    }
    window.setTimeout(() => void poll(), 2000)
  }
  window.setTimeout(() => void poll(), 2000)
}

export function Battle({ active = true, onRoomUpdate, onOpenAnalysis }: { active?: boolean; onRoomUpdate?: (room: RoomView | null) => void; onOpenAnalysis?: OpenAnalysis }) {
  const { t } = useLanguage()
  const now = useNow()
  const [session, setSession] = useState<RoomSession | null>(savedSession)
  const sessionRef = useRef(session); sessionRef.current = session
  const [room, setRoom] = useState<RoomView | null>(null)
  useEffect(() => { onRoomUpdate?.(room) }, [room, onRoomUpdate])
  const [mode, setMode] = useState<'create' | 'join'>(() => roomFromUrl() ? 'join' : 'create')
  const [nickname, setNickname] = useState(initialNickname)
  const [code, setCode] = useState(roomFromUrl)
  const [capacity, setCapacity] = useState(6)
  const [initialStack, setInitialStack] = useState(100)
  const [actionSeconds, setActionSeconds] = useState(30)
  const [roomMode, setRoomMode] = useState<'cash' | 'tournament'>('cash')
  const [blindIntervalMinutes, setBlindIntervalMinutes] = useState(10)
  const [registrationRaises, setRegistrationRaises] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connection, setConnection] = useState<'loading' | 'online' | 'retrying'>('loading')
  const visuals = useBattleVisuals(room, active && connection === 'online')
  const [copyStatus, setCopyStatus] = useState('')
  const [showInvite, setShowInvite] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'players' | 'history' | 'chat'>('history')
  const [statsId, setStatsId] = useState<string | null>(null)
  const [seatMenu, setSeatMenu] = useState<number | null>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const pageElement = useRef<HTMLElement>(null)
  const tableElement = useRef<HTMLDivElement>(null)
  const setupForm = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!active || session) return
    const form = setupForm.current
    const field = mode === 'join' && form?.querySelector<HTMLInputElement>('[name="nickname"]')?.value.trim() ? 'room' : 'nickname'
    form?.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || event.ctrlKey || event.metaKey || event.altKey || busyRef.current) return
      // Inputs and buttons retain native keyboard behavior; Enter also works on the page background.
      if (event.target instanceof Element && event.target.closest('button, input, select, textarea, summary, a, [contenteditable="true"], [role="dialog"]')) return
      event.preventDefault()
      form?.requestSubmit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, session, mode])
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 920)
  const [unreadChat, setUnreadChat] = useState(0)
  const lastChatId = useRef<string | null>(null)
  const [reviewRun, setReviewRun] = useState<number | null>(null)
  const [focusedWinner, setFocusedWinner] = useState<string | null>(null)
  useBattleChipLayout(tableElement, `${active}:${room?.instanceId}:${room?.revision}:${reviewRun}`)
  useEffect(() => { setReviewRun(null) }, [room?.hand?.number, room?.runoutPlayback?.boardIndex])
  useEffect(() => {
    lastChatId.current = room?.chat[room.chat.length - 1]?.id ?? null
    setUnreadChat(0)
  }, [room?.instanceId])
  useEffect(() => {
    if (!room) return
    const last = room.chat[room.chat.length - 1]?.id ?? null
    if (last !== lastChatId.current) {
      const index = room.chat.findIndex(message => message.id === lastChatId.current)
      const incoming = room.chat.slice(index + 1).filter(message => message.playerId !== room.selfId).length
      if (!active || !panelOpen || sidebarTab !== 'chat') setUnreadChat(count => count + incoming)
      lastChatId.current = last
    }
    if (active && panelOpen && sidebarTab === 'chat') setUnreadChat(0)
  }, [room, active, panelOpen, sidebarTab])
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 920px)')
    const changed = () => {
      setPanelOpen(!narrow.matches)
      if (!narrow.matches) setSidebarTab('history')
    }
    narrow.addEventListener('change', changed)
    return () => narrow.removeEventListener('change', changed)
  }, [])
  usePokerTableViewport(pageElement, active && !!room, `${room?.instanceId}:${panelOpen}`)
  const busyRef = useRef(false)
  const roomRef = useRef<RoomView | null>(null)
  const acceptRoom = (next: RoomView) => {
    if (!roomRef.current || roomRef.current.instanceId !== next.instanceId || next.revision >= roomRef.current.revision) {
      roomRef.current = next; saveBattleProfile(next); setRoom(next)
    }
  }
  const resetSession = (message = '') => { sessionRef.current = null; roomRef.current = null; saveSession(null); setSession(null); setRoom(null); setError(message); setConfirmLeave(false); setStatsId(null); setShowInvite(false); setShowMenu(false); setSeatMenu(null) }
  useEffect(() => {
    if (!session) return
    let stopped = false
    let timer: number | undefined
    const controller = new AbortController()
    async function poll() {
      try {
        const next = await getRoom(session!, controller.signal)
        if (stopped || sessionRef.current?.token !== session!.token) return
        acceptRoom(next.room); setConnection('online')
      } catch (failure) {
        if (stopped || sessionRef.current?.token !== session!.token) return
        if (failure instanceof BattleApiError && [401, 404, 410].includes(failure.status)) {
          if (failure.finalRoom) saveBattleProfile(failure.finalRoom)
          resetSession(failure.message); return
        }
        setConnection('retrying')
      }
      if (!stopped) timer = window.setTimeout(poll, 800)
    }
    void poll()
    return () => { stopped = true; controller.abort(); clearTimeout(timer) }
  }, [session, t])
  const connect = async (event: FormEvent) => {
    event.preventDefault()
    if (busyRef.current) return
    const name = nickname.trim()
    if (!name) { setError(t('请输入昵称。', 'Enter a nickname.')); return }
    if (mode === 'join' && !code.trim()) { setError(t('请输入房间码。', 'Enter a room code.')); return }
    busyRef.current = true; setBusy(true); setError('')
    try {
      const result = mode === 'create' ? await createRoom(name, capacity, initialStack, { actionSeconds, mode: roomMode, blindIntervalMinutes, registrationRaises }) : await joinRoom(code.trim().toUpperCase(), name)
      sessionRef.current = result.session; saveSession(result.session); setSession(result.session); acceptRoom(result.room); setConnection('online')
      try { localStorage.setItem('gto.battle.nickname', name) } catch { /* Optional preference. */ }
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('连接失败，请重试。', 'Connection failed. Try again.')) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const command: Command = async value => {
    if (!session || busyRef.current) return
    const token = session.token
    busyRef.current = true; setBusy(true); setError('')
    try {
      const result = await sendCommand(session, value)
      if (sessionRef.current?.token !== token) return
      if (result.left) {
        if (result.room) saveBattleProfile(result.room)
        if (result.receipt && result.room?.hand) trackFinalReceipt(result.receipt, result.room.hand.number)
        resetSession(); return
      }
      if (result.room) acceptRoom(result.room)
      setConnection('online')
    } catch (failure) {
      if (sessionRef.current?.token !== token) return
      if (failure instanceof BattleApiError && [401, 404, 410].includes(failure.status)) {
        if (failure.finalRoom) saveBattleProfile(failure.finalRoom)
        resetSession(failure.message)
      }
      else setError(failure instanceof Error ? failure.message : t('操作失败，请重试。', 'Action failed. Try again.'))
    } finally { busyRef.current = false; setBusy(false) }
  }
  const copyInvite = async () => { if (!room) return; setShowInvite(true); try { await navigator.clipboard.writeText(inviteLink(room.code)); setCopyStatus(t('邀请链接已复制', 'Invite link copied')) } catch { setCopyStatus(t('选中链接即可复制', 'Select the link to copy')) } }

  if (!session) return <section className="battle-page battle-setup">
    <div className="battle-setup-intro"><span className="battle-setup-suit" aria-hidden="true">♠</span><h2>{t('好友对战', 'Private Table')}</h2><p>{t('无限注德州扑克', 'No-limit Hold’em')}</p></div>
    <form ref={setupForm} className="battle-setup-card" onSubmit={event => void connect(event)} onKeyDown={event => {
      if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat)) event.preventDefault()
    }}>
      <div className="battle-mode-switch"><button type="button" aria-pressed={mode === 'create'} onClick={() => { setMode('create'); setError('') }}>{t('创建房间', 'Create room')}</button><button type="button" aria-pressed={mode === 'join'} onClick={() => { setMode('join'); setError('') }}>{t('加入房间', 'Join room')}</button></div>
      <label className="battle-field">{t('昵称', 'Nickname')}<input autoComplete="nickname" name="nickname" maxLength={16} value={nickname} onChange={event => setNickname(event.target.value)} required disabled={busy} placeholder={t('你在牌桌上的名字', 'Your name at the table')} /></label>
      {mode === 'create' ? <>
        <div className="battle-format-switch" role="group" aria-label={t('牌局类型', 'Game format')}>
          <button type="button" aria-pressed={roomMode === 'cash'} onClick={() => setRoomMode('cash')} disabled={busy}>{t('现金桌', 'Cash game')}</button>
          <button type="button" aria-pressed={roomMode === 'tournament'} onClick={() => setRoomMode('tournament')} disabled={busy}>{t('锦标赛', 'Tournament')}</button>
        </div>
        <div className="battle-setup-fields">
          <label className="battle-field">{t('座位数', 'Seats')}<select value={capacity} onChange={event => setCapacity(Number(event.target.value))} disabled={busy}>{Array.from({ length: 8 }, (_, i) => i + 2).map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          <label className="battle-field">{t('初始筹码', 'Starting stack')}<select value={initialStack} onChange={event => setInitialStack(Number(event.target.value))} disabled={busy}>{[50, 100, 200, 300, 500, 1000].map(stack => <option key={stack} value={stack}>{stack} BB</option>)}</select></label>
          <label className="battle-field">{t('行动时间', 'Action time')}<select value={actionSeconds} onChange={event => setActionSeconds(Number(event.target.value))} disabled={busy}>{[20, 30, 40, 50, 60, 0].map(seconds => <option key={seconds} value={seconds}>{seconds === 0 ? t('不限时', 'Unlimited') : `${seconds}s`}</option>)}</select></label>
          {roomMode === 'tournament' && <label className="battle-field">{t('升盲间隔（分钟）', 'Blind interval (minutes)')}<input type="number" min={1} max={60} step={1} value={blindIntervalMinutes} onChange={event => setBlindIntervalMinutes(Number(event.target.value))} disabled={busy} required /></label>}
          {roomMode === 'tournament' && <label className="battle-field battle-field-wide">{t('报名 / 重购截止', 'Entry / rebuy closes')}<select value={registrationRaises} onChange={event => setRegistrationRaises(Number(event.target.value))} disabled={busy}>{Array.from({ length: 11 }, (_, n) => <option key={n} value={n}>{n === 0 ? t('开赛时', 'At the start') : t(`升盲 ${n} 次后 · 第 ${n + 1} 级起`, `After ${n} blind increase${n > 1 ? 's' : ''} · Level ${n + 1}`)}</option>)}</select></label>}
        </div>
        {roomMode === 'tournament' && <p className="battle-tournament-setup-note">{registrationRaises === 0 ? t('开赛即截止报名和重购。升盲从下一手生效。', 'Entry and rebuys close at the start. Blind increases apply to the next hand.') : t(`开赛后 ${registrationRaises * blindIntervalMinutes} 分钟内可报名、重购；截止后淘汰制继续。`, `Late entry and rebuys are open for ${registrationRaises * blindIntervalMinutes} minutes. After that, play continues as a freezeout.`)}</p>}
      </> : <label className="battle-field">{t('房间码', 'Room code')}<input className="battle-code-input" autoComplete="off" name="room" maxLength={8} value={code} onChange={event => setCode(event.target.value.toUpperCase().replace(/\s/g, ''))} required disabled={busy} /></label>}
      {error && <div className="battle-error" role="alert">{error}</div>}
      <button className="battle-button battle-button-gold battle-connect" disabled={busy} type="submit">{busy ? t('正在连接…', 'Connecting…') : mode === 'create' ? t('创建房间', 'Create room') : t('加入房间', 'Join room')} <span aria-hidden="true">→</span></button>
    </form>
  </section>
  if (!room) return <section className="battle-page battle-loading"><span className="battle-loading-suit">♠</span><h2>{connection === 'retrying' ? t('正在重新连接…', 'Reconnecting…') : t('正在恢复房间…', 'Restoring room…')}</h2><p className="battle-muted">{t('房间', 'Room')} {session.code}</p><button className="battle-button battle-button-subtle" onClick={() => resetSession()}>{t('返回房间入口', 'Back')}</button></section>
  const host = room.hostId === room.selfId
  const tournament = room.mode === 'tournament' ? room.tournament : null
  const tournamentLocked = room.mode === 'tournament' && room.started
  const admissionOpen = !tournamentLocked || !!tournament?.registrationOpen
  const selfEntered = !!tournament?.entrantIds.includes(room.selfId)
  const registrationSeconds = tournament?.registrationClosesAt ? Math.max(0, Math.ceil((tournament.registrationClosesAt - now) / 1000)) : null
  const registrationClock = registrationSeconds === null ? '' : `${Math.floor(registrationSeconds / 60)}:${String(registrationSeconds % 60).padStart(2, '0')}`
  const unit = room.mode === 'tournament' ? t('筹码', 'chips') : 'BB'
  const levelSeconds = tournament?.nextLevelAt ? Math.max(0, Math.ceil((tournament.nextLevelAt - now) / 1000)) : null
  const levelClock = levelSeconds === null ? '' : `${Math.floor(levelSeconds / 60)}:${String(levelSeconds % 60).padStart(2, '0')}`
  const self = room.players.find(player => player.id === room.selfId)
  const disabled = busy || connection !== 'online'
  const activePlayers = room.players.filter(player => !player.leaving)
  const members = [...room.players].sort((a, b) => Number(!!a.leaving) - Number(!!b.leaving) || Number(a.seat === null) - Number(b.seat === null) || (a.seat ?? a.pendingSeat ?? room.capacity) - (b.seat ?? b.pendingSeat ?? room.capacity))
  const statsPlayer = statsId ? room.players.find(player => player.id === statsId) : seatMenu !== null ? playerAtSeat(room, seatMenu) : undefined
  const actualOccupant = seatMenu !== null ? room.players.find(player => player.id === room.seats[seatMenu]) : undefined
  const reservation = seatMenu !== null ? room.players.find(player => player.id === room.reservations[seatMenu]) : undefined
  const canSit = admissionOpen && !(tournamentLocked && selfEntered) && seatMenu !== null && !reservation && (!actualOccupant || !tournamentLocked && (actualOccupant.bot || actualOccupant.leaving))
  const canAddBot = admissionOpen && host && seatMenu !== null && !reservation && (!actualOccupant || !tournamentLocked && actualOccupant.pendingRemoval)
  const viewOrigin = self?.seat ?? 0
  const boards = room.hand?.boards?.length ? room.hand.boards : room.hand ? [room.hand.board] : []
  const boardIndex = room.runoutPlayback?.boardIndex ?? Math.min(reviewRun ?? boards.length - 1, Math.max(0, boards.length - 1))
  const displayBoard = boards[boardIndex] ?? room.hand?.board ?? []
  const winning = winningCards(room, boardIndex)
  const highlightedHand = winning.hands.find(hand => hand.playerId === focusedWinner) ?? winning.hands[0]
  const highlightedCards = new Set(highlightedHand?.cards ?? [])
  const runResult = room.settlementAt != null ? undefined : (room.runoutPlayback?.completedResults ?? room.hand?.runResults ?? []).find(result => result.run === boardIndex + 1)
  const resultSummary = battleResultSummary(room, t)
  const winnerIds = new Set(runResult ? [...runResult.winners, ...Object.keys(runResult.payouts).filter(id => runResult.payouts[id] > 0)] : room.hand?.finished && room.settlementAt == null ? room.hand.players.filter(player => room.hand!.showdown ? (room.hand!.delta?.[player.id] ?? -player.invested) + player.invested > 0 : !player.folded).map(player => player.id) : [])
  const mySeatLabel = self?.pendingSeat != null ? t(`已预约座位 ${self.pendingSeat + 1}`, `Seat ${self.pendingSeat + 1} reserved`) : self?.seat != null ? t(`座位 ${self.seat + 1}`, `Seat ${self.seat + 1}`) : t('观战中', 'Spectating')
  const actFromMenu = (value: RoomCommand) => { setSeatMenu(null); setStatsId(null); setShowMenu(false); void command(value) }
  const closePlayer = () => { setSeatMenu(null); setStatsId(null) }
  const seatActions = <div className="battle-seat-menu-actions">
    {canSit && <button className="battle-button battle-button-gold" disabled={disabled} onClick={() => actFromMenu({ type: 'sit', seat: seatMenu! })}>{room.hand && (!room.hand.finished || room.settlementAt != null) ? t('预约此座位', 'Reserve this seat') : t('在此入座', 'Sit here')}</button>}
    {canAddBot && <button className="battle-button battle-button-subtle" disabled={disabled} onClick={() => actFromMenu({ type: 'add-bot', seat: seatMenu! })}>{t('添加电脑', 'Add Bot')}</button>}
    {!tournamentLocked && host && statsPlayer?.bot && !statsPlayer.leaving && <button className="battle-button battle-button-subtle" disabled={disabled || statsPlayer.pendingRemoval} onClick={() => actFromMenu({ type: 'remove-bot', playerId: statsPlayer.id })}>{statsPlayer.pendingRemoval ? t('下手移除', 'Removal queued') : statsPlayer.seat === null ? t('取消添加', 'Cancel addition') : t('移除电脑', 'Remove Bot')}</button>}
    {!tournamentLocked && host && reservation?.bot && reservation.id !== statsPlayer?.id && <button className="battle-button battle-button-subtle" disabled={disabled} onClick={() => actFromMenu({ type: 'remove-bot', playerId: reservation.id })}>{t('取消待加入的电脑', 'Cancel queued Bot')}</button>}
    {room.mode !== 'tournament' && statsPlayer?.id === room.selfId && (self?.seat !== null || self?.pendingSeat !== null) && <button className="battle-button battle-button-subtle" disabled={disabled} onClick={() => actFromMenu({ type: 'stand' })}><BattleStandIcon />{t('站起观战', 'Stand up')}</button>}
    {statsPlayer?.id === room.selfId && self?.seat != null && !self.leaving && !['eliminated', 'forfeited', 'winner'].includes(self.tournamentStatus ?? '') && <button className="battle-button battle-button-subtle" disabled={disabled} onClick={() => actFromMenu({ type: 'away', away: self.awayUntil == null })}>{self.awayUntil != null ? t('取消暂离', 'Return to table') : room.mode === 'tournament' ? t('暂离', 'Go away') : t('暂离 3 分钟', 'Away for 3 minutes')}</button>}
  </div>
  const sharing = <BattleSpectatorSharing room={room} busy={disabled} onCommand={command} />
  return <section ref={pageElement} className="battle-page battle-in-room">
    <header className="battle-room-header">
      <div className="battle-room-identity"><span className={`battle-live-dot ${connection !== 'online' ? 'is-offline' : ''}`} role="status" aria-label={connection === 'online' ? t('已连接', 'Connected') : t('重连中', 'Reconnecting')} /><h2>{room.code}</h2>{tournament && <span className="battle-format-label">{t('锦标赛', 'Tournament')}</span>}<span className="battle-room-count">{room.seats.filter(Boolean).length}/{room.capacity}<span> · {t(`${activePlayers.filter(player => !player.bot && (player.seat === null || player.sittingOut)).length} 观战`, `${activePlayers.filter(player => !player.bot && (player.seat === null || player.sittingOut)).length} watching`)}</span></span></div>
      <div className="battle-header-actions">
        <button className="battle-text-button" onClick={() => setShowRules(true)}>{t('规则介绍', 'Rules')}</button>
        <button className="battle-button battle-button-subtle" onClick={() => void copyInvite()}>{t('邀请好友', 'Invite')}</button>
        <button className="battle-button battle-danger" onClick={() => setConfirmLeave(true)}>{t('退出房间', 'Leave room')}</button>
        <button className="battle-more" aria-label={t('房间设置', 'Room settings')} onClick={() => setShowMenu(true)}>•••</button>
      </div>
    </header>
    {error && <div className="battle-error" role="alert"><span>{error}</span><button className="battle-close" aria-label={t('关闭提示', 'Dismiss error')} onClick={() => setError('')}>×</button></div>}
    {connection !== 'online' && <div className="battle-notice" role="status">{t('正在重连，行动计时仍在继续。', 'Reconnecting. The action timer is still running.')}</div>}
    <div className={`battle-room-grid ${panelOpen ? 'battle-panel-open' : ''}`}>
      <div className="battle-main-column">
        <div className="battle-table-panel">
          <div className="battle-hand-meta"><span>{room.hand ? t(`第 ${room.hand.number} 手`, `Hand ${room.hand.number}`) : t('等待开始', 'Waiting to start')}<i />{room.hand ? room.settlementAt != null ? t('结算中', 'Settling') : room.hand.finished ? t('已结束', 'Finished') : translated(streets, room.hand.street, t) : t(`${room.initialStack} ${unit} 起始筹码`, `${room.initialStack} ${unit} starting stack`)}</span>{tournament && <span className="battle-blind-clock" title={t('升盲从下一手生效', 'Blinds increase from the next hand')}>L{tournament.level} · {bb(tournament.smallBlind)}/{bb(tournament.bigBlind)}{levelSeconds !== null && <b>{levelSeconds ? `${levelClock} ↑` : t('下手升盲', 'Next hand ↑')}</b>}</span>}</div>
          {tournament && <div className={`battle-registration ${tournament.registrationOpen ? 'is-open' : ''}`}><span>{!room.started ? t('延迟报名 / 重购期', 'Late entry / rebuy period') : tournament.registrationOpen ? t('报名 / 重购开放中', 'Entry / rebuys open') : t('报名 / 重购已截止', 'Entry / rebuys closed')}</span><b>{!room.started ? tournament.registrationRaises === 0 ? t('开赛时截止', 'Closes at start') : t(`开赛后 ${tournament.registrationRaises * tournament.blindIntervalMinutes}:00 截止`, `Closes ${tournament.registrationRaises * tournament.blindIntervalMinutes}:00 after start`) : tournament.registrationOpen ? t(`${registrationClock} 后截止`, `Closes in ${registrationClock}`) : t(`第 ${tournament.registrationRaises + 1} 级起`, `From level ${tournament.registrationRaises + 1}`)}</b></div>}
          <div ref={tableElement} className={`battle-table ${room.capacity > 6 ? 'battle-table-full' : ''}`} aria-label={t('对战牌桌', 'Poker table')}>
            <div className="battle-felt" /><BattleAtmosphere room={room} active={active} />
            <TableChatBubbles room={room} active={active && connection === 'online'} />
            <div className={`battle-table-center ${room.runoutPlayback ? 'battle-running-board' : ''}`}>
              {room.hand ? <><div className="battle-pot"><span>{t('底池', 'Pot')}</span><strong><span key={`${room.hand.number}:${room.hand.pot}`} className={visuals?.potValues.has(room.hand.pot) ? 'battle-pot-motion' : undefined}>{bb(room.hand.pot)}</span> <small>{unit}</small></strong></div>{room.hand.runCount > 1 && <div className="battle-run-tabs" aria-label={t('发牌轮次', 'Runouts')}>{Array.from({ length: room.hand.runCount }, (_, index) => <button key={index} disabled={!!room.runoutPlayback || index >= boards.length} aria-pressed={boardIndex === index} onClick={() => setReviewRun(index)}>{t(`第 ${index + 1} 次`, `Run ${index + 1}`)}</button>)}</div>}<div className="battle-board-row"><div className={`battle-board ${highlightedHand ? 'has-winning-hand' : ''}`}>{Array.from({ length: 5 }, (_, index) => displayBoard[index] !== undefined ? <span key={`${room.instanceId}:${room.hand?.number}:${boardIndex}:${index}:${displayBoard[index]}`} className={`battle-board-motion ${highlightedCards.has(displayBoard[index]) ? 'is-winning-card' : ''} ${reviewRun === null && visuals?.boardKeys.has(`${boardIndex}:${index}:${displayBoard[index]}`) ? 'is-revealed' : ''}`} style={{ '--board-delay': `${index < 3 ? index * 65 : 0}ms` } as CSSProperties}><CardFace card={displayBoard[index]} size="lg" /></span> : <span key={index} className="battle-board-empty" />)}</div></div></> : null}
            </div>
            <PokerPayoutEffect capacity={room.capacity} players={[...(room.hand?.players ?? []), ...room.players]} viewOrigin={viewOrigin} award={reviewRun === null && room.settlementAt == null ? visuals?.award ?? null : null} />
            {Array.from({ length: room.capacity }, (_, seat) => <BattleSeat key={seat} room={room} seat={seat} viewSeat={(seat - viewOrigin + room.capacity) % room.capacity} player={playerAtSeat(room, seat)} showdownBoard={room.hand?.finished || room.settlementAt != null || runResult ? displayBoard : null} visuals={visuals} winner={winnerIds.has(playerAtSeat(room, seat)?.id ?? '')} winningHole={highlightedHand?.playerId === playerAtSeat(room, seat)?.id ? highlightedCards : undefined} onFocusWinner={setFocusedWinner} busy={disabled} onCommand={command} onOpen={() => { setSeatMenu(seat); setStatsId(null) }} />)}
          </div>
          <div className="battle-table-footer"><span className="battle-my-seat">{mySeatLabel}</span>{room.mode !== 'tournament' && self?.pendingSeat != null && <button className="battle-cancel-reservation" disabled={disabled} onClick={() => void command({ type: 'cancel-seat' })}>{t('取消预约', 'Cancel reservation')}</button>}<span className="battle-table-format">{tournament ? t('锦标赛', 'Tournament') : t('现金桌', 'Cash game')} · {(room.handActionSeconds ?? room.actionSeconds ?? 30) === 0 ? t('不限时', 'Unlimited') : `${room.handActionSeconds ?? room.actionSeconds ?? 30}s`}</span></div>
        </div>
        {admissionOpen && host && room.capacity < 9 && room.seatRequests.length > 0 && <div className="battle-notice"><span>{t(`${room.seatRequests.length} 位玩家申请增加席位`, `${room.seatRequests.length} players requested another seat`)}</span><button className="battle-button battle-button-subtle" disabled={disabled} onClick={() => void command({ type: 'add-seat' })}>{t('增加座位', 'Add seat')}</button></div>}
        <BattleActions room={room} busy={disabled} onCommand={command} resultSummary={resultSummary} />
      </div>
      {panelOpen && <aside id="battle-room-panel" className="battle-sidebar"><div className="battle-sidebar-panel">
        <div className="battle-sidebar-tabs" role="tablist" aria-label={t('房间面板', 'Room panels')}>{(['history', 'players', 'chat'] as const).map(tab => <button role="tab" aria-selected={sidebarTab === tab} key={tab} className={sidebarTab === tab ? 'selected' : ''} onClick={() => setSidebarTab(tab)}>{tab === 'players' ? t('房间玩家', 'Players') : tab === 'history' ? t('记录', 'Records') : t('聊天', 'Chat')}{tab === 'chat' && unreadChat > 0 && <b className="battle-unread-badge">{unreadChat}</b>}</button>)}<button className="battle-panel-close" aria-label={t('收起面板', 'Collapse panel')} onClick={() => setPanelOpen(false)}>×</button></div>
        <div className="battle-sidebar-content" role="tabpanel">{sidebarTab === 'history' ? <BattleHandLog room={room} active={active} onOpenAnalysis={onOpenAnalysis} /> : sidebarTab === 'chat' ? <RoomChat room={room} busy={disabled} onCommand={command} /> : <div className="battle-room-players"><div className="battle-sidebar-title"><span>{t(`${members.length} 位玩家`, `${members.length} players`)}</span><span>{tournament ? t('筹码', 'Chips') : t('净赢 / BB', 'Net / BB')}</span></div><div className="battle-score-list">{members.map(player => <button type="button" className={`battle-score-row ${player.id === room.selfId ? 'battle-score-self' : ''} ${player.leaving ? 'battle-member-left' : ''}`} key={player.id} onClick={() => { setStatsId(player.id); setSeatMenu(null) }}><div className="battle-score-name"><strong title={playerDisplayName(player, t)}>{playerDisplayName(player, t)}{player.id === room.selfId ? t(' · 你', ' · You') : ''}</strong><span className={`battle-member-state ${player.leaving ? 'is-left' : player.seat !== null ? 'is-seated' : 'is-watching'}`}>{memberStatus(player, t)}</span></div><strong className={player.score > 0 ? 'battle-positive' : player.score < 0 ? 'battle-negative' : ''}>{tournament ? bb(player.stack) : signed(player.score)}</strong></button>)}</div></div>}</div>
      </div></aside>}
    </div>
    {!panelOpen && <nav className="battle-panel-bar" aria-label={t('打开房间面板', 'Open room panel')}>{(['history', 'players', 'chat'] as const).map(tab => <button key={tab} aria-expanded={panelOpen && sidebarTab === tab} aria-controls="battle-room-panel" onClick={() => { setSidebarTab(tab); setPanelOpen(open => sidebarTab === tab ? !open : true) }}>{tab === 'history' ? t('记录', 'Records') : tab === 'players' ? t('房间玩家', 'Players') : t('聊天', 'Chat')}{tab === 'chat' && unreadChat > 0 && <b className="battle-unread-badge">{unreadChat > 99 ? '99+' : unreadChat}</b>}<span aria-hidden="true">{panelOpen && sidebarTab === tab ? '⌄' : '⌃'}</span></button>)}</nav>}
    {showRules && <BattleRules onClose={() => setShowRules(false)} />}
    {showInvite && <BattleDialog title={t('邀请好友', 'Invite friends')} onClose={() => setShowInvite(false)}><p className="battle-dialog-caption">{t('分享链接或房间码，即可加入房间。', 'Share the link or room code to join the room.')}</p><div className="battle-invite-code">{room.code}</div><label className="battle-field">{t('邀请链接', 'Invite link')}<input readOnly value={inviteLink(room.code)} onFocus={event => event.currentTarget.select()} /></label><button className="battle-button battle-button-gold battle-connect" onClick={() => void copyInvite()}>{copyStatus || t('复制链接', 'Copy link')}</button></BattleDialog>}
    {(seatMenu !== null || statsPlayer) && <BattleDialog title={statsPlayer ? playerDisplayName(statsPlayer, t) : t(`座位 ${seatMenu! + 1}`, `Seat ${seatMenu! + 1}`)} onClose={closePlayer}>
      {statsPlayer && <p className="battle-dialog-caption">{memberStatus(statsPlayer, t)}{statsPlayer.id === room.hostId ? t(' · 房主', ' · Host') : ''}</p>}
      {seatActions}
      {reservation && reservation.id !== statsPlayer?.id && <p className="battle-dialog-caption">{t('已预约：', 'Reserved by: ')}{playerDisplayName(reservation, t)}</p>}
      {seatMenu !== null && room.hand && (!room.hand.finished || room.settlementAt != null) && (canSit || canAddBot || statsPlayer?.bot) && <p className="battle-dialog-caption">{t('座位调整在本手结束后生效。', 'Seat changes take effect after this hand.')}</p>}
      {statsPlayer?.id === room.selfId && sharing}
      {statsPlayer && winning.hands.find(hand => hand.playerId === statsPlayer.id) && <div className="battle-winning-detail"><strong>{t('获胜五张牌', 'Winning five cards')}</strong><div>{winning.hands.find(hand => hand.playerId === statsPlayer.id)!.cards.map(card => <CardFace key={card} card={card} />)}</div></div>}
      {statsPlayer && <BattleStats stats={statsPlayer.stats} stack={statsPlayer.stack} stackUnit={unit} />}
    </BattleDialog>}
    {showMenu && <BattleDialog title={t('房间设置', 'Room settings')} onClose={() => setShowMenu(false)}>
      <BattleRoomSettings room={room} busy={disabled} onCommand={command} onClose={() => setShowMenu(false)} />
    </BattleDialog>}
    {confirmLeave && <BattleDialog title={t('退出房间？', 'Leave this room?')} onClose={() => setConfirmLeave(false)}><p className="battle-dialog-caption">{tournamentLocked && (self?.tournamentStatus === 'active' || self?.tournamentStatus === 'rebuy') ? t('本手仍正常结算；若比赛尚未结束，你将弃赛，不能重新参赛。', 'This hand still settles normally. If the tournament continues, you forfeit and cannot re-enter.') : t('用同一昵称回来可继续本场数据。最后一位真人离开后，房间关闭。', 'Rejoin with the same nickname to continue. The room closes when the last human leaves.')}</p><div className="battle-dialog-buttons"><button className="battle-button battle-button-subtle" disabled={busy} onClick={() => setConfirmLeave(false)}>{t('取消', 'Cancel')}</button><button className="battle-button battle-danger" disabled={busy} onClick={() => void command({ type: 'leave' })}>{t('退出房间', 'Leave room')}</button></div></BattleDialog>}
  </section>
}
