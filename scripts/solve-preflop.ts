// 构建期预解翻前：npx tsx scripts/solve-preflop.ts [人数列表，默认 2..9]
// 输出 public/solutions/preflop-{n}p-100bb.bin.gz

import { mkdirSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { DEFAULT_LADDER, PREFLOP_CFR } from '../src/solver/config'
import { solvePreflop } from '../src/solver/preflop/cfr'
import { encodeSolution } from '../src/solver/preflop/serialize'
import { buildPreflopTree } from '../src/solver/preflop/tree'

const sizes = process.argv[2] ? process.argv[2].split(',').map(Number) : [2, 3, 4, 5, 6, 7, 8, 9]
const outDir = new URL('../public/solutions/', import.meta.url)
mkdirSync(outDir, { recursive: true })

for (const n of sizes) {
  const tree = buildPreflopTree(n, DEFAULT_LADDER)
  if (tree.decisionNodes.length > 30000) {
    throw new Error(`${n} 人树 ${tree.decisionNodes.length} 节点超出 3 万预算`)
  }
  console.log(`[${n}人] 决策节点 ${tree.decisionNodes.length}，开始求解…`)
  const t0 = Date.now()
  const sol = solvePreflop(tree, {
    onProgress: (it, total) => {
      if (it % 100 === 0)
        console.log(`  [${n}人] ${it}/${total}，${((Date.now() - t0) / 1000) | 0}s`)
    },
  })
  const raw = encodeSolution(sol, PREFLOP_CFR.storeReachThreshold)
  const gz = gzipSync(raw, { level: 9 })
  const path = new URL(`preflop-${n}p-100bb.bin.gz`, outDir)
  writeFileSync(path, gz)
  console.log(
    `[${n}人] 完成，耗时 ${((Date.now() - t0) / 1000) | 0}s` +
      (sol.exploitability !== undefined ? `，可利用度 ${sol.exploitability.toFixed(4)}bb` : '') +
      `，artifact ${(raw.length / 1024) | 0}KB → gzip ${(gz.length / 1024) | 0}KB`,
  )
}
console.log('全部完成')
