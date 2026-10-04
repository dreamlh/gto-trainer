import assert from 'node:assert/strict'
import { describeTrainerSpot, trainerAction, trainerError, trainerHistoryActions, trainerLeak, trainerLeakComparison, trainerNote, trainerStreet, trainerVerdict } from '../src/game/trainerPresentation'
import { advanceStreet, applyAction, newHand } from '../src/game/engine'
import type { DecisionRecord, HandRecord } from '../src/game/session'
import { computeStats } from '../src/stats/compute'
import type { Leak } from '../src/stats/leaks'

const noChinese = (text: string) => assert.equal(/\p{Script=Han}/u.test(text), false, text)
const actions = [
  ['弃牌', 'Fold'], ['过牌', 'Check'], ['跟注', 'Call'], ['下注 12.5', 'Bet 12.5 BB'],
  ['加注到 20', 'Raise to 20 BB'], ['全下', 'All-in'], ['3-bet 至 8bb', '3-bet to 8 BB'],
  ['全下跟注 94.2', 'Call all-in 94.2 BB'], ['加注至 20', 'Raise to 20 BB'], ['jam', 'All-in'], ['all-in', 'All-in'], ['加注到 100', 'Raise to 100 BB'],
] as const
for (const [label, expected] of actions) assert.equal(trainerAction(label, 'en'), expected)
assert.equal(trainerAction('加注到 20', 'zh'), '加注到 20 BB')
assert.equal(trainerAction('Bet 8 BB', 'en'), 'Bet 8 BB', 'Already translated units must not be duplicated')
for (const street of ['preflop', 'flop', 'turn', 'river']) noChinese(trainerStreet(street, 'en'))
for (const verdict of ['optimal', 'acceptable', 'wrong'] as const) noChinese(trainerVerdict(verdict, 'en'))

const notes = [
  '翻前训练模式：本手到翻牌为止，仅评估翻前决策',
  '多人底池：仅评估翻前决策（翻后 GTO 只在单挑底池有定义）',
  '你在 UTG1 面对 3-bet：训练树在该局面只保留弃牌（不含冷跟注/冷 4-bet），本手自动弃牌',
]
for (const note of notes) noChinese(trainerNote(note, 'en'))
assert.match(trainerNote(notes[0], 'en'), /before the flop/)
assert.match(trainerNote(notes[1], 'en'), /trainer does not solve multiway postflop/)
assert.match(trainerNote(notes[2], 'en'), /UTG\+1.*3-bet.*folded automatically/)
assert.equal(trainerNote(notes[2], 'zh'), notes[2], 'Switching back displays the stored Chinese note')
for (const error of [
  '翻前解加载失败（9 人桌）: HTTP 404',
  '求解失败：worker 错误: 路径越过终端',
  '求解失败：尚未转换为组合向量',
  '不支持人数 10', '不支持的人数: 1',
]) noChinese(trainerError(error, 'en'))
assert.match(trainerError('翻前解加载失败（9 人桌）: HTTP 404', 'en'), /9-player.*HTTP 404/)
assert.equal(trainerError('求解失败：worker 错误: 路径越过终端', 'en'), 'Solving failed: Worker error: The action path goes beyond a terminal node')

const engine = newHand(6)
const heroSeat = engine.positions.indexOf('BB')
const originalEngine = JSON.stringify(engine)
assert.match(describeTrainerSpot(engine, heroSeat, 'en'), /Your turn: BB.*Unopened pot.*Pot 1.5 BB/)
assert.equal(JSON.stringify(engine), originalEngine, 'Rendering the live table must not advance the hand')
applyAction(engine, 0, 'raise', 2.5)
assert.match(describeTrainerSpot(engine, heroSeat, 'en'), /Facing UTG open to 2.5 BB.*1.5 BB to call/)
applyAction(engine, 1, 'raise', 8)
assert.match(describeTrainerSpot(engine, heroSeat, 'en'), /Facing HJ 3-bet to 8 BB.*7 BB to call/)
applyAction(engine, 2, 'raise', 100)
assert.match(describeTrainerSpot(engine, heroSeat, 'en'), /Facing CO all-in to 100 BB/)
noChinese(describeTrainerSpot(engine, heroSeat, 'en'))
assert.match(describeTrainerSpot(engine, heroSeat, 'zh'), /轮到你.*全下到 100 BB/)
const headsUp = newHand(2)
headsUp.street = 'flop'
for (const player of headsUp.players) { player.invested = 3; player.streetBase = 3 }
assert.match(describeTrainerSpot(headsUp, 0, 'en'), /Check or bet/)
applyAction(headsUp, 1, 'bet', 8)
assert.match(describeTrainerSpot(headsUp, 0, 'en'), /Facing BB bet to 5 BB.*5 BB to call/, 'Postflop descriptions use this street’s amount, not cumulative invested chips')

const historyHand = newHand(2)
applyAction(historyHand, 0, 'raise', 3)
applyAction(historyHand, 1, 'call', 3)
advanceStreet(historyHand)
applyAction(historyHand, 0, 'bet', 8)
applyAction(historyHand, 1, 'call', 8)
advanceStreet(historyHand)
applyAction(historyHand, 0, 'check', 0)
applyAction(historyHand, 1, 'bet', 12)
applyAction(historyHand, 0, 'raise', 24)
const historyBefore = JSON.stringify(historyHand)
assert.deepEqual(trainerHistoryActions(historyHand).map(action => action.amount), [3, 2, 5, 5, null, 4, 16], 'Records must show street-local bet/raise targets and exact chips paid for calls')
assert.equal(JSON.stringify(historyHand), historyBefore, 'Rendering history must leave engine accounting unchanged')

const decisions: DecisionRecord[] = [
  { street: 'preflop', pos: 'BB', labels: ['弃牌', '跟注', '加注到 8'], kinds: ['fold', 'call', 'raise'], freqs: [.2, .5, .3], evs: [-1, 1, .8], chosen: 1, evLoss: 0, score: 100, verdict: 'optimal' },
  { street: 'flop', pos: 'BB', labels: ['过牌', '下注 3.5'], kinds: ['check', 'bet'], freqs: [.6, .4], evs: [1, .9], chosen: 1, evLoss: .1, score: 67, verdict: 'acceptable' },
]
const legacy: HandRecord = {
  id: '旧记录-unchanged', ts: 1234, tableSize: 6, heroSeat: 5, heroPos: 'BB', heroCards: [0, 1], board: [5, 6, 7],
  actions: [{ street: 'preflop', seat: 0, pos: 'UTG', kind: 'raise', to: 2.5 }, { street: 'preflop', seat: 5, pos: 'BB', kind: 'call', to: 2.5 }, { street: 'flop', seat: 5, pos: 'BB', kind: 'bet', to: 6 }],
  decisions, result: { deltaBB: null, heroFolded: false, wentToShowdown: false, multiwayCutoff: true, revealed: [], note: notes[1] },
}
const beforeRecord = JSON.stringify(legacy)
const beforeStats = computeStats([legacy])
for (const language of ['en', 'zh', 'en'] as const) {
  const visible = [trainerNote(legacy.result.note!, language), ...legacy.decisions.flatMap(decision => [trainerStreet(decision.street, language), trainerVerdict(decision.verdict, language), ...decision.labels.map(label => trainerAction(label, language))])].join(' / ')
  if (language === 'en') noChinese(visible)
  else assert.match(visible, /翻前.*最优.*弃牌/)
}
assert.equal(JSON.stringify(legacy), beforeRecord, 'Repeated language changes preserve IDs and every historical record field')
assert.deepEqual(computeStats([legacy]), beforeStats, 'Localizing historical labels must not alter training metrics')

const leak: Leak = { id: 'pos-UTG1', title: 'UTG1 位置决策质量偏低', advice: '旧的中文建议', user: .6, gto: .2, n: 25, severity: 10 }
noChinese(trainerLeak(leak, 'en').title)
noChinese(trainerLeak(leak, 'en').advice)
assert.match(trainerLeak(leak, 'en').title, /UTG\+1/)
assert.equal(trainerLeakComparison(leak, 'en'), 'You 0.60 BB · GTO 0.20 BB · 25 decisions', 'Position EV loss uses BB, not frequency percentages')
for (const id of ['too-loose', 'too-tight', 'low-3bet', 'over-3bet', 'fold-to-3bet', 'btn-steal', 'bb-overfold', 'cbet-off', 'river-call']) {
  const value = { ...leak, id }
  noChinese(trainerLeak(value, 'en').title)
  noChinese(trainerLeak(value, 'en').advice)
}
assert.match(trainerLeak({ ...leak, id: 'cbet-off' }, 'en').advice, /too often/)
assert.match(trainerLeak({ ...leak, id: 'river-call', user: .1 }, 'en').advice, /too rarely/)
console.log('Trainer localization: live spots, legacy labels/notes, nested errors, language round trips, unchanged records/statistics and leak units passed.')
