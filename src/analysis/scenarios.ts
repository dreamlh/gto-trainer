import type { PreflopBundle } from '../solver/preflop/api'
import type { PfNode } from '../solver/preflop/tree'
import { postflopOrder } from '../solver/config'
import type { Position } from '../poker/ranges'
import { classRange } from './ranges'
import type { AnalysisRange } from './types'

export interface ScenarioSelection { n: number; opener: Position; defender: Position; raises: 1 | 2 | 3 }
export interface RangeScenario {
  selection: ScenarioSelection
  positions: [Position, Position]
  ranges: [AnalysisRange, AnalysisRange]
  pot: number
  stack: number
}
export const DEFAULT_SCENARIO: ScenarioSelection = { n: 6, opener: 'BTN', defender: 'BB', raises: 1 }

/** Follow the full tree, multiplying each participant's earlier action frequencies. */
export function scenarioFromBundle(bundle: PreflopBundle, selection: ScenarioSelection): RangeScenario | null {
  const { tree } = bundle
  const opener = tree.positions.indexOf(selection.opener), defender = tree.positions.indexOf(selection.defender)
  if (bundle.n !== selection.n || opener < 0 || defender < 0 || opener === defender) return null
  const ranges = Array.from({ length: tree.n }, () => new Float32Array(169).fill(1))
  let node: PfNode = tree.root
  while (node.type === 'decision') {
    const actor = node.actor
    let kind: 'fold' | 'raise' | 'call' = 'fold'
    if (node.raisesBefore === 0 && actor === opener) kind = 'raise'
    else if (node.raisesBefore === 1 && actor === defender) kind = selection.raises > 1 ? 'raise' : 'call'
    else if (node.raisesBefore === 2 && actor === opener) kind = selection.raises > 2 ? 'raise' : 'call'
    else if (node.raisesBefore === 3 && actor === defender) kind = 'call'
    const a = node.actions.findIndex(action => action.kind === kind)
    if (a < 0) return null
    if (actor === opener || actor === defender) {
      if (kind === 'fold') return null
      const frequencies = bundle.freq.get(node.id)
      if (!frequencies) return null
      for (let h = 0; h < 169; h++) ranges[actor][h] *= frequencies[h * node.actions.length + a]
    }
    node = node.children[a]
  }
  if (node.kind !== 'flop' || node.active.length !== 2 || !node.active.includes(opener) || !node.active.includes(defender)) return null
  const order = postflopOrder(tree.positions)
  const seats = [opener, defender].sort((a, b) => order[a] - order[b])
  const vectors = seats.map(seat => classRange(ranges[seat], 'scenario')) as [AnalysisRange, AnalysisRange]
  if (vectors.some(range => !range.weights.some(w => w > 0))) return null
  return { selection, positions: seats.map(s => tree.positions[s]) as [Position, Position], ranges: vectors,
    pot: node.pot, stack: Math.min(...seats.map(s => tree.ladder.stack - node.invested[s])) }
}
