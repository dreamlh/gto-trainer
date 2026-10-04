import type { Language } from '../battle/types'
import { pot, type EngineState } from './engine'
import type { DecisionRecord } from './session'
import type { Leak } from '../stats/leaks'
import { actionName, positionName, translatePokerText } from '../poker/presentation'

const STREET_NAMES: Record<string, [string, string]> = {
  preflop: ['翻前', 'Preflop'], flop: ['翻牌', 'Flop'], turn: ['转牌', 'Turn'], river: ['河牌', 'River'],
}

export function trainerStreet(street: string, language: Language): string {
  return STREET_NAMES[street]?.[language === 'zh' ? 0 : 1] ?? street
}

export function trainerVerdict(verdict: DecisionRecord['verdict'], language: Language): string {
  return ({ optimal: ['✓ 最优', '✓ Optimal'], acceptable: ['~ 可接受', '~ Acceptable'], wrong: ['✗ 错误', '✗ Mistake'], unavailable: ['未评估', 'Not evaluated'] } as const)[verdict][language === 'zh' ? 0 : 1]
}

export function trainerAction(label: string, language: Language): string {
  const translated = actionName(label, language).replace(/(\d)\s*bb\b/gi, '$1 BB')
  // Historical trainer labels contain amounts but no unit; do not alter storage.
  return /^(?:Bet|Raise to|Call all-in|Call|All-in|下注|加注到|加注至|跟注|全下跟注|全下)\s+[\d.]+$/.test(translated) ? `${translated} BB` : translated
}

/** Engine history stores cumulative investment; present street-local raises and chips paid for calls. */
export function trainerHistoryActions(engine: EngineState) {
  const invested: number[] = Array.from({ length: engine.n }, (_, seat) => engine.positions[seat] === 'BB' ? 1 : engine.positions[seat] === 'SB' || engine.n === 2 && seat === 0 ? .5 : 0)
  let street = 'preflop'
  let bases = invested.map(() => 0)
  return engine.history.map(action => {
    if (action.street !== street) { street = action.street; bases = [...invested] }
    const amount = ['fold', 'check'].includes(action.kind) ? null : action.to - (action.kind === 'call' ? invested[action.seat] : bases[action.seat])
    if (amount !== null) invested[action.seat] = action.to
    return { ...action, amount, allin: !['fold', 'check'].includes(action.kind) && action.to >= engine.stack - .001 }
  })
}

/** Read engine state without changing seat identities, records or the solver. */
export function describeTrainerSpot(engine: EngineState, heroSeat: number, language: Language): string {
  const zh = language === 'zh'
  const hero = engine.players[heroSeat]
  const position = positionName(engine.positions[heroSeat], language)
  const maxBet = Math.max(...engine.players.map(player => player.invested - player.streetBase))
  const toCall = Math.max(0, maxBet - (hero.invested - hero.streetBase))
  const amount = Number(maxBet.toFixed(1))
  const aggressiveActions = engine.history.filter(action => action.street === engine.street && !['fold', 'check', 'call'].includes(action.kind))
  const raises = aggressiveActions.length
  const aggressor = aggressiveActions[raises - 1]
  const opponent = aggressor ? positionName(engine.positions[aggressor.seat], language) : (zh ? '对手' : 'opponent')
  let facing: string
  if (engine.street === 'preflop') {
    if (!raises) facing = zh ? '前面无人加注' : 'Unopened pot'
    else {
      const allIn = engine.players[aggressor.seat].allin
      const what = allIn ? (zh ? '全下' : 'all-in') : raises === 1 ? (zh ? '开局加注' : 'open') : `${raises + 1}-bet`
      facing = zh ? `面对 ${opponent} ${what}到 ${amount} BB` : `Facing ${opponent} ${what} to ${amount} BB`
    }
  } else if (!raises) {
    facing = toCall > 0 ? (zh ? `面对下注 ${amount} BB` : `Facing a bet of ${amount} BB`) : (zh ? '可以过牌或下注' : 'Check or bet')
  } else {
    const what = raises === 1 ? (zh ? '下注' : 'bet') : (zh ? '加注' : 'raise')
    facing = zh ? `面对 ${opponent} ${what}到 ${amount} BB` : `Facing ${opponent} ${what} to ${amount} BB`
  }
  const call = toCall > 0.001 ? (zh ? ` · 需跟 ${Number(toCall.toFixed(1))} BB` : ` · ${Number(toCall.toFixed(1))} BB to call`) : ''
  return `${zh ? '轮到你' : 'Your turn'}: ${position} · ${facing} · ${zh ? '底池' : 'Pot'} ${pot(engine).toFixed(1)} BB${call}`
}

/** Translate stored Chinese notes on read, including records created before i18n. */
export function trainerNote(note: string, language: Language): string {
  if (note.startsWith('多人底池：仅评估翻前决策')) return language === 'zh'
    ? '多人底池：仅评估翻前决策（本训练器暂不求解多人翻后策略）'
    : 'Multiway pot: only preflop decisions are scored. This trainer does not solve multiway postflop strategies.'
  if (language === 'zh') return note
  if (note.startsWith('翻前训练模式：')) return 'Preflop-only mode: the hand ends before the flop. Only preflop decisions are scored.'
  const forced = note.match(/^你在 (.+?) 面对 (\d+)-bet[：:]训练树在该局面只保留弃牌/)
  if (forced) return `At ${positionName(forced[1], language)}, you face a ${forced[2]}-bet. This training tree only allows a fold here (no cold calls or cold 4-bets), so your hand was folded automatically.`
  return translatePokerText(note, language)
}

export function trainerError(error: string, language: Language): string {
  if (language === 'zh') return error
  const solving = error.match(/^求解失败[：:]\s*(.*)$/s)
  if (solving) return `Solving failed: ${trainerError(solving[1], language)}`
  const worker = error.match(/^worker 错误[：:]\s*(.*)$/s)
  if (worker) return `Worker error: ${trainerError(worker[1], language)}`
  return translatePokerText(error
    .replace(/尚未转换为组合向量/g, 'Hand-combination ranges have not been initialized')
    .replace(/不支持(?:的)?人数[：:]?\s*(\d+)/g, 'Unsupported table size: $1'), language)
}

export function trainerLeak(leak: Leak, language: Language): { title: string; advice: string } {
  if (language === 'zh') return { title: leak.title, advice: leak.advice }
  const copy: Record<string, [string, string]> = {
    'too-loose': ['Playing too many hands preflop', 'Your voluntary entry rate exceeds the solver baseline. Review marginal offsuit aces and weak connected hands, particularly in early position.'],
    'too-tight': ['Playing too few hands preflop', 'Your voluntary entry rate is below the solver baseline. Review profitable opens and defenses, particularly on the button and in the big blind.'],
    'low-3bet': ['3-betting too rarely', 'Review missed value reraises and suitable blocker bluffs when facing an opening raise.'],
    'over-3bet': ['3-betting too often', 'Your reraise rate exceeds the solver baseline. Review speculative hands without useful blockers.'],
    'fold-to-3bet': ['Folding too much to 3-bets', 'Your fold rate after opening exceeds the solver baseline. Review calls with suited connectors and medium pairs.'],
    'btn-steal': ['Missing button steals', 'Review first-in button opens. Position can make a wider opening range profitable.'],
    'bb-overfold': ['Folding the big blind too often', 'Review your big-blind defense against opening raises, including suited and connected hands with suitable pot odds.'],
    'cbet-off': ['Continuation-bet frequency differs', `You continuation-bet too ${leak.user > leak.gto ? 'often' : 'rarely'} relative to the solver baseline. Review flop texture: dry and connected boards need different betting frequencies and sizes.`],
    'river-call': ['River calling frequency differs', `You call river bets too ${leak.user > leak.gto ? 'often' : 'rarely'} relative to the solver baseline. Review bluff-catching hands, blockers and the price offered.`],
  }
  const result = copy[leak.id]
  if (result) return { title: result[0], advice: result[1] }
  const position = positionName(leak.id.replace('pos-', ''), language)
  return { title: `Decision quality at ${position}`, advice: `Average EV loss per decision is ${leak.user.toFixed(2)} BB versus ${leak.gto.toFixed(2)} BB overall. Review ranges for this position.` }
}

export function trainerLeakComparison(leak: Leak, language: Language): string {
  const positionLeak = leak.id.startsWith('pos-')
  const value = (number: number) => positionLeak ? `${number.toFixed(2)} BB` : `${(number * 100).toFixed(0)}%`
  const count = language === 'zh' ? (positionLeak ? '次决策' : '次机会')
    : positionLeak ? (leak.n === 1 ? 'decision' : 'decisions') : (leak.n === 1 ? 'opportunity' : 'opportunities')
  return `${language === 'zh' ? '你' : 'You'} ${value(leak.user)} · GTO ${value(leak.gto)} · ${leak.n} ${count}`
}
