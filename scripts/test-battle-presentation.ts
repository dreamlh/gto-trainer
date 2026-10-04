import assert from 'node:assert/strict'
import { battleResultSummary, handPosition, playerDisplayName, playerActionLabel, playerShowdownLabel, bettingActionName } from '../src/battle/presentation'
import { historySections } from '../src/battle/history'
import { parseCard } from '../src/poker/cards'
import { act, handView, startHand } from '../src/battle/game'
import { emptyStats } from '../src/battle/stats'
import type { RoomMode, RunoutResult } from '../src/battle/types'

for (let size = 2; size <= 9; size++) {
  const ids = Array.from({ length: size }, (_, i) => `P${i}`)
  for (let dealer = 0; dealer < size; dealer++) {
    const view = handView(startHand(ids, dealer, 1), '')
    assert.equal(handPosition(view, view.dealerId), size === 2 ? 'BTN / SB' : 'BTN')
    assert.equal(handPosition(view, view.smallBlindId), size === 2 ? 'BTN / SB' : 'SB')
    assert.equal(handPosition(view, view.bigBlindId), 'BB')
    const labels = ids.map(id => handPosition(view, id))
    assert.equal(new Set(labels).size, size)
    assert(!labels.includes(null))
    assert.equal(handPosition(view, 'spectator'), null)
    view.players[0].folded = true
    assert.equal(handPosition(view, ids[0]), labels[0])
    if (size >= 6) assert.equal(handPosition(view, ids[(dealer + 3) % size]), 'UTG')
  }
}
const en = (_zh: string, english: string) => english
const zh = (chinese: string, _en: string) => chinese
assert.equal(playerDisplayName({ bot: true, name: '电脑 12' }, en), 'Bot 12')
assert.equal(playerDisplayName({ bot: true, name: 'Computer 12' }, zh), '电脑 12')
assert.equal(playerDisplayName({ bot: false, name: '电脑迷' }, en), '电脑迷')
assert.equal(handPosition(null, 'spectator'), null)
const labels = handView(startHand(['A', 'B', 'C'], 0, 1), 'A')
labels.history.push(
  { playerId: 'A', street: 'preflop', kind: 'raise', amount: 3 },
  { playerId: 'B', street: 'preflop', kind: 'raise', amount: 9 },
  { playerId: 'C', street: 'preflop', kind: 'call', amount: 9 },
)
assert.equal(playerActionLabel(labels, 'A', en), 'Raise 3')
assert.equal(playerActionLabel(labels, 'B', en), '3-bet 9')
assert.equal(playerActionLabel(labels, 'C', en), 'Call 9')
labels.history.push({ playerId: 'A', street: 'preflop', kind: 'raise', amount: 30 })
assert.equal(playerActionLabel(labels, 'A', en), '4-bet 30')
labels.street = 'flop'
assert.equal(playerActionLabel(labels, 'A', en), null)
labels.history.push({ playerId: 'A', street: 'flop', kind: 'check', amount: 0 }, { playerId: 'B', street: 'flop', kind: 'raise', amount: 15 })
assert.equal(playerActionLabel(labels, 'A', en), 'Check')
assert.equal(playerActionLabel(labels, 'B', en), 'Bet 15')
labels.history.push({ playerId: 'C', street: 'flop', kind: 'raise', amount: 40 }, { playerId: 'B', street: 'flop', kind: 'raise', amount: 70 })
labels.players.find(player => player.id === 'B')!.allin = true
assert.equal(playerActionLabel(labels, 'C', en), 'Raise 40')
assert.equal(playerActionLabel(labels, 'B', en), '3-bet 70 · All-in')
labels.history.push({ playerId: 'B', street: 'flop', kind: 'refund', amount: 30 })
assert.equal(playerActionLabel(labels, 'B', en), '3-bet 70 · All-in')
assert.equal(playerActionLabel(null, 'A', en), null)
console.log('Battle presentation: 44 dealer rotations, folded seats, bilingual Bot names and persistent betting-round action labels passed.')

const rankView = handView(startHand(['A', 'B'], 0, 1), 'A')
rankView.showdown = true
const rankingCases = [
  ['As Kd 7c 6h 4s 2d 9c', 'High card', '高牌'],
  ['As Ad 2c 4d 6h 8s Tc', 'One pair', '一对'],
  ['As Ad 2c 2d 6h 8s Tc', 'Two pair', '两对'],
  ['As Ad Ac 2d 6h 8s Tc', 'Three of a kind', '三条'],
  ['9s 8d 7c 6h 5s Kd Ac', 'Straight', '顺子'],
  ['As Js 8s 5s 2s Kd Qc', 'Flush', '同花'],
  ['As Ad Ac 2d 2h 8s Tc', 'Full house', '葫芦'],
  ['As Ad Ac Ah 2d 8s Tc', 'Four of a kind', '四条'],
  ['9s 8s 7s 6s 5s Kd Ac', 'Straight flush', '同花顺'],
  ['As Ks Qs Js Ts 2d 3c', 'Royal flush', '皇家同花顺'],
]
for (const [cards, english, chinese] of rankingCases) {
  const all = cards.split(' ').map(card => parseCard(card)!)
  rankView.players[0].cards = [all[0], all[1]]
  assert.equal(playerShowdownLabel(rankView, 'A', all.slice(2), en), english)
  assert.equal(playerShowdownLabel(rankView, 'A', all.slice(2), zh), chinese)
}
const royalBoard = ['Qs', 'Js', 'Ts', '2d', '3c'].map(card => parseCard(card)!)
assert.equal(playerShowdownLabel(rankView, 'A', null, en), null)
assert.equal(playerShowdownLabel(rankView, 'A', royalBoard.slice(0, 4), en), null)
rankView.showdown = false
assert.equal(playerShowdownLabel(rankView, 'A', royalBoard, en), null)
rankView.showdown = true
rankView.players[0].folded = true
assert.equal(playerShowdownLabel(rankView, 'A', royalBoard, en), null)
rankView.players[0].folded = false
rankView.players[0].cards = [parseCard('As')!, null]
assert.equal(playerShowdownLabel(rankView, 'A', royalBoard, en), null)
rankView.players[0].cards = [parseCard('As')!, parseCard('Ks')!]
assert.equal(playerShowdownLabel(rankView, 'A', ['Ac', 'Ad', '2s', '7d', '8c'].map(card => parseCard(card)!), en), 'Three of a kind')
assert.equal(playerShowdownLabel(rankView, 'A', royalBoard, en), 'Royal flush')
console.log('Showdown labels: all 10 categories, bilingual output, folded/hidden cards, incomplete runs and changing completed boards passed.')

const actionNames = labels.history.map((_, index) => bettingActionName(labels.history, index, en))
assert.deepEqual(actionNames.slice(2), ['Raise', '3-bet', 'Call', '4-bet', 'Check', 'Bet', 'Raise', '3-bet', 'Uncalled return'])
assert.equal(bettingActionName(labels.history, 3, zh), '3-bet')
const runout = { history: labels.history, board: [1, 2, 3, 4], boards: [[1, 2, 3, 4], [5, 6]] }
let sections = historySections(runout)
assert.deepEqual(sections.map(section => section.street), ['preflop', 'flop', 'turn'])
assert.deepEqual(sections[1].boards, [{ run: 1, cards: [1, 2, 3] }])
assert.deepEqual(sections[2].boards, [{ run: 1, cards: [1, 2, 3, 4] }])
runout.boards[1].push(7)
sections = historySections(runout)
assert.equal(sections[1].boards.length, 2)
assert.equal(sections[2].boards.length, 1, 'Do not invent unrevealed turn/river cards')
assert.equal(sections.flatMap(section => section.actions).length, labels.history.length)
const short = startHand(['A', 'B'], 0, 1, { stacks: { A: 100, B: 20 } })
act(short, 'A', { kind: 'raise', to: 100 })
act(short, 'B', { kind: 'call' })
assert.equal(short.history.find(action => action.kind === 'raise')!.allin, true)
assert.equal(short.history.find(action => action.kind === 'call')!.allin, true)
assert.equal(short.history.find(action => action.kind === 'call')!.amount, 19, 'Calls record chips paid, not raise-to totals')
assert(short.history.some(action => action.kind === 'refund'))
console.log('Hand history: street-local raise labels, revealed runout boards, exact call amounts and all-in markers preserved after refunds passed.')

type SummaryRoom = Parameters<typeof battleResultSummary>[0]
const summaryRuns: RunoutResult[] = [
  { run: 1, board: ['Qh', 'Jh', 'Th', '2c', '3d'].map(card => parseCard(card)!), winners: ['A', 'B'], payouts: { A: 40, B: 20 } },
  { run: 2, board: ['Ac', 'Ad', '6h', '7h', '8h'].map(card => parseCard(card)!), winners: ['A', 'C'], payouts: { A: 10, C: 50 } },
  { run: 3, board: ['4c', '5d', '9h', '9c', 'Qd'].map(card => parseCard(card)!), winners: ['B', 'C'], payouts: { B: 25.5, C: 34.5 } },
]
function summaryFixture(count: 1 | 2 | 3, mode: RoomMode = 'cash'): SummaryRoom {
  const hand = handView(startHand(['A', 'B', 'C'], 0, 12), 'A')
  hand.finished = true; hand.toAct = null; hand.legal = null; hand.showdown = true; hand.runCount = count
  hand.runResults = structuredClone(summaryRuns.slice(0, count))
  hand.boards = hand.runResults.map(result => [...result.board]); hand.board = hand.boards[0]
  hand.delta = count === 3 ? { A: -10, B: -14.5, C: 24.5 } : count === 2 ? { A: 10, B: -20, C: 10 } : { A: 20, B: 0, C: -20 }
  return {
    hand, mode, settlementAt: null, runoutPlayback: null, tournament: null,
    players: ['A', 'B', 'C'].map((id, seat) => ({ id, name: ['Alice', 'Bob', '电脑 3'][seat], bot: id === 'C', connected: true,
      seat, pendingSeat: null, stack: 1_000, score: 0, sittingOut: false, timeCards: 3, stats: emptyStats(), shareWithSpectators: false, entryStatus: 'ready' })),
  }
}

for (const count of [2, 3] as const) for (const mode of ['cash', 'tournament'] as const) for (const language of ['zh', 'en'] as const) {
  const translate = language === 'zh' ? zh : en
  const unit = mode === 'cash' ? 'BB' : language === 'zh' ? '筹码' : 'chips'
  const bot = language === 'zh' ? '电脑 3' : 'Bot 3'
  const view = summaryFixture(count, mode), finalDelta = view.hand!.delta
  const perRun = [`Alice +40 ${unit} · Bob +20 ${unit}`, `Alice +10 ${unit} · ${bot} +50 ${unit}`, `Bob +25.5 ${unit} · ${bot} +34.5 ${unit}`]
  view.hand!.finished = false; view.hand!.delta = null
  for (let index = 0; index < count; index++) {
    view.hand!.runResults = structuredClone(summaryRuns.slice(0, index + 1))
    view.runoutPlayback = { boardIndex: index, revealedCount: 5, phase: 'result', completedResults: structuredClone(view.hand!.runResults), nextRevealAt: 10_000 }
    assert.deepEqual(battleResultSummary(view, translate), {
      label: language === 'zh' ? `第 ${index + 1} 次获胜` : `Run ${index + 1} winner`, detail: perRun[index],
    }, 'Each playback result shows that run only, including the final completed run before payout publication')
  }
  assert.equal(view.runoutPlayback!.completedResults.length, count)
  view.runoutPlayback!.phase = 'dealing'
  assert.equal(battleResultSummary(view, translate), null, 'Dealing never shows a completed previous run as the current result')
  view.runoutPlayback!.phase = 'settling'; view.settlementAt = 12_000
  assert.equal(battleResultSummary(view, translate), null, 'The two-second pause hides the pending run winner')
  view.runoutPlayback = null; view.settlementAt = null; view.hand!.finished = true
  assert.equal(battleResultSummary(view, translate), null, 'Finished without the published delta is not a final aggregate')
  view.hand!.delta = finalDelta
  const expected = { label: language === 'zh' ? '合计获胜' : 'Total won', detail: count === 2
    ? `Alice +50 ${unit} · Bob +20 ${unit} · ${bot} +50 ${unit}`
    : `Alice +50 ${unit} · Bob +45.5 ${unit} · ${bot} +84.5 ${unit}` }
  assert.deepEqual(battleResultSummary(view, translate), expected, 'Final payout sums all runs and merges repeat recipients')
  assert(view.hand!.delta!.B < 0)
  assert(battleResultSummary(view, translate)!.detail.includes('Bob +'), 'A side/split-pot recipient remains listed even with a negative whole-hand net result')
  const unchanged = JSON.stringify(view)
  assert.deepEqual(battleResultSummary(view, translate), expected)
  assert.equal(JSON.stringify(view), unchanged, 'Presentation never mutates the published results')
  for (const board of view.hand!.boards) {
    view.hand!.board = [...board]
    assert.deepEqual(battleResultSummary(view, translate), expected, 'Changing the displayed/reviewed board cannot replace the whole-hand result')
  }
  view.settlementAt = 12_000
  assert.equal(battleResultSummary(view, translate), null, 'A settlement marker suppresses even an otherwise complete result')
}
for (const count of [2, 3] as const) {
  const view = summaryFixture(count)
  view.hand!.runResults!.forEach(result => { result.winners = ['A']; result.payouts = { A: 60 } })
  assert.deepEqual(battleResultSummary(view, en), { label: 'Total won', detail: `Alice +${count * 60} BB` }, 'One winner across several runs appears once with the total payout')
}
assert.deepEqual(battleResultSummary(summaryFixture(1), en), { label: 'Winner', detail: 'Alice +40 BB · Bob +20 BB' }, 'An ordinary single-board result retains its winner label')
{
  const view = summaryFixture(3, 'tournament')
  view.tournament = { status: 'finished', winnerId: 'C', startedAt: 1, registrationRaises: 3, registrationClosesAt: 10,
    registrationOpen: false, level: 4, smallBlind: 2, bigBlind: 4, nextLevelAt: null, blindIntervalMinutes: 10,
    entrantIds: ['A', 'B', 'C'], rankings: [] }
  assert.deepEqual(battleResultSummary(view, en), { label: 'Champion', detail: 'Bot 3' })
  assert.deepEqual(battleResultSummary(view, zh), { label: '冠军', detail: '电脑 3' }, 'The tournament champion keeps precedence over multi-run payout totals')
  view.settlementAt = 12_000
  assert.equal(battleResultSummary(view, en), null, 'The settlement guard also suppresses champion presentation')
  view.hand = null; view.settlementAt = null
  assert.equal(battleResultSummary(view, en), null)
}
console.log('Result summaries: 2/3-run transitions, repeated winners, side/split pots with negative net, settlement guards, reviewed boards, cash/tournament units and bilingual champions passed.')
