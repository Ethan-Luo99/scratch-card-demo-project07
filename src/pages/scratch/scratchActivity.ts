/**
 * 连刮 3 次活动纯逻辑层（页面编排可独立单测，零 uni / DOM 依赖）。
 *
 * 硬性约束：
 * - 纯函数 + 不可变更新，不 import 任何 uni / DOM API。
 * - 幂等键 = prizeId + 期次（period）：补偿队列、结算幂等标记、completeCount 均按期次区分。
 * - 前一张 Revealed 未结算完成时禁止发下一张（活动状态机守卫）。
 */

import type { PrizeInfo } from '@/components/scratch-card/types'

export const ACTIVITY_TOTAL_PERIODS = 3
/** 结算完成后自动挂载下一张的延迟 */
export const NEXT_CARD_DELAY_MS = 800

export type ActivityPhase =
  | 'idle' // 活动未开始
  | 'loading' // 当前期次奖品拉取中
  | 'ready' // 当前期次卡片可刮
  | 'failed' // 当前期次拉取失败，活动暂停，等待重试（只重发当前期次）
  | 'finished' // 3 张全部刮完并结算完成

export interface PeriodSettlement {
  /** 该期是否已刮开（complete 已到达） */
  revealed: boolean
  /** 该期结算是否已完成（无论上报成功还是进补偿队列） */
  settled: boolean
  /** 本期奖品 */
  prize: PrizeInfo | null
}

export interface ScratchActivityState {
  /** 期次，从 0 开始 */
  period: number
  phase: ActivityPhase
  periods: PeriodSettlement[]
}

/** 结算补偿记录（幂等键 prizeId+period） */
export interface SettleRecord {
  prizeId: string | number
  period: number
  ts: number
}

/** 期次级幂等键（补偿队列去重 / storage 幂等标记共用） */
export function periodKey(prizeId: string | number, period: number): string {
  return prizeId + '#p' + period
}

/** 补偿队列内同幂等键去重 */
export function dedupeQueue(records: SettleRecord[]): SettleRecord[] {
  const seen = new Set<string>()
  const out: SettleRecord[] = []
  for (const record of records) {
    const key = periodKey(record.prizeId, record.period)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(record)
  }
  return out
}

/** 兼容旧版仅含 prizeId 的记录：缺期次按 0 期补 */
export function normalizeSettleRecord(raw: Partial<SettleRecord>): SettleRecord | null {
  if (raw == null) return null
  if (raw.prizeId === undefined || raw.prizeId === null) return null
  return {
    prizeId: raw.prizeId,
    period: typeof raw.period === 'number' && raw.period >= 0 ? raw.period : 0,
    ts: typeof raw.ts === 'number' ? raw.ts : 0,
  }
}

export function createActivity(total: number = ACTIVITY_TOTAL_PERIODS): ScratchActivityState {
  const n = Math.max(1, Math.min(ACTIVITY_TOTAL_PERIODS, Math.floor(total)))
  return {
    period: 0,
    phase: 'idle',
    periods: Array.from({ length: n }, () => ({
      revealed: false,
      settled: false,
      prize: null,
    })),
  }
}

/** 本地 3 张券池（id 互不相同）；mock 拉取失败的期次不占用券池。 */
export function createPrizePool(): PrizeInfo[] {
  return [
    { id: 88, title: '优惠券 ¥10', subTitle: '满 100 可用' },
    { id: 188, title: '优惠券 ¥20', subTitle: '满 200 可用' },
    { id: 288, title: '优惠券 ¥30', subTitle: '满 300 可用' },
  ]
}

function clonePeriods(periods: PeriodSettlement[]): PeriodSettlement[] {
  return periods.map((p) => ({ ...p }))
}

/** 开始/重发指定期次的拉取（重试只重发当前期次）。 */
export function startPeriod(
  state: ScratchActivityState,
  period: number,
): ScratchActivityState {
  if (period < 0 || period >= state.periods.length) return state
  const periods = clonePeriods(state.periods)
  periods[period] = { revealed: false, settled: false, prize: null }
  return { period, phase: 'loading', periods }
}

export function markPeriodFetched(
  state: ScratchActivityState,
  period: number,
  prize: PrizeInfo,
): ScratchActivityState {
  if (period !== state.period || state.phase !== 'loading') return state
  const periods = clonePeriods(state.periods)
  periods[period] = { ...periods[period], prize }
  return { ...state, phase: 'ready', periods }
}

export function markPeriodFailed(
  state: ScratchActivityState,
  period: number,
): ScratchActivityState {
  if (period !== state.period) return state
  // 已完成期次的结算状态不受影响（只改当前期）。
  return { ...state, phase: 'failed' }
}

/**
 * 刮开达标（complete）：标记本期 revealed。
 * 同一期重复 complete 幂等返回原状态（组件状态机已守一层，页面再守一层）。
 */
export function markPeriodRevealed(
  state: ScratchActivityState,
  period: number,
): ScratchActivityState {
  const current = state.periods[period]
  if (!current || current.revealed) return state
  const periods = clonePeriods(state.periods)
  periods[period] = { ...periods[period], revealed: true }
  return { ...state, periods }
}

/**
 * 结算完成：标记本期 settled；若已是最后一期则活动结束。
 * 必须在 revealed 之后调用；未 revealed 的期次不允许结算。
 */
export function markPeriodSettled(
  state: ScratchActivityState,
  period: number,
): ScratchActivityState {
  const current = state.periods[period]
  if (!current || !current.revealed || current.settled) return state
  const periods = clonePeriods(state.periods)
  periods[period] = { ...periods[period], settled: true }
  const allDone = periods.every((p) => p.settled)
  return { ...state, periods, phase: allDone ? 'finished' : state.phase }
}

/**
 * 是否允许挂载下一张新卡：
 * - 当前期已结算完成；
 * - 还有后续期次；
 * - 活动未结束、未暂停（非 failed）。
 * 前一张处于 Revealed 未结算完成时返回 false（禁止发下一张）。
 */
export function canAdvance(state: ScratchActivityState): boolean {
  const current = state.periods[state.period]
  if (!current) return false
  if (!current.settled) return false
  if (state.period + 1 >= state.periods.length) return false
  return state.phase !== 'failed' && state.phase !== 'finished'
}

/** 推进到下一期（进入 loading 前的状态迁移；下一期拉取由页面发起）。 */
export function advancePeriod(state: ScratchActivityState): ScratchActivityState {
  if (!canAdvance(state)) return state
  const next = state.period + 1
  const periods = clonePeriods(state.periods)
  periods[next] = { revealed: false, settled: false, prize: null }
  return { period: next, phase: 'loading', periods }
}

/** 已刮开但未完成结算的期次数（调试/埋点用）。 */
export function completeCountByPeriod(state: ScratchActivityState): number[] {
  return state.periods.map((p) => (p.revealed ? 1 : 0))
}

/** 已结算完成的期次数。 */
export function settledCount(state: ScratchActivityState): number {
  return state.periods.reduce((n, p) => (p.settled ? n + 1 : n), 0)
}
