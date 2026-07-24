import type { Card } from '../../poker/cards'
import type { PostflopPreset } from '../config'

// 单挑翻后下注树。0 = OOP，1 = IP
// - river：本街结束 → 摊牌
// - turn：本街结束（有筹码）→ 机会节点展开每张河牌的子树；全下 → 摊牌（发完）
// - flop：本街结束 → 深度受限叶（热权益 × 实现系数，在 cfr 中求值）；全下 → 摊牌（发完）
// amount 均为「本街累计投入」目标值（bb）

export type Street = 'flop' | 'turn' | 'river'

export interface PostSpec {
  street: Street
  board: Card[] // flop 3 / turn 4 / river 5
  pot: number // 街开始时底池
  stack: number // 双方剩余有效筹码
  preset: PostflopPreset
}

export interface PostAction {
  kind: 'check' | 'bet' | 'fold' | 'call' | 'raise'
  amount: number
}

export interface PostDecision {
  type: 'decision'
  id: number
  street: Street
  actor: 0 | 1
  actions: PostAction[]
  children: PostNode[]
}

export interface PostChance {
  type: 'chance'
  id: number
  cards: Card[] // 每个子节点对应的发牌
  children: PostNode[]
  pot: number
}

export interface PostTerminal {
  type: 'terminal'
  id: number
  // fold: 一方弃牌
  // showdown: 摊牌（河牌结束或全下发完）
  // street-end: flop 深度受限叶（热权益求值）
  kind: 'fold' | 'showdown' | 'street-end'
  pot: number // 总底池（含所有投入）
  invested: [number, number] // 累计投入（相对本次求解开始）
  folder?: 0 | 1
  allin: boolean
  riverCard?: Card // 位于转牌子树中的摊牌叶：对应的河牌
}

export type PostNode = PostDecision | PostChance | PostTerminal

export interface PostTree {
  spec: PostSpec
  root: PostNode
  decisionNodes: PostDecision[]
  terminals: PostTerminal[]
}

function r1(x: number): number {
  return Math.round(x * 10) / 10
}

export function buildPostflopTree(spec: PostSpec): PostTree {
  const { preset } = spec
  const decisionNodes: PostDecision[] = []
  const terminals: PostTerminal[] = []
  let nextId = 0

  const boardSet = new Uint8Array(52)
  for (const c of spec.board) boardSet[c] = 1

  function terminal(
    kind: PostTerminal['kind'],
    pot: number,
    inv: [number, number],
    folder: 0 | 1 | undefined,
    allin: boolean,
    riverCard?: Card,
  ): PostTerminal {
    const t: PostTerminal = {
      type: 'terminal',
      id: nextId++,
      kind,
      pot,
      invested: [inv[0], inv[1]],
      folder,
      allin,
      riverCard,
    }
    terminals.push(t)
    return t
  }

  // street: 当前街；basePot: 街开始时底池；baseInv: 之前街的累计投入
  // riverCard: 当前处于哪张河牌的子树（仅 turn 求解的河牌子树）
  function closeStreet(
    street: Street,
    basePot: number,
    baseInv: [number, number],
    streetInv: [number, number],
    allin: boolean,
    riverCard: Card | undefined,
    stackLeft: number,
  ): PostNode {
    const inv: [number, number] = [baseInv[0] + streetInv[0], baseInv[1] + streetInv[1]]
    const pot = basePot + streetInv[0] + streetInv[1]
    if (street === 'river' || allin) {
      return terminal('showdown', pot, inv, undefined, allin, riverCard)
    }
    if (street === 'turn') {
      // 机会节点：每张河牌（剩余筹码扣除本街已投入）
      const remain = stackLeft - streetInv[0]
      const chance: PostChance = { type: 'chance', id: nextId++, cards: [], children: [], pot }
      for (let c = 0; c < 52; c++) {
        if (boardSet[c]) continue
        chance.cards.push(c)
        chance.children.push(buildStreet('river', pot, inv, remain, c))
      }
      return chance
    }
    // flop 深度受限
    return terminal('street-end', pot, inv, undefined, false, riverCard)
  }

  function buildStreet(
    street: Street,
    basePot: number,
    baseInv: [number, number],
    stack: number, // 本街开始时双方剩余
    riverCard: Card | undefined,
  ): PostNode {
    // 转牌解中的河牌子树用粗化 continuation（单一尺寸、无加注）
    const isCont = riverCard !== undefined
    const betSizes = isCont ? preset.contBetSizes : preset.betSizes
    const raiseSizes = isCont ? [] : preset.raiseSizes
    const maxRaises = isCont ? 1 : preset.maxRaisesPerStreet

    function betAmounts(curPot: number, own: number): number[] {
      const out: number[] = []
      for (const f of betSizes) {
        const amt = Math.min(stack, r1(own + f * curPot))
        if (amt > own + 0.05 && !out.some((x) => Math.abs(x - amt) < 0.5)) out.push(amt)
      }
      if (stack > own + 0.05 && !out.some((x) => Math.abs(x - stack) < 0.5)) out.push(stack)
      return out
    }
    function raiseAmounts(curPot: number, facing: number, own: number): number[] {
      const out: number[] = []
      for (const f of raiseSizes) {
        const amt = Math.min(stack, r1(facing + f * (curPot + facing - own)))
        if (amt > facing + 0.5 && !out.some((x) => Math.abs(x - amt) < 0.5)) out.push(amt)
      }
      if (stack > facing + 0.5 && !out.some((x) => Math.abs(x - stack) < 0.5)) out.push(stack)
      return out
    }

    function build(
      actor: 0 | 1,
      streetInv: [number, number],
      facing: number,
      raises: number,
    ): PostNode {
      const curPot = basePot + streetInv[0] + streetInv[1]
      const own = streetInv[actor]
      const actions: PostAction[] = []
      const kids: (() => PostNode)[] = []

      if (facing <= own) {
        actions.push({ kind: 'check', amount: own })
        if (actor === 0) {
          kids.push(() => build(1, streetInv, facing, raises))
        } else {
          kids.push(() =>
            closeStreet(street, basePot, baseInv, streetInv, false, riverCard, stack),
          )
        }
        for (const amt of betAmounts(curPot, own)) {
          actions.push({ kind: 'bet', amount: amt })
          const inv2: [number, number] = [streetInv[0], streetInv[1]]
          inv2[actor] = amt
          const nx = (1 - actor) as 0 | 1
          kids.push(() => build(nx, inv2, amt, raises + 1))
        }
      } else {
        actions.push({ kind: 'fold', amount: own })
        kids.push(() =>
          terminal(
            'fold',
            basePot + streetInv[0] + streetInv[1],
            [baseInv[0] + streetInv[0], baseInv[1] + streetInv[1]],
            actor,
            false,
            riverCard,
          ),
        )
        {
          const inv2: [number, number] = [streetInv[0], streetInv[1]]
          inv2[actor] = facing
          actions.push({ kind: 'call', amount: facing })
          const allin = facing >= stack - 0.05
          kids.push(() => closeStreet(street, basePot, baseInv, inv2, allin, riverCard, stack))
        }
        if (raises <= maxRaises && facing < stack - 0.05) {
          for (const amt of raiseAmounts(curPot, facing, own)) {
            actions.push({ kind: 'raise', amount: amt })
            const inv2: [number, number] = [streetInv[0], streetInv[1]]
            inv2[actor] = amt
            const nx = (1 - actor) as 0 | 1
            kids.push(() => build(nx, inv2, amt, raises + 1))
          }
        }
      }

      const node: PostDecision = {
        type: 'decision',
        id: nextId++,
        street,
        actor,
        actions,
        children: [],
      }
      decisionNodes.push(node)
      for (const k of kids) node.children.push(k())
      return node
    }

    return build(0, [0, 0], 0, 0)
  }

  const root = buildStreet(spec.street, spec.pot, [0, 0], spec.stack, undefined)
  return { spec, root, decisionNodes, terminals }
}
