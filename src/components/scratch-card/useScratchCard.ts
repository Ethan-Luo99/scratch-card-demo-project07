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
import { createScratchEngine, shouldReveal } from './scratchEngine'
import { platformAdapter, toCanvasPoint } from './platformAdapter'
import {
  decideRecoveryTier,
  fallbackAfterRestoreFailure,
  isSnapshotInSession,
  tierAfterReplayUnavailable,
} from './recoveryPolicy'
import type {
  BitmapSnapshot,
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
  /** 页面会话标识：位图/网格进度仅同会话 onShow 可恢复，跨会话一律发新卡 */
  sessionId?: Ref<string>
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
  // 进度保留：onHide 导出的位图快照（绑定会话标识）+ 导出尝试标记（三级兜底决策用）。
  let bitmapSnapshot: { session: string; data: BitmapSnapshot } | null = null
  let exportAttempted = false
  let pendingExport: Promise<BitmapSnapshot | null> | null = null
  // H5 自测钩子：置 true 时下一次位图导出强制失败（验证静默降级）。
  let debugForceExportFail = false

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
    if (shouldReveal(snap, options.threshold.value)) {
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

  async function init(): Promise<void> {
    if (initialized) return
    try {
      const measured = await queryRectWithRetry()
      rect = measured
      cssWidth = measured.width
      cssHeight = measured.height
      const screenWidth = uni.getSystemInfoSync().windowWidth || cssWidth
      brushRadiusPx = (options.brushRadiusRpx.value * screenWidth) / 750
      const s = await platformAdapter.mount(options.canvasId, {
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
      rebuildEngine()
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
    clearBitmapSnapshot()
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

  /* ---------------- onHide / onShow 异常转移（§8.3 / 本轮进度保留升级） ---------------- */

  function clearBitmapSnapshot(): void {
    bitmapSnapshot = null
    exportAttempted = false
    pendingExport = null
  }

  /** 仅同会话的位图快照可用；跨会话（持久化恢复）一律视为无快照 → 发新卡。 */
  function sessionSnapshot(): BitmapSnapshot | null {
    if (!bitmapSnapshot) return null
    const session = options.sessionId ? options.sessionId.value : ''
    return isSnapshotInSession(bitmapSnapshot.session, session)
      ? bitmapSnapshot.data
      : null
  }

  /** 按当前尺寸/笔刷重建引擎（与 init 路径同口径）。 */
  function rebuildEngine(): void {
    engine = createScratchEngine({
      width: cssWidth,
      height: cssHeight,
      brushRadius: brushRadiusPx,
      cols: options.gridCols.value,
      rows: options.gridRows.value,
    })
  }

  /**
   * 重置为新卡（静默降级终态 / 尺寸变化）：
   * 重绘涂层 + 重建引擎（不能只 reset：resume 后 surface 已换新实例，
   * 旧引擎的 ratio 单调快照会在下一帧采样时把进度「写回」）。
   */
  async function resetToFreshCover(ns: CanvasSurface): Promise<void> {
    await ns.paintCover(options.coverColor.value, options.coverImage.value)
    rebuildEngine()
    ratio.value = 0
    dirty = false
    lastSnapshot = null
    if (status.value === 'scratching') status.value = 'idle'
    // 向外同步归零（页面埋点/自验窗口钩子），避免外部仍显示旧进度。
    options.onProgress?.(0)
  }

  /**
   * 刮卡中切后台：
   * - 停 rAF、结束当前笔画，防止回前台贯穿长线；
   * - 进度保留升级：把当前 canvas 位图导出到内存
   *   （H5 toDataURL；MP-WEIXIN / APP-PLUS 2D 节点 canvasToTempFilePath({canvas})）。
   * 导出全程静默：失败只置标记，onShow 时按三级兜底降级，不报错、不留脏状态。
   */
  function pause(): void {
    stopLoop()
    engine.endStroke()
    activeIdentifier = null
    const s = surface.value
    // 揭晓态/无 surface 不导出：揭晓结果由下层奖品 view 承载，无需位图。
    if (!s || (status.value !== 'idle' && status.value !== 'scratching')) return
    bitmapSnapshot = null
    exportAttempted = true
    // runBitmapExport 内部已吞错；理论上不会 reject，catch 仅作静默保险。
    try {
      pendingExport = runBitmapExport(s)
    } catch {
      /* 静默：无快照时恢复策略自动降级 fresh */
    }
  }

  async function runBitmapExport(
    s: CanvasSurface,
  ): Promise<BitmapSnapshot | null> {
    let snapshot: BitmapSnapshot | null = null
    try {
      snapshot = debugForceExportFail ? null : await s.exportBitmap()
    } catch {
      snapshot = null
    }
    // 导出成功的唯一标志是持有快照；失败保持 bitmapSnapshot=null，
    // 恢复策略据 exportAttempted && !snapshot 判定为 fresh 降级。
    if (snapshot) {
      bitmapSnapshot = {
        session: options.sessionId ? options.sessionId.value : '',
        data: snapshot,
      }
    }
    return snapshot
  }

  /**
   * 回前台（进度保留升级）：
   * - 先重查 rect；node 存活且尺寸未变：位图仍在，直接续刮。
   * - 布局尺寸变化（旋转/分屏）：坐标系改变，按新尺寸重建并重置为新卡。
   * - node 失效/尺寸为 0（画布被回收）：重新 mount 后按三级兜底恢复——
   *   1. 位图可用：drawImage 整体恢复（ratio/网格不回退、不误触发揭晓）；
   *   2. 位图不可用（旧内核等）：buildReplayCommand 网格圆点重放（二级兜底）；
   *   3. 导出失败或恢复失败：静默降级回「重置为新卡」（不报错、不留脏状态）。
   */
  async function resume(): Promise<void> {
    if (disposed || !initialized) return
    // 等 onHide 已发起的导出落定（不阻塞 node 存活的快路径判空之外的逻辑）。
    if (pendingExport) {
      try {
        await pendingExport
      } catch {
        /* 静默 */
      }
      pendingExport = null
    }
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
    const recycled = !s || !s.isAlive()
    const sizeChanged = measured.width !== cssWidth || measured.height !== cssHeight
    rect = measured

    if (!recycled && !sizeChanged) {
      // 节点位图仍在，导出的快照不再需要（避免持有 dataURL/临时文件引用）。
      clearBitmapSnapshot()
      if (status.value === 'scratching' || status.value === 'idle') startLoop()
      return
    }

    stopLoop()
    s?.dispose()
    surface.value = null

    const targetW = measured.width
    const targetH = measured.height
    const screenWidth = uni.getSystemInfoSync().windowWidth || targetW
    const targetBrush = (options.brushRadiusRpx.value * screenWidth) / 750

    let ns: CanvasSurface
    try {
      ns = await platformAdapter.mount(options.canvasId, {
        cssWidthPx: targetW,
        cssHeightPx: targetH,
        brushRadiusPx: targetBrush,
        gridCols: options.gridCols.value,
        gridRows: options.gridRows.value,
        instance: options.getInstance(),
      })
    } catch (err) {
      console.error('[scratch-card] resume failed', err)
      status.value = 'failed'
      return
    }
    if (disposed) {
      ns.dispose()
      return
    }
    surface.value = ns
    cssWidth = targetW
    cssHeight = targetH
    brushRadiusPx = targetBrush
    canvasHidden.value = false
    fadeOut.value = false

    if (sizeChanged) {
      // 尺寸变化：坐标系改变，位图/网格坐标均失效，等同发一张新卡。
      // cssWidth/Height 已在前面更新，resetToFreshCover 内按新尺寸重建引擎。
      await resetToFreshCover(ns)
      clearBitmapSnapshot()
      startLoop()
      return
    }

    if (status.value === 'revealed' || status.value === 'settled') {
      // 揭晓后画布回收：结果由下层奖品 view 展示，清空涂层即可，无需恢复位图。
      ns.revealAll()
      canvasHidden.value = true
      clearBitmapSnapshot()
      startLoop()
      return
    }

    // 画布被回收且尺寸未变：位图恢复 → 网格重放 → 重置新卡（三级兜底，纯逻辑决策）。
    // 位图快照绑定会话标识：跨会话（持久化恢复）sessionSnapshot() 为 null → fresh。
    const usableSnapshot = sessionSnapshot()
    let tier = decideRecoveryTier({
      legacy: Boolean(ns.legacy),
      exportAttempted,
      snapshot: usableSnapshot,
    })
    let replayCmd: ReturnType<typeof engine.buildReplayCommand> = null

    if (tier === 'bitmap') {
      const restored = usableSnapshot
        ? await ns.restoreBitmap(usableSnapshot)
        : false
      if (!restored) {
        // 位图恢复失败：按约束直接静默降级为重置新卡（不报错、不留脏状态）。
        tier = fallbackAfterRestoreFailure()
      }
    } else if (tier === 'replay') {
      await ns.paintCover(options.coverColor.value, options.coverImage.value)
      replayCmd = engine.buildReplayCommand()
      if (!replayCmd) {
        // 网格也无进度可重放：等同新卡。
        tier = tierAfterReplayUnavailable()
      }
    }

    if (tier === 'fresh') {
      await resetToFreshCover(ns)
      clearBitmapSnapshot()
      startLoop()
      return
    }

    if (tier === 'replay' && replayCmd) {
      ns.erase(replayCmd)
    }
    // tier === 'bitmap' 已整体 drawImage 恢复。
    // 恢复成功：ratio 与网格保持 onHide 前状态（单调不回退），下一笔采样自然校准，
    // 恢复路径本身不做揭晓判定（杜绝误触发）。
    dirty = true
    lastCheckAt = 0
    clearBitmapSnapshot()
    startLoop()
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

  /**
   * H5 自验：模拟「onHide 导出位图后 canvas 节点被回收」。
   * 停循环 + 导出位图 + 销毁旧 surface（节点位图随之丢失），随后可调用 resume() 验证恢复。
   */
  // #ifdef H5
  async function debugSimulateRecycled(): Promise<void> {
    const s = surface.value
    if (!s) return
    pause()
    if (pendingExport) {
      try {
        await pendingExport
      } catch {
        /* 静默 */
      }
      pendingExport = null
    }
    stopLoop()
    s.dispose()
    surface.value = null
    // H5 节点仍在 DOM 中：置空物理尺寸模拟回收（isAlive() 为 false）。
    const host = document.getElementById(options.canvasId)
    const inner =
      host && host.tagName === 'CANVAS'
        ? (host as HTMLCanvasElement)
        : host
          ? host.querySelector('canvas')
          : null
    if (inner) {
      inner.width = 0
      inner.height = 0
    }
  }

  function debugSetExportFail(on: boolean): void {
    debugForceExportFail = on
  }
  // #endif

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
    ...({
      // #ifdef H5
      debugSimulateRecycled,
      debugSetExportFail,
      // #endif
    } as Record<string, unknown>),
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
