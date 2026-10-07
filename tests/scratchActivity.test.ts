/**
 * 连刮活动：状态持久化 + 旧数据迁移 + 结算竞态 纯逻辑单测。
 * 运行：node --test tests/scratchActivity.test.ts
 *
 * 覆盖：
 * 1. 活动状态快照：序列化/解析/坏数据兜底、恢复期次推导
 * 2. 旧数据迁移三种组合：旧标记存在 / 队列非空 / 写入中断后重入（幂等可重入）
 * 3. FallbackStorage 写失败静默降级纯内存模式
 * 4. SettleCoordinator 恰好一次 / EpochGuard 过期响应丢弃
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_STATE_KEY,
  SETTLE_QUEUE_KEY,
  MIGRATION_DONE_KEY,
  LEGACY_UNKNOWN_PERIOD,
  FallbackStorage,
  createActivityState,
  parseActivityState,
  serializeActivityState,
  markPeriodRevealed,
  markPeriodSettled,
  setActivityPeriod,
  deriveStreakState,
  revealedPeriods,
  prizePeriodMapper,
  isLegacySettleFlagKey,
  legacySettleFlagKey,
  normalizeQueueRecord,
  migrateLegacyStorage,
  hasSettleFlag,
  SettleCoordinator,
  EpochGuard,
  type ActivityStorageLike,
} from '../src/pages/scratch/scratchActivity.ts'
import {
  STREAK_TOTAL,
  buildLocalPrizePool,
  settleFlagKey,
} from '../src/pages/scratch/scratchStreak.ts'

/** 内存存储（测试替身） */
class MemStorage implements ActivityStorageLike {
  map = new Map<string, string>()
  get(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  set(key: string, value: string): void {
    this.map.set(key, value)
  }
  keys(): string[] {
    return [...this.map.keys()]
  }
}

const pool = buildLocalPrizePool()
const periodOf = prizePeriodMapper(pool)

/* ---------------- 状态快照 ---------------- */

test('快照序列化/解析往返一致；坏数据返回 null', () => {
  let s = createActivityState()
  s = markPeriodRevealed(s, 1, 8801)
  s = markPeriodSettled(s, 1)
  s = setActivityPeriod(s, 2)
  const restored = parseActivityState(serializeActivityState(s))
  assert.deepEqual(restored, s)
  assert.equal(parseActivityState(null), null)
  assert.equal(parseActivityState(''), null)
  assert.equal(parseActivityState('not-json{'), null)
  assert.equal(parseActivityState('{"version":2}'), null)
  assert.equal(parseActivityState('{"version":1,"period":0,"periods":{}}'), null)
  assert.equal(
    parseActivityState(
      '{"version":1,"period":1,"periods":{"1":{"prizeId":1}}}',
    ),
    null,
  )
})

test('mark 系列返回新对象，不改原快照', () => {
  const s0 = createActivityState()
  const s1 = markPeriodRevealed(s0, 1, 8801)
  assert.equal(s0.periods['1'], undefined)
  assert.equal(s1.periods['1'].revealed, true)
  assert.equal(s1.periods['1'].settled, false)
  const s2 = markPeriodSettled(s1, 1)
  assert.equal(s1.periods['1'].settled, false)
  assert.equal(s2.periods['1'].settled, true)
  assert.equal(s2.periods['1'].prizeId, 8801)
})

test('恢复期次推导：无历史→第1期；部分完成→下一未揭晓期；全部完成→结束态', () => {
  assert.deepEqual(deriveStreakState(createActivityState()), {
    period: 1,
    stage: 'loading',
  })
  let s = createActivityState()
  s = markPeriodRevealed(s, 1, 8801)
  s = markPeriodSettled(s, 1)
  assert.deepEqual(deriveStreakState(s), { period: 2, stage: 'loading' })
  s = markPeriodRevealed(s, 2, 8802)
  s = markPeriodSettled(s, 2)
  s = markPeriodRevealed(s, 3, 8803)
  s = markPeriodSettled(s, 3)
  assert.deepEqual(deriveStreakState(s), {
    period: STREAK_TOTAL,
    stage: 'finished',
  })
  assert.deepEqual(revealedPeriods(s), [1, 2, 3])
})

/* ---------------- 旧数据迁移 ---------------- */

test('迁移：仅旧幂等标记存在 → 升级为期次级标记，旧标记保留', () => {
  const storage = new MemStorage()
  storage.set(legacySettleFlagKey(8801), '1')
  storage.set(legacySettleFlagKey(8802), '1')
  const r = migrateLegacyStorage(storage, periodOf)
  assert.equal(r.flagsUpgraded, 2)
  assert.equal(r.flagsUnknown, 0)
  assert.equal(storage.get(settleFlagKey(8801, 1)), '1')
  assert.equal(storage.get(settleFlagKey(8802, 2)), '1')
  // 旧标记不删除（幂等重入安全）
  assert.equal(storage.get(legacySettleFlagKey(8801)), '1')
  assert.equal(storage.get(MIGRATION_DONE_KEY), '1')
  assert.equal(hasSettleFlag(storage, 8801, 1), true)
  assert.equal(hasSettleFlag(storage, 8803, 3), false)
})

test('迁移：仅旧补偿队列非空 → 补期次写回，无法映射的置 0 保留', () => {
  const storage = new MemStorage()
  storage.set(
    SETTLE_QUEUE_KEY,
    JSON.stringify([
      { prizeId: 8802, ts: 111 }, // 旧记录：可映射到期 2
      { prizeId: 9999, ts: 222 }, // 旧记录：奖品不在券池，期次不得猜测
      { prizeId: 8801, period: 1, ts: 333 }, // 新记录：原样保留
    ]),
  )
  const r = migrateLegacyStorage(storage, periodOf)
  assert.equal(r.queueNormalized, 1)
  assert.equal(r.queueUnknown, 1)
  const queue = JSON.parse(storage.get(SETTLE_QUEUE_KEY) as string)
  assert.deepEqual(queue, [
    { prizeId: 8802, period: 2, ts: 111 },
    { prizeId: 9999, period: LEGACY_UNKNOWN_PERIOD, ts: 222 },
    { prizeId: 8801, period: 1, ts: 333 },
  ])
})

test('迁移：旧标记 + 旧队列同时存在，且重复执行幂等', () => {
  const storage = new MemStorage()
  storage.set(legacySettleFlagKey(8803), '1')
  storage.set(SETTLE_QUEUE_KEY, JSON.stringify([{ prizeId: 8801, ts: 1 }]))
  migrateLegacyStorage(storage, periodOf)
  const snapshotAfterFirst = new Map(storage.map)
  const r2 = migrateLegacyStorage(storage, periodOf)
  assert.deepEqual(storage.map, snapshotAfterFirst, '重跑不得产生任何差异')
  assert.equal(r2.queueNormalized, 0, '已规范化的记录不再重复计数')
  const queue = JSON.parse(storage.get(SETTLE_QUEUE_KEY) as string)
  assert.equal(queue.length, 1, '不得重复入队')
  assert.equal(storage.get(settleFlagKey(8803, 3)), '1')
})

test('迁移：写入中断后重入 → 不重复、不丢失、不算错期次', () => {
  const backing = new MemStorage()
  backing.set(legacySettleFlagKey(8801), '1')
  backing.set(legacySettleFlagKey(8802), '1')
  backing.set(SETTLE_QUEUE_KEY, JSON.stringify([{ prizeId: 8803, ts: 7 }]))

  // 第一次执行：第 2 次写（升级第 1 个旧标记时）注入崩溃。
  let writes = 0
  const crashing: ActivityStorageLike = {
    get: (k) => backing.get(k),
    keys: () => backing.keys(),
    set: (k, v) => {
      writes += 1
      if (writes === 2) throw new Error('crash mid-migration')
      backing.set(k, v)
    },
  }
  assert.throws(() => migrateLegacyStorage(crashing, periodOf))
  assert.equal(backing.get(MIGRATION_DONE_KEY), null, '中断时完成标记未写')

  // 重进：底层存储已恢复，重跑迁移必须收敛到正确终态。
  const r = migrateLegacyStorage(backing, periodOf)
  assert.equal(backing.get(MIGRATION_DONE_KEY), '1')
  assert.equal(backing.get(settleFlagKey(8801, 1)), '1')
  assert.equal(backing.get(settleFlagKey(8802, 2)), '1')
  const queue = JSON.parse(backing.get(SETTLE_QUEUE_KEY) as string)
  assert.deepEqual(queue, [{ prizeId: 8803, period: 3, ts: 7 }])
  assert.equal(r.queueNormalized, 0, '首次已规范化的队列记录不重复计数')
})

test('迁移：无法映射期次的旧标记原样保留，hasSettleFlag 旧标记兜底命中', () => {
  const storage = new MemStorage()
  storage.set(legacySettleFlagKey(7777), '1')
  const r = migrateLegacyStorage(storage, periodOf)
  assert.equal(r.flagsUnknown, 1)
  assert.equal(r.flagsUpgraded, 0)
  assert.equal(storage.get(legacySettleFlagKey(7777)), '1', '旧标记不得删除')
  assert.equal(hasSettleFlag(storage, 7777, 1), true, '旧标记任意期次兜底')
})

test('key 判定：期次级标记不算旧标记', () => {
  assert.equal(isLegacySettleFlagKey('scratch_settled_8801'), true)
  assert.equal(isLegacySettleFlagKey('scratch_settled_8801:1'), false)
  assert.equal(isLegacySettleFlagKey(SETTLE_QUEUE_KEY), false)
  assert.equal(isLegacySettleFlagKey(ACTIVITY_STATE_KEY), false)
})

test('normalizeQueueRecord：坏记录返回 null，新记录原样保留', () => {
  assert.equal(normalizeQueueRecord(null, periodOf), null)
  assert.equal(normalizeQueueRecord({ ts: 1 }, periodOf), null)
  assert.deepEqual(normalizeQueueRecord({ prizeId: 8801, period: 1, ts: 5 }, periodOf), {
    prizeId: 8801,
    period: 1,
    ts: 5,
  })
  assert.deepEqual(normalizeQueueRecord({ prizeId: 8802 }, periodOf), {
    prizeId: 8802,
    period: 2,
    ts: 0,
  })
})

/* ---------------- FallbackStorage 降级 ---------------- */

test('写失败静默降级：不抛错、会话内数据可读回、重进按无历史', () => {
  const backing = new MemStorage()
  backing.set('persisted_old', '1')
  const storage = new FallbackStorage(backing)
  assert.equal(storage.get('persisted_old'), '1')
  storage.set('k1', 'v1')
  assert.equal(backing.get('k1'), 'v1', '正常时写穿透到底层')
  assert.equal(storage.isDegraded(), false)

  // 注入配额异常：后续写全部失败。
  const quotaBacking: ActivityStorageLike = {
    get: (k) => backing.get(k),
    keys: () => backing.keys(),
    set: () => {
      throw new Error('QuotaExceededError')
    },
  }
  const degraded = new FallbackStorage(quotaBacking)
  degraded.set('activity', '{"version":1}')
  assert.equal(degraded.isDegraded(), true)
  assert.doesNotThrow(() => degraded.set('k2', 'v2'))
  assert.equal(degraded.get('activity'), '{"version":1}', '降级后会话内可读回')
  assert.equal(degraded.get('k2'), 'v2')
  assert.ok(degraded.keys().includes('k2'))
  // 「重进页面」= 新 FallbackStorage 实例 + 仍失败的底层：按无历史处理。
  const reentered = new FallbackStorage(quotaBacking)
  assert.equal(reentered.get('activity'), null)
})

test('读失败同样静默降级', () => {
  const broken: ActivityStorageLike = {
    get: () => {
      throw new Error('storage broken')
    },
    set: () => {},
    keys: () => {
      throw new Error('storage broken')
    },
  }
  const storage = new FallbackStorage(broken)
  assert.equal(storage.get('any'), null)
  assert.equal(storage.isDegraded(), true)
  assert.deepEqual(storage.keys(), [])
})

/* ---------------- 竞态协调 ---------------- */

test('SettleCoordinator：同一键恰好放行一次，失败可重试，成功为终态', () => {
  const c = new SettleCoordinator()
  assert.equal(c.tryBegin('8801:1'), true)
  assert.equal(c.tryBegin('8801:1'), false, 'in-flight 中拒绝重入')
  assert.equal(c.isInflight('8801:1'), true)
  c.fail('8801:1')
  assert.equal(c.tryBegin('8801:1'), true, '失败释放后允许重试')
  c.succeed('8801:1')
  assert.equal(c.isDone('8801:1'), true)
  assert.equal(c.tryBegin('8801:1'), false, '完成后永久拒绝')
  c.fail('8801:1')
  assert.equal(c.isDone('8801:1'), true, 'done 不可被 fail 回退')
  assert.equal(c.tryBegin('8802:2'), true, '不同键互不影响')
})

test('SettleCoordinator：恢复时 markDone 预置已完成期次', () => {
  const c = new SettleCoordinator()
  c.markDone('8801:1')
  assert.equal(c.tryBegin('8801:1'), false)
  assert.equal(c.isDone('8801:1'), true)
})

test('EpochGuard：过期响应一律丢弃', () => {
  const g = new EpochGuard()
  const first = g.next()
  const second = g.next()
  assert.equal(g.isCurrent(first), false, '慢响应/旧重试丢弃')
  assert.equal(g.isCurrent(second), true)
  const third = g.next()
  assert.equal(g.isCurrent(second), false)
  assert.equal(g.isCurrent(third), true)
})
