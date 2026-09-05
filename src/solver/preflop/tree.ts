import type { Position } from '../../poker/ranges'
import { POSITIONS_BY_SIZE, postflopOrder, type LadderConfig } from '../config'

// 翻前博弈树。动作抽象（控制树规模的关键）：
// - 不允许 limp：首入只有 弃牌/开局加注
// - 面对开局：所有人 弃牌/跟注/3bet
// - 面对 3bet：开局者 弃牌/跟注/4bet；已跟注者与盲注 弃牌/跟注（盲注可冷跟、不可冷 4bet）；其它未投入者只能弃牌
// - 面对 4bet：3bet 者 弃牌/跟注/全下；其他已投入者 弃牌/跟注；未投入者只能弃牌
// - 第 4 次加注 = 全下；面对全下只有 弃牌/跟注

export type PfActionKind = 'fold' | 'call' | 'raise'

export interface PfAction {
  kind: PfActionKind
  to: number // raise/call 后的累计投入（bb）；fold 为 0
}

export interface PfDecisionNode {
  type: 'decision'
  id: number
  actor: number // 座位索引（行动顺序）
  actions: PfAction[]
  children: PfNode[]
  publicPath: string // 例 "F-F-R2.5-C" 便于导航与调试
  raisesBefore: number // 面对的加注次数
  forcedFolds: number[] // 到达本节点前被树坍缩（唯一动作=弃牌）的座位，按行动顺序
}

export interface PfTerminalNode {
  type: 'terminal'
  id: number
  kind: 'foldwin' | 'runout' | 'flop'
  pot: number
  invested: number[] // 每座位投入
  active: number[] // 未弃牌座位
  winner?: number // foldwin 时
  realization?: number[] // flop 叶：每个 active 玩家的 R 系数（与 active 对齐）
  publicPath: string
  forcedFolds: number[] // 到达本节点前被树坍缩的座位，按行动顺序
}

export type PfNode = PfDecisionNode | PfTerminalNode

export interface PfTree {
  n: number
  positions: Position[]
  ladder: LadderConfig
  root: PfNode
  decisionNodes: PfDecisionNode[] // 按 id 顺序
  terminals: PfTerminalNode[]
}

interface BuildState {
  invested: number[]
  voluntary: boolean[] // 是否有自愿投入（盲注不算）
  folded: boolean[]
  allin: boolean[]
  currentBet: number
  raises: number
  opener: number // 开局者座位；-1 无
  threeBettor: number
  callersOfOpen: number
  pending: number[] // 待行动座位队列
  path: string
}

function round05(x: number): number {
  return Math.round(x * 2) / 2
}

export function buildPreflopTree(n: number, ladder: LadderConfig): PfTree {
  const positions = POSITIONS_BY_SIZE[n]
  if (!positions) throw new Error(`不支持的人数: ${n}`)
  const pfIdx = postflopOrder(positions)
  const sbSeat = n === 2 ? 0 : positions.indexOf('SB')
  const bbSeat = positions.indexOf('BB')

  const decisionNodes: PfDecisionNode[] = []
  const terminals: PfTerminalNode[] = []
  let nextId = 0

  function makeTerminal(st: BuildState, forcedFolds: number[]): PfTerminalNode {
    const active = positions.map((_, i) => i).filter((i) => !st.folded[i])
    const pot = st.invested.reduce((a, b) => a + b, 0)
    let t: PfTerminalNode
    if (active.length === 1) {
      t = {
        type: 'terminal',
        id: nextId++,
        kind: 'foldwin',
        pot,
        invested: st.invested.slice(),
        active,
        winner: active[0],
        publicPath: st.path,
        forcedFolds,
      }
    } else {
      const notAllin = active.filter((i) => !st.allin[i])
      if (notAllin.length <= 1) {
        t = {
          type: 'terminal',
          id: nextId++,
          kind: 'runout',
          pot,
          invested: st.invested.slice(),
          active,
          publicPath: st.path,
          forcedFolds,
        }
      } else {
        // 进翻牌：计算每个玩家的实现系数（在 leaf.ts 里按 SPR/位置算，这里存位置序即可）
        t = {
          type: 'terminal',
          id: nextId++,
          kind: 'flop',
          pot,
          invested: st.invested.slice(),
          active,
          publicPath: st.path,
          forcedFolds,
        }
      }
    }
    terminals.push(t)
    return t
  }

  function threeBetSize(st: BuildState, seat: number): number {
    const ip = pfIdx[seat] > pfIdx[st.opener]
    const mult = ip ? ladder.threeBetIpMult : ladder.threeBetOopMult
    return Math.min(
      ladder.stack,
      round05(st.currentBet * mult + st.callersOfOpen * ladder.squeezeBonus),
    )
  }

  function legalActions(st: BuildState, seat: number): PfAction[] {
    const acts: PfAction[] = [{ kind: 'fold', to: 0 }]
    const facing = st.currentBet
    if (st.raises === 0) {
      // 首入：弃牌/开局（不允许 limp）
      const to = seat === sbSeat && n > 2 ? ladder.sbOpenSize : ladder.openSize
      acts.push({ kind: 'raise', to })
      return acts
    }
    const allinFacing = facing >= ladder.stack
    const canRaise = st.raises < ladder.maxRaises && !allinFacing
    if (st.raises === 1) {
      // 面对开局：可跟（冷跟人数上限 2）可 3bet
      if (st.callersOfOpen < 2) acts.push({ kind: 'call', to: facing })
      if (canRaise) acts.push({ kind: 'raise', to: threeBetSize(st, seat) })
      return acts
    }
    if (st.raises === 2) {
      // 面对 3bet
      const fourBetTo = Math.min(ladder.stack, round05(facing * ladder.fourBetMult))
      if (seat === st.opener) {
        acts.push({ kind: 'call', to: facing })
        if (canRaise) acts.push({ kind: 'raise', to: fourBetTo })
      } else if (st.voluntary[seat] || seat === sbSeat || seat === bbSeat) {
        // 已跟注者与盲注可以跟（盲注冷跟 3bet：有折扣/关闭行动，AA/KK 用跟注代替冷 4bet）
        acts.push({ kind: 'call', to: facing })
      }
      // 其它未投入者只能弃牌（BTN/CO 冷跟 3bet 在 GTO 里接近 0，砍掉换树规模）
      return acts
    }
    if (st.raises === 3) {
      // 面对 4bet
      if (seat === st.threeBettor) {
        acts.push({ kind: 'call', to: Math.min(facing, ladder.stack) })
        if (canRaise) acts.push({ kind: 'raise', to: ladder.stack }) // 5bet 全下
      } else if (st.voluntary[seat]) {
        acts.push({ kind: 'call', to: Math.min(facing, ladder.stack) })
      }
      // 未投入者只能弃牌
      return acts
    }
    // 面对全下
    if (st.voluntary[seat] || seat === bbSeat || seat === sbSeat) {
      acts.push({ kind: 'call', to: ladder.stack })
    }
    return acts
  }

  // forced：到达本状态前被坍缩掉的座位（唯一动作=弃牌），挂到下一个真实节点上，
  // 让消费方（训练器牌桌）知道这些人已经弃牌，而不是凭空跳过。
  function build(st: BuildState, forced: number[] = []): PfNode {
    if (st.pending.length === 0) return makeTerminal(st, forced)
    const seat = st.pending[0]
    const rest = st.pending.slice(1)
    const actions = legalActions(st, seat)
    // 只有弃牌一个选项时直接坍缩（未投入者面对 3bet/4bet）
    if (actions.length === 1) {
      const st2 = applyFold(st, seat, rest)
      const forced2 = [...forced, seat]
      const activeCnt = st2.folded.filter((f) => !f).length
      if (activeCnt === 1) return makeTerminal(st2, forced2)
      return build(st2, forced2)
    }
    const node: PfDecisionNode = {
      type: 'decision',
      id: nextId++,
      actor: seat,
      actions,
      children: [],
      publicPath: st.path,
      raisesBefore: st.raises,
      forcedFolds: forced,
    }
    decisionNodes.push(node)
    for (const a of actions) {
      let st2: BuildState
      if (a.kind === 'fold') {
        st2 = applyFold(st, seat, rest)
        const activeCnt = st2.folded.filter((f) => !f).length
        if (activeCnt === 1) {
          node.children.push(makeTerminal(st2, []))
          continue
        }
      } else if (a.kind === 'call') {
        st2 = {
          ...cloneState(st),
          pending: rest,
          path: st.path + (st.path ? '-' : '') + 'C',
        }
        st2.invested[seat] = a.to
        st2.voluntary[seat] = true
        if (a.to >= ladder.stack) st2.allin[seat] = true
        if (st.raises === 1) st2.callersOfOpen++
      } else {
        st2 = {
          ...cloneState(st),
          currentBet: a.to,
          raises: st.raises + 1,
          path: st.path + (st.path ? '-' : '') + `R${a.to}`,
        }
        st2.invested[seat] = a.to
        st2.voluntary[seat] = true
        if (a.to >= ladder.stack) st2.allin[seat] = true
        if (st.raises === 0) st2.opener = seat
        if (st.raises === 1) st2.threeBettor = seat
        // 其他所有未弃牌未全下的玩家重新获得行动权（按座位顺序，从 seat 之后开始）
        const reopened: number[] = []
        for (let k = 1; k < n; k++) {
          const s = (seat + k) % n
          if (!st2.folded[s] && !st2.allin[s] && s !== seat) reopened.push(s)
        }
        st2.pending = reopened
      }
      node.children.push(build(st2))
    }
    return node
  }

  function cloneState(st: BuildState): BuildState {
    return {
      invested: st.invested.slice(),
      voluntary: st.voluntary.slice(),
      folded: st.folded.slice(),
      allin: st.allin.slice(),
      currentBet: st.currentBet,
      raises: st.raises,
      opener: st.opener,
      threeBettor: st.threeBettor,
      callersOfOpen: st.callersOfOpen,
      pending: st.pending,
      path: st.path,
    }
  }

  function applyFold(st: BuildState, seat: number, rest: number[]): BuildState {
    const st2 = cloneState(st)
    st2.folded[seat] = true
    st2.pending = rest
    st2.path = st.path + (st.path ? '-' : '') + 'F'
    return st2
  }

  const invested = new Array(n).fill(0)
  invested[sbSeat] = 0.5
  invested[bbSeat] = 1
  const initial: BuildState = {
    invested,
    voluntary: new Array(n).fill(false),
    folded: new Array(n).fill(false),
    allin: new Array(n).fill(false),
    currentBet: 1,
    raises: 0,
    opener: -1,
    threeBettor: -1,
    callersOfOpen: 0,
    pending: positions.map((_, i) => i),
    path: '',
  }

  const root = build(initial)
  return { n, positions, ladder, root, decisionNodes, terminals }
}
