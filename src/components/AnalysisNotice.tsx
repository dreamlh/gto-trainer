import type { AnalysisContext } from '../analysis/types'
import type { SolverBlock } from '../analysis/replay'
import { useLanguage } from '../battle/i18n'

export function useSolverBlockLabel() {
  const { t } = useLanguage()
  return (reason: SolverBlock) => ({
    street: t('求解复盘支持翻牌、转牌和河牌的轮次起点。', 'Solver review starts at the beginning of the flop, turn or river.'),
    missing: t('此记录缺少起始筹码、盲注或轮次快照，无法还原求解局面。', 'This record is missing starting stacks, blinds or a street snapshot needed to reconstruct the solver state.'),
    multiway: t('当前是多人底池，不能作为单挑局面求解。', 'This is a multiway pot and cannot be solved as heads-up.'),
    allin: t('有玩家已全下，本轮没有完整的双方下注决策。可使用权益计算。', 'A player is all-in, so this street has no two-sided betting decision. Use equity instead.'),
    position: t('记录缺少行动位置，无法确定先后顺序。', 'The record has no positions to determine the action order.'),
  })[reason]
}
export function AnalysisNotice({ context, onClear }: { context: AnalysisContext; onClear?: () => void }) {
  const { t } = useLanguage()
  return <div className="analysis-context">
    <strong>{t('已导入复盘', 'Imported review')}: {context.title}</strong>
    {context.mode === 'tournament' && <p className="spot-desc">{t('锦标赛：按筹码价值分析，不包含 ICM。', 'Tournament: chip-value analysis, without ICM.')}</p>}
    {context.rangeUnconditioned && <p className="input-error">{t('范围仅按翻前行动推定，尚未按翻后行动收窄，请按需要调整。', 'Ranges are inferred from preflop only and are not narrowed by postflop actions. Adjust them as needed.')}</p>}
    {context.players.filter(p => !p.folded).length > 2 && <p className="input-error">{t('这里只比较选定两人的权益，不代表整个多人底池权益。', 'This compares only the selected pair, not equity in the entire multiway pot.')}</p>}
    {context.missingState && <p className="spot-desc">{t('旧记录信息不全：仅导入已保存的牌面和本人手牌，范围可点选设置。', 'This older record is incomplete. Saved board and own cards are imported; choose range presets as needed.')}</p>}
    {onClear && <button type="button" className="link-btn" onClick={onClear}>{t('退出复盘，编辑新局面', 'Leave review and edit a new spot')}</button>}
  </div>
}
