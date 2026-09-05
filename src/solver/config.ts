import type { Position } from '../poker/ranges'

// ============ 各桌型位置表（翻前行动顺序）============
// N=2 时 BTN 兼任小盲、翻前先行动、翻后有位置
export const POSITIONS_BY_SIZE: Record<number, Position[]> = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['CO', 'BTN', 'SB', 'BB'],
  5: ['HJ', 'CO', 'BTN', 'SB', 'BB'],
  6: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  7: ['UTG', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  8: ['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
  9: ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
}

// 翻后行动顺序索引（越小越先行动；HU 特殊：BB 先动，BTN 有位置）
export function postflopOrder(positions: Position[]): number[] {
  const n = positions.length
  if (n === 2) return positions.map((p) => (p === 'BB' ? 0 : 1))
  const order: Position[] = ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN']
  return positions.map((p) => order.indexOf(p))
}

// ============ 加注阶梯 ============
export interface LadderConfig {
  stack: number // 起始筹码（bb）
  openSize: number // 开局加注到
  sbOpenSize: number // 小盲开局加注到
  threeBetIpMult: number // 有位置 3bet = 开局×3
  threeBetOopMult: number // 无位置 3bet = 开局×4
  squeezeBonus: number // 每个跟注者 +1bb
  fourBetMult: number // 4bet = 3bet×2.3
  maxRaises: number // 第 4 次加注 = 全下
}

export const DEFAULT_LADDER: LadderConfig = {
  stack: 100,
  openSize: 2.5,
  sbOpenSize: 3,
  threeBetIpMult: 3,
  threeBetOopMult: 4,
  squeezeBonus: 1,
  fourBetMult: 2.3,
  maxRaises: 4,
}

// ============ 权益实现系数（翻前叶子模型）============
export const REALIZATION = {
  lastToAct: 1.05, // 翻后最后行动
  firstToAct: 0.88, // 翻后最先行动
  middle: 0.95,
  multiwayPenaltyPerOpp: 0.95, // 每多一个对手
  sprNormalize: 4, // SPR<4 时向 1 收缩
  min: 0.7,
  max: 1.15,
  // 权益锐化：翻牌叶 share = e^γ/(e^γ+(1-e)^γ)。
  // 模拟翻后博弈中权益优势被放大（弱牌实现率远低于面值），只用于进翻牌的叶子，
  // 全下摊牌用精确权益。γ=1 退化为原始权益。
  sharpen: 1.6,
}

export function sharpenEquity(e: number, gamma = REALIZATION.sharpen): number {
  if (e <= 0) return 0
  if (e >= 1) return 1
  const a = Math.pow(e, gamma)
  const b = Math.pow(1 - e, gamma)
  return a / (a + b)
}

export function realizationFactor(
  postflopIdx: number,
  activePostflopIdxs: number[],
  spr: number,
): number {
  const sorted = [...activePostflopIdxs].sort((a, b) => a - b)
  let r: number
  if (postflopIdx === sorted[sorted.length - 1]) r = REALIZATION.lastToAct
  else if (postflopIdx === sorted[0]) r = REALIZATION.firstToAct
  else r = REALIZATION.middle
  r *= Math.pow(REALIZATION.multiwayPenaltyPerOpp, activePostflopIdxs.length - 2)
  if (spr < REALIZATION.sprNormalize) r = 1 + (r - 1) * (spr / REALIZATION.sprNormalize)
  return Math.min(REALIZATION.max, Math.max(REALIZATION.min, r))
}

// ============ 翻前 CFR 求解参数 ============
export const PREFLOP_CFR = {
  iterations: 600,
  averagingDelayFrac: 0.25, // 前 25% 迭代不计入平均策略（CFR+ 常规做法）
  pruneReachMass: 1e-7, // 对手 reach 质量乘积低于此则剪枝
  storeReachThreshold: 1e-4, // artifact 只存公共序列 reach 高于此的节点
  huExploitabilityTarget: 0.0025, // bb（即 0.25bb/100）
}

// ============ 翻后下注抽象预设 ============
export interface PostflopPreset {
  betSizes: number[] // 占底池比例
  raiseSizes: number[] // 加注（对方下注后）占底池比例；空=只有全下
  maxRaisesPerStreet: number
  iterations: { river: number; turn: number; flop: number }
  // 转牌求解中河牌子树（continuation）的粗化尺寸：单一尺寸、无加注。
  // 实战每街都会重解，continuation 只用于估值。
  contBetSizes: number[]
  // flop 深度受限叶的 runout 采样数（0 = 全部 1176 个）
  runoutSample: number
}

export const POSTFLOP_PRESETS: Record<'explorer' | 'trainer', PostflopPreset> = {
  explorer: {
    betSizes: [0.33, 0.75],
    raiseSizes: [0.6],
    maxRaisesPerStreet: 2,
    iterations: { river: 400, turn: 400, flop: 120 },
    contBetSizes: [0.75],
    runoutSample: 300,
  },
  trainer: {
    betSizes: [0.66],
    raiseSizes: [],
    maxRaisesPerStreet: 1,
    iterations: { river: 200, turn: 200, flop: 80 },
    contBetSizes: [0.66],
    runoutSample: 150,
  },
}
