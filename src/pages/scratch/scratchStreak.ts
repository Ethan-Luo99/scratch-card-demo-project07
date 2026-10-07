/**
 * 连刮 3 次活动：期次状态机 + 期次级幂等（纯逻辑，不 import 任何 uni / DOM API）。
 *
 * 页面职责仍在 pages/scratch/index.vue；本文件只承载可在 Node 下单测的规则：
 * - 本地 3 张奖券池（id 互不相同）；
 * - 幂等键从 prizeId 升级为 prizeId+期次（settleKey / 补偿队列 / 标记 / completeCount）；
 * - 前一张处于 Revealed 未结算完成时禁止发下一张；
 * - Failed 只阻塞当前期次，重试只重发当前期次，不影响已完成期次结算状态。
 */

import type { PrizeInfo } from '@/components/scratch-card/types'

/** 连刮活动总期次 */
export const STREAK_TOTAL = 3
/** 结算完成后自动挂载下一张的延迟 */
export const NEXT_CARD_DELAY_MS = 800

/** 活动阶段（与单卡 ScratchStatus 正交） */
export type StreakStage =
  | 'loading'
  | 'ready'
  | 'revealed'
  | 'failed'
  | 'finished'

export interface StreakState {
  /** 当前期次，1 起 */
  period: number
  stage: StreakStage
}

export function createStreakState(): StreakState {
  return { period: 1, stage: 'loading' }
}

/** 本地券池：3 张奖品 id 互不相同（mock，接入后端时由接口下发）。 */
export function buildLocalPrizePool(): PrizeInfo[] {
  return [
    { id: 8801, title: '优惠券 ¥10', subTitle: '满 100 可用' },
    { id: 8802, title: '优惠券 ¥20', subTitle: '满 200 可用' },
    { id: 8803, title: '优惠券 ¥50', subTitle: '满 500 可用' },
  ]
}

/**
 * 期次迁移：允许时返回新状态，否则返回 null（状态机非法转移保护）。
 * loading→loading 为「同阶段重入」（初次挂载/防御性重发），语义合法但状态不变。
 */
export function transitionStreak(
  state: StreakState,
  stage: StreakStage,
): StreakState | null {
  if (state.stage === 'finished') return stage === 'finished' ? state : null
  if (stage === 'loading') {
    // loading 可从任意非结束态进入（含自身，代表重发当前期）。
    return { period: state.period, stage: 'loading' }
  }
  const allowed: Record<StreakStage, StreakStage[]> = {
    loading: ['ready', 'failed'],
    ready: ['revealed', 'failed'],
    revealed: ['failed'],
    failed: [],
    finished: [],
  }
  if (!allowed[state.stage].includes(stage)) return null
  return { period: state.period, stage }
}

/**
 * 是否允许挂载下一张：
 * - 当前期次已到 Revealed（结算完成由页面标记后调用）；
 * - 还没刮满 STREAK_TOTAL 期。
 * 前一张 Revealed 未结算完成时页面不得调用本函数（settlePending 守卫在页面侧）。
 */
export function canMountNext(state: StreakState): boolean {
  return (
    state.stage === 'revealed' &&
    state.period >= 1 &&
    state.period < STREAK_TOTAL
  )
}

/** 挂载下一张：期次 +1 回到 loading（重新走 Loading→Idle 全流程）。 */
export function advanceToNextPeriod(state: StreakState): StreakState {
  return { period: state.period + 1, stage: 'loading' }
}

/** 最后一期结算完成 → 活动结束态。 */
export function finishStreak(state: StreakState): StreakState {
  return { period: state.period, stage: 'finished' }
}

/** 活动是否已结束。 */
export function isStreakFinished(state: StreakState): boolean {
  return state.stage === 'finished' || state.period > STREAK_TOTAL
}

/* ---------------- 期次级幂等 ---------------- */

export interface SettleRecord {
  prizeId: string | number
  /** 期次（幂等键的一部分） */
  period: number
  ts: number
}

/**
 * 幂等键：prizeId + 期次。
 * 连刮池中不同期奖品 id 已不同，叠加 period 后即使后端复用同一 prizeId 也不串单。
 */
export function settleKey(prizeId: string | number, period: number): string {
  return String(prizeId) + ':' + period
}

/** 结算幂等标记的 storage key（期次级）。 */
export function settleFlagKey(prizeId: string | number, period: number): string {
  return 'scratch_settled_' + settleKey(prizeId, period)
}

/** 补偿队列入队去重：同一 (prizeId, period) 只保留一条。 */
export function enqueueSettleRecord(
  queue: SettleRecord[],
  record: SettleRecord,
): SettleRecord[] {
  if (
    queue.some(
      (r) => r.period === record.period && r.prizeId === record.prizeId,
    )
  ) {
    return queue
  }
  return [...queue, record]
}

/** 单期结算完成守卫：同一期 complete 只结算一次。 */
export class PeriodCompleteGuard {
  private settledPeriods = new Set<number>()

  /** 是否已处理过该期 complete。 */
  has(period: number): boolean {
    return this.settledPeriods.has(period)
  }

  /** 标记该期已处理；返回 false 表示重复进入（调用方应直接放弃）。 */
  mark(period: number): boolean {
    if (this.settledPeriods.has(period)) return false
    this.settledPeriods.add(period)
    return true
  }
}

/**
 * 按期次统计 completeCount（页面埋点/自验用）。
 * 同一期重复 complete 不累加，返回新计数。
 */
export function bumpCompleteCount(
  counts: Record<number, number>,
  period: number,
): number {
  if (counts[period]) return counts[period]
  counts[period] = 1
  return counts[period]
}
