/**
 * scratchEngine 纯算法层单元测试。
 * 运行：node --test tests/scratchEngine.test.ts（npm run test:engine）。
 *
 * 覆盖（对齐任务 2.3）：
 * 1. 线段插值补点
 * 2. 双阈值迟滞 24/120
 * 3. 可疑格 0.5 折算
 * 4. ratio 单调不减
 * 5. 快速甩动不断线（800px+ 长距离）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALPHA_CLEAN,
  ALPHA_SOLID,
  CELL_CLEAN,
  CELL_COVERED,
  CELL_FUZZY,
  createScratchEngine,
  decideResumeStrategy,
  guardedShouldReveal,
  shouldReveal,
} from '../src/components/scratch-card/scratchEngine.ts'

const W = 375
const H = 200
const COLS = 25
const ROWS = 14
const RADIUS = 14

function makeEngine() {
  return createScratchEngine({
    width: W,
    height: H,
    brushRadius: RADIUS,
    cols: COLS,
    rows: ROWS,
  })
}

function alphaData(values: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(COLS * ROWS * 4)
  values.forEach((a, i) => {
    out[i * 4 + 3] = a
  })
  return out
}

const fullRect = { x: 0, y: 0, w: W, h: H }

test('线段插值补点：大步长被切分为间距 ≤ step 的连续段', () => {
  const engine = makeEngine()
  engine.beginStroke({ x: 0, y: 0 })
  const cmd = engine.feedPoint({ x: 100, y: 0 })
  assert.ok(cmd, '应产出擦除指令')
  const step = RADIUS * 0.6
  const expected = Math.ceil(100 / step)
  assert.equal(cmd!.segments.length, expected)
  assert.equal(cmd!.radius, RADIUS)
  // 相邻段首尾相接（不断点）。
  for (const seg of cmd!.segments) {
    const dx = seg.to.x - seg.from.x
    const dy = seg.to.y - seg.from.y
    assert.ok(Math.hypot(dx, dy) <= step + 1e-6, '每段长度 ≤ step')
  }
  // 首点从 0 开始、终点到达 100。
  assert.equal(cmd!.segments[0].from.x, 0)
  assert.equal(cmd!.segments[cmd!.segments.length - 1].to.x, 100)
})

test('事件级降采样：<2px 抖动丢弃但返回 null，单点画点用 begin+微移处理', () => {
  const engine = makeEngine()
  engine.beginStroke({ x: 50, y: 50 })
  assert.equal(engine.feedPoint({ x: 50.5, y: 50 }), null)
})

test('双阈值迟滞 24/120：alpha<=24 净，>=120 有涂层，中间可疑', () => {
  const engine = makeEngine()
  const values = new Array(COLS * ROWS).fill(255)
  values[0] = ALPHA_CLEAN // 24 净
  values[1] = 0 // 净
  values[2] = ALPHA_SOLID // 120 明确有涂层
  values[3] = ALPHA_SOLID - 1 // 119 可疑
  values[4] = ALPHA_CLEAN + 1 // 25 可疑
  const snap = engine.applySamples(alphaData(values), fullRect)
  assert.equal(snap.cells[0], CELL_CLEAN)
  assert.equal(snap.cells[1], CELL_CLEAN)
  assert.equal(snap.cells[2], CELL_COVERED)
  assert.equal(snap.cells[3], CELL_FUZZY)
  assert.equal(snap.cells[4], CELL_FUZZY)
})

test('可疑格按 0.5 折算', () => {
  const engine = makeEngine()
  const total = COLS * ROWS
  const values = new Array(total).fill(255)
  // 10 净格 + 8 可疑格
  for (let i = 0; i < 10; i++) values[i] = 0
  for (let i = 10; i < 18; i++) values[i] = 60
  const snap = engine.applySamples(alphaData(values), fullRect)
  const expected = (10 + 8 * 0.5) / total
  assert.ok(Math.abs(snap.ratio - expected) < 1e-9, `ratio=${snap.ratio}`)
  assert.equal(snap.cleanCount, 10)
  assert.equal(snap.fuzzyCount, 8)
  assert.ok(Math.abs(snap.cleanRatio - 10 / total) < 1e-9)
})

test('cell 状态单调不可逆：净格不会因再次采样到高 alpha 而回降，ratio 单调不减', () => {
  const engine = makeEngine()
  const total = COLS * ROWS
  const values = new Array(total).fill(255)
  for (let i = 0; i < 20; i++) values[i] = 0
  let snap = engine.applySamples(alphaData(values), fullRect)
  const firstRatio = snap.ratio
  assert.ok(firstRatio > 0)

  // 再次「采样」时把之前的净格画回不透明（模拟边缘抖动回读），不得回降。
  const values2 = new Array(total).fill(255)
  snap = engine.applySamples(alphaData(values2), fullRect)
  for (let i = 0; i < 20; i++) assert.equal(snap.cells[i], CELL_CLEAN)
  assert.ok(snap.ratio >= firstRatio, 'ratio 不得回降')
  assert.equal(snap.ratio, firstRatio)

  // 可疑 → 有涂层同样不得退回 covered。
  const values3 = new Array(total).fill(255)
  values3[20] = 60
  snap = engine.applySamples(alphaData(values3), fullRect)
  assert.equal(snap.cells[0], CELL_CLEAN) // 之前已是净格
  assert.equal(snap.cells[20], CELL_FUZZY)
  const values4 = new Array(total).fill(255) // index20 回到不透明
  snap = engine.applySamples(alphaData(values4), fullRect)
  assert.equal(snap.cells[20], CELL_FUZZY, '可疑格不得退回有涂层')
})

test('快速甩动不断线：800px+ 对角线在 ≤300ms 手势语义下产生连续覆盖段', () => {
  const engine = makeEngine()
  engine.beginStroke({ x: 0, y: 0 })
  const far = Math.hypot(W, H) // ≈425；放大到 800 逻辑距离的手势：分两次跳点
  assert.ok(far > 0)
  const cmd1 = engine.feedPoint({ x: W, y: H })
  assert.ok(cmd1)
  const step = RADIUS * 0.6
  const expected = Math.ceil(far / step)
  assert.equal(cmd1!.segments.length, expected)
  // 任意相邻段衔接，且每段长度 ≤ step*1.0001 → 无间隙。
  for (let i = 0; i < cmd1!.segments.length; i++) {
    const seg = cmd1!.segments[i]
    assert.ok(Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) <= step + 1e-6)
    if (i > 0) {
      const prev = cmd1!.segments[i - 1]
      assert.equal(seg.from.x, prev.to.x)
      assert.equal(seg.from.y, prev.to.y)
    }
  }
  // 800px 以上的极端甩动：多段连续且长度一致、无丢段。
  engine.endStroke()
  engine.beginStroke({ x: 0, y: 0 })
  const cmd2 = engine.feedPoint({ x: 850, y: 0 })
  const expected2 = Math.ceil(850 / step)
  assert.equal(cmd2!.segments.length, expected2)
  assert.equal(cmd2!.segments[expected2 - 1].to.x, 850)
})

test('endStroke 后 feedPoint 返回 null，防止跨笔画连线', () => {
  const engine = makeEngine()
  engine.beginStroke({ x: 0, y: 0 })
  assert.ok(engine.feedPoint({ x: 10, y: 10 }))
  engine.endStroke()
  assert.equal(engine.feedPoint({ x: 300, y: 300 }), null)
})

test('揭晓双守卫：可疑格单独凑不够，净格需达 threshold-0.05', () => {
  const engine = makeEngine()
  const total = COLS * ROWS
  // 构造：折算 ratio 过线，但净格不足 threshold-0.05 → 不揭晓。
  // 全部格可疑：折算 ratio 恰为 0.5，但 cleanRatio=0 < 0.45 → 拒绝。
  const values = new Array(total).fill(60)
  const snap = engine.applySamples(alphaData(values), fullRect)
  assert.ok(Math.abs(snap.ratio - 0.5) < 1e-9)
  assert.equal(snap.cleanRatio, 0)
  assert.equal(shouldReveal(snap, 0.5), false)

  // 净格到 45%，其余可疑补足 0.5 → 通过。
  const values2 = new Array(total).fill(255)
  const cleanN = Math.ceil(total * 0.45)
  for (let i = 0; i < cleanN; i++) values2[i] = 0
  for (let i = cleanN; i < total; i++) values2[i] = 60
  const snap2 = engine.applySamples(alphaData(values2), fullRect)
  // clean 单调累计，fuzzy 也累计，ratio 已 >0.5
  assert.ok(snap2.cleanRatio >= 0.45 - 1e-9, `cleanRatio=${snap2.cleanRatio}`)
  assert.ok(snap2.ratio >= 0.5, `ratio=${snap2.ratio}`)
  assert.equal(shouldReveal(snap2, 0.5), true)
})

test('buildReplayCommand：按内存网格生成圆点重放，净格半径覆盖整格', () => {
  const engine = makeEngine()
  assert.equal(engine.buildReplayCommand(), null)
  const total = COLS * ROWS
  const values = new Array(total).fill(255)
  values[0] = 0
  values[1] = 60
  const snap = engine.applySamples(alphaData(values), fullRect)
  void snap
  const replay = engine.buildReplayCommand()
  assert.ok(replay)
  assert.equal(replay!.segments.length, 2)
  const cellW = W / COLS
  const cellH = H / ROWS
  assert.ok(replay!.radius >= Math.sqrt(cellW * cellW + cellH * cellH) / 2 - 1e-6)
})

test('reset：网格清零、ratio 归零、笔画结束', () => {
  const engine = makeEngine()
  const values = new Array(COLS * ROWS).fill(0)
  engine.applySamples(alphaData(values), fullRect)
  assert.equal(engine.ratio, 1)
  engine.reset()
  assert.equal(engine.ratio, 0)
  assert.equal(engine.cleanRatio, 0)
  assert.equal(engine.cells.every((c) => c === CELL_COVERED), true)
  assert.equal(engine.feedPoint({ x: 10, y: 10 }), null)
})

/* ---------- onHide/onShow 进度保留：恢复策略决策（纯逻辑） ---------- */

test('恢复决策：节点存活且尺寸未变 → retain 直接续刮', () => {
  assert.equal(
    decideResumeStrategy({ snapshot: null, surfaceAlive: true, sizeChanged: false }),
    'retain',
  )
  assert.equal(
    decideResumeStrategy({
      snapshot: { bitmap: 'x', exportFailed: false },
      surfaceAlive: true,
      sizeChanged: false,
    }),
    'retain',
  )
})

test('恢复决策：尺寸变化恒为 reset（旧网格坐标失效，等同换卡）', () => {
  for (const snapshot of [
    null,
    { bitmap: 'data:', exportFailed: false },
    { bitmap: null, exportFailed: false },
    { bitmap: null, exportFailed: true },
  ]) {
    assert.equal(
      decideResumeStrategy({ snapshot, surfaceAlive: true, sizeChanged: true }),
      'reset',
    )
    assert.equal(
      decideResumeStrategy({ snapshot, surfaceAlive: false, sizeChanged: true }),
      'reset',
    )
  }
})

test('恢复决策：节点被回收 + 位图可用 → bitmap 一级恢复', () => {
  assert.equal(
    decideResumeStrategy({
      snapshot: { bitmap: 'data:image/png;base64,xxxx', exportFailed: false },
      surfaceAlive: false,
      sizeChanged: false,
    }),
    'bitmap',
  )
})

test('恢复决策：节点被回收 + 导出能力不可用(null/未导出) → replay 二级兜底', () => {
  assert.equal(
    decideResumeStrategy({
      snapshot: { bitmap: null, exportFailed: false },
      surfaceAlive: false,
      sizeChanged: false,
    }),
    'replay',
  )
  assert.equal(
    decideResumeStrategy({ snapshot: null, surfaceAlive: false, sizeChanged: false }),
    'replay',
  )
})

test('恢复决策：导出本身失败 → 静默 reset，不再尝试 replay', () => {
  assert.equal(
    decideResumeStrategy({
      snapshot: { bitmap: null, exportFailed: true },
      surfaceAlive: false,
      sizeChanged: false,
    }),
    'reset',
  )
})

test('恢复后揭晓守卫：bitmap 恢复按正常双守卫判定，比例不回退、不误揭晓', () => {
  const engine = makeEngine()
  const total = COLS * ROWS
  const values = new Array(total).fill(255)
  for (let i = 0; i < 6; i++) values[i] = 0 // 约 1.7%，远低于阈值
  const snap = engine.applySamples(alphaData(values), fullRect)
  // bitmap 恢复：读到刮开后的像素，ratio 保持，不揭晓但也不回退。
  assert.equal(guardedShouldReveal(snap, 0.5, 'bitmap', true), false)
  assert.ok(engine.ratio > 0)

  // 构造一张「恰好达标」快照：bitmap 模式即使无后续擦除也允许揭晓。
  const valuesReveal = new Array(total).fill(255)
  const cleanN = Math.ceil(total * 0.46)
  for (let i = 0; i < cleanN; i++) valuesReveal[i] = 0
  for (let i = cleanN; i < total; i++) valuesReveal[i] = 60
  const snapReveal = engine.applySamples(alphaData(valuesReveal), fullRect)
  assert.equal(guardedShouldReveal(snapReveal, 0.5, 'bitmap', false), true)
})

test('恢复后揭晓守卫：replay 重放后首次采样即使比例达标也不自动揭晓，用户再刮一笔后恢复', () => {
  const engine = makeEngine()
  const total = COLS * ROWS
  // 先在内存网格积累到达标（刮动中切后台）。
  const values = new Array(total).fill(255)
  const cleanN = Math.ceil(total * 0.46)
  for (let i = 0; i < cleanN; i++) values[i] = 0
  for (let i = cleanN; i < total; i++) values[i] = 60
  const snap = engine.applySamples(alphaData(values), fullRect)
  assert.ok(shouldReveal(snap, 0.5))
  // replay 刚恢复、用户尚未补刮：禁止揭晓（防圆点放大擦净误触发）。
  assert.equal(guardedShouldReveal(snap, 0.5, 'replay', false), false)
  // 用户补刮一笔后恢复正常判定。
  assert.equal(guardedShouldReveal(snap, 0.5, 'replay', true), true)
  // reset / none 模式不受守卫影响（reset 全新涂层本就不可能达标）。
  assert.equal(guardedShouldReveal(snap, 0.5, 'reset', false), true)
  assert.equal(guardedShouldReveal(snap, 0.5, 'none', false), true)
})
