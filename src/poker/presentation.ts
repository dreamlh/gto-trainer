import type { Language } from '../battle/types'
import { CATEGORY_LABELS, type Spot } from './ranges'

// Translate legacy solver artifacts and saved labels at the display boundary.
// Strategies, IDs, input ranges and persisted records keep their original values.
const ACTION_NAMES: Record<string, [string, string]> = {
  fold: ['弃牌', 'Fold'], check: ['过牌', 'Check'], call: ['跟注', 'Call'],
  bet: ['下注', 'Bet'], raise: ['加注', 'Raise'], threebet: ['3-bet', '3-bet'],
  fourbet: ['4-bet', '4-bet'], fivebet: ['全下', 'All-in'],
  'all-in': ['全下', 'All-in'], allin: ['全下', 'All-in'], jam: ['全下', 'All-in'],
}
const CATEGORY_EN: Record<Spot['category'], string> = {
  rfi: 'Raise first in (RFI)', 'vs-rfi': 'Facing an open', 'vs-3bet': 'Facing a 3-bet',
  'cold-3bet': 'Blind cold-calls vs 3-bet', 'vs-4bet': 'Facing a 4-bet',
}

export function categoryName(category: Spot['category'], language: Language): string {
  return language === 'zh' ? CATEGORY_LABELS[category] : CATEGORY_EN[category]
}

export function positionName(value: string, language: Language): string {
  const positions: Record<string, [string, string]> = {
    按钮位: ['按钮位', 'Button'], 小盲位: ['小盲位', 'Small blind'], 大盲位: ['大盲位', 'Big blind'],
    枪口位: ['枪口位', 'Under the gun'], 劫机位: ['劫机位', 'Hijack'], 关煞位: ['关煞位', 'Cutoff'],
  }
  return positions[value]?.[language === 'zh' ? 0 : 1] ?? value.replace(/^UTG([12])$/, 'UTG+$1')
}

export function actionName(value: string, language: Language): string {
  const known = ACTION_NAMES[value.toLowerCase()]
    ?? Object.values(ACTION_NAMES).find(([zh, en]) => value === zh || value.toLowerCase() === en.toLowerCase())
  if (known) return known[language === 'zh' ? 0 : 1]
  if (language === 'zh') return value
  return value
    .replace(/^弃牌$/, 'Fold').replace(/^过牌$/, 'Check').replace(/^跟注\s*/, 'Call ')
    .replace(/^全下跟注\s*/, 'Call all-in ').replace(/^下注\s*/, 'Bet ').replace(/^加注(?:到|至)?\s*/, 'Raise to ')
    .replace(/^(3-bet|4-bet|5-bet)\s*至\s*/i, '$1 to ')
    .replace(/^全下\s*/, 'All-in ').trim()
}

export function postflopActionName(action: { kind: string; amount?: number }, language: Language): string {
  if (action.kind === 'bet') return `${language === 'zh' ? '下注' : 'Bet'} ${action.amount}`
  if (action.kind === 'raise') return `${language === 'zh' ? '加注到' : 'Raise to'} ${action.amount}`
  return actionName(action.kind, language)
}

const TEXT_EN: Record<string, string> = {
  '请输入范围': 'Enter a range',
  '请选择 3（翻牌）/ 4（转牌）/ 5（河牌）张公共牌': 'Select 3 (flop), 4 (turn), or 5 (river) board cards',
  '底池与筹码需为正数': 'The pot must be positive and the effective stack cannot be negative',
  '范围与公共牌完全冲突': 'A range has no combinations remaining after removing board cards',
  '公共牌请选 0、3、4 或 5 张（翻牌为 3 张）': 'Select 0, 3, 4, or 5 board cards (the flop has 3 cards)',
  '已取消': 'Cancelled', '路径越过终端': 'The action path goes beyond a terminal node',
  '需要 5 张公共牌': 'Five board cards are required',
  '超强牌 QQ+/AK': 'Premium QQ+/AK', '紧凶开局': 'Tight opening range', '按钮位开局': 'Button opening range',
  '单挑：你在按钮位（兼小盲），翻前先行动。': 'Heads-up: you are on the button (also the small blind) and act first preflop.',
  '你在 UTG（枪口位），轮到你第一个行动。加注 2.5bb 或弃牌？': 'You are under the gun (UTG) and first to act. Raise to 2.5bb or fold?',
  'UTG 弃牌，你在 HJ（劫机位）。加注 2.5bb 或弃牌？': 'UTG folds. You are in the hijack (HJ). Raise to 2.5bb or fold?',
  '前面全部弃牌，你在 CO（关煞位）。加注 2.5bb 或弃牌？': 'It folds to you in the cutoff (CO). Raise to 2.5bb or fold?',
  '前面全部弃牌，你在按钮位。加注 2.5bb 或弃牌？': 'It folds to you on the button. Raise to 2.5bb or fold?',
  '前面全部弃牌，你在小盲位（采用加注或弃牌策略）。加注 3bb 或弃牌？': 'It folds to you in the small blind (using a raise-or-fold strategy). Raise to 3bb or fold?',
  'BTN 加注至 2.5bb，SB 弃牌，轮到你在大盲位。': 'BTN raises to 2.5bb and SB folds. You are in the big blind.',
  'CO 加注至 2.5bb，BTN 和 SB 弃牌，轮到你在大盲位。': 'CO raises to 2.5bb; BTN and SB fold. You are in the big blind.',
  'UTG 加注至 2.5bb，其余全部弃牌，轮到你在大盲位。': 'UTG raises to 2.5bb and everyone else folds. You are in the big blind.',
  '前面全部弃牌，SB 加注至 3bb，轮到你在大盲位。': 'It folds to SB, who raises to 3bb. You are in the big blind.',
  'BTN 加注至 2.5bb，轮到你在小盲位（SB 采用 3-bet 或弃牌的常见简化策略，不平跟）。': 'BTN raises to 2.5bb. You are in the small blind (using a simplified 3-bet-or-fold strategy, without flat calls).',
  'CO 加注至 2.5bb，轮到你在按钮位。': 'CO raises to 2.5bb. You are on the button.',
  '你在 BTN 加注 2.5bb，SB 3-bet 至 10bb，BB 弃牌，轮到你。': 'You open to 2.5bb on BTN. SB 3-bets to 10bb and BB folds. Action is back on you.',
  '你在 CO 加注 2.5bb，BTN 3-bet 至 7.5bb，盲注弃牌，轮到你。': 'You open to 2.5bb in CO. BTN 3-bets to 7.5bb and the blinds fold. Action is back on you.',
  '你在 UTG 加注 2.5bb，其余弃牌，BB 3-bet 至 11bb，轮到你。': 'You open to 2.5bb in UTG. Everyone else folds and BB 3-bets to 11bb. Action is back on you.',
}

type TextRule = [RegExp, (...groups: string[]) => string]
const TEXT_RULES: TextRule[] = [
  [/^(\S+) 首入（RFI）$/, p => `${p} raise first in (RFI)`],
  [/^(\S+) 防守 vs (\S+) 开局$/, (hero, villain) => `${hero} vs ${villain} open`],
  [/^(\S+) 应对 (\S+) ([34]-bet)$/, (hero, villain, action) => `${hero} vs ${villain} ${action}`],
  [/^(\S+) 面对 (\S+) 开局 \+ (\S+) 3-bet（冷跟）$/, (hero, opener, villain) => `${hero} cold-call vs ${opener} open + ${villain} 3-bet`],
  [/^前面全部弃牌，你在 (\S+)。$/, p => `It folds to you in ${p}.`],
  [/^(\S+) 加注至 (\S+)bb，其余弃牌，轮到你（(\S+)）。$/, (p, amount, hero) => `${p} raises to ${amount}bb and everyone else folds. You are in ${hero}.`],
  [/^你在 (\S+) 开局加注，(\S+) 3-bet，其余弃牌，轮到你。$/, (hero, villain) => `You open in ${hero}. ${villain} 3-bets and everyone else folds. Action is back on you.`],
  [/^(\S+) 开局加注，(\S+) 3-bet，轮到你在 (\S+)（只能跟注或弃牌，不含冷 4-bet）。$/, (opener, villain, hero) => `${opener} opens and ${villain} 3-bets. You are in ${hero} (call or fold only; cold 4-bets are excluded).`],
  [/^你 3-bet 后，(\S+) 4-bet，轮到你。$/, villain => `You 3-bet and ${villain} 4-bets. Action is back on you.`],
  [/^(OOP|IP) 策略$/, actor => `${actor} strategy`],
  [/^(OOP|IP) (.+)$/, (actor, action) => `${actor} ${actionName(action, 'en')}`],
  [/^请为玩家 (\d+) 选择两张牌$/, player => `Select two cards for Player ${player}`],
  [/^玩家 (\d+) 范围有误：(.*)$/, (player, detail) => `Invalid range for Player ${player}: ${translatePokerText(detail, 'en')}`],
  [/^翻前解加载失败（(\d+) 人桌）: (.*)$/, (players, detail) => `Could not load the ${players}-player preflop solution: ${detail}`],
  [/^范围解析失败：(.*)$/, detail => `Could not parse the range: ${translatePokerText(detail, 'en')}`],
  [/^求解失败：(.*)$/, detail => `Solve failed: ${translatePokerText(detail, 'en')}`],
  [/^worker 错误: (.*)$/, detail => `Worker error: ${translatePokerText(detail, 'en')}`],
  [/^非法手牌: (.*)$/, spec => `Invalid hand: ${spec}`],
  [/^非法记法: (.*)$/, spec => `Invalid range notation: ${spec}`],
  [/^非法记法（间距不同）: (.*)$/, spec => `Range endpoints must have the same gap: ${spec}`],
  [/^无法解析: (.*)$/, spec => `Could not parse: ${spec}`],
  [/^非法频率: (.*)$/, spec => `Frequency must be greater than 0 and at most 1: ${spec}`],
  [/^未知场景: (.*)$/, id => `Unknown spot: ${id}`],
]

export function translatePokerText(text: string, language: Language): string {
  if (language === 'zh') return text
  if (TEXT_EN[text]) return TEXT_EN[text]
  for (const [pattern, format] of TEXT_RULES) {
    const match = text.match(pattern)
    if (match) return format(...match.slice(1))
  }
  return actionName(text, language)
}
