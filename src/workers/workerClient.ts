import type { Card } from '../poker/cards'
import type { Street } from '../solver/postflop/tree'

// 翻后 worker 的 Promise 封装：进度回调 + 取消

export interface WorkerNode {
  id: number
  street: string
  actor: number
  actions: { kind: string; amount: number }[]
  strategy: Float32Array // 1326*A
  ev: Float32Array // 1326*A（bb）
}

export interface WorkerSolution {
  exploitability: number
  iterations: number
  nodes: WorkerNode[]
  root: WorkerNode // 本街首个决策节点（id 最小）
}

export interface SolveHandle {
  promise: Promise<WorkerSolution>
  cancel: () => void
}

export interface SolveRequest {
  street: Street
  board: Card[]
  pot: number
  stack: number
  preset: 'explorer' | 'trainer'
  oop: Float32Array
  ip: Float32Array
  iterations?: number
  onProgress?: (iter: number, total: number) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<
  number,
  {
    resolve: (s: WorkerSolution) => void
    reject: (e: Error) => void
    onProgress?: (iter: number, total: number) => void
  }
>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./postflop.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data
    const entry = pending.get(msg.id)
    if (!entry) return
    if (msg.type === 'progress') {
      entry.onProgress?.(msg.iter, msg.total)
    } else if (msg.type === 'done') {
      pending.delete(msg.id)
      const nodes: WorkerNode[] = msg.nodes.map(
        (n: { id: number; street: string; actor: number; actions: { kind: string; amount: number }[]; strategy: ArrayBuffer; ev: ArrayBuffer }) => ({
          ...n,
          strategy: new Float32Array(n.strategy),
          ev: new Float32Array(n.ev),
        }),
      )
      const root = nodes.reduce((a, b) => (a.id < b.id ? a : b))
      entry.resolve({ exploitability: msg.exploitability, iterations: msg.iterations, nodes, root })
    } else if (msg.type === 'error') {
      pending.delete(msg.id)
      entry.reject(new Error(msg.message))
    }
  }
  worker.onerror = (e) => {
    for (const [id, entry] of pending) {
      entry.reject(new Error(`worker 错误: ${e.message}`))
      pending.delete(id)
    }
  }
  return worker
}

export function solveInWorker(req: SolveRequest): SolveHandle {
  const id = nextId++
  const w = getWorker()
  const promise = new Promise<WorkerSolution>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: req.onProgress })
  })
  const oopBuf = req.oop.slice().buffer
  const ipBuf = req.ip.slice().buffer
  w.postMessage(
    {
      type: 'solve',
      id,
      spec: { street: req.street, board: req.board, pot: req.pot, stack: req.stack, preset: req.preset },
      oop: oopBuf,
      ip: ipBuf,
      iterations: req.iterations,
    },
    [oopBuf, ipBuf],
  )
  return {
    promise,
    cancel: () => {
      w.postMessage({ type: 'cancel', id })
    },
  }
}
