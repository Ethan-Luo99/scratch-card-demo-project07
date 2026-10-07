/**
 * 断点续刮 + 旧数据迁移（纯逻辑，不 import 任何 uni / DOM API）。
 *
 * 页面职责仍在 pages/scratch/index.vue；本文件只承载可在 Node 下单测的规则：
 * - 活动快照（当前期次 / 已完成期次幂等键）的序列化、解析与恢复推导；
 * - 旧版数据迁移：旧幂等标记 scratch_settled_{prizeId}（无期次后缀）与
 *   旧补偿队列记录（仅 prizeId+ts，无 period）→ 期次级格式；
 * - 迁移幂等可重入：备份先行 + 每步写入幂等 + 完成标记最后写，
 *   任意时刻崩溃重进不得重复结算、不得丢失补偿记录、不得错算期次；
 * - storage 失败静默降级（FallbackStore）：任一读写抛错即切纯内存模式；
 * - 结算竞态判定：过期响应丢弃、补报合并防并发覆盖。
 */

import {
  STREAK_TOTAL,
  settleKey,
  settleFlagKey,
  type SettleRecord,
} from './scratchStreak'
import type { PrizeInfo } from '@/components/scratch-card/types'

/** 活动快照 storage key */
export const ACTIVITY_STORAGE_KEY = 'scratch_activity_v1'
/** 补偿队列 storage key（沿用旧 key，旧记录即存在这里） */
export const QUEUE_STORAGE_KEY = 'scratch_settle_queue'
/** 迁移前原始队列备份 key（撕裂写保护） */
export const QUEUE_BACKUP_STORAGE_KEY = 'scratch_settle_queue_bak'
/** 迁移完成标记 key（最后写；缺失则整体重跑，全部步骤幂等） */
export const MIGRATION_FLAG_STORAGE_KEY = 'scratch_activity_migrated_v1'
/** 幂等标记前缀（旧版无期次后缀，新版为 {prefix}{prizeId}:{period}） */
export const SETTLED_FLAG_PREFIX = 'scratch_settled_'

/** KV 抽象：页面侧用 uni.*StorageSync 实现，测试用内存 Map 实现。 */
export interface KVStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  keys(): string[]
}

/* ---------------- 活动快照 ---------------- */

export interface ActivitySnapshot {
  version: 1
  /** 恢复时应挂载的期次（1..STREAK_TOTAL；finished 时为最后一期） */
  period: number
  /** 已完结期次的幂等键（settleKey 列表：settled 或 revealed 待补报） */
  completedKeys: string[]
  finished: boolean
}

export function createInitialSnapshot(): ActivitySnapshot {
  return { version: 1, period: 1, completedKeys: [], finished: false }
}

/** 解析快照：任何字段非法一律返回 null（按无历史处理）。 */
export function parseSnapshot(raw: string | null): ActivitySnapshot | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Partial<ActivitySnapshot>
    if (!obj || obj.version !== 1) return null
    if (
      typeof obj.period !== 'number' ||
      obj.period < 1 ||
      obj.period > STREAK_TOTAL
    ) {
      return null
    }
    if (!Array.isArray(obj.completedKeys)) return null
    const completedKeys = obj.completedKeys.filter(
      (k): k is string => typeof k === 'string',
    )
    return {
      version: 1,
      period: obj.period,
      completedKeys,
      finished: obj.finished === true,
    }
  } catch {
    return null
  }
}

export function serializeSnapshot(snapshot: ActivitySnapshot): string {
  return JSON.stringify(snapshot)
}

/**
 * 由「已完成幂等键集合」推导恢复快照：
 * 期次 = 第一个未完成的期次；全部完成 → finished。
 * 期次完成判定依赖本地券池的 period→prizeId 确定性映射。
 */
export function deriveSnapshotFromProgress(
  completedKeys: string[],
  pool: PrizeInfo[],
): ActivitySnapshot {
  const done = new Set(completedKeys)
  const keys: string[] = []
  for (let p = 1; p <= STREAK_TOTAL; p++) {
    const prize = pool[p - 1]
    if (!prize) break
    const key = settleKey(prize.id, p)
    if (!done.has(key)) {
      return { version: 1, period: p, completedKeys: keys, finished: false }
    }
    keys.push(key)
  }
  return {
    version: 1,
    period: STREAK_TOTAL,
    completedKeys: keys,
    finished: true,
  }
}

/**
 * 恢复推导：期次幂等标记 + 补偿队列 → 恢复快照。
 * 队列中的记录代表「已揭晓待补报」，同样算已完成（不重刮、不重结算、不重复入队）。
 */
export function computeResumeSnapshot(input: {
  settledFlagKeys: string[]
  queue: SettleRecord[]
  pool: PrizeInfo[]
}): ActivitySnapshot {
  const completed = new Set<string>()
  for (const flagKey of input.settledFlagKeys) {
    if (!flagKey.startsWith(SETTLED_FLAG_PREFIX)) continue
    const key = flagKey.slice(SETTLED_FLAG_PREFIX.length)
    if (key.includes(':')) completed.add(key)
  }
  for (const record of input.queue) {
    if (record.period >= 1) {
      completed.add(settleKey(record.prizeId, record.period))
    }
  }
  return deriveSnapshotFromProgress([...completed], input.pool)
}

/* ---------------- 补偿队列读取与迁移 ---------------- */

/** 解析队列原始串：非法 JSON / 非数组 → null（调用方回退备份）。 */
export function parseQueueRaw(raw: string | null): unknown[] | null {
  if (raw === null || raw === '') return []
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

/** 读队列记录：主键损坏（迁移撕裂写）时回退备份，均不可用 → 空队列。 */
export function readQueueRecords(store: KVStore): unknown[] {
  const main = parseQueueRaw(store.get(QUEUE_STORAGE_KEY))
  if (main !== null) return main
  const backup = parseQueueRaw(store.get(QUEUE_BACKUP_STORAGE_KEY))
  if (backup !== null) return backup
  return []
}

/** prizeId → 期次映射（本地券池确定性映射）；无法归属 → null。 */
export function mapPrizeToPeriod(
  prizeId: string | number,
  pool: PrizeInfo[],
): number | null {
  const index = pool.findIndex((p) => String(p.id) === String(prizeId))
  return index >= 0 ? index + 1 : null
}

function normalizeRecord(raw: unknown): SettleRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const prizeId = r.prizeId
  if (typeof prizeId !== 'string' && typeof prizeId !== 'number') return null
  const period = typeof r.period === 'number' ? r.period : NaN
  const ts = typeof r.ts === 'number' ? r.ts : 0
  return { prizeId, period, ts }
}

/**
 * 队列迁移（纯函数）：
 * - 新格式记录（period 为 ≥0 的整数）原样保留；
 * - 旧记录（无 period）：能映射到期次 → 补上 period；无法归属 → period 0
 *   （照常补报但不计入任何期次，绝不错算到别的期次上）；
 * - 按 (prizeId, period) 去重；坏记录丢弃。
 */
export function migrateQueueRecords(
  records: unknown[],
  pool: PrizeInfo[],
): { queue: SettleRecord[]; changed: boolean } {
  const queue: SettleRecord[] = []
  let changed = false
  for (const raw of records) {
    const rec = normalizeRecord(raw)
    if (!rec) {
      changed = true
      continue
    }
    let period = rec.period
    if (!Number.isInteger(period) || period < 0) {
      changed = true
      period = mapPrizeToPeriod(rec.prizeId, pool) ?? 0
    }
    const next: SettleRecord = { prizeId: rec.prizeId, period, ts: rec.ts }
    if (
      queue.some((r) => r.period === next.period && r.prizeId === next.prizeId)
    ) {
      changed = true
      continue
    }
    queue.push(next)
  }
  return { queue, changed }
}

/**
 * 旧幂等标记迁移计划：scratch_settled_{prizeId} → scratch_settled_{prizeId}:{period}。
 * 无法归属期次的旧标记不迁移（保留原样，不计入任何期次）。
 */
export function planLegacyFlagMigration(
  keys: string[],
  pool: PrizeInfo[],
): Array<{ from: string; to: string }> {
  const plans: Array<{ from: string; to: string }> = []
  for (const key of keys) {
    if (!key.startsWith(SETTLED_FLAG_PREFIX)) continue
    const prizeId = key.slice(SETTLED_FLAG_PREFIX.length)
    if (!prizeId || prizeId.includes(':')) continue
    const period = mapPrizeToPeriod(prizeId, pool)
    if (period === null) continue
    plans.push({ from: key, to: settleFlagKey(prizeId, period) })
  }
  return plans
}

/** 当前全部期次级幂等标记 key（含 ':' 的才算，旧标记不算）。 */
export function collectSettledFlagKeys(keys: string[]): string[] {
  return keys.filter((key) => {
    if (!key.startsWith(SETTLED_FLAG_PREFIX)) return false
    return key.slice(SETTLED_FLAG_PREFIX.length).includes(':')
  })
}

export interface MigrationResult {
  /** 本次是否执行了迁移（false = 此前已完成） */
  migrated: boolean
  /** 迁移后的补偿队列（可直接投入使用） */
  queue: SettleRecord[]
  /** 迁移完成后的全部期次级幂等标记 key */
  settledFlagKeys: string[]
}

/**
 * 迁移编排（幂等、可重入；任意步骤崩溃后重跑安全）：
 * 1. 备份原始队列（仅无备份时写，重入不覆盖原始备份）；
 * 2. 迁移队列并整体写回（主键撕裂时下次读取自动回退备份）；
 * 3. 旧幂等标记 → 期次级标记（set 天然幂等）；
 * 4. 最后写迁移完成标记（此前任意崩溃都会整体重跑，而每步幂等）。
 */
export function runMigration(
  store: KVStore,
  pool: PrizeInfo[],
): MigrationResult {
  const already = store.get(MIGRATION_FLAG_STORAGE_KEY) === '1'
  if (!already) {
    const rawQueue = store.get(QUEUE_STORAGE_KEY)
    if (rawQueue !== null && store.get(QUEUE_BACKUP_STORAGE_KEY) === null) {
      store.set(QUEUE_BACKUP_STORAGE_KEY, rawQueue)
    }
    const migrated = migrateQueueRecords(readQueueRecords(store), pool)
    if (migrated.changed || rawQueue !== null) {
      store.set(QUEUE_STORAGE_KEY, JSON.stringify(migrated.queue))
    }
    for (const plan of planLegacyFlagMigration(store.keys(), pool)) {
      store.set(plan.to, '1')
    }
    store.set(MIGRATION_FLAG_STORAGE_KEY, '1')
  }
  return {
    migrated: !already,
    queue: migrateQueueRecords(readQueueRecords(store), pool).queue,
    settledFlagKeys: collectSettledFlagKeys(store.keys()),
  }
}

/* ---------------- storage 失败静默降级 ---------------- */

/**
 * 降级存储：任一读写抛错（异常/配额）即永久切换为纯内存模式。
 * 内存模式下活动可完整刮完、不报错不阻断；重进页面按无历史处理
 * （内存 Map 随页面销毁，主存储下次可用时旧数据仍在）。
 */
export class FallbackStore implements KVStore {
  private memory = new Map<string, string>()
  private down = false
  private primary: KVStore

  constructor(primary: KVStore) {
    this.primary = primary
  }

  /** 是否已降级为纯内存模式（页面可用于调试展示）。 */
  get degraded(): boolean {
    return this.down
  }

  get(key: string): string | null {
    if (this.down) return this.memory.get(key) ?? null
    try {
      return this.primary.get(key)
    } catch {
      this.down = true
      return null
    }
  }

  set(key: string, value: string): void {
    if (this.down) {
      this.memory.set(key, value)
      return
    }
    try {
      this.primary.set(key, value)
    } catch {
      this.down = true
      this.memory.set(key, value)
    }
  }

  remove(key: string): void {
    if (this.down) {
      this.memory.delete(key)
      return
    }
    try {
      this.primary.remove(key)
    } catch {
      this.down = true
      this.memory.delete(key)
    }
  }

  keys(): string[] {
    if (this.down) return [...this.memory.keys()]
    try {
      return this.primary.keys()
    } catch {
      this.down = true
      return [...this.memory.keys()]
    }
  }
}

/* ---------------- 结算竞态判定 ---------------- */

/**
 * 期次拉取响应是否过期：序号已被更新的请求取代，或期次已推进 → 一律丢弃，
 * 不得污染当前期状态（重试连点 / 慢响应防护）。
 */
export function isStalePeriodResponse(input: {
  requestSeq: number
  latestSeq: number
  requestPeriod: number
  currentPeriod: number
}): boolean {
  return (
    input.requestSeq !== input.latestSeq ||
    input.requestPeriod !== input.currentPeriod
  )
}

/**
 * 补报合并：flush 期间可能有新记录入队（onComplete 直报失败），
 * 结束时只移除本次补报成功的记录，其余一律保留（防并发覆盖丢失）。
 */
export function removeSettledFromQueue(
  current: SettleRecord[],
  succeeded: SettleRecord[],
): SettleRecord[] {
  const done = new Set(succeeded.map((r) => settleKey(r.prizeId, r.period)))
  return current.filter((r) => !done.has(settleKey(r.prizeId, r.period)))
}

/**
 * 同一 (prizeId, period) 是否已生效：有期次幂等标记或已在补偿队列中。
 * 已生效则不得再直报/再入队（恰好生效一次）。
 */
export function isSettleEffectivelyDone(input: {
  settledFlagKeys: string[]
  queue: SettleRecord[]
  prizeId: string | number
  period: number
}): boolean {
  const key = settleKey(input.prizeId, input.period)
  if (input.settledFlagKeys.includes(SETTLED_FLAG_PREFIX + key)) return true
  return input.queue.some(
    (r) => r.period === input.period && r.prizeId === input.prizeId,
  )
}
