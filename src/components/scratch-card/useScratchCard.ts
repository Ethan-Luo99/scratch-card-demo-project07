/**
 * 刮刮卡组合式编排（对齐 01-技术方案 §8 状态机 / §6 调度 / §8.3 异常转移）。
 *
 * 职责：
 * - 驱动 Loading/Idle/Scratching/Revealing/Revealed/Settled/Failed 状态机。
 * - rAF 调度：仅 dirty && 间隔 ≥120ms 时采样；touchmove 路径零 getImageData。
 * - progress emit 限频 ≤10fps。
 * - 多指只追踪首指 identifier；touchmove 时间戳 gap>1s 强制抬笔重按。
 * - onHide 停 rAF + endStroke；onShow 重查 rect、检测画布回收并重绘/重放。
 * - complete 全周期只 emit 一次（状态守卫）。
 */

import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue'
import {
  createScratchEngine,
  decideResumeStrategy,
  guardedShouldReveal,
  type PausedSnapshot,
  type ResumeMode,
} from './scratchEngine'
import { platformAdapter, toCanvasPoint } from './platformAdapter'
import type {
  CanvasSurface,
  GridSnapshot,
  MeasuredRect,
  Point,
  PrizeInfo,
  ScratchStatus,
  TouchEventLike,
} from './types'

export interface UseScratchCardOptions {
  canvasId: string
  widthRpx: Ref<number>
  heightRpx: Ref<number>
  brushRadiusRpx: Ref<number>
  threshold: Ref<number>
  coverColor: Ref<string>
  coverImage: Ref<string | undefined>
  gridCols: Ref<number>
  gridRows: Ref<number>
  disabled: Ref<boolean>
  prize: Ref<PrizeInfo | null>
  /** 逻辑层实例（小程序组件内 SelectorQuery 需要） */
  getInstance: () => unknown
  /** 调试开关：强制位图导出失败，验证静默重置新卡路径（H5 自测入口） */
  debugExportFail?: () => boolean
  /** 调试开关：模拟导出能力不可用（位图恒为 null，走网格圆点重放二级兜底） */
  debugNoBitmap?: () => boolean
  /** 调试开关：强制位图恢复失败，验证静默降级（H5 自测入口） */
  debugRestoreFail?: () => boolean
  onProgress?: (ratio: number) => void
  onScratchStart?: () => void
  onComplete: (prize: PrizeInfo) => void
}

const SAMPLE_INTERVAL_MS = 120
const PROGRESS_EMIT_INTERVAL_MS = 100
const REVEAL_FADE_MS = 260
const STROKE_GAP_MS = 1000

export function useScratchCard(options: UseScratchCardOptions) {
  const status = ref<ScratchStatus>('loading')
  const ratio = ref(0)
  const canvasHidden = ref(false)
  const fadeOut = ref(false)
  const ready = ref(false)

  const surface = shallowRef<CanvasSurface | null>(null)
  let rect: MeasuredRect | null = null
  let cssWidth = 0
  let cssHeight = 0
  let brushRadiusPx = 0
  let frameHandle: number | null = null
  let rafRunning = false
  let dirty = false
  let lastCheckAt = 0
  let lastProgressEmitAt = 0
  let activeIdentifier: number | null = null
  let lastMoveAt = 0
  let lastSnapshot: GridSnapshot | null = null
  let completeEmitted = false
  let revealTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let initialized = false
  // onHide 位图快照与恢复状态（仅内存保留，不落盘）
  let pausedSnapshot: PausedSnapshot | null = null
  let resumeMode: ResumeMode = 'none'
  let userErasedAfterResume = true

  function isInteractive(): boolean {
    return (
      !options.disabled.value &&
      Boolean(options.prize.value) &&
      (status.value === 'idle' || status.value === 'scratching')
    )
  }

  /* ---------------- rAF 调度循环（采样不在 touchmove 内） ---------------- */

  function stopLoop(): void {
    rafRunning = false
    if (frameHandle !== null && surface.value) {
      surface.value.cancelFrame(frameHandle)
      frameHandle = null
    }
  }

  function startLoop(): void {
    if (rafRunning) return
    rafRunning = true
    const tick = (time: number): void => {
      if (!rafRunning || disposed) return
      if (
        dirty &&
        status.value === 'scratching' &&
        surface.value &&
        time - lastCheckAt >= SAMPLE_INTERVAL_MS
      ) {
        lastCheckAt = time
        dirty = false
        checkArea(time)
      }
      if (rafRunning) {
        frameHandle = surface.value ? surface.value.scheduleFrame(tick) : null
      }
    }
    frameHandle = surface.value ? surface.value.scheduleFrame(tick) : null
  }

  /** rAF 内执行：drawImage 降采样 → 更新网格 → 限频 progress → 阈值判定。 */
  function checkArea(time: number): void {
    const s = surface.value
    if (!s) return
    const samples = s.sampleGrid(options.gridCols.value, options.gridRows.value)
    const snap = engineApply(samples)
    lastSnapshot = snap
    ratio.value = snap.ratio
    if (
      time - lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS ||
      snap.ratio === 0
    ) {
      lastProgressEmitAt = time
      options.onProgress?.(snap.ratio)
    }
    if (
      guardedShouldReveal(
        snap,
        options.threshold.value,
        resumeMode,
        userErasedAfterResume,
      )
    ) {
      enterRevealing()
    }
  }

  /* ---------------- 引擎（随尺寸变化重建） ---------------- */

  let engine = createScratchEngine({
    width: 1,
    height: 1,
    brushRadius: 1,
    cols: options.gridCols.value,
    rows: options.gridRows.value,
  })

  function engineApply(samples: Uint8ClampedArray): GridSnapshot {
    return engine.applySamples(samples, {
      x: 0,
      y: 0,
      w: cssWidth,
      h: cssHeight,
    })
  }

  /* ---------------- 初始化 / 涂层绘制 ---------------- */

  function queryRectWithRetry(attempt = 0): Promise<MeasuredRect> {
    return platformAdapter
      .queryRect(options.canvasId, options.getInstance())
      .catch((err) => {
        // 小程序组件 mounted 可能早于节点 ready：轮询重试约 1s（R2）。
        if (attempt >= 20) throw err
        return new Promise<MeasuredRect>((resolve, reject) => {
          setTimeout(() => {
            queryRectWithRetry(attempt + 1).then(resolve, reject)
          }, 50)
        })
      })
  }

  /**
   * mount 重试：queryRect 已返回但内部 2d 节点尚未 ready（重试挂载/重新渲染
   * 后 uni-canvas 内部 canvas 滞后创建）时，轮询约 1s，避免误进 Failed。
   */
  function mountWithRetry(opts: Parameters<typeof platformAdapter.mount>[1], attempt = 0): Promise<CanvasSurface> {
    return platformAdapter.mount(options.canvasId, opts).catch((err) => {
      if (attempt >= 20 || disposed) throw err
      return new Promise<CanvasSurface>((resolve, reject) => {
        setTimeout(() => {
          mountWithRetry(opts, attempt + 1).then(resolve, reject)
        }, 50)
      })
    })
  }

  async function init(): Promise<void> {
    if (initialized) return
    try {
      const measured = await queryRectWithRetry()
      rect = measured
      cssWidth = measured.width
      cssHeight = measured.height
      const screenWidth = uni.getSystemInfoSync().windowWidth || cssWidth
      brushRadiusPx = (options.brushRadiusRpx.value * screenWidth) / 750
      const s = await mountWithRetry({
        cssWidthPx: cssWidth,
        cssHeightPx: cssHeight,
        brushRadiusPx,
        gridCols: options.gridCols.value,
        gridRows: options.gridRows.value,
        instance: options.getInstance(),
      })
      if (disposed) {
        s.dispose()
        return
      }
      surface.value = s
      engine = createScratchEngine({
        width: cssWidth,
        height: cssHeight,
        brushRadius: brushRadiusPx,
        cols: options.gridCols.value,
        rows: options.gridRows.value,
      })
      await s.paintCover(options.coverColor.value, options.coverImage.value)
      canvasHidden.value = false
      fadeOut.value = false
      ready.value = true
      initialized = true
      if (options.prize.value && !options.disabled.value && status.value === 'loading') {
        status.value = 'idle'
      }
      startLoop()
    } catch (err) {
      // canvas 初始化失败（非旧内核）：Failed 态，由页面展示重试（§8.3）。
      console.error('[scratch-card] init failed', err)
      status.value = 'failed'
      ready.value = false
    }
  }

  /** 奖品由 loading → 就绪时调用 */
  function notifyPrizeReady(): void {
    if (
      ready.value &&
      options.prize.value &&
      !options.disabled.value &&
      (status.value === 'loading')
    ) {
      status.value = 'idle'
    }
  }

  function retry(): void {
    status.value = 'loading'
    ready.value = false
    void init()
  }

  function paintCoverAgain(): Promise<void> {
    const s = surface.value
    if (!s) return Promise.resolve()
    return s.paintCover(options.coverColor.value, options.coverImage.value)
  }

  /* ---------------- 触摸 / 鼠标事件（首指追踪） ---------------- */

  function pickPoint(raw: TouchEventLike): Point | null {
    if (!rect || !surface.value) return null
    return toCanvasPoint(raw, rect, cssWidth, cssHeight)
  }

  function onTouchStart(raw: TouchEventLike, identifier?: number): void {
    if (!isInteractive() || activeIdentifier !== null) return
    // 只追踪首指：次指落下直接忽略（R9 / T08）。
    activeIdentifier = identifier ?? 0
    const p = pickPoint(raw)
    if (!p) return
    if (status.value === 'idle') {
      status.value = 'scratching'
      options.onScratchStart?.()
    }
    userErasedAfterResume = true
    lastMoveAt = Date.now()
    engine.beginStroke(p)
    // 起笔先点一个圆，保证单击也有擦除区。
    surface.value?.erase(engine.dotAt(p))
    dirty = true
  }

  function onTouchMove(raw: TouchEventLike, identifier?: number): void {
    if (!isInteractive()) return
    // 非追踪指（多指）忽略，不切换追踪目标，不发生跨指连线。
    if (activeIdentifier === null || identifier !== activeIdentifier) return
    const now = Date.now()
    if (now - lastMoveAt > STROKE_GAP_MS) {
      // 来电/系统弹窗造成的序列断档：强制结束旧笔画并以当前点重开（§8.3）。
      engine.endStroke()
      const restart = pickPoint(raw)
      if (restart) engine.beginStroke(restart)
    }
    lastMoveAt = now
    const p = pickPoint(raw)
    if (!p) return
    const cmd = engine.feedPoint(p)
    if (cmd) {
      surface.value?.erase(cmd)
      dirty = true
    }
  }

  function onTouchEnd(identifier?: number): void {
    if (identifier !== undefined && identifier !== activeIdentifier) return
    activeIdentifier = null
    if (status.value !== 'scratching') return
    engine.endStroke()
    // 抬笔后强制再判一次（处理最后一笔，§6.4-6）。
    const s = surface.value
    if (s && dirty) {
      lastCheckAt = 0
    }
  }

  /** 组件归一 uni 触摸事件 */
  function normalizeAndHandle(
    type: 'start' | 'move' | 'end',
    e: { touches?: Array<TouchEventLike>; changedTouches?: Array<TouchEventLike> },
  ): void {
    const list =
      type === 'end'
        ? e.changedTouches && e.changedTouches.length
          ? e.changedTouches
          : e.touches
        : e.touches && e.touches.length
          ? e.touches
          : e.changedTouches
    const t = list && list[0]
    if (!t) {
      if (type === 'end') onTouchEnd(activeIdentifier ?? undefined)
      return
    }
    const id = typeof t.identifier === 'number' ? t.identifier : 0
    if (type === 'start') onTouchStart(t, id)
    else if (type === 'move') onTouchMove(t, id)
    else onTouchEnd(id)
  }

  /* ---------------- 揭晓（complete 只 emit 一次） ---------------- */

  function enterRevealing(): void {
    // 状态守卫：非 Scratching 不得进入，杜绝重复 complete（T30）。
    if (status.value !== 'scratching') return
    status.value = 'revealing'
    resumeMode = 'none'
    stopLoop()
    const s = surface.value
    if (!s) return
    if (s.legacy) {
      // App 旧内核：即时清空并隐藏原生节点，露出下方 view（§7.2）。
      s.revealAll()
      canvasHidden.value = true
      status.value = 'revealed'
      emitCompleteOnce()
      return
    }
    // 主路径：CSS opacity 200~260ms 淡出；transitionend 不可靠统一用 260ms 定时。
    fadeOut.value = true
    revealTimer = setTimeout(() => {
      s.revealAll()
      fadeOut.value = false
      canvasHidden.value = true
      status.value = 'revealed'
      emitCompleteOnce()
    }, REVEAL_FADE_MS)
  }

  function emitCompleteOnce(): void {
    if (completeEmitted) return
    const prize = options.prize.value
    if (!prize) return
    completeEmitted = true
    options.onComplete(prize)
  }

  /** 页面结算完成后调用，进入 Settled 锁定态 */
  function markSettled(): void {
    if (status.value === 'revealed' || status.value === 'settled') {
      status.value = 'settled'
    }
  }

  /* ---------------- onHide / onShow 异常转移（§8.3 / 约束 2.6） ---------------- */

  /**
   * 刮卡中切后台：停 rAF、结束当前笔画（防止回前台贯穿长线），
   * 并把当前 canvas 位图导出到内存（H5 toDataURL；MP/App 2D
   * wx.canvasToTempFilePath({canvas})；App 旧内核 canvasId 版同名 API）。
   * 导出能力不可用记为 bitmap=null（走网格圆点重放二级兜底）；
   * 导出本身失败标记 exportFailed（回前台静默重置为新卡）。
   */
  async function pause(): Promise<void> {
    stopLoop()
    engine.endStroke()
    activeIdentifier = null
    const s = surface.value
    // 仅刮卡链路（Idle/Scratching）需要保留进度；揭晓/结算中画布即将隐藏，无需快照。
    if (!s || (status.value !== 'idle' && status.value !== 'scratching')) {
      pausedSnapshot = null
      return
    }
    if (options.debugExportFail?.()) {
      pausedSnapshot = { bitmap: null, exportFailed: true }
      return
    }
    try {
      const bitmap = options.debugNoBitmap?.() ? null : await s.exportBitmap()
      pausedSnapshot = { bitmap, exportFailed: false }
    } catch {
      pausedSnapshot = { bitmap: null, exportFailed: true }
    }
  }

  function readDebugRecycleFlag(): boolean {
    // #ifdef H5
    const g = globalThis as unknown as { __scratchDebugRecycle?: boolean }
    if (g.__scratchDebugRecycle) return true
    // #endif
    // #ifndef H5
    // 小程序/App 无此自测钩子；真实画布回收由系统触发，isAlive() 自然为 false。
    // #endif
    return false
  }

  /** 静默重置为新卡：重绘完整涂层、网格与 ratio 归零、回到 Idle（降级不留脏状态）。 */
  async function resetToFreshCard(
    ns: CanvasSurface,
    targetW: number,
    targetH: number,
    targetBrush: number,
  ): Promise<void> {
    await ns.paintCover(options.coverColor.value, options.coverImage.value)
    cssWidth = targetW
    cssHeight = targetH
    brushRadiusPx = targetBrush
    engine = createScratchEngine({
      width: cssWidth,
      height: cssHeight,
      brushRadius: brushRadiusPx,
      cols: options.gridCols.value,
      rows: options.gridRows.value,
    })
    ratio.value = 0
    lastSnapshot = null
    dirty = false
    lastCheckAt = 0
    if (status.value === 'scratching') status.value = 'idle'
  }

  /**
   * 回前台（进度保留三级兜底）：
   * - 先重查 rect；node 存活且尺寸未变：位图仍在，直接续刮（retain）。
   * - node 失效（画布被回收）：位图可用 → drawImage 原样恢复（bitmap，一级）；
   *   位图导出能力不可用 → 重绘涂层 + buildReplayCommand 圆点重放（replay，二级）；
   *   导出/恢复失败或尺寸变化 → 静默重置为新卡（reset，三级）。
   */
  async function resume(): Promise<void> {
    if (disposed || !initialized) return
    const snapshot = pausedSnapshot
    let measured: MeasuredRect
    try {
      measured = await platformAdapter.queryRect(
        options.canvasId,
        options.getInstance(),
      )
    } catch {
      return
    }
    const s = surface.value
    const surfaceAlive = Boolean(s && s.isAlive())
    const sizeChanged = measured.width !== cssWidth || measured.height !== cssHeight
    rect = measured
    // H5 自测钩子：强制按「画布被系统回收」处理（真实回收由系统触发，无需此标记）。
    const forceRecycle = readDebugRecycleFlag()
    const strategy = decideResumeStrategy({
      snapshot,
      surfaceAlive: surfaceAlive && !forceRecycle,
      sizeChanged,
    })

    if (strategy === 'retain') {
      pausedSnapshot = null
      if (status.value === 'scratching' || status.value === 'idle') startLoop()
      return
    }

    stopLoop()
    s?.dispose()
    surface.value = null

    // #ifdef H5
    // 自测钩子：在释放旧 surface 后、重新 mount 前，把宿主内 canvas 换成全新节点，
    // 等价于系统回收后位图随节点销毁。重置 backing store（width 自赋值会清空位图）
    // 但保留 uni-canvas 托管的同一节点与其 hidpi 上下文，随后 mount 重新设置物理尺寸。
    const recycleG = globalThis as unknown as { __scratchDebugRecycle?: boolean }
    if (recycleG.__scratchDebugRecycle) {
      recycleG.__scratchDebugRecycle = false
      const host = document.getElementById(options.canvasId)
      const oldInner =
        host && host.tagName !== 'CANVAS' ? host.querySelector('canvas') : null
      if (oldInner) oldInner.width = oldInner.width
    }
    // #endif

    const targetW = measured.width
    const targetH = measured.height
    const screenWidth = uni.getSystemInfoSync().windowWidth || targetW
    const targetBrush = (options.brushRadiusRpx.value * screenWidth) / 750

    try {
      const ns = await mountWithRetry({
        cssWidthPx: targetW,
        cssHeightPx: targetH,
        brushRadiusPx: targetBrush,
        gridCols: options.gridCols.value,
        gridRows: options.gridRows.value,
        instance: options.getInstance(),
      })
      if (disposed) {
        ns.dispose()
        return
      }
      surface.value = ns
      canvasHidden.value = false
      fadeOut.value = false

      let needFreshReset = false
      if (strategy === 'bitmap' && snapshot?.bitmap) {
        // 一级方案：位图原样恢复，ratio 不回退、无误揭晓（读到的仍是刮开后的像素）。
        const forcedFail = options.debugRestoreFail?.()
        const ok = forcedFail ? false : await ns.restoreBitmap(snapshot.bitmap)
        if (!ok) {
          // 恢复失败：静默降级为「重置为新卡」，不留脏状态（不再尝试 replay）。
          needFreshReset = true
        }
        resumeMode = 'bitmap'
      } else if (strategy === 'replay') {
        // 二级兜底：重绘涂层 + 网格圆点重放（buildReplayCommand）。
        await ns.paintCover(options.coverColor.value, options.coverImage.value)
        const replay = engine.buildReplayCommand()
        if (replay) {
          ns.erase(replay)
          dirty = true
          lastCheckAt = 0
        }
        // 近似重建在用户下一笔之前不允许自动揭晓（防可疑格被放大擦净误触发）。
        resumeMode = 'replay'
        userErasedAfterResume = false
      }

      if (strategy === 'reset') {
        // reset（含导出失败、恢复失败、尺寸变化）：静默重置为新卡。
        needFreshReset = true
        resumeMode = 'reset'
        userErasedAfterResume = true
      }

      if (needFreshReset) {
        await resetToFreshCard(ns, targetW, targetH, targetBrush)
      }

      pausedSnapshot = null

      if (status.value === 'revealed' || status.value === 'settled') {
        ns.revealAll()
        canvasHidden.value = true
      }
      startLoop()
    } catch (err) {
      // 重建/恢复链路异常：静默降级，不抛出、不留脏状态。
      void err
      status.value = 'failed'
      ready.value = false
    }
  }

  function setFailed(): void {
    stopLoop()
    status.value = 'failed'
  }

  onBeforeUnmount(() => {
    disposed = true
    stopLoop()
    if (revealTimer) clearTimeout(revealTimer)
    surface.value?.dispose()
    surface.value = null
  })

  return {
    status,
    ratio,
    ready,
    canvasHidden,
    fadeOut,
    init,
    retry,
    notifyPrizeReady,
    setFailed,
    markSettled,
    pause,
    resume,
    normalizeAndHandle,
    onMouseDown(e: TouchEventLike): void {
      onTouchStart(e, 0)
    },
    onMouseMove(e: TouchEventLike): void {
      onTouchMove(e, 0)
    },
    onMouseUp(): void {
      onTouchEnd(0)
    },
  }
}
