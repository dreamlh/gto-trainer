// 构建期预解翻前：npx tsx scripts/solve-preflop.ts [人数列表，默认 2..9]
// 输出 public/solutions/preflop-{n}p-100bb.bin.gz
// 多个桌型互相独立，各起一个子进程并行求解（wall-clock ≈ 最大的那个桌型）；
// 传单个人数时在本进程求解。SOLVE_SERIAL=1 强制串行。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { DEFAULT_LADDER, PREFLOP_CFR } from '../src/solver/config'
import { solvePreflop } from '../src/solver/preflop/cfr'
import { encodeSolution } from '../src/solver/preflop/serialize'
import { buildPreflopTree } from '../src/solver/preflop/tree'

const sizes = process.argv[2] ? process.argv[2].split(',').map(Number) : [2, 3, 4, 5, 6, 7, 8, 9]
const outDir = new URL('../public/solutions/', import.meta.url)
mkdirSync(outDir, { recursive: true })

function solveOne(n: number) {
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

function solveInChild(n: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), String(n)],
      { stdio: 'inherit', env: { ...process.env, SOLVE_CHILD: '1' } },
    )
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`[${n}人] 子进程退出码 ${code}`))
    })
  })
}

const t0 = Date.now()
if (sizes.length === 1 || process.env.SOLVE_SERIAL) {
  for (const n of sizes) solveOne(n)
} else {
  // 大的先起，避免最后只剩一个大桌型在跑
  const results = await Promise.allSettled([...sizes].sort((a, b) => b - a).map(solveInChild))
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length > 0) {
    for (const f of failed) console.error((f as PromiseRejectedResult).reason)
    process.exit(1)
  }
}
if (!process.env.SOLVE_CHILD) console.log(`全部完成，总耗时 ${((Date.now() - t0) / 1000) | 0}s`)
