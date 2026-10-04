import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { BattleAction, RoomCommand, RoomView } from '../battle/types'
import { useLanguage } from '../battle/i18n'
import { playerDisplayName, type BattleResultSummary } from '../battle/presentation'
import { canPostBlind, canRebuy, canShowCards, showCardsCommand } from '../battle/actionAvailability'
import { CardFace } from './CardFace'
import { PokerHoleCard } from './PokerHoleCard'
import { useBattlePreAction } from './useBattlePreAction'
import { holeCardOrder } from '../poker/holeCardOrder'
import { ActionLabel, DecisionDock } from './PokerDecisionDock'

type Command = (command: RoomCommand) => Promise<void>
const bb = (value: number) => Number(value.toFixed(2)).toLocaleString('en-GB')
const signed = (value: number) => `${value > 0 ? '+' : ''}${bb(value)}`

function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** Amounts remain visible; only the final action button commits a bet. */
export function BattleActions({ room, busy, onCommand, resultSummary }: { room: RoomView; busy: boolean; onCommand: Command; resultSummary?: BattleResultSummary | null }) {
  const { t } = useLanguage()
  const now = useNow()
  const editorId = useId()
  const preAction = useBattlePreAction(room, busy, onCommand)
  const hand = room.hand
  const unit = room.mode === 'tournament' ? t('筹码', 'chips') : 'BB'
  const legal = hand?.legal
  const myTurn = !!hand && !hand.finished && hand.toAct === room.selfId && !!legal
  const min = legal?.minRaiseTo ?? 0
  const max = legal?.maxRaiseTo ?? 0
  const [raiseTo, setRaiseTo] = useState(String(min))
  const latest = useRef({ room, busy })
  latest.current = { room, busy }

  useEffect(() => {
    setRaiseTo(String(min))
  }, [min, hand?.number, hand?.street, hand?.toAct])


  const selfPlayer = room.players.find(player => player.id === room.selfId)
  const rebuyAvailable = canRebuy(room, now)
  const rebuy = rebuyAvailable && <div className="ba-rebuy">
    <span>{room.mode === 'tournament' ? t('筹码已用完 · 等待重购', 'Out of chips · Rebuy available') : t('筹码已用完 · 正在观战', 'Out of chips · Spectating')}</span>
    <button type="button" className="ba-action ba-action-primary ba-rebuy-button" disabled={busy} onClick={() => {
      if (!latest.current.busy && canRebuy(latest.current.room, Date.now())) void onCommand({ type: 'rebuy' })
    }}>{t(room.mode === 'tournament' ? '重购' : '补码', 'Rebuy')} <strong>{bb(room.initialStack)} <small>{unit}</small></strong></button>
  </div>
  const entryNotice = room.mode !== 'tournament' && selfPlayer && !selfPlayer.leaving && selfPlayer.stack > 0
    && (selfPlayer.seat !== null || selfPlayer.pendingSeat !== null) && selfPlayer.entryStatus !== 'ready' && <div className="ba-entry-notice">
      <span>{selfPlayer.entryStatus === 'post' ? t('下一手入场时支付 1 BB', 'Posting 1 BB when your next hand is dealt') : t('等待大盲，或支付盲注加入下一手', 'Wait for your big blind, or post to join next hand')}</span>
      {selfPlayer.entryStatus === 'waiting' && <button type="button" className="ba-action ba-entry-button" disabled={busy || !canPostBlind(room)} onClick={() => {
        if (!latest.current.busy && canPostBlind(latest.current.room)) void onCommand({ type: 'post-blind' })
      }}>{t('支付 1 BB', 'Post 1 BB')}</button>}
    </div>

  if (!hand) {
    const host = room.hostId === room.selfId
    const canStart = host && (room.mode !== 'tournament' || room.tournament?.status === 'waiting')
    const readyCount = room.players.filter(player => player.seat !== null && !player.sittingOut && !player.leaving && player.stack > 0).length
    const emptySeats = room.seats.filter((id, seat) => !id && !room.reservations[seat]).length
    return <DecisionDock active={false} className="ba-idle ba-lobby" label={t('开局准备', 'Table setup')}>
      <div className="ba-lobby-copy">
        <strong>{readyCount < 2 ? t('等待玩家入座', 'Waiting for players') : t('准备就绪', 'Ready to play')}</strong>
      </div>
      <div className="ba-dock-body">
        {rebuy || entryNotice}
        {canStart && <div className="ba-lobby-actions">
          <button type="button" className="ba-action ba-action-primary" disabled={busy || readyCount < 2} onClick={() => void onCommand({ type: 'start' })}><ActionLabel>{t('开始对战', 'Start game')}</ActionLabel></button>
          {!room.started && emptySeats > 0 && <button type="button" className="ba-action ba-action-fold" disabled={busy} onClick={() => void onCommand({ type: 'fill-bots' })}><ActionLabel>{t(`空位补齐电脑（${emptySeats}）`, `Fill ${emptySeats} seats with bots`)}</ActionLabel></button>}
        </div>}
      </div>
    </DecisionDock>
  }

  const currentPlayer = room.players.find(player => player.id === hand.toAct)
  const self = hand.players.find(player => player.id === room.selfId)
  const seconds = room.actionDeadline !== null ? Math.max(0, Math.ceil((room.actionDeadline - now) / 1000)) : null
  const play = (action: BattleAction) => onCommand({ type: 'action', action, handNumber: hand.number, revision: room.actionRevision })

  const runResult = room.runoutPlayback?.phase === 'settling' || room.runoutPlayback?.phase === 'result'
  if (hand.finished || runResult) {
    const shown = room.revealed[room.selfId] ?? []
    const delta = hand.delta?.[room.selfId]
    const settling = room.settlementAt != null
    const reveal = (cards: number[]) => {
      const current = latest.current
      if (current.busy) return
      const command = showCardsCommand(current.room, room.instanceId, hand.number, cards, Date.now())
      if (command) void onCommand(command)
    }
    const visibleSummary = !settling ? resultSummary : null
    return <DecisionDock active={false} className={`ba-result${visibleSummary ? ' ba-result-has-detail' : ''}`} label={t('本手结果', 'Hand result')}>
      <div className="ba-result-top">
        <div className="ba-result-summary">
          <span>{runResult ? t(`第 ${room.runoutPlayback!.boardIndex + 1} 次发牌`, `Run ${room.runoutPlayback!.boardIndex + 1}`) : t('本手结束', 'Hand complete')}</span>
          {settling ? <strong className="ba-settling">{t('结算中', 'Settling')}</strong> : self && delta !== undefined && <strong className={delta > 0 ? 'ba-win' : delta < 0 ? 'ba-loss' : ''}>{signed(delta)} <small>{unit}</small></strong>}
        </div>
        <span className="ba-next-hand">{settling ? '' : runResult ? t('发牌结果展示中', 'Showing the run result') : room.tournament?.status === 'finished' ? t('锦标赛结束', 'Tournament complete') : room.nextHandAt !== null ? t('准备下一手', 'Preparing next hand') : room.tournament?.registrationOpen ? t('等待重购或新玩家', 'Waiting for rebuys or entrants') : t('等待玩家就绪', 'Waiting for players')}</span>
      </div>
      <div className="ba-dock-body ba-result-body">
        {visibleSummary && <div className="ba-payout-summary" title={`${visibleSummary.label}: ${visibleSummary.detail}`}>
          <span>{visibleSummary.label}</span><strong>{visibleSummary.detail}</strong>
        </div>}
        {canShowCards(room, now) && self && <div className={`ba-reveal${self.folded ? ' ba-cards-folded' : ''}`} role="group" aria-label={t('亮牌', 'Show cards')}>
          {holeCardOrder(self.cards).map(index => <button
            type="button"
            className={`ba-show-card${shown.includes(index) ? ' is-publicly-shown' : ''}`}
            key={index}
            aria-label={t(`公开第 ${index + 1} 张底牌`, `Show hole card ${index + 1}`)}
            disabled={busy || shown.includes(index)}
            onClick={() => reveal([index])}
          >
            {self.cards?.[index] != null && <CardFace card={self.cards[index]!} />}
            <span>{shown.includes(index) ? t('已亮', 'Shown') : t('亮这张', 'Show')}</span>
          </button>)}
          <button type="button" className="ba-show-both" aria-label={t('两张都亮', 'Show both')} disabled={busy} onClick={() => reveal([0, 1])}>
            <span className="ba-show-both-cards" aria-hidden="true">
              {holeCardOrder(self.cards).map((index, displayIndex) => <PokerHoleCard key={index} card={self.cards?.[index] ?? null} index={displayIndex} back={null} publiclyShown={shown.includes(index)} />)}
            </span>
            <span>{t('两张都亮', 'Show both')}</span>
          </button>
        </div>}
        {rebuy || entryNotice}
      </div>
    </DecisionDock>
  }

  if (room.runoutVote) {
    const vote = room.runoutVote
    const eligible = vote.eligibleIds.includes(room.selfId) && !room.isSpectator && !selfPlayer?.sittingOut
    const selected = vote.votes[room.selfId]
    const secondsLeft = Math.max(0, Math.ceil((vote.deadline - now) / 1000))
    return <DecisionDock active={eligible && !selected} className="ba-runout" label={t('选择发牌次数', 'Choose runouts')}>
      <div className="ba-status-row">
        <strong>{t('发几次公共牌？', 'How many runouts?')}</strong>
        <span className="ba-clock" aria-label={t(`剩余 ${secondsLeft} 秒`, `${secondsLeft} seconds remaining`)}>{secondsLeft}<small>s</small></span>
      </div>
      <div className="ba-dock-body">
        {eligible ? <div className="ba-runout-choices">{([1, 2, 3] as const).map(count => <button
          type="button"
          className={`ba-action ${selected === count ? 'ba-action-primary' : ''}`}
          key={count}
          disabled={busy || selected !== undefined}
          aria-pressed={selected === count}
          onClick={() => void onCommand({ type: 'runouts', count, handNumber: hand.number })}
        >{t(`发 ${count} 次`, `Run ${count}×`)}{selected === count && <span aria-hidden="true">✓</span>}</button>)}</div> : rebuy || entryNotice || <p className="ba-note">{t('等待参战玩家选择', 'Waiting for the players to choose')}</p>}
        <p className="ba-note">{t('按最低次数发牌；未选择则发 1 次。', 'Lowest choice wins. No choice means one runout.')}</p>
      </div>
    </DecisionDock>
  }

  if (!myTurn || !legal || preAction.selected && busy) {
    const label = myTurn && preAction.selected && busy ? t('等待执行预选', 'Preselection pending') : room.isSpectator || !self ? t('观战中', 'Spectating') : self.folded ? t('你已弃牌', 'You folded') : self.allin ? t('你已全下', 'You are all-in') : currentPlayer ? t(`等待 ${playerDisplayName(currentPlayer, t)}`, `Waiting for ${playerDisplayName(currentPlayer, t)}`) : t('发牌中', 'Dealing')
    if (!rebuy && !entryNotice && (preAction.canSelect || preAction.selected)) return <DecisionDock active={false} className="ba-decision ba-preselection" label={t('预选操作', 'Preselect action')}>
      <div className="ba-status-row">
        <span className="ba-idle-label" title={label}>{label}</span>
        {seconds !== null && <span className="ba-idle-clock">{seconds}s</span>}
      </div>
      <div className="ba-preselect-copy">
        <span className="ba-preselect-heading">{t('预选操作', 'Preselect')}</span>
        <span className="ba-preselect-note">{t('轮到你时执行', 'On your turn')}</span>
      </div>
      <div className="ba-actions ba-preselect-choices" role="group" aria-label={t('预选操作，轮到你时执行', 'Preselect an action for your turn')}>
        {preAction.actions.map(action => <button type="button" key={action} className={`ba-action ba-action-${action === 'fold' ? 'fold' : 'call'} ba-preselect-button${preAction.selected === action ? ' is-selected' : ''}`} disabled={!preAction.canSelect} aria-pressed={preAction.selected === action} title={action === 'check' ? t('若有人下注或加注，使你需要跟注，预选会立即取消。', 'If a bet or raise leaves you facing a call, this preselection is cancelled immediately.') : undefined} onClick={() => preAction.toggle(action)}>
          <ActionLabel>{preAction.selected === action && <span aria-hidden="true">✓</span>}{action === 'fold' ? t('弃牌', 'Fold') : t('过牌', 'Check')}</ActionLabel>
        </button>)}
      </div>
    </DecisionDock>
    return <DecisionDock active={false} className="ba-idle" label={t('牌局状态', 'Hand status')}>
      <div className="ba-idle-head"><span className="ba-idle-label" title={label}>{label}</span>
        {room.canFastForward
          ? <button type="button" className="ba-text-button ba-fast-forward" disabled={busy} onClick={() => void onCommand({ type: 'fast-forward' })}>{t('加速结束', 'Fast-forward')} <span aria-hidden="true">»</span></button>
          : seconds !== null && <span className="ba-idle-clock">{seconds}s</span>}
      </div>
      <div className="ba-dock-body">
        {rebuy || entryNotice || <div className="ba-waiting-context">
          <dl className="ba-waiting-facts">
            <div><dt>{self && !room.isSpectator ? t('剩余筹码', 'Your stack') : t('底池', 'Pot')}</dt><dd>{bb(self && !room.isSpectator ? self.stack : hand.pot)} <small>{unit}</small></dd></div>
            <div><dt>{self && !room.isSpectator ? t('本轮投入', 'This round') : t('仍在本手', 'Still in hand')}</dt><dd>{self && !room.isSpectator ? <>{bb(self.streetBet)} <small>{unit}</small></> : hand.players.filter(player => !player.folded).length}</dd></div>
          </dl>
        </div>}
      </div>
    </DecisionDock>
  }

  const amount = Number(raiseTo)
  const validRaise = raiseTo.trim() !== '' && Number.isFinite(amount) && amount >= min && amount <= max && Math.abs(amount * 2 - Math.round(amount * 2)) < .0001
  const canRaise = legal.minRaiseTo !== null
  const opening = hand.street === 'preflop' && !hand.history.some(action => action.street === 'preflop' && ['raise', 'bet'].includes(action.kind))
  const potRaise = (fraction: number) => (self?.streetBet ?? 0) + legal.callAmount + (hand.pot + legal.callAmount) * fraction
  const presets = opening
    ? [2, 3, 4, 5].map(multiple => { const value = multiple * (hand.bigBlind ?? 1); return { label: `${multiple} BB`, value, disabled: value < min || value > max } })
    : hand.street !== 'preflop'
      ? [1 / 3, 1 / 2, 3 / 4, 1].map((fraction, index) => ({ label: ['⅓', '½', '¾', t('满池', 'Pot')][index], value: potRaise(fraction), disabled: false }))
      : [{ label: t('最小', 'Min'), value: min, disabled: false }, { label: '½', value: potRaise(.5), disabled: false }, { label: t('满池', 'Pot'), value: potRaise(1), disabled: false }]
  presets.push({ label: t('全下', 'All-in'), value: max, disabled: false })
  const isBet = hand.street !== 'preflop' && legal.canCheck && !(self?.streetBet)
  const submitRaise = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && validRaise) void play({ kind: 'raise', to: amount })
  }

  return <DecisionDock active className="ba-decision" label={t('轮到你行动', 'Your turn')}>
    <div className="ba-status-row">
      <strong className="ba-your-turn"><span aria-hidden="true" />{t('轮到你', 'Your turn')}</strong>
      <div className="ba-timing">
        {room.actionDeadline !== null && <button
          type="button"
          className="ba-time-card"
          disabled={busy || !selfPlayer?.timeCards}
          onClick={() => void onCommand({ type: 'time-card', handNumber: hand.number })}
          title={t('使用一张加时卡，增加 30 秒', 'Use a time card to add 30 seconds')}
          aria-label={t(`加时 30 秒，剩余 ${selfPlayer?.timeCards ?? 0} 张`, `Add 30 seconds, ${selfPlayer?.timeCards ?? 0} time cards remaining`)}
        >+30s <span>×{selfPlayer?.timeCards ?? 0}</span></button>}
        {room.actionDeadline === null && <span className="ba-idle-clock">{t('不限时', 'Unlimited')}</span>}
        {seconds !== null && <span className={`ba-clock ${seconds <= 10 ? 'ba-clock-urgent' : ''}`} aria-label={t(`剩余 ${seconds} 秒`, `${seconds} seconds remaining`)}>{seconds}<small>s</small></span>}
      </div>
    </div>

    {canRaise && <form id={editorId} className="ba-raise-editor" onSubmit={submitRaise}>
      <div className="ba-amount-row">
        <label htmlFor={`${editorId}-amount`}>{isBet ? t('下注金额', 'Bet amount') : t('加注至', 'Raise to')}</label>
        <div className="ba-amount-field">
          <input
            id={`${editorId}-amount`}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step="0.5"
            value={raiseTo}
            aria-invalid={!validRaise}
            aria-describedby={!validRaise ? `${editorId}-error` : undefined}
            onChange={event => setRaiseTo(event.target.value)}
            onFocus={event => event.target.select()}
            disabled={busy}
          /><span>{unit}</span>
        </div>
      </div>
      <div className="ba-presets" aria-label={t('快捷下注金额', 'Bet sizes')}>{presets.map(preset => {
        const value = Math.min(max, Math.max(min, Math.round(preset.value * 2) / 2))
        return <button type="button" key={preset.label} disabled={busy || preset.disabled} className={validRaise && amount === value && !preset.disabled ? 'ba-preset-selected' : ''} onClick={() => setRaiseTo(String(value))}>{preset.label}</button>
      })}</div>
      <input className="ba-raise-slider" aria-label={t('调整加注金额', 'Raise amount')} type="range" min={min} max={max} step="0.5" value={validRaise ? amount : min} onChange={event => setRaiseTo(event.target.value)} disabled={busy} />
      {!validRaise && <p id={`${editorId}-error`} className="ba-input-error">{t(`请输入 ${bb(min)}–${bb(max)} ${unit}，以 0.5 递增。`, `Enter ${bb(min)}–${bb(max)} ${unit} in 0.5 steps.`)}</p>}
    </form>}

    <div className="ba-actions">
      <button type="button" className="ba-action ba-action-fold" disabled={busy || !legal.canFold} onClick={() => void play({ kind: 'fold' })}><ActionLabel>{t('弃牌', 'Fold')}</ActionLabel></button>
      {legal.canCheck
        ? <button type="button" className="ba-action ba-action-call" disabled={busy} onClick={() => void play({ kind: 'check' })}><ActionLabel>{t('过牌', 'Check')}</ActionLabel></button>
        : <button type="button" className="ba-action ba-action-call" disabled={busy} onClick={() => void play({ kind: 'call' })}><ActionLabel><span>{legal.callAmount >= (self?.stack ?? Infinity) ? t('全下跟注', 'Call all-in') : t('跟注', 'Call')}</span><strong>{bb(legal.callAmount)} <small>{unit}</small></strong></ActionLabel></button>}
      {canRaise && <button type="submit" form={editorId} className="ba-action ba-action-primary" disabled={busy || !validRaise}>
        <ActionLabel><span>{amount === max ? t('全下', 'All-in') : isBet ? t('下注', 'Bet') : t('加注至', 'Raise to')}</span><strong>{validRaise ? bb(amount) : '—'} <small>{unit}</small></strong></ActionLabel>
      </button>}
    </div>
  </DecisionDock>
}
