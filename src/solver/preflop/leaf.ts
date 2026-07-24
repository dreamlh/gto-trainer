import { EQ169, CC169 } from '../../gen/equity169'
import { HAND_NAMES, comboCount } from '../../poker/cards'

// 阻断牌加权矩阵：
// BETA[h][h']  = 兼容组合对占比 = CC[h][h'] / (n_h · n_h')
// BETAEQ[h][h'] = BETA × EQ（h 对 h' 的权益，已按兼容度加权）
// reach 向量以 q(h)=n_h/1326 为基准初始化，则
//   matvec(BETA, r_j)(h)   = 对手 j 与 h 兼容的到达质量 M_j(h)
//   matvec(BETAEQ, r_j)(h) = e_pj(h)·M_j(h)（权益×质量）

const N_COMBOS = HAND_NAMES.map(comboCount)

export const BETA = (() => {
  const a = new Float32Array(169 * 169)
  for (let i = 0; i < 169; i++)
    for (let j = 0; j < 169; j++) a[i * 169 + j] = CC169[i * 169 + j] / (N_COMBOS[i] * N_COMBOS[j])
  return a
})()

export const BETAEQ = (() => {
  const a = new Float32Array(169 * 169)
  for (let i = 0; i < 169; i++)
    for (let j = 0; j < 169; j++) a[i * 169 + j] = BETA[i * 169 + j] * EQ169[i * 169 + j]
  return a
})()

// 基准手牌分布 q(h) = n_h / 1326
export const BASE_DIST = (() => {
  const a = new Float32Array(169)
  for (let h = 0; h < 169; h++) a[h] = N_COMBOS[h] / 1326
  return a
})()

// out[h] = Σ_h' M[h*169+h'] · w[h']
export function matvec169(M: Float32Array, w: Float32Array, out: Float32Array): void {
  for (let h = 0; h < 169; h++) {
    let acc = 0
    const row = h * 169
    for (let k = 0; k < 169; k++) acc += M[row + k] * w[k]
    out[h] = acc
  }
}

export function vecSum(v: Float32Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]
  return s
}
