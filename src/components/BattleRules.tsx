import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../battle/i18n'
import { parseCard, type Card } from '../poker/cards'
import { CardFace } from './CardFace'
import '../battle/rules.css'

type Copy = [zh: string, en: string]
type GuideTab = 'rules' | 'hands' | 'terms'

const HAND_RANKS: { title: Copy; description: Copy; cards: Card[] }[] = [
  { title: ['皇家同花顺', 'Royal flush'], description: ['同花色的 A、K、Q、J、10，最高的同花顺。', 'A, K, Q, J and 10 of one suit: the highest straight flush.'], cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'] },
  { title: ['同花顺', 'Straight flush'], description: ['同花色的五张连续点数；比较最高牌。', 'Five consecutive ranks of one suit. The higher top card wins.'], cards: ['9h', '8h', '7h', '6h', '5h'] },
  { title: ['四条', 'Four of a kind'], description: ['四张相同点数；先比四条，再比第五张牌。', 'Four cards of one rank. Compare the four-card rank, then the kicker.'], cards: ['Qs', 'Qh', 'Qd', 'Qc', '2s'] },
  { title: ['葫芦', 'Full house'], description: ['三条加一对；先比三条，再比对子。', 'Three of a kind plus a pair. Compare the three-card rank, then the pair.'], cards: ['Jh', 'Jd', 'Js', '4c', '4h'] },
  { title: ['同花', 'Flush'], description: ['同花色五张牌；从最高牌起逐张比较。', 'Five cards of one suit. Compare their ranks from highest to lowest.'], cards: ['Ad', 'Jd', '8d', '5d', '2d'] },
  { title: ['顺子', 'Straight'], description: ['五张连续点数；比较最高牌。A2345 是最小顺子。', 'Five consecutive ranks. Compare the top card. A2345 is the lowest straight.'], cards: ['Ts', '9h', '8d', '7c', '6s'] },
  { title: ['三条', 'Three of a kind'], description: ['三张相同点数；先比三条，再依次比两张踢脚牌。', 'Three cards of one rank. Compare that rank, then the two kickers in order.'], cards: ['8s', '8h', '8d', 'Ks', '3c'] },
  { title: ['两对', 'Two pair'], description: ['两组对子；先比大对子，再比小对子，最后比踢脚牌。', 'Two pairs. Compare the higher pair, lower pair, then the kicker.'], cards: ['Ks', 'Kh', '5d', '5c', '2h'] },
  { title: ['一对', 'One pair'], description: ['两张相同点数；先比对子，再依次比三张踢脚牌。', 'Two cards of one rank. Compare the pair, then the three kickers in order.'], cards: ['As', 'Ah', 'Qd', '8c', '3s'] },
  { title: ['高牌', 'High card'], description: ['没有以上牌型；从最高牌起逐张比较五张牌。', 'None of the hands above. Compare the five cards from highest to lowest.'], cards: ['As', 'Jd', '8c', '5h', '2s'] },
].map(hand => ({
  title: hand.title as Copy,
  description: hand.description as Copy,
  cards: hand.cards.map(value => {
    const card = parseCard(value)
    if (card === null) throw new Error(`Invalid rules example card: ${value}`)
    return card
  }),
}))

const TABLE_RULES: { title: Copy; content: Copy }[] = [
  { title: ['一手牌如何进行', 'How a hand works'], content: ['每人两张底牌，公共牌依次发出翻牌三张、转牌一张、河牌一张。每轮可弃牌、过牌、跟注或下注/加注。只剩一人未弃牌时，该玩家直接获胜；多人摊牌时比较最佳五张牌。', 'Each player receives two hole cards. The board is dealt as three flop cards, one turn card and one river card. Each betting round offers fold, check, call or bet/raise. The last player who has not folded wins; at showdown, the best five-card hand wins.'] },
  { title: ['预选操作', 'Preselecting an action'], content: ['等待其他玩家行动时，可以预选弃牌；本轮投入已追平当前最高下注时，也可预选过牌。再次点击或选择取消预选即可撤销。若有人下注或加注，使你需要跟注，过牌选项会立即隐藏，已有的过牌预选也会取消，不会改成跟注或弃牌。有效预选轮到自己时只执行一次，本手结束后清除。', 'While waiting, you can preselect Fold. Check is also available when your street bet matches the current highest bet. Click the selected action again or choose Cancel preselect to undo it. If a bet or raise leaves you facing a call, Check disappears and any queued check is cancelled immediately; it never becomes a call or fold. A valid selection runs once on your turn and clears when the hand ends.'] },
  { title: ['现金桌与补码', 'Cash games and rebuys'], content: ['现金桌盲注固定为 0.5 / 1 BB，筹码逐手保留。真人输完后可按房间当前设置的买入量补码，也可观战；电脑输完自动补码。参与本手的玩家须等本手结算后再补码。补码不算盈利。', 'Cash-game blinds are fixed at 0.5 / 1 BB, and stacks carry over between hands. Busted humans can rebuy the currently configured amount or spectate; busted bots rebuy automatically. Players in the current hand must wait for settlement before rebuying. Rebuys are not winnings.'] },
  { title: ['房间设置', 'Room settings'], content: ['现金桌房主可在房间设置中修改行动时间和买入／补码量。行动时间从下一手生效，本手后续回合仍沿用本手开始时的设置；买入量用于后续买入／补码，不改变现有筹码。锦标赛的初始筹码、行动时间、升盲间隔和报名截止条件在建房时确定，之后可在设置中查看。', 'The cash-game host can change action time and buy-in / rebuy size in room settings. Action time changes apply from the next hand; all remaining turns in the current hand keep the setting from when it began. Buy-in size applies to future buy-ins / rebuys without changing existing stacks. Tournament starting stacks, action time, blind intervals and registration cutoff are chosen when creating the room and remain available to view in settings.'] },
  { title: ['锦标赛', 'Tournaments'], content: ['锦标赛不开放观战。报名开放且有空席时，加入房间即入座报名，从下一手参赛。默认每 10 分钟升盲，建房可设为 1–60 分钟；默认升盲 3 次后截止报名和重购，可设为 0–10 次，0 表示开赛即截止。截止前输光可按初始筹码重购，电脑自动重购；截止后不再接受新玩家或重购。最后一位有筹码的参赛者获胜。升盲从下一手生效，不改变筹码。加入后不能站起观战，开赛后不能换位。退出仍结算本手，比赛继续则记为弃赛；弃赛或淘汰后不能重新入场。被淘汰者看完本手结果后离开房间。', 'Tournaments have no spectators. While registration is open and a seat is free, joining the room registers and seats you for the next hand. Blinds rise every 10 minutes by default, adjustable from 1–60 minutes. Registration and rebuys close after 3 blind increases by default; choose 0–10, where 0 closes at the start. Before the cutoff, busted players may rebuy the starting stack and bots rebuy automatically. Afterward, new entries and rebuys are closed. The last funded entrant wins. Blind increases apply next hand without changing stacks. You cannot stand up to spectate, even before play starts, or move seats after it starts. A departing player’s current hand settles before any forfeit. Forfeited or eliminated players cannot re-enter; eliminated players leave after viewing their final hand result.'] },
  { title: ['行动时间与加时卡', 'Action clock and time cards'], content: ['建房可选每次行动 20、30、40、50、60 秒或不限时，默认 30 秒。入场获得 3 张加时卡，每张延长 30 秒；留在房间期间每小时再获得 1 张，可在自己的限时回合使用。首次超时自动过牌，不能过牌时弃牌；连续第二次超时会进入暂离并自动弃牌。手动完成一次行动或取消暂离会清除连续超时记录。不限时回合没有行动倒计时，也无需加时卡；发牌次数投票与下一手等待时间不变。', 'Choose 20, 30, 40, 50 or 60 seconds per action, or unlimited; the default is 30 seconds. Players start with 3 time cards, each adding 30 seconds, and gain one more per hour in the room. Use them during your own timed turn. A first timeout checks if possible, otherwise folds. A second consecutive timeout marks you away and folds. A successful manual action or returning from away clears the timeout count. Unlimited turns have no action countdown or need for time cards; runout voting and next-hand delays are unchanged.'] },
  { title: ['暂离与返回', 'Going away and returning'], content: ['入座后可在房间设置中暂离，并随时取消。暂离期间仍会发牌和交盲注，轮到自己时自动弃牌，包括本可过牌的情况；发牌次数投票自动选择 1 次。现金桌暂离满 3 分钟后自动站起观战，再参与需重新入座。锦标赛暂离不会站起，筹码继续承担盲注，直到取消暂离或被淘汰。', 'Seated players can mark themselves away in room settings and return at any time. While away, you are still dealt in and post blinds, but fold automatically on your turn, even when checking is possible. Runout votes default to once. At cash tables, being away for 3 minutes automatically stands you up to spectate; take a seat again to play. At tournaments, you remain seated and continue paying blinds until you return or are eliminated.'] },
  { title: ['入座与等待大盲', 'Taking a seat and entering play'], content: ['现金桌中途可进入观战，选择空位或替代电脑位；正在进行的一手不会加入。下一手起可等待自己的大盲，或选择补交 1 BB 提前参与。单挑重新开桌时，等待入场的玩家可直接作为大盲加入。', 'In cash games, join as a spectator and choose an empty seat or replace a bot. You cannot enter a hand already in progress. For later hands, wait for your big blind or post 1 BB to enter sooner. When restarting heads-up, the waiting player can enter as the big blind.'] },
  { title: ['结算、亮牌与下一手', 'Results, showing cards and the next hand'], content: ['每次胜负确定后先显示“结算中”并保留 2 秒，再发放筹码和显示获胜结果。未摊牌的玩家可在结算中或本手结果展示期间选择亮一张或两张底牌。结算后，未摊牌等待 3 秒；摊牌发 1 次等待 5 秒，跑 2 次等待 7 秒，跑 3 次等待 10 秒。等待从所有牌面及逐轮结果展示完毕、完成结算后开始，至少需要两名可参与的玩家才会自动下一手。参与摊牌的玩家公开底牌；电脑每手结束后自动亮牌。', 'Once a hand or run is decided, “Settling” is shown for 2 seconds before chips are awarded and winners appear. Players whose cards remain hidden may show one or both during settlement or the current hand’s result display. After settlement, the next-hand delay is 3 seconds without a showdown, 5 seconds after one showdown board, 7 seconds after two runs, or 10 seconds after three. The wait starts once all boards and run results have been shown and settlement is complete. At least two eligible players are needed for the next hand. Showdown participants reveal their cards; bots show after every hand.'] },
  { title: ['全下后发几次', 'Running the board more than once'], content: ['全下后无需继续下注、且公共牌未发完时，仍在牌局中的真人可选择发 1 / 2 / 3 次。取所有选择中的最低次数，15 秒未选择默认 1 次。已发公共牌保留，每个剩余牌面分别结算底池份额。', 'When an all-in leaves no further betting and the board is incomplete, humans still in the hand can choose 1, 2 or 3 runouts. The lowest choice applies; no choice within 15 seconds means 1. Existing board cards stay, and each runout awards its share of each pot.'] },
  { title: ['观战与底牌分享', 'Spectating and sharing hole cards'], content: ['观战仅限现金桌。玩家自行决定是否向观战者分享底牌，默认不分享。本手参赛者（包括已弃牌的玩家）不能借观战查看对手共享的底牌。锦标赛没有观战或底牌分享开关。房间内可通过聊天交流。', 'Spectating is available only at cash tables. Each player chooses whether to share hole cards with spectators; sharing is off by default. Participants in the current hand, including folded players, cannot use spectator sharing to see opponents’ cards. Tournaments have neither spectators nor a spectator-sharing switch. Room members can use chat.'] },
  { title: ['昵称与数据', 'Nicknames and statistics'], content: ['同一房间内昵称是唯一身份。现金桌离开的玩家以相同昵称再次入场可继承本场筹码和数据，新昵称是新记录。锦标赛仍在参赛的玩家可恢复连接，但退赛或淘汰后不能借相同昵称重新入场。所有真人明确离开后房间解散，本场数据清空。自己的对战统计保留在本浏览器的数据统计中。', 'Your nickname is your unique identity within a room. At cash tables, rejoining with a departed player’s nickname inherits that session’s chips and statistics; a new nickname starts a new record. Active tournament entrants can reconnect, but forfeited or eliminated players cannot re-enter with the same nickname. The room closes after all humans explicitly leave. Your own Private Table statistics remain in this browser’s Statistics page.'] },
]

const TERM_GROUPS: { title: Copy; items: { term: string; label: Copy; definition: Copy }[] }[] = [
  { title: ['位置与盲注', 'Positions and blinds'], items: [
    { term: 'SB', label: ['小盲', 'Small blind'], definition: ['通常在按钮左侧，发牌前交 0.5 BB；单挑时按钮位兼任小盲。', 'Usually left of the button, posting 0.5 BB before the deal. Heads-up, the button is also the small blind.'] },
    { term: 'BB', label: ['大盲', 'Big blind'], definition: ['小盲左侧，发牌前交 1 BB；BB 也表示以一个大盲为单位的筹码量。', 'Left of the small blind, posting 1 BB before the deal. BB also means a chip amount measured in big blinds.'] },
    { term: 'BTN / Button / D', label: ['按钮位／庄位', 'Dealer button'], definition: ['标记本手的名义庄位，并逐手移动。通常在翻后最后行动；单挑时按钮交小盲、翻前先行动，翻后由大盲先行动。', 'Marks the nominal dealer and moves each hand. Usually acts last postflop. Heads-up, the button posts the small blind and acts first preflop; the big blind acts first postflop.'] },
    { term: 'UTG', label: ['枪口位', 'Under the gun'], definition: ['多人桌中大盲左侧的位置，翻前第一个行动。人数减少时，一些位置名称会省略。', 'The seat left of the big blind at a multiway table, first to act preflop. Some position names disappear at shorter tables.'] },
    { term: 'UTG+1 / UTG+2', label: ['枪口后第一位／第二位', 'Seats after under the gun'], definition: ['依次位于 UTG 之后，翻前比 UTG 晚一位或两位行动；主要用于人数较多的牌桌。', 'The first and second seats after UTG, acting one and two places later preflop. Mainly used at fuller tables.'] },
    { term: 'LJ', label: ['低劫位', 'Lojack'], definition: ['按钮前三位、HJ 之前；六人桌中通常也就是 UTG。', 'Three seats before the button, immediately before the hijack. At a six-player table this is usually also UTG.'] },
    { term: 'HJ', label: ['劫位', 'Hijack'], definition: ['按钮前两位，位于 CO 之前，是较靠后的行动位置。', 'Two seats before the button, immediately before the cutoff: a later position.'] },
    { term: 'CO', label: ['关煞位', 'Cutoff'], definition: ['紧邻按钮之前的位置，翻后通常仅按钮比它更晚行动。', 'The seat immediately before the button; usually only the button acts later postflop.'] },
  ] },
  { title: ['行动与底池', 'Actions and pots'], items: [
    { term: 'Check / Call / Fold', label: ['过牌／跟注／弃牌', 'Basic actions'], definition: ['过牌是不加钱继续，仅在无需跟注时可用；跟注是补足所面对的下注；弃牌是放弃本手争夺底池。', 'Check adds no chips and is available when nothing is owed. Call matches the bet faced. Fold gives up the right to win this hand’s pots.'] },
    { term: 'Bet / Raise', label: ['下注／加注', 'Betting and raising'], definition: ['下注是在本轮无人下注时投入筹码；加注是提高已有下注。界面“加注到”表示本轮总下注额，不是额外增加的金额。', 'Bet puts chips in when the street has no bet yet; raise increases an existing bet. “Raise to” is your total bet for this street, not the extra amount added.'] },
    { term: 'Pot / Side pot', label: ['底池／边池', 'Main and side pots'], definition: ['底池是本手投入的筹码。多人投入不同时会产生边池；玩家只能争夺自己有投入资格的底池，不能赢取超出自己覆盖额度的部分。', 'The pot contains chips committed to the hand. Unequal all-in contributions create side pots. A player can win only pots their contribution makes them eligible for.'] },
    { term: 'All-in', label: ['全下', 'All-in'], definition: ['投入当前剩余全部筹码。金额不足时只能覆盖相应部分；对手未被跟注的多余下注会退回。', 'Commit all remaining chips. A short stack covers only the corresponding amount; an opponent’s uncalled excess is returned.'] },
    { term: 'Showdown / Kicker', label: ['摊牌／踢脚牌', 'Showdown and kickers'], definition: ['摊牌比较最佳五张牌。主体牌型相同时，用五张牌中的其余牌依次分胜负，这些牌称为踢脚牌。', 'Showdown compares the best five cards. When the main combination ties, the remaining cards in that five-card hand break the tie; these are kickers.'] },
    { term: 'Preflop / Flop / Turn / River', label: ['翻前／翻牌／转牌／河牌', 'The four betting rounds'], definition: ['翻前尚无公共牌；翻牌有三张，转牌四张，河牌五张。', 'Preflop has no board cards; the flop has three, the turn four and the river five.'] },
  ] },
  { title: ['专业统计', 'Player statistics'], items: [
    { term: 'VPIP', label: ['自愿入池率', 'Voluntarily put money in pot'], definition: ['翻前自愿跟注或加注的手数 ÷ 发到牌的手数。单纯交盲注或入场补盲不计入。', 'Hands with a voluntary preflop call or raise ÷ hands dealt. Forced blinds and entry blinds do not count.'] },
    { term: 'PFR', label: ['翻前加注率', 'Preflop raise'], definition: ['翻前至少加注一次的手数 ÷ 发到牌的手数。', 'Hands with at least one preflop raise ÷ hands dealt.'] },
    { term: '3-bet', label: ['再加注', 'Three-bet'], definition: ['翻前对首次加注进行再加注，称为 3-bet。统计为此类再加注次数 ÷ 面对首次加注的行动机会，每手最多一次；不是所有手数作分母。', 'A preflop reraise over the first raise. The stat is such reraises ÷ decisions facing that first raise, at most once per hand; its denominator is opportunities, not all hands.'] },
    { term: 'C-bet', label: ['持续下注', 'Continuation bet'], definition: ['本桌统计翻牌 C-bet：翻前最后加注者，在无人先下注时首次行动选择下注 ÷ 此类机会。全下后没有行动机会不计分母。', 'This table tracks flop c-bets: the last preflop raiser bets on their first flop decision with no prior flop bet ÷ such opportunities. All-in runouts with no decision are excluded.'] },
    { term: 'AF', label: ['激进因子', 'Aggression factor'], definition: ['翻后下注与加注次数 ÷ 翻后跟注次数。没有跟注但有下注时为 ∞；两者都没有时显示 —。', 'Postflop bets and raises ÷ postflop calls. Aggression with no calls is ∞; no actions is —.'] },
    { term: 'WTSD', label: ['看翻牌后的摊牌率', 'Went to showdown'], definition: ['看过翻牌且未弃牌到摊牌的手数 ÷ 看过翻牌的手数，包括全下发牌。', 'Hands reaching showdown after seeing the flop ÷ hands seeing the flop, including all-in runouts.'] },
    { term: 'W$SD', label: ['摊牌获胜率', 'Won money at showdown'], definition: ['摊牌时获得任意底池份额的手数 ÷ 摊牌手数。平分和边池也算，不要求该手净盈利。', 'Showdowns receiving any pot share ÷ showdowns. Ties and side pots count, even when the hand has a net loss.'] },
  ] },
]

export function BattleRules({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage()
  const [tab, setTab] = useState<GuideTab>('rules')
  const id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const closeCallback = useRef(onClose)
  closeCallback.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    close.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeCallback.current(); return }
      if (event.key !== 'Tab') return
      const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), summary, [href], input, select, textarea, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0)
      const first = targets[0], last = targets[targets.length - 1]
      if (!first) return
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  const tabs: { id: GuideTab; label: string }[] = [
    { id: 'rules', label: t('牌局规则', 'Table rules') },
    { id: 'hands', label: t('牌型大小', 'Hand rankings') },
    { id: 'terms', label: t('术语解释', 'Poker terms') },
  ]
  const copy = (value: Copy) => t(value[0], value[1])

  return createPortal(<div className="battle-guide-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="battle-guide-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <header className="battle-guide-header">
        <h2 id={`${id}-title`}>{t('规则介绍', 'Table guide')}</h2>
        <button className="battle-guide-close" ref={close} onClick={onClose} aria-label={t('关闭规则介绍', 'Close table guide')}>×</button>
      </header>
      <div className="battle-guide-tabs" role="tablist" aria-label={t('指南内容', 'Guide sections')}>
        {tabs.map((item, index) => <button key={item.id} role="tab" id={`${id}-${item.id}-tab`} aria-selected={tab === item.id}
          aria-controls={`${id}-${item.id}-panel`} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => setTab(item.id)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
            if (next !== null) { event.preventDefault(); setTab(tabs[next].id); document.getElementById(`${id}-${tabs[next].id}-tab`)?.focus() }
          }}>{item.label}</button>)}
      </div>
      <div className="battle-guide-content" key={tab} id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`} tabIndex={0}>
        {tab === 'rules' && <div className="battle-guide-rule-grid">{TABLE_RULES.map((rule, index) => <details key={rule.title[1]} className="battle-guide-rule" open={index === 0}>
          <summary>{copy(rule.title)}<span aria-hidden="true">+</span></summary><p>{copy(rule.content)}</p>
        </details>)}</div>}
        {tab === 'hands' && <>
          <p className="battle-guide-intro">{t('由强到弱排列。用两张底牌与五张公共牌中的最佳五张组合，可使用 0、1 或 2 张底牌。T 表示 10。', 'Strongest to weakest. Make the best five-card hand from two hole cards and five board cards, using 0, 1 or 2 hole cards. T means 10.')}</p>
          <ol className="battle-guide-hands">{HAND_RANKS.map((hand, index) => <li key={hand.title[1]}>
            <span className="battle-guide-rank-number">{index + 1}</span>
            <div className="battle-guide-hand-copy"><h3>{copy(hand.title)}</h3><p>{copy(hand.description)}</p></div>
            <div className="battle-guide-card-row" role="img" aria-label={copy(hand.title)}>{hand.cards.map(card => <CardFace key={card} card={card} />)}</div>
          </li>)}</ol>
          <div className="battle-guide-note">{t('花色不分大小。双方最佳五张牌点数完全相同则平分；第六、第七张牌不参与比较。A 可作顺子的最高牌或最低牌，但不能跨越组成 QKA23 这样的顺子。', 'Suits have equal value. Identical best five-card ranks split the pot; sixth and seventh cards do not break ties. A can be the highest or lowest straight card, but straights cannot wrap around, such as QKA23.')}</div>
        </>}
        {tab === 'terms' && <div className="battle-guide-terms">{TERM_GROUPS.map(group => <section key={group.title[1]}>
          <h3>{copy(group.title)}</h3><dl>{group.items.map(item => <div key={item.term}><dt><b>{item.term}</b><span>{copy(item.label)}</span></dt><dd>{copy(item.definition)}</dd></div>)}</dl>
        </section>)}</div>}
      </div>
    </div>
  </div>, document.body)
}
