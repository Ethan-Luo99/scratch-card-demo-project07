/**
 * 连刮活动：状态持久化 + 旧数据迁移 + 结算竞态协调（纯逻辑，不 import 任何 uni / DOM API）。
 *
 * 职责边界：
 * - 本模块只承载可在 Node 下单测的规则；页面（pages/scratch/index.vue）负责
 *   提供 uni 存储适配器并调用本模块；组件层完全不感知本文件。
 * - 持久化内容：当前期次、每期 revealed/settled、补偿队列（沿用 scratchStreak 的
 *   SettleRecord / settleFlagKey 口径，幂等键 = prizeId + 期次）。
 * - 旧数据迁移幂等可重入：任意时刻中断，重进不得重复结算、不得丢失补偿记录、
 *   不得把旧记录算到错误的期次上（无法确定期次的旧记录 period=0 原样保留）。
 * - 存储失败静默降级：FallbackStorage 写穿内存镜像，底层抛错即切换纯内存模式，
 *   不报错、不阻断，重进页面按无历史处理。
 */

import type { PrizeInfo } from '@/components/scratch-card/types'
import type { SettleRecord, StreakState } from './scratchStreak'
// @ts-ignore TS4.9 无 allowImportingTsExtensions；Node 单测（type-stripping）要求显式 .ts 后缀
import * as streak from './scratchStreak.ts'

const { STREAK_TOTAL, settleFlagKey, enqueueSettleRecord } = streak

/** 活动状态快照的 storage key */
export const ACTIVITY_STATE_KEY = 'scratch_activity_state_v1'
/** 补偿队列 storage key（沿用旧版同名 key，旧记录就在这个 key 下） */
export const SETTLE_QUEUE_KEY = 'scratch_settle_queue'
/** 迁移完成标记（最后写入；缺失则下次进入重跑迁移，步骤本身幂等） */
export const MIGRATION_DONE_KEY = 'scratch_activity_migrated_v1'
/** 结算幂等标记前缀（旧版：scratch_settled_{prizeId}；新版：…_{prizeId}:{period}） */
export const LEGACY_FLAG_PREFIX = 'scratch_settled_'
/** 旧记录无法判定期次时的占位期次（不得猜测归属，原样保留补报） */
export const LEGACY_UNKNOWN_PERIOD = 0

/* ---------------- 存储抽象（页面注入 uni 实现，测试注入内存实现） ---------------- */

export interface ActivityStorageLike {
  /** 缺失返回 null；底层异常允许抛出（由 FallbackStorage 兜底） */
  get(key: string): string | null
  set(key: string, value: string): void
  keys(): string[]
}

/**
 * 静默降级存储：正常情况下读写穿透到底层存储并镜像到内存；
 * 任一读/写抛错即永久降级为纯内存模式（不报错、不阻断）。
 * 降级后本会话内已写入的数据仍可读回（活动可完整刮完），
 * 重进页面内存为空，按无历史处理。
 */
export class FallbackStorage implements ActivityStorageLike {
  private memory = new Map<string, string>()
  private degraded = false
  private backing: ActivityStorageLike

  constructor(backing: ActivityStorageLike) {
    this.backing = backing
  }

  /** 是否已降级为纯内存模式（页面可用于调试展示，不允许用于阻断流程） */
  isDegraded(): boolean {
    return this.degraded
  }

  get(key: string): string | null {
    if (this.degraded) return this.memory.get(key) ?? null
    try {
      return this.backing.get(key)
    } catch {
      this.degrade()
      return this.memory.get(key) ?? null
    }
  }

  set(key: string, value: string): void {
    // 写穿内存镜像：即使随后底层写失败降级，本会话数据仍可读回。
    this.memory.set(key, value)
    if (this.degraded) return
    try {
      this.backing.set(key, value)
    } catch {
      this.degrade()
    }
  }

  keys(): string[] {
    if (this.degraded) return [...this.memory.keys()]
    try {
      return this.backing.keys()
    } catch {
      this.degrade()
      return [...this.memory.keys()]
    }
  }

  private degrade(): void {
    this.degraded = true
  }
}

/* ---------------- 活动状态快照 ---------------- */

export interface PeriodState {
  prizeId: string | number | null
  /** 已揭晓（重进不再重刮本期；结算无论直报成功还是已入队都视为本地完成） */
  revealed: boolean
  /** 结算已在本地处理完毕（直报成功或已写入补偿队列） */
  settled: boolean
}

export interface ActivityStateV1 {
  version: 1
  /** 当前期次，1 起 */
  period: number
  /** key 为期次（字符串） */
  periods: Record<string, PeriodState>
}

export function createActivityState(): ActivityStateV1 {
  return { version: 1, period: 1, periods: {} }
}

function isValidPeriodState(raw: unknown): raw is PeriodState {
  if (!raw || typeof raw !== 'object') return false
  const p = raw as PeriodState
  const idOk =
    p.prizeId === null ||
    typeof p.prizeId === 'string' ||
    typeof p.prizeId === 'number'
  return idOk && typeof p.revealed === 'boolean' && typeof p.settled === 'boolean'
}

/** 解析持久化快照；任何字段异常（坏数据/版本不符）返回 null，调用方按无历史处理。 */
export function parseActivityState(raw: string | null): ActivityStateV1 | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const s = parsed as ActivityStateV1
  if (s.version !== 1) return null
  if (!Number.isInteger(s.period) || s.period < 1) return null
  if (!s.periods || typeof s.periods !== 'object') return null
  for (const key of Object.keys(s.periods)) {
    if (!isValidPeriodState(s.periods[key])) return null
  }
  return s
}

export function serializeActivityState(state: ActivityStateV1): string {
  return JSON.stringify(state)
}

function cloneState(state: ActivityStateV1): ActivityStateV1 {
  const periods: Record<string, PeriodState> = {}
  for (const key of Object.keys(state.periods)) {
    periods[key] = { ...state.periods[key] }
  }
  return { version: 1, period: state.period, periods }
}

/** 记录某期已揭晓（重进后本期不重刮、不重结算、不重复入队）。 */
export function markPeriodRevealed(
  state: ActivityStateV1,
  period: number,
  prizeId: string | number,
): ActivityStateV1 {
  const next = cloneState(state)
  const prev = next.periods[String(period)]
  next.periods[String(period)] = {
    prizeId,
    revealed: true,
    settled: prev ? prev.settled : false,
  }
  return next
}

/** 记录某期结算已在本地处理完毕（直报成功或已入补偿队列）。 */
export function markPeriodSettled(
  state: ActivityStateV1,
  period: number,
): ActivityStateV1 {
  const next = cloneState(state)
  const prev = next.periods[String(period)]
  next.periods[String(period)] = {
    prizeId: prev ? prev.prizeId : null,
    revealed: prev ? prev.revealed : true,
    settled: true,
  }
  return next
}

/** 推进当前期次（挂载新期时持久化）。 */
export function setActivityPeriod(
  state: ActivityStateV1,
  period: number,
): ActivityStateV1 {
  const next = cloneState(state)
  next.period = period
  return next
}

/**
 * 由快照推导恢复后的活动状态：
 * - 第一个未 revealed 的期次 → 从该期 loading 重发新卡（新涂层，不恢复位图/网格）；
 * - 全部 revealed → 直接结束态。
 */
export function deriveStreakState(state: ActivityStateV1): StreakState {
  for (let period = 1; period <= STREAK_TOTAL; period++) {
    const p = state.periods[String(period)]
    if (!p || !p.revealed) return { period, stage: 'loading' }
  }
  return { period: STREAK_TOTAL, stage: 'finished' }
}

/** 已 revealed 的期次列表（恢复时预标记 completeGuard，防止重复结算）。 */
export function revealedPeriods(state: ActivityStateV1): number[] {
  const out: number[] = []
  for (const key of Object.keys(state.periods)) {
    const period = Number(key)
    if (Number.isInteger(period) && state.periods[key].revealed) out.push(period)
  }
  return out.sort((a, b) => a - b)
}

/* ---------------- 旧数据迁移（幂等、可重入） ---------------- */

/** 由本地券池构造 prizeId → 期次 映射（池内 id 互不相同，映射唯一）。 */
export function prizePeriodMapper(
  pool: PrizeInfo[],
): (prizeId: string | number) => number | null {
  return (prizeId) => {
    const index = pool.findIndex((p) => String(p.id) === String(prizeId))
    return index >= 0 ? index + 1 : null
  }
}

/** 旧版幂等标记 key：scratch_settled_{prizeId}（无期次后缀，即不含冒号）。 */
export function isLegacySettleFlagKey(key: string): boolean {
  if (!key.startsWith(LEGACY_FLAG_PREFIX)) return false
  return !key.slice(LEGACY_FLAG_PREFIX.length).includes(':')
}

export function legacyFlagPrizeId(key: string): string | null {
  if (!isLegacySettleFlagKey(key)) return null
  const id = key.slice(LEGACY_FLAG_PREFIX.length)
  return id.length > 0 ? id : null
}

/** 旧式（无期次）幂等标记 key，period=0 的补偿记录补报成功后写回。 */
export function legacySettleFlagKey(prizeId: string | number): string {
  return LEGACY_FLAG_PREFIX + String(prizeId)
}

/**
 * 规范化一条队列记录：
 * - 新版记录（period 为正整数）原样保留；
 * - 旧版记录（仅 prizeId+ts）经 periodOfPrize 映射期次；
 *   无法映射（奖品不在当前券池）时 period=LEGACY_UNKNOWN_PERIOD 原样保留，
 *   绝不猜测归属期次。
 * - 形状非法（缺 prizeId）返回 null（丢弃，避免坏记录反复阻塞队列）。
 */
export function normalizeQueueRecord(
  raw: unknown,
  periodOfPrize: (prizeId: string | number) => number | null,
): SettleRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<SettleRecord>
  if (typeof r.prizeId !== 'string' && typeof r.prizeId !== 'number') return null
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0
  if (Number.isInteger(r.period) && (r.period as number) >= 1) {
    return { prizeId: r.prizeId, period: r.period as number, ts }
  }
  const mapped = periodOfPrize(r.prizeId)
  return {
    prizeId: r.prizeId,
    period: mapped ?? LEGACY_UNKNOWN_PERIOD,
    ts,
  }
}

export interface MigrationResult {
  /** 队列中被补上期次的旧记录数 */
  queueNormalized: number
  /** 无法判定期次、按 period=0 保留的旧记录数 */
  queueUnknown: number
  /** 由旧标记升级出的期次级标记数 */
  flagsUpgraded: number
  /** 无法映射期次、原样保留的旧标记数 */
  flagsUnknown: number
}

/**
 * 旧数据迁移（幂等、可重入）：
 * 1. 规范化补偿队列并整体写回（单 key 单次写，天然原子；重复执行结果相同）；
 * 2. 旧幂等标记升级为期次级标记（只新增、不删除，重复执行无副作用）；
 * 3. 最后写迁移完成标记。
 * 任意一步中断：重进后重跑本函数，队列去重（enqueueSettleRecord）与标记
 * 覆盖写保证「不重复结算、不丢失记录、不算错期次」。
 * 存储写异常会向上抛出，由调用方（FallbackStorage 场景下不会发生）或重进兜底。
 */
export function migrateLegacyStorage(
  storage: ActivityStorageLike,
  periodOfPrize: (prizeId: string | number) => number | null,
): MigrationResult {
  const result: MigrationResult = {
    queueNormalized: 0,
    queueUnknown: 0,
    flagsUpgraded: 0,
    flagsUnknown: 0,
  }

  // 1. 队列规范化（旧记录缺 period → 映射/置 0）+ 去重后整体写回。
  let rawQueue: unknown[] = []
  const raw = storage.get(SETTLE_QUEUE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) rawQueue = parsed
    } catch {
      rawQueue = []
    }
  }
  let queue: SettleRecord[] = []
  let changed = false
  for (const item of rawQueue) {
    const normalized = normalizeQueueRecord(item, periodOfPrize)
    if (!normalized) {
      changed = true
      continue
    }
    const legacy =
      !item ||
      typeof item !== 'object' ||
      !Number.isInteger((item as SettleRecord).period) ||
      (item as SettleRecord).period < 1
    if (legacy) {
      changed = true
      if (normalized.period === LEGACY_UNKNOWN_PERIOD) result.queueUnknown++
      else result.queueNormalized++
    }
    const before = queue.length
    queue = enqueueSettleRecord(queue, normalized)
    if (queue.length === before) changed = true
  }
  if (changed || raw !== null) {
    storage.set(SETTLE_QUEUE_KEY, JSON.stringify(queue))
  }

  // 2. 旧幂等标记 → 期次级标记（无法映射期次的旧标记原样保留，不删除）。
  for (const key of storage.keys()) {
    const prizeId = legacyFlagPrizeId(key)
    if (prizeId === null) continue
    const period = periodOfPrize(prizeId)
    if (period === null) {
      result.flagsUnknown++
      continue
    }
    storage.set(settleFlagKey(prizeId, period), '1')
    result.flagsUpgraded++
  }

  // 3. 迁移完成标记（最后写；缺失时下次进入重跑，以上步骤均幂等）。
  storage.set(MIGRATION_DONE_KEY, '1')
  return result
}

/**
 * 结算幂等标记查询：新标记（期次级）或旧标记（无期次）任一存在即视为已结算。
 * 旧标记兜底覆盖「prizeId 不在当前券池、迁移无法升级」的场景。
 */
export function hasSettleFlag(
  storage: ActivityStorageLike,
  prizeId: string | number,
  period: number,
): boolean {
  if (period >= 1 && storage.get(settleFlagKey(prizeId, period)) !== null) {
    return true
  }
  return storage.get(legacySettleFlagKey(prizeId)) !== null
}

/* ---------------- 结算竞态协调 ---------------- */

/**
 * 结算恰好一次协调器（会话内）：
 * 同一 settleKey（prizeId+期次）在「直报 / 补偿补报 / 重试连点」并发下只放行一个。
 * 跨会话的恰好一次由持久化幂等标记（hasSettleFlag）保证。
 */
export class SettleCoordinator {
  private states = new Map<string, 'inflight' | 'done'>()

  /** 尝试占有某键的结算权；已占有/已完成返回 false（调用方不得重复上报）。 */
  tryBegin(key: string): boolean {
    if (this.states.has(key)) return false
    this.states.set(key, 'inflight')
    return true
  }

  /** 上报成功：终态，之后任何 tryBegin 均拒绝。 */
  succeed(key: string): void {
    this.states.set(key, 'done')
  }

  /** 上报失败：释放占有，允许后续重试（仅 inflight 态可释放）。 */
  fail(key: string): void {
    if (this.states.get(key) === 'inflight') this.states.delete(key)
  }

  /** 恢复时预置已完成键（已 revealed 期次不得再结算）。 */
  markDone(key: string): void {
    this.states.set(key, 'done')
  }

  isDone(key: string): boolean {
    return this.states.get(key) === 'done'
  }

  isInflight(key: string): boolean {
    return this.states.get(key) === 'inflight'
  }
}

/**
 * 期次拉取纪元守卫：每次挂载/重试递增纪元，异步响应只接受最新纪元，
 * 过期响应（慢响应、上一期重试）一律丢弃，不污染当前期状态。
 */
export class EpochGuard {
  private epoch = 0

  /** 发起新一轮异步流程，返回本轮令牌。 */
  next(): number {
    this.epoch += 1
    return this.epoch
  }

  /** 响应回来时校验：非最新纪元的响应必须丢弃。 */
  isCurrent(token: number): boolean {
    return token === this.epoch
  }
}
