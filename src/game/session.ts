import { comboIndex, handIndexOf, type Card } from '../poker/cards'
import type { Position } from '../poker/ranges'
import { POSTFLOP_PRESETS, postflopOrder } from '../solver/config'
import { loadPreflop, type PreflopBundle } from '../solver/preflop/api'
import type { PfDecisionNode, PfNode } from '../solver/preflop/tree'
import { buildPostflopTree, type PostNode, type PostSpec } from '../solver/postflop/tree'
import { solveInWorker, type WorkerNode } from '../workers/workerClient'
import {
  advanceStreet,
  applyAction,
  newHand,
  pot,
  runOutBoard,
  settle,
  showdown,
  type EngineState,
  type GameStreet,
} from './engine'
import { RangeTracker } from './rangeTracker'

// 全牌局训练会话：翻前多人（solver 策略机器人），翻后单挑逐街重解

export type SessionPhase = 'idle' | 'hero-turn' | 'bot-thinking' | 'solving' | 'hand-done'

export interface DecisionRecord {
  street: GameStreet
  pos: Position
  labels: string[]
  kinds: string[]
  freqs: number[]
  evs: number[] | null // 低到达未存储节点为 null
  chosen: number
  evLoss: number
  score: number
  verdict: 'optimal' | 'acceptable' | 'wrong'
}

export interface HandResultInfo {
  deltaBB: number | null // multiway cutoff / 翻前模式结束为 null
  heroFolded: boolean
  wentToShowdown: boolean
  multiwayCutoff: boolean
  revealed: { seat: number; cards: [Card, Card] }[]
  note?: string
}

export interface HeroActionView {
  label: string
  kind: string
}

export interface SessionSnapshot {
  version: number
  phase: SessionPhase
  engine: EngineState | null
  heroSeat: number
  toActSeat: number
  heroActions: HeroActionView[]
  decisions: DecisionRecord[]
  lastDecision: DecisionRecord | null
  result: HandResultInfo | null
  solveProgress: { street: GameStreet; iter: number; total: number } | null
  error: string
  preflopOnly: boolean
  tableSize: number
}

const BOT_DELAY_MS = 550

// 牌局记录（Phase 6 落 IndexedDB；先提供内存缓冲与订阅口）
export interface HandRecord {
  id: string
  ts: number
  tableSize: number
  heroSeat: number
  heroPos: Position
  heroCards: [Card, Card]
  board: Card[]
  actions: { street: GameStreet; seat: number; pos: Position; kind: string; to: number }[]
  decisions: DecisionRecord[]
  result: HandResultInfo
}

type RecordListener = (r: HandRecord) => void
const recordListeners = new Set<RecordListener>()
export function onHandRecord(fn: RecordListener): () => void {
  recordListeners.add(fn)
  return () => recordListeners.delete(fn)
}

function labelOf(kind: string, to: number, street: GameStreet, streetBase: number): string {
  if (kind === 'fold') return '弃牌'
  if (kind === 'check') return '过牌'
  if (kind === 'call') return '跟注'
  const amt = street === 'preflop' ? to : to - streetBase
  void amt
  if (kind === 'bet') return `下注 ${to}`
  if (kind === 'raise') return street === 'preflop' ? `加注到 ${to}` : `加注到 ${to}`
  return kind
}

export class TrainerSession {
  private listeners = new Set<() => void>()
  private snap: SessionSnapshot = {
    version: 0,
    phase: 'idle',
    engine: null,
    heroSeat: -1,
    toActSeat: -1,
    heroActions: [],
    decisions: [],
    lastDecision: null,
    result: null,
    solveProgress: null,
    error: '',
    preflopOnly: false,
    tableSize: 6,
  }

  private bundle: PreflopBundle | null = null
  private engine: EngineState | null = null
  private tracker: RangeTracker | null = null
  private pfNode: PfNode | null = null
  // 翻后状态
  private postNodes: Map<number, WorkerNode> | null = null
  private postNode: PostNode | null = null
  private postTreeRootStack = 0 // 本街开始时的剩余筹码
  private streetBaseInvested: number[] = [] // 每座位本街开始时的累计投入
  private seatOf: [number, number] = [-1, -1] // [OOP 座位, IP 座位]
  private cancelSolve: (() => void) | null = null
  private generation = 0 // 换手牌时递增，丢弃过期异步回调

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): SessionSnapshot => this.snap

  private update(patch: Partial<SessionSnapshot>) {
    this.snap = { ...this.snap, ...patch, version: this.snap.version + 1, engine: this.engine }
    for (const fn of this.listeners) fn()
  }

  setPreflopOnly(v: boolean) {
    this.update({ preflopOnly: v })
  }

  async startHand(n: number, preflopOnly?: boolean) {
    const gen = ++this.generation
    this.cancelSolve?.()
    this.cancelSolve = null
    if (preflopOnly !== undefined) this.snap = { ...this.snap, preflopOnly }
    try {
      this.update({ phase: 'solving', error: '', tableSize: n, decisions: [], lastDecision: null, result: null, solveProgress: null })
      const bundle = await loadPreflop(n)
      if (gen !== this.generation) return
      this.bundle = bundle
      this.engine = newHand(n)
      this.tracker = new RangeTracker(n)
      this.pfNode = bundle.tree.root
      this.postNodes = null
      this.postNode = null
      this.update({
        phase: 'bot-thinking',
        heroSeat: (Math.random() * n) | 0,
        decisions: [],
        lastDecision: null,
        result: null,
      })
      void this.process(gen)
    } catch (e) {
      if (gen !== this.generation) return
      this.update({ phase: 'idle', error: (e as Error).message })
    }
  }

  private heroClass(): number {
    const hero = this.engine!.players[this.snap.heroSeat]
    return handIndexOf(hero.cards[0], hero.cards[1])
  }

  private heroCombo(): number {
    const hero = this.engine!.players[this.snap.heroSeat]
    return comboIndex(hero.cards[0], hero.cards[1])
  }

  // ============ 主循环 ============
  private async process(gen: number): Promise<void> {
    while (gen === this.generation) {
      if (this.engine!.street === 'preflop') {
        const node = this.pfNode!
        // 树把「唯一动作=弃牌」的座位坍缩掉了，这里补记到引擎，别让牌桌凭空跳过
        if (this.applyForcedFolds(node.forcedFolds)) return
        if (node.type === 'terminal') {
          await this.handlePfTerminal(gen, node)
          return
        }
        const seat = node.actor
        if (seat === this.snap.heroSeat) {
          this.update({
            phase: 'hero-turn',
            toActSeat: seat,
            heroActions: node.actions.map((a) => ({
              label: labelOf(a.kind, a.to, 'preflop', 0),
              kind: a.kind,
            })),
          })
          return // 等待 heroAct
        }
        // 机器人
        this.update({ phase: 'bot-thinking', toActSeat: seat })
        await delay(BOT_DELAY_MS)
        if (gen !== this.generation) return
        const botClass = handIndexOf(
          this.engine!.players[seat].cards[0],
          this.engine!.players[seat].cards[1],
        )
        const freq = this.bundle!.freq.get(node.id)
        const A = node.actions.length
        const i = sampleAction(freq, botClass, A)
        this.applyPreflopAction(node, seat, i)
        continue
      }
      // 翻后
      const node = this.postNode!
      if (node.type === 'terminal') {
        await this.handlePostTerminal(gen, node)
        return
      }
      if (node.type === 'chance') {
        // 本街结束 → 下一街
        await this.nextStreet(gen)
        if (gen !== this.generation) return
        continue
      }
      const seat = this.seatOf[node.actor]
      const wn = this.postNodes!.get(node.id)
      if (seat === this.snap.heroSeat) {
        this.update({
          phase: 'hero-turn',
          toActSeat: seat,
          heroActions: node.actions.map((a) => ({
            label: labelOf(a.kind, a.amount, this.engine!.street, 0),
            kind: a.kind,
          })),
        })
        return
      }
      this.update({ phase: 'bot-thinking', toActSeat: seat })
      await delay(BOT_DELAY_MS)
      if (gen !== this.generation) return
      const botCombo = comboIndex(
        this.engine!.players[seat].cards[0],
        this.engine!.players[seat].cards[1],
      )
      const A = node.actions.length
      const i = sampleAction(wn?.strategy, botCombo, A)
      this.applyPostflopAction(node, seat, i)
    }
  }

  // ============ 英雄行动 ============
  heroAct(i: number) {
    const gen = this.generation
    if (this.snap.phase !== 'hero-turn') return
    if (this.engine!.street === 'preflop') {
      const node = this.pfNode! as PfDecisionNode
      this.recordPreflopDecision(node, i)
      this.applyPreflopAction(node, this.snap.heroSeat, i)
    } else {
      const node = this.postNode! as PostNode & { type: 'decision' }
      this.recordPostflopDecision(node, i)
      this.applyPostflopAction(node, this.snap.heroSeat, i)
    }
    if (this.snap.result) return // 英雄弃牌已结束
    void this.process(gen)
  }

  // 树上坍缩的强制弃牌：逐个补记到引擎（牌桌实时变灰、底池正确）。
  // 英雄被强制弃牌时按普通弃牌收尾，并说明原因——以前这里是静默跳过，
  // 结算面板只剩一句「本手没轮到你决策」。返回 true 表示本手已结束。
  private applyForcedFolds(seats: number[]): boolean {
    if (seats.length === 0) return false
    const eng = this.engine!
    let heroForced = false
    for (const seat of seats) {
      if (eng.players[seat].folded) continue
      applyAction(eng, seat, 'fold', 0)
      if (seat === this.snap.heroSeat) heroForced = true
    }
    if (!heroForced) {
      this.update({})
      return false
    }
    const raises = eng.history.filter((h) => h.street === 'preflop' && h.kind === 'raise').length
    this.finishHeroFold(
      `你在 ${eng.positions[this.snap.heroSeat]} 面对 ${raises + 1}-bet：` +
        `训练树在该局面只保留弃牌（不含冷跟注/冷 4-bet），本手自动弃牌`,
    )
    return true
  }

  // ============ 翻前细节 ============
  private applyPreflopAction(node: PfDecisionNode, seat: number, i: number) {
    const a = node.actions[i]
    applyAction(this.engine!, seat, a.kind, a.to)
    this.tracker!.applyPreflop(seat, this.bundle!.freq.get(node.id), node.actions.length, i)
    this.pfNode = node.children[i]
    if (a.kind === 'fold' && seat === this.snap.heroSeat) {
      this.finishHeroFold()
    }
  }

  private recordPreflopDecision(node: PfDecisionNode, chosen: number) {
    const A = node.actions.length
    const h = this.heroClass()
    const freqArr = this.bundle!.freq.get(node.id)
    const evArr = this.bundle!.ev.get(node.id)
    const freqs = Array.from({ length: A }, (_, a) => (freqArr ? freqArr[h * A + a] : 1 / A))
    const evs = evArr ? Array.from({ length: A }, (_, a) => evArr[h * A + a]) : null
    this.pushDecision(
      node.actions.map((a) => labelOf(a.kind, a.to, 'preflop', 0)),
      node.actions.map((a) => a.kind),
      freqs,
      evs,
      chosen,
      'preflop',
    )
  }

  private async handlePfTerminal(gen: number, t: PfNode & { type: 'terminal' }) {
    const eng = this.engine!
    // 兜底：终端 active 列表是权威（强制弃牌已在 applyForcedFolds 里补记过）
    for (const p of eng.players) {
      if (!t.active.includes(p.seat)) p.folded = true
    }
    if (t.kind === 'foldwin') {
      const winnings = new Map<number, number>([[t.winner!, pot(eng)]])
      this.finishHand(settle(eng, winnings), false, [])
      return
    }
    if (t.kind === 'runout') {
      runOutBoard(eng)
      const win = showdown(eng)
      this.finishHand(settle(eng, win), true, this.revealActive())
      return
    }
    // 进翻牌
    const active = t.active
    if (!active.includes(this.snap.heroSeat)) {
      // 英雄已弃（应已在 fold 时结束，防御）
      this.finishHeroFold()
      return
    }
    if (this.snap.preflopOnly) {
      this.finishCutoff('翻前训练模式：本手到翻牌为止，仅评估翻前决策')
      return
    }
    if (active.length > 2) {
      this.finishCutoff('多人底池：仅评估翻前决策（翻后 GTO 只在单挑底池有定义）')
      return
    }
    // 单挑进翻后
    advanceStreet(eng)
    const villain = active.find((s) => s !== this.snap.heroSeat)!
    const pfIdx = postflopOrder(eng.positions)
    const heroFirst = pfIdx[this.snap.heroSeat] < pfIdx[villain]
    this.seatOf = heroFirst ? [this.snap.heroSeat, villain] : [villain, this.snap.heroSeat]
    await this.solveCurrentStreet(gen)
  }

  // ============ 翻后细节 ============
  private applyPostflopAction(node: PostNode & { type: 'decision' }, seat: number, i: number) {
    const a = node.actions[i]
    const total = a.kind === 'fold' || a.kind === 'check' ? 0 : this.streetBaseInvested[seat] + a.amount
    applyAction(this.engine!, seat, a.kind, total)
    const wn = this.postNodes!.get(node.id)
    if (wn) {
      const actorIdx = node.actor
      this.tracker!.applyPostflop(this.seatOf[actorIdx], wn.strategy, node.actions.length, i)
    }
    this.postNode = node.children[i]
    if (a.kind === 'fold' && seat === this.snap.heroSeat) {
      this.finishHeroFold()
    }
  }

  private recordPostflopDecision(node: PostNode & { type: 'decision' }, chosen: number) {
    const A = node.actions.length
    const c = this.heroCombo()
    const wn = this.postNodes!.get(node.id)
    const freqs = Array.from({ length: A }, (_, a) => (wn ? wn.strategy[c * A + a] : 1 / A))
    const evs = wn ? Array.from({ length: A }, (_, a) => wn.ev[c * A + a]) : null
    this.pushDecision(
      node.actions.map((a) => labelOf(a.kind, a.amount, this.engine!.street, 0)),
      node.actions.map((a) => a.kind),
      freqs,
      evs,
      chosen,
      this.engine!.street,
    )
  }

  private async handlePostTerminal(gen: number, t: PostNode & { type: 'terminal' }) {
    const eng = this.engine!
    if (t.kind === 'fold') {
      const folderSeat = this.seatOf[t.folder!]
      if (folderSeat === this.snap.heroSeat) {
        this.finishHeroFold()
        return
      }
      const winnings = new Map<number, number>([[this.snap.heroSeat, pot(eng)]])
      this.finishHand(settle(eng, winnings), false, [])
      return
    }
    if (t.kind === 'showdown') {
      if (t.allin || eng.street !== 'river') runOutBoard(eng)
      const win = showdown(eng)
      this.finishHand(settle(eng, win), true, this.revealActive())
      return
    }
    // street-end（flop 深度受限树）→ 下一街
    await this.nextStreet(gen)
    if (gen !== this.generation) return
    void this.process(gen)
  }

  private async nextStreet(gen: number) {
    const eng = this.engine!
    advanceStreet(eng)
    const newCard = eng.board[eng.board.length - 1]
    this.tracker!.maskBoard(this.seatOf[0], [newCard])
    this.tracker!.maskBoard(this.seatOf[1], [newCard])
    await this.solveCurrentStreet(gen)
  }

  private async solveCurrentStreet(gen: number) {
    const eng = this.engine!
    const street = eng.street as PostSpec['street']
    const [oopSeat, ipSeat] = this.seatOf
    // 双方本街开始时投入应相等
    this.streetBaseInvested = eng.players.map((p) => p.invested)
    const matched = eng.players[oopSeat].invested
    const stackLeft = eng.stack - matched
    const curPot = pot(eng)
    const oop = this.tracker!.combo1326[oopSeat] ?? this.tracker!.toCombos(oopSeat, eng.board)
    const ip = this.tracker!.combo1326[ipSeat] ?? this.tracker!.toCombos(ipSeat, eng.board)

    this.update({ phase: 'solving', solveProgress: { street: eng.street, iter: 0, total: 1 } })
    const handle = solveInWorker({
      street,
      board: eng.board.slice(),
      pot: curPot,
      stack: stackLeft,
      preset: 'trainer',
      oop: oop.slice(),
      ip: ip.slice(),
      onProgress: (iter, total) => {
        if (gen !== this.generation) return
        this.update({ solveProgress: { street: eng.street, iter, total } })
      },
    })
    this.cancelSolve = handle.cancel
    try {
      const sol = await handle.promise
      if (gen !== this.generation) return
      this.cancelSolve = null
      this.postNodes = new Map(sol.nodes.map((n) => [n.id, n]))
      // 客户端重建同一棵街树用于导航（确定性 id 一致）
      const tree = buildPostflopTree({
        street,
        board: eng.board.slice(),
        pot: curPot,
        stack: stackLeft,
        preset: POSTFLOP_PRESETS.trainer,
      })
      this.postNode = tree.root
      this.update({ phase: 'bot-thinking', solveProgress: null })
      void this.process(gen)
    } catch (e) {
      if (gen !== this.generation) return
      this.cancelSolve = null
      this.update({ phase: 'idle', error: `求解失败：${(e as Error).message}`, solveProgress: null })
    }
  }

  // ============ 判分与结束 ============
  private pushDecision(
    labels: string[],
    kinds: string[],
    freqs: number[],
    evs: number[] | null,
    chosen: number,
    street: GameStreet,
  ) {
    const maxF = Math.max(...freqs)
    const f = freqs[chosen]
    let evLoss = 0
    if (evs) {
      const maxEv = Math.max(...evs)
      evLoss = maxEv - evs[chosen]
    }
    let verdict: DecisionRecord['verdict']
    if (evs ? evLoss <= 0.05 : f >= maxF - 0.001) verdict = 'optimal'
    else if (f >= 0.1 || (evs !== null && evLoss <= 0.25)) verdict = 'acceptable'
    else verdict = 'wrong'
    const rec: DecisionRecord = {
      street,
      pos: this.engine!.positions[this.snap.heroSeat],
      labels,
      kinds,
      freqs,
      evs,
      chosen,
      evLoss,
      score: maxF > 0 ? Math.round((f / maxF) * 100) : 100,
      verdict,
    }
    this.update({ decisions: [...this.snap.decisions, rec], lastDecision: rec })
  }

  private revealActive(): { seat: number; cards: [Card, Card] }[] {
    return this.engine!.players.filter((p) => !p.folded && p.seat !== this.snap.heroSeat).map(
      (p) => ({ seat: p.seat, cards: p.cards }),
    )
  }

  private finishHeroFold(note?: string) {
    const eng = this.engine!
    const delta = -eng.players[this.snap.heroSeat].invested
    this.finishWith({
      deltaBB: delta,
      heroFolded: true,
      wentToShowdown: false,
      multiwayCutoff: false,
      revealed: [],
      note,
    })
  }

  private finishCutoff(note: string) {
    this.finishWith({
      deltaBB: null,
      heroFolded: false,
      wentToShowdown: false,
      multiwayCutoff: true,
      revealed: [],
      note,
    })
  }

  private finishHand(
    settled: Map<number, number>,
    wentToShowdown: boolean,
    revealed: { seat: number; cards: [Card, Card] }[],
  ) {
    this.finishWith({
      deltaBB: settled.get(this.snap.heroSeat) ?? 0,
      heroFolded: false,
      wentToShowdown,
      multiwayCutoff: false,
      revealed,
    })
  }

  private finishWith(result: HandResultInfo) {
    this.update({ phase: 'hand-done', result })
    const eng = this.engine!
    const hero = eng.players[this.snap.heroSeat]
    const record: HandRecord = {
      id: `${Date.now()}-${((Math.random() * 1e6) | 0).toString(36)}`,
      ts: Date.now(),
      tableSize: eng.n,
      heroSeat: this.snap.heroSeat,
      heroPos: eng.positions[this.snap.heroSeat],
      heroCards: [hero.cards[0], hero.cards[1]],
      board: eng.board.slice(),
      actions: eng.history.map((h) => ({
        street: h.street,
        seat: h.seat,
        pos: eng.positions[h.seat],
        kind: h.kind,
        to: h.to,
      })),
      decisions: this.snap.decisions,
      result,
    }
    for (const fn of recordListeners) fn(record)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sampleAction(strat: Float32Array | undefined, row: number, A: number): number {
  if (!strat) return sampleUniform(A)
  let total = 0
  for (let a = 0; a < A; a++) total += strat[row * A + a]
  if (total <= 1e-9) return sampleUniform(A)
  let x = Math.random() * total
  for (let a = 0; a < A; a++) {
    x -= strat[row * A + a]
    if (x <= 0) return a
  }
  return A - 1
}

function sampleUniform(A: number): number {
  return (Math.random() * A) | 0
}

export const trainerSession = new TrainerSession()
