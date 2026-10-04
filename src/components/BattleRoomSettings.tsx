import { useEffect, useState, type FormEvent } from 'react'
import type { RoomCommand, RoomView } from '../battle/types'
import { useLanguage } from '../battle/i18n'
import '../battle/room-settings.css'
import { PokerSettingSwitch } from './PokerSettingSwitch'

interface SettingsProps {
  room: RoomView
  busy: boolean
  onCommand: (command: RoomCommand) => Promise<void>
  onClose?: () => void
}

const chips = (value: number) => Number(value.toFixed(2)).toLocaleString('en-GB')
const ACTION_SECONDS = [0, 20, 30, 40, 50, 60]
const BUY_INS = [50, 100, 200, 300, 500, 1000]

export function BattleStandIcon() {
  return <svg className="brs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="4" r="2" /><path d="M8 8v7m0-5-4 3m4 2-3 6m3-6 4 6M15 7h6m-3-3 3 3-3 3" />
  </svg>
}

export function BattleSpectatorSharing({ room, busy, onCommand }: Omit<SettingsProps, 'onClose'>) {
  const { t } = useLanguage()
  const self = room.players.find(player => player.id === room.selfId)
  if (!self || room.mode === 'tournament') return null
  return <PokerSettingSwitch checked={self.shareWithSpectators} disabled={busy} onChange={show => void onCommand({ type: 'spectator-cards', show })}>
    {t('向观战者公开底牌', 'Share cards with spectators')}
  </PokerSettingSwitch>
}

/** Dialog content only; the caller owns the dialog and its dismissal. */
export function BattleRoomSettings({ room, busy, onCommand, onClose }: SettingsProps) {
  const { t } = useLanguage()
  const [now, setNow] = useState(Date.now)
  const [actionSeconds, setActionSeconds] = useState(room.actionSeconds ?? 30)
  const [initialStack, setInitialStack] = useState(room.initialStack)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => { setActionSeconds(room.actionSeconds ?? 30); setInitialStack(room.initialStack) }, [room.actionSeconds, room.initialStack])

  const self = room.players.find(player => player.id === room.selfId)
  const isTournament = room.mode === 'tournament'
  const tournament = room.tournament
  const registrationSeconds = tournament ? tournament.status === 'waiting'
    ? tournament.registrationRaises * tournament.blindIntervalMinutes * 60
    : Math.max(0, Math.ceil(((tournament.registrationClosesAt ?? now) - now) / 1000)) : 0
  const registrationClock = `${String(Math.floor(registrationSeconds / 60)).padStart(2, '0')}:${String(registrationSeconds % 60).padStart(2, '0')}`
  const registrationOpen = tournament?.status === 'waiting' || tournament?.status === 'running' && tournament.registrationOpen && registrationSeconds > 0
  const registrationDeadline = tournament?.status === 'waiting'
    ? registrationSeconds === 0 ? t('开赛时截止', 'At the start') : t(`开赛后 ${registrationClock} 截止`, `${registrationClock} after start`)
    : registrationOpen ? registrationClock : t('已截止', 'Closed')
  const host = room.hostId === room.selfId
  const canEdit = host && !isTournament
  const away = self?.awayUntil != null
  const awaySeconds = away ? Math.min(180, Math.max(0, Math.ceil((self!.awayUntil! - now) / 1000))) : 0
  const awayClock = `${Math.floor(awaySeconds / 60)}:${String(awaySeconds % 60).padStart(2, '0')}`
  const unit = isTournament ? t('筹码', 'chips') : 'BB'
  const turnTime = room.actionSeconds === 0 ? t('不限时', 'Unlimited') : `${room.actionSeconds ?? 30}s`
  const grantMinutes = Math.max(1, Math.ceil((room.nextTimeCardAt - now) / 60_000))
  const seatLabel = away ? t('暂离中', 'Away') : self?.pendingSeat != null ? t(`已预约座位 ${self.pendingSeat + 1}`, `Seat ${self.pendingSeat + 1} reserved`) : self?.seat != null ? t(`座位 ${self.seat + 1}`, `Seat ${self.seat + 1}`) : t('观战中', 'Spectating')
  const canBeAway = self && !self.leaving && self.seat !== null && !['eliminated', 'forfeited', 'winner'].includes(self.tournamentStatus ?? '')
  const admissionOpen = !isTournament || !room.started || !!tournament?.registrationOpen
  const changed = actionSeconds !== (room.actionSeconds ?? 30) || initialStack !== room.initialStack
  const stackOptions = [...new Set([...BUY_INS, room.initialStack])].sort((a, b) => a - b)
  const act = (command: RoomCommand, close = true) => {
    if (busy) return
    if (close) onClose?.()
    void onCommand(command)
  }
  const save = (event: FormEvent) => {
    event.preventDefault()
    if (canEdit && changed && !busy) act({ type: 'settings', actionSeconds, initialStack }, false)
  }

  return <div className="brs-settings">
    <dl className="brs-summary">
      <div><dt>{t('我的状态', 'My status')}</dt><dd>{seatLabel}</dd></div>
      <div><dt>{t('牌局类型', 'Game format')}</dt><dd>{isTournament ? t('锦标赛', 'Tournament') : t('现金桌', 'Cash game')}</dd></div>
      <div><dt>{t('席位数', 'Seats')}</dt><dd>{room.capacity}</dd></div>
      {!canEdit && <><div><dt>{isTournament ? t('初始筹码', 'Starting stack') : t('买入 / 补码', 'Buy-in / rebuy')}</dt><dd>{chips(room.initialStack)} {unit}</dd></div>
        <div><dt>{t('行动时间', 'Action time')}</dt><dd>{turnTime}</dd></div></>}
      {isTournament && tournament && <>
        <div><dt>{t('起始盲注', 'Starting blinds')}</dt><dd>0.5 / 1</dd></div>
        <div><dt>{t('当前盲注', 'Current blinds')}</dt><dd>{chips(tournament.smallBlind)} / {chips(tournament.bigBlind)} · L{tournament.level}</dd></div>
        <div><dt>{t('升盲间隔', 'Blind interval')}</dt><dd>{t(`${tournament.blindIntervalMinutes} 分钟`, `${tournament.blindIntervalMinutes} min`)}</dd></div>
        <div><dt>{t('报名 / 重购截止', 'Entry / rebuy closes')}</dt><dd>{registrationDeadline}</dd></div>
        <div><dt>{t('报名状态', 'Registration')}</dt><dd>{tournament.status === 'waiting' ? t('尚未开赛', 'Not started') : registrationOpen ? t('开放中', 'Open') : t('已截止', 'Closed')}</dd></div>
      </>}
      {room.actionSeconds !== 0 && <div><dt>{t('加时卡', 'Time cards')}</dt><dd>{self?.timeCards ?? 0}<small>{t(`${grantMinutes} 分钟后 +1`, `+1 in ${grantMinutes} min`)}</small></dd></div>}
    </dl>

    {canEdit && <form className="brs-edit" onSubmit={save}>
      <div className="brs-fields">
        <label>{t('行动时间', 'Action time')}<select value={actionSeconds} disabled={busy} onChange={event => setActionSeconds(Number(event.target.value))}>{ACTION_SECONDS.map(seconds => <option key={seconds} value={seconds}>{seconds === 0 ? t('不限时', 'Unlimited') : `${seconds}s`}</option>)}</select></label>
        <label>{t('买入 / 补码', 'Buy-in / rebuy')}<select value={initialStack} disabled={busy} onChange={event => setInitialStack(Number(event.target.value))}>{stackOptions.map(stack => <option key={stack} value={stack}>{chips(stack)} BB</option>)}</select></label>
      </div>
      <div className="brs-save-row"><p>{t('行动时间从下一手生效；买入量用于后续买入／补码。', 'Action time applies from the next hand; buy-in size applies to future buy-ins / rebuys.')}</p><button type="submit" className="battle-button battle-button-gold" disabled={busy || !changed}>{t('保存设置', 'Save settings')}</button></div>
    </form>}

    <BattleSpectatorSharing room={room} busy={busy} onCommand={onCommand} />
    <div className="brs-actions">
      {(away || canBeAway) && <button type="button" className="brs-action" disabled={busy} title={isTournament ? t('暂离期间自动弃牌，回来后继续参赛。', 'Hands are automatically folded while away. Return to continue playing.') : t('暂离期间自动弃牌，3 分钟后自动站起观战。', 'Hands are automatically folded while away. After 3 minutes you stand up to spectate.')} onClick={() => act({ type: 'away', away: !away }, false)}>
        <span>{away ? t('取消暂离', 'Return to table') : isTournament ? t('暂离', 'Go away') : t('暂离 3 分钟', 'Away for 3 minutes')}</span>
        {away && !isTournament ? <small>{awaySeconds > 0 ? awayClock : t('暂离中', 'Away')}</small> : <svg className="brs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>}
      </button>}
      {!isTournament && self?.pendingSeat != null && <button type="button" className="brs-action" disabled={busy} onClick={() => act({ type: 'cancel-seat' })}><span>{t('取消座位预约', 'Cancel seat reservation')}</span><span aria-hidden="true">×</span></button>}
      {!isTournament && self && (self.seat !== null || self.pendingSeat !== null) && <button type="button" className="brs-action" disabled={busy} onClick={() => act({ type: 'stand' })}><span>{t('站起观战', 'Stand up')}</span><BattleStandIcon /></button>}
      {admissionOpen && room.capacity < 9 && <button type="button" className="brs-action" disabled={busy || !host && room.seatRequests.includes(room.selfId)} onClick={() => act({ type: host ? 'add-seat' : 'request-seat' })}><span>{host ? t('增加座位', 'Add seat') : room.seatRequests.includes(room.selfId) ? t('已请求增加座位', 'Seat requested') : t('请求增加座位', 'Request another seat')}</span><small>{room.capacity} → {room.capacity + 1}</small></button>}
    </div>
  </div>
}
