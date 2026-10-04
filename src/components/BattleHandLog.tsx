import { useLayoutEffect, useRef, useState } from 'react'
import { useLanguage } from '../battle/i18n'
import { historySections } from '../battle/history'
import { bettingActionName, handPosition, playerDisplayName } from '../battle/presentation'
import type { RoomView } from '../battle/types'
import { CardFace } from './CardFace'

const chips = (value: number) => Number(value.toFixed(2)).toLocaleString('en-GB')
const signed = (value: number) => `${value > 0 ? '+' : ''}${chips(value)}`
const streetNames = { preflop: ['翻前', 'Preflop'], flop: ['翻牌', 'Flop'], turn: ['转牌', 'Turn'], river: ['河牌', 'River'] } as const

export function BattleHandLog({ room, active }: { room: RoomView; active: boolean }) {
  const { t } = useLanguage()
  const unit = room.mode === 'tournament' ? t('筹码', 'chips') : 'BB'
  const [selected, setSelected] = useState('current')
  const [following, setFollowing] = useState(true)
  const scroll = useRef<HTMLDivElement>(null)
  const archive = room.handHistory?.find(hand => String(hand.number) === selected)
  const hand = archive ?? room.hand
  const current = !archive
  const members = archive?.players ?? room.players
  const names = new Map(members.map(player => [player.id, playerDisplayName(player, t)]))
  const positions = new Map(archive ? archive.players.map(player => [player.id, player.position])
    : room.hand?.players.map(player => [player.id, handPosition(room.hand, player.id)]) ?? [])
  const history = (room.handHistory ?? []).filter(previous => previous.number !== room.hand?.number)
  const own = room.hand?.players.find(player => player.id === room.selfId)
  const ownCards = archive ? archive.myCards : own?.cards
  const participated = hand && (archive ? archive.players.some(player => player.id === room.selfId) : !!own)
  const finished = !!archive || !!room.hand?.finished
  const results = hand?.runResults ?? []
  const boardKey = hand?.boards.map(board => board.join(',')).join('|')
  const selectionKey = archive ? `archive:${archive.number}` : 'current'
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = current ? scroll.current.scrollHeight : 0
    setFollowing(current)
  }, [selectionKey, room.instanceId])
  useLayoutEffect(() => {
    if (active && current && following && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [active, current, following, hand?.number, hand?.history.length, boardKey, results.length, finished])

  return <div className="battle-log">
    <div className="battle-record-select"><label htmlFor="battle-record-hand">{t('手牌', 'Hand')}</label><select id="battle-record-hand" aria-label={t('选择手牌记录', 'Select hand record')} value={archive ? selected : 'current'} onChange={event => setSelected(event.target.value)}>
      <option value="current">{room.hand ? t(`本手 · 第 ${room.hand.number} 手`, `Current · Hand ${room.hand.number}`) : t('本手', 'Current hand')}</option>
      {history.map(previous => <option value={previous.number} key={previous.number}>{t(`第 ${previous.number} 手`, `Hand ${previous.number}`)} · {previous.players.some(player => player.id === room.selfId) ? `${signed(previous.delta[room.selfId] ?? 0)} ${unit}` : t('观战', 'Spectated')}</option>)}
    </select></div>
    {archive && <div className="battle-record-hero">
      <div><span>{t('你的底牌', 'Your cards')}{positions.get(room.selfId) && <small>{positions.get(room.selfId)}</small>}</span>
        <div className="battle-record-cards">{ownCards?.every(card => card !== null) ? ownCards.map((card, index) => <CardFace key={index} card={card!} />) : <span className="battle-muted">{participated ? t('此记录未保存底牌', 'Cards unavailable in this record') : t('本手未参与', 'Not dealt in')}</span>}</div>
      </div>
      {(archive.boards.length ? archive.boards : [archive.board]).map((board, index) => <div className="battle-record-summary-board" key={index}>
        <span>{t('公共牌', 'Board')}{archive.boards.length > 1 && <small>{t(`第 ${index + 1} 次`, `Run ${index + 1}`)}</small>}</span>
        <div className="battle-record-cards">{board.length ? board.map((card, cardIndex) => <CardFace key={cardIndex} card={card} />) : <span className="battle-muted">{t('未发公共牌', 'No board dealt')}</span>}</div>
      </div>)}
      {participated && <div className="battle-record-net"><span>{t('净盈亏', 'Net result')}</span><strong className={(hand.delta?.[room.selfId] ?? 0) < 0 ? 'battle-negative' : 'battle-positive'}>{signed(hand.delta?.[room.selfId] ?? 0)} <small>{unit}</small></strong></div>}
    </div>}
    <div className="battle-record-scroll" ref={scroll} onScroll={() => {
      const node = scroll.current
      if (current && node) setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 48)
    }}>
      {!hand ? <p className="battle-empty-note">{t('开局后，这里会按轮次记录每个行动。', 'Actions will appear here by street after the hand starts.')}</p> : <>
        <p className="battle-record-legend">{t('加注显示本轮总额；跟注显示本次投入。', 'Raises show the street total; calls show chips added.')}</p>
        {historySections(hand).map(section => <section className={`battle-history-street is-${section.street}`} key={section.street}>
          <header><h3>{t(streetNames[section.street][0], streetNames[section.street][1])}</h3>{section.street === 'preflop' && <span>{t('盲注', 'Blinds')} {chips(hand.smallBlind ?? .5)}/{chips(hand.bigBlind ?? 1)} {unit}</span>}</header>
          {section.boards.map(board => <div className="battle-record-board" key={board.run}>{hand.boards.length > 1 && <span>{t(`第 ${board.run} 次`, `Run ${board.run}`)}</span>}<div>{board.cards.map((card, i) => <span className={i === board.cards.length - 1 && section.street !== 'flop' ? 'is-new-card' : ''} key={i}><CardFace card={card} /></span>)}</div></div>)}
          {section.actions.length ? <ol>{section.actions.map(({ action, index }) => {
            const aggressive = ['raise', 'bet'].includes(action.kind)
            const label = bettingActionName(hand.history, index, t)
            return <li key={index} className={`${action.playerId === room.selfId ? 'is-self' : ''} ${aggressive ? 'is-aggressive' : ''} ${action.kind.includes('blind') ? 'is-blind' : ''}`}>
              <div className="battle-history-player"><strong title={names.get(action.playerId)}>{names.get(action.playerId) ?? t('已离桌玩家', 'Former player')}</strong>{action.playerId === room.selfId && <em>{t('你', 'You')}</em>}<small>{positions.get(action.playerId)}</small></div>
              <div className="battle-history-action"><span>{label}{aggressive && label !== t('下注', 'Bet') && action.amount > 0 ? t('至', ' to') : ''}</span>{action.amount > 0 && <strong>{chips(action.amount)} <small>{unit}</small></strong>}{action.allin && <em>{t('全下', 'All-in')}</em>}</div>
            </li>
          })}</ol> : <p className="battle-history-empty">{finished || room.hand?.awaitingRunout || room.runoutPlayback ? t('无后续下注行动', 'No further betting') : t('等待行动…', 'Waiting for action…')}</p>}
        </section>)}
        {finished && <div className="battle-record-results"><h3>{t('本手结算', 'Hand result')}</h3>
          {results.length ? results.map(result => <div key={result.run}><span>{results.length > 1 ? t(`第 ${result.run} 次获胜`, `Run ${result.run} awards`) : t('获胜', 'Winner')}</span>{result.winners.map(id => <strong key={id}>{names.get(id) ?? id}<small>+{chips(result.payouts[id] ?? 0)} {unit}</small></strong>)}</div>) : <p>{t('其余玩家弃牌，本手结束。', 'All other players folded. Hand complete.')}</p>}
          <div className="battle-record-deltas"><span>{t('玩家净盈亏', 'Player net results')}</span>{Object.entries(hand.delta ?? {}).map(([id, delta]) => <strong key={id}>{names.get(id) ?? id}<small className={delta < 0 ? 'battle-negative' : delta > 0 ? 'battle-positive' : ''}>{signed(delta)} {unit}</small></strong>)}</div>
        </div>}
      </>}
    </div>
    {current && hand && !following && <div className="battle-record-follow"><button className="battle-text-button" onClick={() => setFollowing(true)}>{t('回到最新行动 ↓', 'Jump to latest ↓')}</button></div>}
  </div>
}
