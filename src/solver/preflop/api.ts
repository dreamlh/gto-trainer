import { handIndex, HAND_NAMES } from '../../poker/cards'
import type { Position, Spot, SpotAction } from '../../poker/ranges'
import { DEFAULT_LADDER } from '../config'
import { buildPreflopTree, type PfDecisionNode, type PfNode, type PfTree } from './tree'
import { decodeSolution, type DecodedArtifact } from './serialize'

// 翻前解的消费层：加载 artifact、重建树、导航、生成经典场景（Spot 适配）

export interface PreflopBundle {
  n: number
  tree: PfTree
  freq: Map<number, Float32Array> // nodeId -> 169*A
  ev: Map<number, Float32Array>
  spots: Spot[]
  exploitability?: number
}

// ---------- 加载 ----------
const cache = new Map<number, Promise<PreflopBundle>>()

export function loadPreflop(n: number): Promise<PreflopBundle> {
  let p = cache.get(n)
  if (!p) {
    p = fetchAndBuild(n)
    cache.set(n, p)
  }
  return p
}

async function fetchAndBuild(n: number): Promise<PreflopBundle> {
  const resp = await fetch(`${import.meta.env.BASE_URL}solutions/preflop-${n}p-100bb.bin.gz`)
  if (!resp.ok) throw new Error(`翻前解加载失败（${n} 人桌）: HTTP ${resp.status}`)
  let bytes = new Uint8Array(await resp.arrayBuffer())
  // 服务器可能已按 Content-Encoding 自动解压（如 Vite dev）；按 gzip 魔数判断
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const ds = new DecompressionStream('gzip')
    const decompressed = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer()
    bytes = new Uint8Array(decompressed)
  }
  return bundleFromArtifact(bytes)
}

// Node 测试与 worker 也可直接用已解码的字节构建
export function bundleFromArtifact(bytes: Uint8Array): PreflopBundle {
  const decoded = decodeSolution(bytes)
  return bundleFromDecoded(decoded)
}

export function bundleFromDecoded(decoded: DecodedArtifact): PreflopBundle {
  const tree = buildPreflopTree(decoded.header.n, decoded.header.ladder)
  const bundle: PreflopBundle = {
    n: decoded.header.n,
    tree,
    freq: decoded.freq,
    ev: decoded.ev,
    spots: [],
    exploitability: decoded.header.exploitability,
  }
  bundle.spots = deriveSpots(bundle)
  return bundle
}

// ---------- 树导航 ----------
// 动作序列 = 子节点索引数组；引擎按 (kind, to) 找子索引
export function childIndex(node: PfDecisionNode, kind: string, to?: number): number {
  return node.actions.findIndex((a) => a.kind === kind && (to === undefined || a.to === to))
}

export function nodeAtPath(tree: PfTree, actionIdxs: number[]): PfNode {
  let node: PfNode = tree.root
  for (const i of actionIdxs) {
    if (node.type !== 'decision') throw new Error('路径越过终端')
    node = node.children[i]
  }
  return node
}

// 手牌 h 在节点的策略（归一化频率数组，与 node.actions 对齐）
export function strategyFor(bundle: PreflopBundle, node: PfDecisionNode, hand: string): number[] {
  const A = node.actions.length
  const f = bundle.freq.get(node.id)
  const h = handIndex(hand)
  if (!f) return new Array(A).fill(1 / A) // 未存储的低到达节点
  return Array.from({ length: A }, (_, a) => f[h * A + a])
}

// ---------- 经典场景生成（适配 v1 Spot 接口）----------
interface WalkCtx {
  node: PfNode
  raises: number
  calls: number
  opener: number
  threeBettor: number
  fourBettor: number
}

function actionKeyFor(raisesBefore: number): SpotAction['key'] {
  if (raisesBefore === 0) return 'raise'
  if (raisesBefore === 1) return 'threebet'
  if (raisesBefore === 2) return 'fourbet'
  return 'fivebet'
}

const KEY_LABELS: Record<string, (to: number) => string> = {
  raise: (to) => `加注 ${to}bb`,
  threebet: (to) => `3-bet 至 ${to}bb`,
  fourbet: (to) => `4-bet 至 ${to}bb`,
  fivebet: () => `全下`,
  call: () => '跟注',
}

function deriveSpots(bundle: PreflopBundle): Spot[] {
  const { tree, freq } = bundle
  const pos = tree.positions
  const spots: Spot[] = []

  function spotFrom(node: PfDecisionNode, ctx: WalkCtx): Spot | null {
    const hero = pos[node.actor]
    const f = freq.get(node.id)
    if (!f) return null
    const A = node.actions.length
    const actions: SpotAction[] = []
    const keys: string[] = []
    for (const a of node.actions) {
      if (a.kind === 'fold') {
        keys.push('fold')
        continue
      }
      const key = a.kind === 'call' ? 'call' : actionKeyFor(node.raisesBefore)
      keys.push(key)
      actions.push({ key: key as SpotAction['key'], label: KEY_LABELS[key](a.to) })
    }
    const strategy = new Map<string, Record<string, number>>()
    for (let h = 0; h < 169; h++) {
      const entry: Record<string, number> = {}
      for (let a = 0; a < A; a++) {
        const key = keys[a]
        if (key === 'fold') continue
        const v = f[h * A + a]
        if (v > 0.004) entry[key] = v
      }
      if (Object.keys(entry).length > 0) strategy.set(HAND_NAMES[h], entry)
    }

    let category: Spot['category']
    let villain: Position | undefined
    let title: string
    let situation: string
    const openTo = node.raisesBefore >= 1 ? '' : ''
    void openTo
    if (node.raisesBefore === 0) {
      category = 'rfi'
      title = `${hero} 首入（RFI）`
      situation =
        tree.n === 2
          ? '单挑：你在按钮位（兼小盲），翻前先行动。'
          : `前面全部弃牌，你在 ${hero}。`
      spots.push({
        id: `${tree.n}p-rfi-${hero.toLowerCase()}`,
        category,
        hero,
        villain: undefined,
        title,
        situation,
        actions,
        strategy,
      })
      return null
    }
    if (node.raisesBefore === 1 && ctx.calls === 0) {
      category = 'vs-rfi'
      villain = pos[ctx.opener]
      title = `${hero} 防守 vs ${villain} 开局`
      const openAmt = tree.n > 2 && villain === 'SB' ? tree.ladder.sbOpenSize : tree.ladder.openSize
      situation = `${villain} 加注至 ${openAmt}bb，其余弃牌，轮到你（${hero}）。`
      spots.push({
        id: `${tree.n}p-${hero.toLowerCase()}-vs-${villain.toLowerCase()}`,
        category,
        hero,
        villain,
        title,
        situation,
        actions,
        strategy,
      })
      return null
    }
    if (node.raisesBefore === 2 && ctx.calls === 0 && node.actor === ctx.opener) {
      category = 'vs-3bet'
      villain = pos[ctx.threeBettor]
      title = `${hero} 应对 ${villain} 3-bet`
      situation = `你在 ${hero} 开局加注，${villain} 3-bet，其余弃牌，轮到你。`
      spots.push({
        id: `${tree.n}p-${hero.toLowerCase()}-vs-${villain.toLowerCase()}-3bet`,
        category,
        hero,
        villain,
        title,
        situation,
        actions,
        strategy,
      })
      return null
    }
    if (node.raisesBefore === 2 && ctx.calls === 0 && node.actor !== ctx.opener) {
      // 盲注面对「开局 + 3-bet」的冷跟/弃（树里只有盲注在此有决策）
      category = 'cold-3bet'
      villain = pos[ctx.threeBettor]
      const opener = pos[ctx.opener]
      title = `${hero} 面对 ${opener} 开局 + ${villain} 3-bet（冷跟）`
      situation = `${opener} 开局加注，${villain} 3-bet，轮到你在 ${hero}（只能跟注或弃牌，不含冷 4-bet）。`
      spots.push({
        id: `${tree.n}p-${hero.toLowerCase()}-vs-${opener.toLowerCase()}-${villain.toLowerCase()}-cold`,
        category,
        hero,
        villain,
        chip: `${hero} vs ${opener}+${villain}`,
        title,
        situation,
        actions,
        strategy,
      })
      return null
    }
    if (node.raisesBefore === 3 && ctx.calls === 0 && node.actor === ctx.threeBettor) {
      category = 'vs-4bet'
      villain = pos[ctx.fourBettor]
      title = `${hero} 应对 ${villain} 4-bet`
      situation = `你 3-bet 后，${villain} 4-bet，轮到你。`
      spots.push({
        id: `${tree.n}p-${hero.toLowerCase()}-vs-${villain.toLowerCase()}-4bet`,
        category,
        hero,
        villain,
        title,
        situation,
        actions,
        strategy,
      })
      return null
    }
    return null
  }

  function walk(node: PfNode, ctx: WalkCtx) {
    if (node.type === 'terminal') return
    spotFrom(node, ctx)
    node.actions.forEach((a, i) => {
      const child = node.children[i]
      const next: WalkCtx = { ...ctx, node: child }
      if (a.kind === 'call') next.calls++
      if (a.kind === 'raise') {
        if (node.raisesBefore === 0) next.opener = node.actor
        if (node.raisesBefore === 1) next.threeBettor = node.actor
        if (node.raisesBefore === 2) next.fourBettor = node.actor
        next.raises++
        next.calls = 0 // 经典场景只关心「无人跟注」的线路；calls 在再加注后重置
      }
      // 只沿弃牌与加注路径走（经典场景），跟注路径的节点不生成 Spot 但仍可被 explorer 导航
      if (a.kind !== 'call') walk(child, next)
    })
  }

  walk(tree.root, {
    node: tree.root,
    raises: 0,
    calls: 0,
    opener: -1,
    threeBettor: -1,
    fourBettor: -1,
  })
  return spots
}
