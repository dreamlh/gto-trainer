# GTO 德州扑克训练器 v2

纯浏览器的德州扑克 GTO 学习工具：**双层 CFR 求解**（翻前 169 手牌抽象预解 + 翻后单挑逐街 CFR+）、全牌局训练、数据统计与弱点分析。React + Vite + TypeScript，无后端、无额外运行时依赖。

## 功能

- **训练器**：2-9 人桌全牌局训练。翻前多人（机器人按预解均衡策略采样行动），恰好单挑进翻后时逐街在 Web Worker 中现场求解（翻牌 ~2s / 转牌 ~7s / 河牌 <1s），每个决策即时判分（GTO 频率 + EV 损失），牌局结算并入库。多人进翻后则只评翻前（多人翻后不存在可求解的 GTO）。支持只练翻前模式。
- **求解器**：任意翻后单挑局面的 CFR 求解——选公共牌、输入双方范围与底池/筹码，精细（33%/75%/全下，转牌约 1 分钟）或快速预设，结果以 13×13 矩阵展示（范围外置灰），可沿动作树导航，显示可利用度。
- **范围表**：2-9 人桌全部翻前场景（首入/面对开局/面对 3-bet/面对 4-bet，6-max 约 50 个、9-max 约 100 个节点），来自构建期预解的 artifact，加载即看。
- **权益计算**：手牌/范围 vs 手牌/范围蒙特卡洛（5 万次）。
- **数据统计**：牌局历史（IndexedDB），任意时间段的 VPIP/PFR/3-bet/弃于3-bet/C-bet/BB防守/BTN偷盲/河牌跟注/WTSD 等指标——每项都与**同样本 GTO 基线**对比（同样的局面下 solver 会怎么打），9 个弱点检测器给出中文改进建议（≥30 手激活）。

## 求解架构

- **翻前**：向量 CFR+（regret-matching+，线性平均），169 手牌抽象；动作阶梯 2.5bb 开局（SB 3bb）/3-bet/4-bet/5-bet 全下，无 limp、禁冷跟 3-bet；叶子估值 = 169×169 预计算权益矩阵 × 权益锐化（γ=1.6）× 位置实现系数。8 个桌型构建期预解并入库（`public/solutions/*.bin.gz`，共 ~900KB），HU 可利用度 <0.25bb/100。
- **翻后**：1326 组合向量 CFR+，河牌精确（排序牌力扫描 O(M) 摊牌评估 + 阻断牌容斥）；转牌全枚举 48 张河牌（河牌子树用粗化 continuation）；翻牌深度受限（发完热权益 × 实现系数，runout 采样）。跑在 Web Worker，支持进度与取消。
- 已知近似：多人 CFR 无纳什保证、翻前叶子模型是启发式、翻牌层较粗（靠逐街重解弥补）。定位是学习工具，精度不及商用 solver。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 生产构建
```

## 重新生成求解数据（改了 solver 参数后）

```bash
npx tsx scripts/gen-equity169.ts 100000   # 169×169 权益矩阵（~5 分钟）
npx tsx scripts/solve-preflop.ts          # 预解 2-9 人桌（~20 分钟）
```

## 测试

```bash
npx tsx scripts/test-logic.ts      # 快：解析/评估器/权益/引擎
npx tsx scripts/test-stats.ts      # 快：统计与弱点检测（合成数据）
npx tsx scripts/test-solver.ts     # 慢：翻前 CFR 收敛带（现场求解 HU+6max，~2 分钟）
npx tsx scripts/test-postflop.ts   # 慢：翻后 CFR（暴力对拍/玩具博弈解析解/性能预算，~3 分钟）
```
