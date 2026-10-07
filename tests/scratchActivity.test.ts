/**
 * 连刮活动纯逻辑层单元测试（期次状态机 / 幂等键）。
 * 运行：node --test tests/scratchActivity.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_TOTAL_PERIODS,
  NEXT_CARD_DELAY_MS,
  advancePeriod,
  canAdvance,
  completeCountByPeriod,
  createActivity,
  createPrizePool,
  dedupeQueue,
  markPeriodFailed,
  markPeriodFetched,
  markPeriodRevealed,
  markPeriodSettled,
  normalizeSettleRecord,
  periodKey,
  settledCount,
  startPeriod,
} from '../src/pages/scratch/scratchActivity.ts'
import type { PrizeInfo, SettleRecord } from '../src/pages/scratch/scratchActivity.ts'

test('本地券池：3 张奖品且 id 互不相同', () => {
  const pool = createPrizePool()
  assert.equal(pool.length, ACTIVITY_TOTAL_PERIODS)
  const ids = new Set(pool.map((p) => String(p.id)))
  assert.equal(ids.size, ACTIVITY_TOTAL_PERIODS)
  assert.ok(pool.every((p) => typeof p.title === 'string' && p.title.length > 0))
})

test('初始活动：3 期全部未刮未结算', () => {
  const a = createActivity()
  assert.equal(a.period, 0)
  assert.equal(a.periods.length, 3)
  assert.ok(a.periods.every((p) => !p.revealed && !p.settled && p.prize === null))
  assert.deepEqual(completeCountByPeriod(a), [0, 0, 0])
})

test('期次推进全流程：loading→ready→revealed→settled，800ms 常量为 800', () => {
  assert.equal(NEXT_CARD_DELAY_MS, 800)
  let a = createActivity()
  a = startPeriod(a, 0)
  assert.equal(a.phase, 'loading')
  const prize: PrizeInfo = { id: 88, title: '优惠券 ¥10' }
  a = markPeriodFetched(a, 0, prize)
  assert.equal(a.phase, 'ready')
  assert.equal(a.periods[0].prize?.id, 88)

  // 未刮开不允许推进到下一张。
  assert.equal(canAdvance(a), false)

  a = markPeriodRevealed(a, 0)
  // Revealed 但未结算完成：禁止发下一张。
  assert.equal(canAdvance(a), false)
  a = markPeriodSettled(a, 0)
  assert.equal(a.periods[0].settled, true)
  assert.equal(a.phase, 'ready')
  assert.equal(canAdvance(a), true)

  a = advancePeriod(a)
  assert.equal(a.period, 1)
  assert.equal(a.phase, 'loading')
  // 已完成期次状态不受影响。
  assert.equal(a.periods[0].settled, true)
  assert.equal(a.periods[1].revealed, false)
})

test('complete/结算幂等：同一期重复标记不重复计数', () => {
  let a = createActivity()
  a = startPeriod(a, 0)
  a = markPeriodFetched(a, 0, { id: 88, title: 'x' })
  a = markPeriodRevealed(a, 0)
  const once = a
  a = markPeriodRevealed(a, 0)
  assert.strictEqual(a, once, '重复 revealed 返回同一引用（幂等）')
  a = markPeriodSettled(a, 0)
  const settled = a
  a = markPeriodSettled(a, 0)
  assert.strictEqual(a, settled)
  // 未 revealed 的期次不能直接 settled。
  let b = createActivity()
  b = startPeriod(b, 1)
  b = markPeriodFetched(b, 1, { id: 188, title: 'y' })
  const before = b
  b = markPeriodSettled(b, 1)
  assert.strictEqual(b, before)
})

test('3 期全部结算完成 → finished 结束态，且不再可推进', () => {
  let a = createActivity()
  for (let i = 0; i < 3; i++) {
    a = startPeriod(a, i)
    a = markPeriodFetched(a, i, createPrizePool()[i])
    a = markPeriodRevealed(a, i)
    assert.equal(canAdvance(a), false, '第 ' + i + ' 期 revealed 未结算不可推进')
    a = markPeriodSettled(a, i)
  }
  assert.equal(a.phase, 'finished')
  assert.equal(settledCount(a), 3)
  assert.equal(canAdvance(a), false)
  assert.strictEqual(advancePeriod(a), a)
})

test('任一期拉取失败：活动暂停 failed，已完成期次结算状态不受影响', () => {
  let a = createActivity()
  // 第 0 期完成。
  a = markPeriodSettled(
    markPeriodRevealed(markPeriodFetched(startPeriod(a, 0), 0, createPrizePool()[0]), 0),
    0,
  )
  a = advancePeriod(a)
  assert.equal(a.period, 1)
  a = markPeriodFailed(a, 1)
  assert.equal(a.phase, 'failed')
  assert.equal(canAdvance(a), false, '失败暂停期间禁止发下一张')
  // 已完成的第 0 期不受影响。
  assert.equal(a.periods[0].settled, true)
  // 重试只重发当前期次：期次仍为 1、loading，前序状态保留。
  a = startPeriod(a, 1)
  assert.equal(a.period, 1)
  assert.equal(a.phase, 'loading')
  assert.equal(a.periods[0].settled, true)
  assert.equal(a.periods[1].revealed, false)
})

test('期次级幂等键：同 prizeId 不同期次键不同；同期不同 prize 键不同', () => {
  assert.equal(periodKey(88, 0), '88#p0')
  assert.equal(periodKey(88, 1), '88#p1')
  assert.notEqual(periodKey(88, 0), periodKey(88, 1))
  assert.notEqual(periodKey(88, 0), periodKey(188, 0))
})

test('补偿队列按 prizeId+期次去重（同 prizeId 跨期不去重）', () => {
  const records: SettleRecord[] = [
    { prizeId: 88, period: 0, ts: 1 },
    { prizeId: 88, period: 0, ts: 2 }, // 同期重复 → 去
    { prizeId: 88, period: 1, ts: 3 }, // 同 prize 跨期 → 留
    { prizeId: 188, period: 1, ts: 4 },
  ]
  const out = dedupeQueue(records)
  assert.equal(out.length, 3)
  assert.deepEqual(
    out.map((r) => periodKey(r.prizeId, r.period)),
    ['88#p0', '88#p1', '188#p1'],
  )
})

test('旧版仅 prizeId 的队列记录可归一为 period=0（向后兼容，不脏状态）', () => {
  assert.deepEqual(normalizeSettleRecord({ prizeId: 88, ts: 5 }), {
    prizeId: 88,
    period: 0,
    ts: 5,
  })
  assert.equal(normalizeSettleRecord({ ts: 5 }), null)
  assert.equal(normalizeSettleRecord(null), null)
  assert.deepEqual(normalizeSettleRecord({ prizeId: 1, period: -1 }), {
    prizeId: 1,
    period: 0,
    ts: 0,
  })
})

test('失败/就绪只接受当前期次：过期回调不污染状态', () => {
  let a = createActivity()
  a = startPeriod(a, 0)
  a = markPeriodFetched(a, 0, createPrizePool()[0])
  // 期次不匹配的 fetched/failed 均被忽略。
  assert.strictEqual(markPeriodFetched(a, 2, createPrizePool()[2]), a)
  assert.strictEqual(markPeriodFailed(a, 2), a)
  // 非 loading 态 fetched 被忽略。
  assert.strictEqual(markPeriodFetched(a, 0, createPrizePool()[0]), a)
})
