// 生成 169×169 翻前权益矩阵 -> src/gen/equity169.ts
// 用法：npx tsx scripts/gen-equity169.ts [每对采样数=30000]
// EQ[i*169+j] = 手牌类 i 对 j 的平均权益（胜+平/2，对所有不冲突组合对与随机公共牌平均）
// CC[i*169+j] = 不冲突组合对的精确计数（阻断牌加权用）

import { writeFileSync } from 'node:fs'
import { HAND_NAMES, combosForHand } from '../src/poker/cards'
import { evaluate } from '../src/poker/evaluator'

const SAMPLES = parseInt(process.argv[2] ?? '30000', 10)

const combos = HAND_NAMES.map(combosForHand)

const EQ = new Float32Array(169 * 169)
const CC = new Uint16Array(169 * 169)

// 精确组合对计数
for (let i = 0; i < 169; i++) {
  for (let j = 0; j < 169; j++) {
    let n = 0
    for (const [a, b] of combos[i])
      for (const [c, d] of combos[j]) if (a !== c && a !== d && b !== c && b !== d) n++
    CC[i * 169 + j] = n
  }
}

// 蒙特卡洛权益：组合对循环分层，公共牌印章法拒绝采样
const stamp = new Int32Array(52).fill(-1)
const hand1 = new Int32Array(7)
const hand2 = new Int32Array(7)
let stampCounter = 0

function pairEquity(pairs: Int32Array, nPairs: number, samples: number): number {
  let win = 0
  let tie = 0
  for (let s = 0; s < samples; s++) {
    const p = (s % nPairs) * 4
    const a = pairs[p]
    const b = pairs[p + 1]
    const c = pairs[p + 2]
    const d = pairs[p + 3]
    const st = stampCounter++
    stamp[a] = st
    stamp[b] = st
    stamp[c] = st
    stamp[d] = st
    hand1[0] = a
    hand1[1] = b
    hand2[0] = c
    hand2[1] = d
    for (let k = 2; k < 7; k++) {
      let card
      do {
        card = (Math.random() * 52) | 0
      } while (stamp[card] === st)
      stamp[card] = st
      hand1[k] = card
      hand2[k] = card
    }
    const s1 = evaluate(hand1)
    const s2 = evaluate(hand2)
    if (s1 > s2) win++
    else if (s1 === s2) tie++
  }
  return (win + tie / 2) / samples
}

const t0 = Date.now()
const pairBuf = new Int32Array(6 * 16 * 4)
for (let i = 0; i < 169; i++) {
  for (let j = i; j < 169; j++) {
    const idx = i * 169 + j
    if (i === j) {
      EQ[idx] = 0.5 // 镜像对称
      continue
    }
    if (CC[idx] === 0) {
      EQ[idx] = 0.5
      EQ[j * 169 + i] = 0.5
      continue
    }
    let n = 0
    for (const [a, b] of combos[i])
      for (const [c, d] of combos[j])
        if (a !== c && a !== d && b !== c && b !== d) {
          pairBuf[n * 4] = a
          pairBuf[n * 4 + 1] = b
          pairBuf[n * 4 + 2] = c
          pairBuf[n * 4 + 3] = d
          n++
        }
    const e = pairEquity(pairBuf, n, SAMPLES)
    EQ[idx] = e
    EQ[j * 169 + i] = 1 - e
  }
  if ((i + 1) % 13 === 0) {
    const pct = (((i + 1) * (338 - i)) / 2 / 14365) * 100
    console.log(`行 ${i + 1}/169（约 ${pct.toFixed(0)}%），已用 ${((Date.now() - t0) / 1000) | 0}s`)
  }
}

function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64')
}

const out = `// 自动生成：npx tsx scripts/gen-equity169.ts ${SAMPLES}
// 生成时间 ${new Date().toISOString()}，每对采样 ${SAMPLES}
// EQ169[i*169+j] = 手牌类 i vs j 的平均权益；CC169 = 不冲突组合对数
/* eslint-disable */

const nodeBuffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer

function b64ToBytes(b64: string): Uint8Array {
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(b64, 'base64'))
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const EQ_B64 = '${toBase64(EQ.buffer)}'
const CC_B64 = '${toBase64(CC.buffer)}'

export const EQ169: Float32Array = new Float32Array(b64ToBytes(EQ_B64).buffer)
export const CC169: Uint16Array = new Uint16Array(b64ToBytes(CC_B64).buffer)
`

writeFileSync(new URL('../src/gen/equity169.ts', import.meta.url), out)
console.log(`完成，总耗时 ${((Date.now() - t0) / 1000) | 0}s，已写入 src/gen/equity169.ts`)
