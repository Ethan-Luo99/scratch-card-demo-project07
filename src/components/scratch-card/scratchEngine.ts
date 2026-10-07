/**
 * 刮刮卡纯算法层（对齐 01-技术方案 §4.2 / §6）。
 *
 * 硬性约束：
 * - 纯函数/纯数据，不 import 任何 uni / DOM API，可直接在 Node 下单测。
 * - 笔画插值补点（快速甩动不断线）。
 * - 网格三态：0=有涂层 1=已擦净 2=可疑；双阈值迟滞 ALPHA_CLEAN=24 / ALPHA_SOLID=120。
 * - cell 状态单调不可逆（只允许 0→2→1），ratio 单调不减。
 */

import type {
  EraseCommand,
  GridSnapshot,
  Point,
  SampleRect,
  ScratchEngineLike,
  StrokeSegment,
} from './types'

/** alpha ≤ 24 判定为明确擦净 */
export const ALPHA_CLEAN = 24
/** alpha ≥ 120 判定为明确有涂层 */
export const ALPHA_SOLID = 120
/** 可疑格折算系数 */
export const FUZZY_WEIGHT = 0.5
/** 补点步长 = 笔刷半径 × 0.6 */
export const STEP_RATIO = 0.6
/** 事件级降采样：相邻点距离 < 2 逻辑 px 时丢弃 */
export const MIN_MOVE_DISTANCE = 2
/** 可疑格凑阈值的额外守卫：净格占比必须达到 threshold - 0.05 */
export const CLEAN_GUARD_GAP = 0.05

export const CELL_COVERED = 0
export const CELL_CLEAN = 1
export const CELL_FUZZY = 2

export interface CreateEngineOptions {
  /** canvas 逻辑宽（CSS px），重放网格时需要 */
  width: number
  /** canvas 逻辑高（CSS px） */
  height: number
  brushRadius: number
  cols: number
  rows: number
}

function distance(a: Point, b: Point): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

export function createScratchEngine(options: CreateEngineOptions): ScratchEngineLike {
  const width = options.width
  const height = options.height
  const brushRadius = options.brushRadius
  const cols = options.cols
  const rows = options.rows
  const total = cols * rows
  const cellW = width / cols
  const cellH = height / rows

  let cells = new Uint8Array(total)
  let active = false
  let lastPoint: Point = { x: 0, y: 0 }
  let lastSampleRatio = 0
  let lastCleanRatio = 0

  function snapshot(): GridSnapshot {
    let cleanCount = 0
    let fuzzyCount = 0
    for (let i = 0; i < total; i++) {
      if (cells[i] === CELL_CLEAN) cleanCount++
      else if (cells[i] === CELL_FUZZY) fuzzyCount++
    }
    const cleanRatio = cleanCount / total
    const ratio = (cleanCount + fuzzyCount * FUZZY_WEIGHT) / total
    // 单调性兜底：cell 单调已保证不回降，浮点场景下再钳一次。
    lastSampleRatio = ratio >= lastSampleRatio ? ratio : lastSampleRatio
    lastCleanRatio = cleanRatio >= lastCleanRatio ? cleanRatio : lastCleanRatio
    return {
      cols,
      rows,
      cells,
      cleanCount,
      fuzzyCount,
      cleanRatio: lastCleanRatio,
      ratio: lastSampleRatio,
    }
  }

  function beginStroke(p: Point): void {
    active = true
    lastPoint = { x: p.x, y: p.y }
  }

  function dotAt(p: Point): EraseCommand {
    return { segments: [{ from: p, to: p }], radius: brushRadius }
  }

  function feedPoint(p: Point): EraseCommand | null {
    if (!active) return null
    const d = distance(lastPoint, p)
    // 事件级降采样：<2px 的密集点丢弃（round cap 已连续覆盖）。
    if (d < MIN_MOVE_DISTANCE) return null

    const step = Math.max(1, brushRadius * STEP_RATIO)
    const n = Math.max(1, Math.ceil(d / step))
    const segments: StrokeSegment[] = []
    let prev = lastPoint
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const q: Point = {
        x: lastPoint.x + (p.x - lastPoint.x) * t,
        y: lastPoint.y + (p.y - lastPoint.y) * t,
      }
      segments.push({ from: prev, to: q })
      prev = q
    }
    lastPoint = { x: p.x, y: p.y }
    return { segments, radius: brushRadius }
  }

  function endStroke(): void {
    active = false
  }

  function applySamples(samples: Uint8ClampedArray, _rect: SampleRect): GridSnapshot {
    // samples：离屏 cols×rows 小画布读出的 RGBA，步长 4 取 alpha。
    // 双阈值迟滞 + 状态单调不可逆（只允许 0→2→1）。
    const limit = Math.min(total, Math.floor(samples.length / 4))
    for (let idx = 0; idx < limit; idx++) {
      const alpha = samples[idx * 4 + 3]
      const prev = cells[idx]
      if (alpha <= ALPHA_CLEAN) {
        cells[idx] = CELL_CLEAN
      } else if (alpha < ALPHA_SOLID) {
        // 可疑只允许从「有涂层」升级，已是净格不得回降。
        if (prev !== CELL_CLEAN) cells[idx] = CELL_FUZZY
      }
      // alpha >= ALPHA_SOLID：明确有涂层，保持现状（单调）。
    }
    return snapshot()
  }

  function buildReplayCommand(): EraseCommand | null {
    // onShow 检测到画布被回收：重绘涂层后，按内存网格把已擦区域重放出来。
    // 净格擦除半径取格对角线一半（≥ 覆盖整格），可疑格取格宽一半。
    const segments: StrokeSegment[] = []
    let hasClean = false
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const state = cells[row * cols + col]
        if (state !== CELL_CLEAN && state !== CELL_FUZZY) continue
        const center: Point = {
          x: (col + 0.5) * cellW,
          y: (row + 0.5) * cellH,
        }
        // 以零长线段表达「圆点」，适配层 erase 会在端点补 arc。
        segments.push({ from: center, to: center })
        if (state === CELL_CLEAN) hasClean = true
      }
    }
    if (segments.length === 0) return null
    // 半径按「净格覆盖整格」为准；仅有可疑格时用较小半径。
    const radius = hasClean
      ? Math.sqrt(cellW * cellW + cellH * cellH) / 2
      : cellW * 0.5
    return { segments, radius }
  }

  function reset(): void {
    cells = new Uint8Array(total)
    active = false
    lastPoint = { x: 0, y: 0 }
    lastSampleRatio = 0
    lastCleanRatio = 0
  }

  return {
    beginStroke,
    dotAt,
    feedPoint,
    endStroke,
    applySamples,
    buildReplayCommand,
    reset,
    get ratio() {
      return lastSampleRatio
    },
    get cleanRatio() {
      return lastCleanRatio
    },
    get cells() {
      return cells
    },
    get cols() {
      return cols
    },
    get rows() {
      return rows
    },
  }
}

/**
 * 揭晓判定（双守卫）：
 * 1. 折算 ratio 达到 threshold；
 * 2. 严格净格占比 ≥ threshold - 0.05，防止全靠可疑格凑阈值。
 */
export function shouldReveal(snapshot: GridSnapshot, threshold: number): boolean {
  return (
    snapshot.ratio >= threshold &&
    snapshot.cleanRatio >= Math.max(0, threshold - CLEAN_GUARD_GAP)
  )
}

/* ------------------------------------------------------------------ */
/* onHide/onShow 进度保留：恢复路径决策（纯逻辑，可单测）             */
/* ------------------------------------------------------------------ */

/**
 * 恢复策略（三级兜底）：
 * - bitmap：onHide 位图可用，onShow drawImage 原样恢复（一级）；
 * - replay：位图导出不可用（快照为 null），用内存网格圆点重放（二级）；
 * - reset：导出/恢复失败或布局尺寸变化，静默重置为新卡（兜底）；
 * - retain：画布未被回收且尺寸未变，位图仍在，直接续刮。
 */
export type ResumeStrategy = 'bitmap' | 'replay' | 'reset' | 'retain'

export interface PausedSnapshot {
  /** data URL / 临时文件路径；null 表示导出能力不可用（可走 replay） */
  bitmap: string | null
  /** exportBitmap 自身执行失败：只能静默 reset，不再尝试 replay */
  exportFailed: boolean
}

export interface ResumeDecisionInput {
  /** onHide 时捕获的位图快照；null 表示 onHide 未发生/已消费 */
  snapshot: PausedSnapshot | null
  /** onShow 重查后画布节点是否存活（被系统回收） */
  surfaceAlive: boolean
  /** 布局尺寸是否变化（旋转/分屏，旧网格坐标失效） */
  sizeChanged: boolean
}

export function decideResumeStrategy(input: ResumeDecisionInput): ResumeStrategy {
  if (input.sizeChanged) return 'reset'
  if (input.surfaceAlive && !input.snapshot) return 'retain'
  if (!input.surfaceAlive) {
    if (!input.snapshot) return 'replay'
    if (input.snapshot.exportFailed) return 'reset'
    if (input.snapshot.bitmap) return 'bitmap'
    return 'replay'
  }
  // 节点存活但带快照（一般只在强制调试回收分支出现）：位图仍在，直接续刮。
  return 'retain'
}

/**
 * 恢复后揭晓守卫（防止二级兜底的网格圆点重放把可疑格放大擦净后误触发揭晓）：
 * - bitmap：逐像素恢复，读到的比例与刮动时一致，正常双守卫判定；
 * - replay：网格圆点是「近似重建」，保守起见在用户下一笔之前不允许自动揭晓
 *   （用户继续刮动产生新擦除后恢复正常判定）；
 * - reset：全新涂层 ratio=0，本就不可能揭晓。
 */
export type ResumeMode = 'bitmap' | 'replay' | 'reset' | 'none'

export function guardedShouldReveal(
  snapshot: GridSnapshot,
  threshold: number,
  resumeMode: ResumeMode,
  userErasedAfterResume: boolean,
): boolean {
  if (resumeMode === 'replay' && !userErasedAfterResume) return false
  return shouldReveal(snapshot, threshold)
}
