import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { actionName, categoryName, positionName, postflopActionName, translatePokerText } from '../src/poker/presentation'
import { SPOTS, type Spot } from '../src/poker/ranges'
import { parseRange } from '../src/poker/rangeParser'
import { bundleFromArtifact } from '../src/solver/preflop/api'
import { RangeChart } from '../src/components/RangeChart'
import { RangeViewer } from '../src/components/RangeViewer'
import { SolverExplorer } from '../src/components/SolverExplorer'
import { EquityCalc } from '../src/components/EquityCalc'
import { setLanguage } from '../src/battle/i18n'

const hasChinese = /[\u3400-\u9fff]/u
function english(text: string, context = text): void {
  assert.ok(!hasChinese.test(text), `Untranslated text (${context}): ${text}`)
  assert.ok(text.length > 0, `Empty English text (${context})`)
}

const actionCases = [
  ['弃牌', 'Fold'], ['过牌', 'Check'], ['跟注', 'Call'], ['下注 12.5', 'Bet 12.5'],
  ['加注到 20', 'Raise to 20'], ['加注至 2.5bb', 'Raise to 2.5bb'],
  ['3-bet 至 8bb', '3-bet to 8bb'], ['4-bet 至 22bb', '4-bet to 22bb'],
  ['全下', 'All-in'], ['全下 97.5', 'All-in 97.5'], ['jam', 'All-in'], ['all-in', 'All-in'],
]
for (const [input, expected] of actionCases) assert.equal(actionName(input, 'en'), expected)
assert.equal(actionName('check', 'zh'), '过牌')
assert.equal(actionName('下注 12.5', 'zh'), '下注 12.5')
assert.equal(actionName('Custom action', 'en'), 'Custom action')
assert.equal(positionName('UTG1', 'en'), 'UTG+1')
assert.equal(positionName('大盲位', 'en'), 'Big blind')
assert.equal(postflopActionName({ kind: 'raise', amount: 24.75 }, 'en'), 'Raise to 24.75')
assert.equal(postflopActionName({ kind: 'check' }, 'en'), 'Check')
assert.equal(translatePokerText('OOP 加注到 24.75', 'en'), 'OOP Raise to 24.75')

let spotCount = 0
const coveredCategories = new Set<Spot['category']>()
function checkSpot(spot: Spot): void {
  const original = JSON.stringify(spot)
  english(translatePokerText(spot.title, 'en'), spot.id)
  english(translatePokerText(spot.situation, 'en'), spot.id)
  english(categoryName(spot.category, 'en'))
  for (const { label } of spot.actions) english(actionName(label, 'en'), `${spot.id} action`)
  assert.equal(translatePokerText(spot.title, 'zh'), spot.title)
  assert.equal(translatePokerText(spot.situation, 'zh'), spot.situation)
  assert.equal(JSON.stringify(spot), original, 'Presentation must not mutate source data')
  coveredCategories.add(spot.category)
  spotCount++
}
SPOTS.forEach(checkSpot)
for (let players = 2; players <= 9; players++) {
  const bytes = gunzipSync(readFileSync(new URL(`../public/solutions/preflop-${players}p-100bb.bin.gz`, import.meta.url)))
  const bundle = bundleFromArtifact(bytes)
  assert.ok(bundle.spots.length > 0, `${players}-player artifact has spots`)
  bundle.spots.forEach(checkSpot)
}
assert.equal(coveredCategories.size, 5)

// Exercise real parser failures and nested solver/equity error wrappers, not copied translations.
for (const input of ['22s', '2As', '2As+', 'AJs-ATo', 'T9s-75s', 'wat', 'AA:1.2']) {
  let error: string | undefined
  try { parseRange(input) } catch (cause) { error = (cause as Error).message }
  assert.ok(error, `${input} should be rejected by the parser`)
  english(translatePokerText(error, 'en'))
  english(translatePokerText(`范围解析失败：${error}`, 'en'))
  english(translatePokerText(`玩家 2 范围有误：${error}`, 'en'))
  assert.equal(translatePokerText(error, 'zh'), error)
}
for (const text of [
  '请输入范围', '请为玩家 1 选择两张牌', '公共牌请选 0、3、4 或 5 张（翻牌为 3 张）',
  '请选择 3（翻牌）/ 4（转牌）/ 5（河牌）张公共牌', '底池与筹码需为正数', '范围与公共牌完全冲突',
  '翻前解加载失败（9 人桌）: HTTP 404', '求解失败：需要 5 张公共牌', '已取消',
  '超强牌 QQ+/AK', '紧凶开局', '按钮位开局',
]) english(translatePokerText(text, 'en'))
assert.equal(translatePokerText('Network disconnected', 'en'), 'Network disconnected')

// SSR smoke checks catch hard-coded copy in the actual components and legends.
Object.assign(globalThis, {
  window: new EventTarget(),
  document: { documentElement: { lang: '' } },
  localStorage: { getItem: () => null, setItem: () => {} },
})
setLanguage('en')
for (const Component of [RangeViewer, SolverExplorer, EquityCalc]) {
  english(renderToStaticMarkup(createElement(Component)), Component.name)
}
const chart = () => renderToStaticMarkup(createElement(RangeChart, {
  spot: SPOTS[0], weights: new Map([['AA', 6]]), actionLabels: { raise: '加注到 12.5', fold: '弃牌' },
}))
const englishChart = chart()
english(englishChart)
assert.match(englishChart, /Raise to 12.5/)
setLanguage('zh')
assert.match(chart(), /加注到 12.5/)
setLanguage('en')
assert.equal(chart(), englishChart, 'Switching languages preserves source strategy and labels')
console.log(`Poker presentation passed: ${spotCount} real/fallback spots across 2–9 players, 5 categories, action labels, parser/solver/equity errors and bilingual component renders.`)
