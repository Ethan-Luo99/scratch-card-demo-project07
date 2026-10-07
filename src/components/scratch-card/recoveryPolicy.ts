/**
 * onShow 画布回收后的恢复策略决策（纯逻辑，不 import 任何 uni / DOM API）。
 *
 * 三级兜底（本轮进度保留升级）：
 * 1. bitmap —— onHide 已导出位图：新节点上 drawImage 整体恢复，ratio 与网格均不回退。
 * 2. replay —— 位图不可用（App 旧内核无导出能力 / onHide 时未发起导出）：
 *              buildReplayCommand 网格圆点重放。
 * 3. fresh  —— 位图导出失败（尝试过但无快照）或位图恢复失败：
 *              静默降级回「重置为新卡」（旧语义），不报错、不留脏状态。
 */

import type { BitmapSnapshot } from './types'

export type RecoveryTier = 'bitmap' | 'replay' | 'fresh'

export interface RecoveryDecisionInput {
  /** 旧内核 createCanvasContext 分支：不具备位图导出/恢复能力 */
  legacy: boolean
  /** onHide 是否尝试过导出位图（区分「没能力/没机会」与「有能力但失败」） */
  exportAttempted: boolean
  /** 内存中是否持有可用位图快照（导出成功的唯一标志） */
  snapshot: BitmapSnapshot | null
}

/** 选择恢复策略（位图恢复前调用）。 */
export function decideRecoveryTier(input: RecoveryDecisionInput): RecoveryTier {
  if (input.legacy) return 'replay'
  if (input.snapshot) return 'bitmap'
  if (input.exportAttempted) {
    // 节点式内核上导出被尝试过却拿不到快照：按失败处理，直接重置为新卡。
    return 'fresh'
  }
  // 未尝试导出（如 onHide 时 surface 尚未就绪/已为空）：网格圆点二级兜底。
  return 'replay'
}

/** 位图恢复动作失败后的回退策略：按约束降级回「重置为新卡」，不报错、不留脏状态。 */
export function fallbackAfterRestoreFailure(): RecoveryTier {
  return 'fresh'
}

/** 二级兜底网格重放拿不到指令时：无进度可恢复，直接发新卡。 */
export function tierAfterReplayUnavailable(): RecoveryTier {
  return 'fresh'
}
