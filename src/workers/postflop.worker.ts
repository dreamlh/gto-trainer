import { POSTFLOP_PRESETS } from '../solver/config'
import { solvePostflop } from '../solver/postflop/cfr'
import { buildPostflopTree, type PostSpec } from '../solver/postflop/tree'

// 翻后求解 worker。协议：
// -> {type:'solve', id, spec:{street,board,pot,stack,preset}, oop:ArrayBuffer, ip:ArrayBuffer, iterations?}
// <- {type:'progress', id, iter, total}
// <- {type:'done', id, exploitability, iterations, nodes:[{id,street,actor,actions,strategy,ev}]}
// <- {type:'error', id, message}
// -> {type:'cancel', id}

interface SolveMsg {
  type: 'solve'
  id: number
  spec: { street: PostSpec['street']; board: number[]; pot: number; stack: number; preset: keyof typeof POSTFLOP_PRESETS }
  oop: ArrayBuffer
  ip: ArrayBuffer
  iterations?: number
}

const cancelled = new Set<number>()

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as SolveMsg | { type: 'cancel'; id: number }
  if (msg.type === 'cancel') {
    cancelled.add(msg.id)
    return
  }
  if (msg.type !== 'solve') return
  const { id } = msg
  try {
    const preset = POSTFLOP_PRESETS[msg.spec.preset]
    const spec: PostSpec = {
      street: msg.spec.street,
      board: msg.spec.board,
      pot: msg.spec.pot,
      stack: msg.spec.stack,
      preset,
    }
    const tree = buildPostflopTree(spec)
    const sol = await solvePostflop(tree, new Float32Array(msg.oop), new Float32Array(msg.ip), {
      iterations: msg.iterations,
      yieldEvery: 5,
      onProgress: (iter, total) => self.postMessage({ type: 'progress', id, iter, total }),
      shouldStop: () => cancelled.has(id),
    })
    if (cancelled.has(id)) {
      cancelled.delete(id)
      self.postMessage({ type: 'error', id, message: 'cancelled' })
      return
    }
    // 只传本街节点（转牌解不含河牌子树——实战逐街重解）
    const nodes: {
      id: number
      street: string
      actor: number
      actions: { kind: string; amount: number }[]
      strategy: ArrayBuffer
      ev: ArrayBuffer
    }[] = []
    const transfers: ArrayBuffer[] = []
    for (const nd of tree.decisionNodes) {
      if (nd.street !== spec.street) continue
      const strategy = sol.avgStrategy.get(nd.id)!
      const ev = sol.evByAction.get(nd.id)!
      const sBuf = strategy.slice().buffer
      const eBuf = ev.slice().buffer
      nodes.push({
        id: nd.id,
        street: nd.street,
        actor: nd.actor,
        actions: nd.actions.map((a) => ({ kind: a.kind, amount: a.amount })),
        strategy: sBuf,
        ev: eBuf,
      })
      transfers.push(sBuf, eBuf)
    }
    self.postMessage(
      { type: 'done', id, exploitability: sol.exploitability, iterations: sol.iterations, nodes },
      { transfer: transfers },
    )
  } catch (err) {
    self.postMessage({ type: 'error', id, message: (err as Error).message })
  }
}
