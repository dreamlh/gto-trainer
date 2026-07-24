import type { LadderConfig } from '../config'
import type { PreflopSolution } from './cfr'

// Artifact 二进制格式：
// [4B header 长度][header JSON][逐节点: 4B nodeId | 1B A | Uint8 freq[169*A] | Int16 ev[169*A](0.01bb)]
// 树结构不存——由相同的 ladder 配置确定性重建

export interface ArtifactHeader {
  v: 1
  n: number
  ladder: LadderConfig
  iterations: number
  exploitability?: number
  nodeCount: number
  storedCount: number
}

const EV_SCALE = 100 // 0.01bb
const EV_CLAMP = 32000

export function encodeSolution(sol: PreflopSolution, reachThreshold: number): Uint8Array {
  const stored = sol.tree.decisionNodes.filter(
    (nd) => (sol.nodeReach.get(nd.id) ?? 0) >= reachThreshold,
  )
  const header: ArtifactHeader = {
    v: 1,
    n: sol.tree.n,
    ladder: sol.tree.ladder,
    iterations: sol.iterations,
    exploitability: sol.exploitability,
    nodeCount: sol.tree.decisionNodes.length,
    storedCount: stored.length,
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  let size = 4 + headerBytes.length
  for (const nd of stored) size += 4 + 1 + 169 * nd.actions.length * 3

  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)
  view.setUint32(0, headerBytes.length, true)
  buf.set(headerBytes, 4)
  let off = 4 + headerBytes.length
  for (const nd of stored) {
    const A = nd.actions.length
    view.setUint32(off, nd.id, true)
    off += 4
    buf[off++] = A
    const freq = sol.avgStrategy.get(nd.id)!
    for (let i = 0; i < 169 * A; i++) buf[off++] = Math.round(freq[i] * 255)
    const ev = sol.evByAction.get(nd.id)!
    for (let i = 0; i < 169 * A; i++) {
      const q = Math.max(-EV_CLAMP, Math.min(EV_CLAMP, Math.round(ev[i] * EV_SCALE)))
      view.setInt16(off, q, true)
      off += 2
    }
  }
  return buf
}

export interface DecodedArtifact {
  header: ArtifactHeader
  freq: Map<number, Float32Array> // nodeId -> 169*A（解码时重新归一化）
  ev: Map<number, Float32Array> // nodeId -> 169*A（bb）
}

export function decodeSolution(buf: Uint8Array): DecodedArtifact {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const headerLen = view.getUint32(0, true)
  const header: ArtifactHeader = JSON.parse(
    new TextDecoder().decode(buf.subarray(4, 4 + headerLen)),
  )
  const freq = new Map<number, Float32Array>()
  const ev = new Map<number, Float32Array>()
  let off = 4 + headerLen
  for (let k = 0; k < header.storedCount; k++) {
    const nodeId = view.getUint32(off, true)
    off += 4
    const A = buf[off++]
    const f = new Float32Array(169 * A)
    for (let h = 0; h < 169; h++) {
      let s = 0
      for (let a = 0; a < A; a++) s += buf[off + h * A + a]
      for (let a = 0; a < A; a++) f[h * A + a] = s > 0 ? buf[off + h * A + a] / s : 1 / A
    }
    off += 169 * A
    const e = new Float32Array(169 * A)
    for (let i = 0; i < 169 * A; i++) {
      e[i] = view.getInt16(off, true) / EV_SCALE
      off += 2
    }
    freq.set(nodeId, f)
    ev.set(nodeId, e)
  }
  return { header, freq, ev }
}
