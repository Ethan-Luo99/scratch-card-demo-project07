/**
 * 连刮 3 次活动：期次状态机 + 期次级幂等 纯逻辑单测。
 * 运行：node --test tests/scratchStreak.test.ts
 *
 * 覆盖：
 * 1. 本地券池 3 张、prize id 互不相同
 * 2. 期次状态机：前一张 Revealed 未结算完成禁止发下一张；Failed 只重试当前期
 * 3. 幂等键 prizeId+期次（标记 key / 补偿队列入队去重）
 * 4. PeriodCompleteGuard 单期只结算一次
 * 5. completeCount 按期次区分
 * 6. 3 张刮完进入结束态
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STREAK_TOTAL,
  NEXT_CARD_DELAY_MS,
  buildLocalPrizePool,
  createStreakState,
  transitionStreak,
  canMountNext,
  advanceToNextPeriod,
  finishStreak,
  isStreakFinished,
  settleKey,
  settleFlagKey,
  enqueueSettleRecord,
  PeriodCompleteGuard,
  bumpCompleteCount,
} from '../src/pages/scratch/scratchStreak.ts'

test('本地券池：3 张奖品且 id 互不相同', () => {
  const pool = buildLocalPrizePool()
  assert.equal(pool.length, STREAK_TOTAL)
  assert.equal(STREAK_TOTAL, 3)
  const ids = pool.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须互不相同')
  for (const p of pool) assert.ok(p.title, '每张都有标题')
})

test('自动下一张延迟为 800ms', () => {
  assert.equal(NEXT_CARD_DELAY_MS, 800)
})

test('期次状态机：loading→ready→revealed→loading（下一期）合法', () => {
  let s = createStreakState()
  assert.deepEqual(s, { period: 1, stage: 'loading' })
  s = transitionStreak(s, 'ready')!
  assert.equal(s.stage, 'ready')
  s = transitionStreak(s, 'revealed')!
  assert.equal(s.stage, 'revealed')
  assert.equal(canMountNext(s), true)
  s = advanceToNextPeriod(s)
  assert.deepEqual(s, { period: 2, stage: 'loading' })
})

test('前一张 Revealed 未结算完成（仍 ready/loading/failed）禁止发下一张', () => {
  let s = createStreakState()
  assert.equal(canMountNext(s), false)
  s = transitionStreak(s, 'ready')!
  assert.equal(canMountNext(s), false, 'ready 未揭晓不得发下一张')
  s = transitionStreak(s, 'failed')!
  assert.equal(canMountNext(s), false, '当前期 Failed 不得跳到下一张')
})

test('非法状态转移返回 null：未就绪不得揭晓/结束，finished 后不得再迁移', () => {
  const s = createStreakState()
  assert.equal(transitionStreak(s, 'finished'), null, 'loading 不得直接 finished')
  assert.equal(transitionStreak(s, 'revealed'), null, 'loading 不得直接 revealed')
  const ready = transitionStreak(s, 'ready')!
  assert.equal(transitionStreak(ready, 'finished'), null, 'ready 不得直接 finished')
  const finished = { period: 3, stage: 'finished' as const }
  assert.equal(transitionStreak(finished, 'loading'), null, 'finished 不得再迁移')
  assert.equal(transitionStreak(finished, 'revealed'), null)
})

test('loading→loading 为合法重入（初次挂载/重试防御性重发）', () => {
  const s = createStreakState()
  assert.deepEqual(transitionStreak(s, 'loading'), { period: 1, stage: 'loading' })
})

test('Failed 只重试当前期次：failed→loading 期次不变，已完成期不受影响', () => {
  // 第 1 期已 revealed → 推进到第 2 期 → 第 2 期失败
  let s = { period: 2, stage: 'ready' as const }
  s = transitionStreak(s, 'failed')!
  assert.deepEqual(s, { period: 2, stage: 'failed' })
  // 重试当前期：只能回 loading，期次保持 2
  s = transitionStreak(s, 'loading')!
  assert.deepEqual(s, { period: 2, stage: 'loading' })
  // failed 不允许直接发下一张/结束
  assert.equal(canMountNext(s), false)
})

test('3 张刮完：第 3 期 revealed 不再发新卡，进入结束态', () => {
  const last = { period: 3, stage: 'revealed' as const }
  assert.equal(canMountNext(last), false, '最后一期不能再发下一张')
  const done = finishStreak(last)
  assert.deepEqual(done, { period: 3, stage: 'finished' })
  assert.equal(isStreakFinished(done), true)
})

test('幂等键 prizeId+期次：同 prizeId 不同期不串单', () => {
  assert.equal(settleKey(88, 1), '88:1')
  assert.equal(settleKey(88, 2), '88:2')
  assert.notEqual(settleKey(88, 1), settleKey(88, 2))
  assert.equal(settleFlagKey(88, 1), 'scratch_settled_88:1')
  // 连刮池中不同 id + 不同期，键天然全部唯一。
  const pool = buildLocalPrizePool()
  const keys = pool.map((p, i) => settleKey(p.id, i + 1))
  assert.equal(new Set(keys).size, keys.length)
})

test('补偿队列入队按 (prizeId, period) 去重', () => {
  let q = enqueueSettleRecord([], { prizeId: 88, period: 1, ts: 1 })
  q = enqueueSettleRecord(q, { prizeId: 88, period: 1, ts: 2 })
  assert.equal(q.length, 1, '同一期重复记录不重复入队')
  q = enqueueSettleRecord(q, { prizeId: 88, period: 2, ts: 3 })
  assert.equal(q.length, 2)
  // 同 prizeId 不同期是不同结算
  assert.ok(q.some((r) => r.period === 2 && r.prizeId === 88))
})

test('PeriodCompleteGuard：同一期 complete 只结算一次，跨期互不影响', () => {
  const guard = new PeriodCompleteGuard()
  assert.equal(guard.has(1), false)
  assert.equal(guard.mark(1), true)
  assert.equal(guard.has(1), true)
  assert.equal(guard.mark(1), false, '同期重复 complete 必须被拒')
  assert.equal(guard.mark(2), true, '新期允许结算')
  assert.equal(guard.mark(3), true)
  assert.equal(guard.mark(2), false)
})

test('completeCount 按期次区分', () => {
  const counts: Record<number, number> = {}
  assert.equal(bumpCompleteCount(counts, 1), 1)
  assert.equal(bumpCompleteCount(counts, 1), 1, '同期不累加')
  assert.equal(bumpCompleteCount(counts, 2), 1)
  assert.equal(bumpCompleteCount(counts, 3), 1)
  assert.deepEqual(counts, { 1: 1, 2: 1, 3: 1 })
})
