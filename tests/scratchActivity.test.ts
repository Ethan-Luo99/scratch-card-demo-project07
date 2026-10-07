/**
 * 断点续刮 + 旧数据迁移 纯逻辑单测。
 * 运行：node --test tests/scratchActivity.test.ts（npm run test:engine）。
 *
 * 覆盖（对齐任务 1 / 2 / 3.1）：
 * 1. 恢复快照推导：已完成期次不重刮、队列待补报记录算已完成
 * 2. 旧数据迁移三种组合：旧幂等标记存在 / 旧队列非空 / 写入中断后重入
 * 3. 迁移幂等可重入：重复执行结果一致、不重复结算、不丢补偿记录、不错算期次
 * 4. storage 失败静默降级（FallbackStore 纯内存模式）
 * 5. 竞态判定：过期响应丢弃、补报合并防并发覆盖、恰好生效一次
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_STORAGE_KEY,
  MIGRATION_FLAG_STORAGE_KEY,
  QUEUE_BACKUP_STORAGE_KEY,
  QUEUE_STORAGE_KEY,
  FallbackStore,
  computeResumeSnapshot,
  createInitialSnapshot,
  deriveSnapshotFromProgress,
  isStalePeriodResponse,
  isSettleEffectivelyDone,
  migrateQueueRecords,
  parseSnapshot,
  planLegacyFlagMigration,
  readQueueRecords,
  removeSettledFromQueue,
  runMigration,
  serializeSnapshot,
  type KVStore,
} from '../src/pages/scratch/scratchActivity.ts'
import {
  buildLocalPrizePool,
  settleFlagKey,
  settleKey,
  type SettleRecord,
} from '../src/pages/scratch/scratchStreak.ts'

const pool = buildLocalPrizePool()
const [P1, P2, P3] = pool.map((p) => p.id)

class MemStore implements KVStore {
  map = new Map<string, string>()
  get(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  set(key: string, value: string): void {
    this.map.set(key, value)
  }
  remove(key: string): void {
    this.map.delete(key)
  }
  keys(): string[] {
    return [...this.map.keys()]
  }
}

/** 指定 key 写入时崩溃一次（模拟迁移写一半中断）。 */
class CrashOnceStore extends MemStore {
  crashKey: string | null = null
  set(key: string, value: string): void {
    if (key === this.crashKey) {
      this.crashKey = null
      throw new Error('crash during write')
    }
    super.set(key, value)
  }
}

/* ---------------- 恢复快照推导 ---------------- */

test('恢复快照：无历史 → 第 1 期；快照序列化/解析往返一致', () => {
  const snap = computeResumeSnapshot({ settledFlagKeys: [], queue: [], pool })
  assert.deepEqual(snap, createInitialSnapshot())
  const parsed = parseSnapshot(serializeSnapshot(snap))
  assert.deepEqual(parsed, snap)
})

test('恢复快照：非法快照串一律按无历史处理（parseSnapshot → null）', () => {
  assert.equal(parseSnapshot(null), null)
  assert.equal(parseSnapshot(''), null)
  assert.equal(parseSnapshot('{broken'), null)
  assert.equal(parseSnapshot('{"version":2,"period":1}'), null)
  assert.equal(parseSnapshot('{"version":1,"period":99,"completedKeys":[]}'), null)
  assert.equal(parseSnapshot('{"version":1,"period":1}'), null)
})

test('恢复快照：第 1 期已结算 → 恢复到第 2 期，不重刮第 1 期', () => {
  const snap = computeResumeSnapshot({
    settledFlagKeys: [settleFlagKey(P1, 1)],
    queue: [],
    pool,
  })
  assert.equal(snap.period, 2)
  assert.equal(snap.finished, false)
  assert.deepEqual(snap.completedKeys, [settleKey(P1, 1)])
})

test('恢复快照：队列中的待补报记录算已完成（不重复入队、不重刮）', () => {
  const snap = computeResumeSnapshot({
    settledFlagKeys: [settleFlagKey(P1, 1)],
    queue: [{ prizeId: P2, period: 2, ts: 1 }],
    pool,
  })
  assert.equal(snap.period, 3)
  assert.equal(snap.finished, false)
})

test('恢复快照：全部期次完成 → finished，期次停在最后一期', () => {
  const snap = computeResumeSnapshot({
    settledFlagKeys: [
      settleFlagKey(P1, 1),
      settleFlagKey(P2, 2),
      settleFlagKey(P3, 3),
    ],
    queue: [],
    pool,
  })
  assert.equal(snap.finished, true)
  assert.equal(snap.period, 3)
})

test('deriveSnapshotFromProgress：期次必须连续完成，断档即停', () => {
  // 只有第 2 期完成、第 1 期未完成 → 恢复到第 1 期（第 2 期不计入连续进度）
  const snap = deriveSnapshotFromProgress([settleKey(P2, 2)], pool)
  assert.equal(snap.period, 1)
  assert.equal(snap.finished, false)
})

/* ---------------- 旧数据迁移：旧幂等标记存在 ---------------- */

test('迁移：旧幂等标记（无期次后缀）→ 期次级标记，恢复跳过该期', () => {
  const store = new MemStore()
  store.set('scratch_settled_' + P1, '1')
  const result = runMigration(store, pool)
  assert.equal(result.migrated, true)
  assert.equal(store.get(settleFlagKey(P1, 1)), '1', '旧标记迁移到期次级')
  assert.equal(store.get(MIGRATION_FLAG_STORAGE_KEY), '1')
  const snap = computeResumeSnapshot({
    settledFlagKeys: result.settledFlagKeys,
    queue: result.queue,
    pool,
  })
  assert.equal(snap.period, 2, '已结算期次不重刮')
})

test('迁移：无法归属期次的旧标记不迁移、不算到任何期次上', () => {
  const store = new MemStore()
  store.set('scratch_settled_9999', '1')
  const result = runMigration(store, pool)
  assert.equal(store.get('scratch_settled_9999'), '1', '原样保留')
  assert.equal(store.get('scratch_settled_9999:1'), null, '不得错算期次')
  const snap = computeResumeSnapshot({
    settledFlagKeys: result.settledFlagKeys,
    queue: result.queue,
    pool,
  })
  assert.equal(snap.period, 1)
})

test('planLegacyFlagMigration：期次级新标记不参与迁移', () => {
  const plans = planLegacyFlagMigration(
    ['scratch_settled_' + P1, settleFlagKey(P2, 2), 'other_key'],
    pool,
  )
  assert.deepEqual(plans, [
    { from: 'scratch_settled_' + P1, to: settleFlagKey(P1, 1) },
  ])
})

/* ---------------- 旧数据迁移：旧队列非空 ---------------- */

test('迁移：旧队列记录（仅 prizeId+ts）补期次；无法归属 → period 0 保留不丢', () => {
  const legacy = [
    { prizeId: P2, ts: 100 },
    { prizeId: 9999, ts: 200 },
  ]
  const { queue, changed } = migrateQueueRecords(legacy, pool)
  assert.equal(changed, true)
  assert.deepEqual(queue, [
    { prizeId: P2, period: 2, ts: 100 },
    { prizeId: 9999, period: 0, ts: 200 },
  ])
  // period 0 照常补报但不计入任何期次
  const snap = computeResumeSnapshot({ settledFlagKeys: [], queue, pool })
  assert.equal(snap.period, 1, 'period 0 不得算到任何期次上')
})

test('迁移：旧队列经 runMigration 整体迁移，备份先行、记录不丢、恢复跳期', () => {
  const store = new MemStore()
  store.set(
    QUEUE_STORAGE_KEY,
    JSON.stringify([{ prizeId: P1, ts: 1 }, { prizeId: P2, ts: 2 }]),
  )
  const result = runMigration(store, pool)
  assert.equal(
    store.get(QUEUE_BACKUP_STORAGE_KEY),
    JSON.stringify([{ prizeId: P1, ts: 1 }, { prizeId: P2, ts: 2 }]),
    '迁移前原始队列已备份',
  )
  assert.deepEqual(result.queue, [
    { prizeId: P1, period: 1, ts: 1 },
    { prizeId: P2, period: 2, ts: 2 },
  ])
  const snap = computeResumeSnapshot({
    settledFlagKeys: result.settledFlagKeys,
    queue: result.queue,
    pool,
  })
  assert.equal(snap.period, 3, '队列待补报记录算已完成，不重刮不重复入队')
})

test('迁移：队列去重（同 prizeId+期次只留一条），坏记录丢弃', () => {
  const { queue } = migrateQueueRecords(
    [
      { prizeId: P1, period: 1, ts: 1 },
      { prizeId: P1, period: 1, ts: 2 },
      { prizeId: P1, ts: 3 },
      'garbage',
      { noPrize: true },
    ],
    pool,
  )
  assert.deepEqual(queue, [{ prizeId: P1, period: 1, ts: 1 }])
})

/* ---------------- 旧数据迁移：写入中断后重入 ---------------- */

test('迁移中断（队列写崩溃）→ 重入整体重跑，结果一致不丢记录', () => {
  const store = new CrashOnceStore()
  store.set(
    QUEUE_STORAGE_KEY,
    JSON.stringify([{ prizeId: P1, ts: 1 }]),
  )
  store.set('scratch_settled_' + P2, '1')
  // 第一次：写迁移后队列时崩溃（备份已写、完成标记未写）
  store.crashKey = QUEUE_STORAGE_KEY
  assert.throws(() => runMigration(store, pool))
  assert.equal(store.get(MIGRATION_FLAG_STORAGE_KEY), null, '完成标记未写')
  assert.ok(store.get(QUEUE_BACKUP_STORAGE_KEY), '原始备份已保留')
  // 重入：整体重跑，全部步骤幂等
  const result = runMigration(store, pool)
  assert.deepEqual(result.queue, [{ prizeId: P1, period: 1, ts: 1 }])
  assert.equal(store.get(settleFlagKey(P2, 2)), '1')
  assert.equal(store.get(MIGRATION_FLAG_STORAGE_KEY), '1')
})

test('迁移中断（主键撕裂写）→ 读取回退备份，补偿记录不丢', () => {
  const store = new MemStore()
  const original = JSON.stringify([{ prizeId: P3, ts: 9 }])
  store.set(QUEUE_BACKUP_STORAGE_KEY, original)
  store.set(QUEUE_STORAGE_KEY, '{"prizeId":8803,"ts":9},{{{') // 撕裂写
  // 读取：主键损坏 → 回退备份
  assert.deepEqual(readQueueRecords(store), [{ prizeId: P3, ts: 9 }])
  const result = runMigration(store, pool)
  assert.deepEqual(result.queue, [{ prizeId: P3, period: 3, ts: 9 }])
  // 主键被修复为合法迁移结果
  assert.deepEqual(readQueueRecords(store), [{ prizeId: P3, period: 3, ts: 9 }])
})

test('迁移中断（完成标记写崩溃）→ 重入不重复迁移、队列不翻倍', () => {
  const store = new CrashOnceStore()
  store.set(QUEUE_STORAGE_KEY, JSON.stringify([{ prizeId: P1, ts: 1 }]))
  store.crashKey = MIGRATION_FLAG_STORAGE_KEY
  assert.throws(() => runMigration(store, pool))
  // 重入：队列已是新格式，再迁移不翻倍；备份不被覆盖
  const result = runMigration(store, pool)
  assert.deepEqual(result.queue, [{ prizeId: P1, period: 1, ts: 1 }])
  assert.equal(
    store.get(QUEUE_BACKUP_STORAGE_KEY),
    JSON.stringify([{ prizeId: P1, ts: 1 }]),
    '备份保持原始内容',
  )
})

test('迁移幂等：已完成标记存在 → 不再迁移，重复执行结果一致', () => {
  const store = new MemStore()
  store.set(QUEUE_STORAGE_KEY, JSON.stringify([{ prizeId: P1, ts: 1 }]))
  store.set('scratch_settled_' + P2, '1')
  const first = runMigration(store, pool)
  const snapshotAfterFirst = store.keys().sort()
  const second = runMigration(store, pool)
  assert.equal(first.migrated, true)
  assert.equal(second.migrated, false)
  assert.deepEqual(second.queue, first.queue)
  assert.deepEqual(store.keys().sort(), snapshotAfterFirst, '重入零副作用')
})

/* ---------------- storage 失败静默降级 ---------------- */

test('FallbackStore：写入抛错即降级纯内存模式，活动数据仍可读写', () => {
  const primary = new MemStore()
  primary.set('existing', 'v1')
  const store = new FallbackStore({
    get: (k) => primary.get(k),
    set: () => {
      throw new Error('quota exceeded')
    },
    remove: (k) => primary.remove(k),
    keys: () => primary.keys(),
  })
  assert.equal(store.degraded, false)
  assert.equal(store.get('existing'), 'v1', '降级前读正常')
  store.set(ACTIVITY_STORAGE_KEY, serializeSnapshot(createInitialSnapshot()))
  assert.equal(store.degraded, true, '写失败 → 静默降级')
  // 内存模式：活动可完整进行，不报错
  store.set(settleFlagKey(P1, 1), '1')
  assert.equal(store.get(settleFlagKey(P1, 1)), '1')
  assert.ok(store.keys().includes(settleFlagKey(P1, 1)))
  // 重进页面（新 FallbackStore 实例）按无历史处理
  const fresh = new FallbackStore(primary)
  assert.equal(fresh.get(settleFlagKey(P1, 1)), null)
})

test('FallbackStore：读取抛错同样降级，不阻断', () => {
  const store = new FallbackStore({
    get: () => {
      throw new Error('storage broken')
    },
    set: () => undefined,
    remove: () => undefined,
    keys: () => [],
  })
  assert.equal(store.get('anything'), null)
  assert.equal(store.degraded, true)
  store.set('k', 'v')
  assert.equal(store.get('k'), 'v')
})

/* ---------------- 结算竞态判定 ---------------- */

test('过期响应判定：序号失效或期次已推进 → 丢弃', () => {
  assert.equal(
    isStalePeriodResponse({
      requestSeq: 1,
      latestSeq: 2,
      requestPeriod: 1,
      currentPeriod: 1,
    }),
    true,
    '有更新的请求 → 旧响应过期',
  )
  assert.equal(
    isStalePeriodResponse({
      requestSeq: 2,
      latestSeq: 2,
      requestPeriod: 1,
      currentPeriod: 2,
    }),
    true,
    '期次已推进 → 旧期响应过期',
  )
  assert.equal(
    isStalePeriodResponse({
      requestSeq: 2,
      latestSeq: 2,
      requestPeriod: 2,
      currentPeriod: 2,
    }),
    false,
  )
})

test('补报合并：flush 期间新入队的记录必须保留（防并发覆盖丢失）', () => {
  const flushed: SettleRecord[] = [
    { prizeId: P1, period: 1, ts: 1 },
    { prizeId: P2, period: 2, ts: 2 },
  ]
  // flush 快照为两条；期间第 3 期新入队
  const current: SettleRecord[] = [
    ...flushed,
    { prizeId: P3, period: 3, ts: 3 },
  ]
  const remain = removeSettledFromQueue(current, [flushed[0]])
  assert.deepEqual(remain, [
    { prizeId: P2, period: 2, ts: 2 },
    { prizeId: P3, period: 3, ts: 3 },
  ])
})

test('恰好生效一次：有幂等标记或已在队列 → 不再直报/再入队', () => {
  assert.equal(
    isSettleEffectivelyDone({
      settledFlagKeys: [settleFlagKey(P1, 1)],
      queue: [],
      prizeId: P1,
      period: 1,
    }),
    true,
  )
  assert.equal(
    isSettleEffectivelyDone({
      settledFlagKeys: [],
      queue: [{ prizeId: P1, period: 1, ts: 1 }],
      prizeId: P1,
      period: 1,
    }),
    true,
  )
  assert.equal(
    isSettleEffectivelyDone({
      settledFlagKeys: [settleFlagKey(P1, 1)],
      queue: [],
      prizeId: P1,
      period: 2,
    }),
    false,
    '同 prizeId 不同期不算已生效',
  )
})
