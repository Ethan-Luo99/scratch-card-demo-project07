/**
 * 跨端适配层（对齐 01-技术方案 §3 / §5 / §9.2）。
 *
 * - mount / 像素采样按 H5 / MP-WEIXIN / APP-PLUS 三段条件编译实现。
 * - 坐标换算 toCanvasPoint 三端共用：x = clientX - rect.left，y = clientY - rect.top。
 * - rAF：H5 用全局 requestAnimationFrame；MP 2D 用节点 requestAnimationFrame，
 *   回退 setTimeout(16)；MP 分支不允许出现 window.requestAnimationFrame。
 * - 面积采样只允许经「drawImage 缩放到 cols×rows 离屏画布后一次读取」实现。
 */

import type {
  BitmapSnapshot,
  CanvasSurface,
  DomRectLike,
  EraseCommand,
  MeasuredRect,
  MountOpts,
  PlatformAdapter,
  Point,
  TouchEventLike,
} from './types'

const FALLBACK_FRAME_MS = 16
const MAX_DPR = 3

/**
 * 触摸点 → canvas 逻辑坐标（三端共用，对齐 §5.3）。
 * rect 为视口坐标，clientX/clientY 也是视口坐标，页面滚动天然抵消。
 * 结果钳制到 [0, width] / [0, height]。
 */
export function toCanvasPoint(
  e: TouchEventLike,
  rect: DomRectLike,
  cssWidth: number,
  cssHeight: number,
): Point {
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  return {
    x: Math.min(cssWidth, Math.max(0, x)),
    y: Math.min(cssHeight, Math.max(0, y)),
  }
}

function getDpr(): number {
  // #ifdef H5
  const winDpr =
    typeof window !== 'undefined' && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1
  const sysDpr = uni.getSystemInfoSync().pixelRatio || 1
  return Math.max(1, Math.min(MAX_DPR, Math.min(winDpr, sysDpr)))
  // #endif
  // #ifndef H5
  const dpr = uni.getSystemInfoSync().pixelRatio || 1
  return Math.max(1, Math.min(MAX_DPR, dpr))
  // #endif
}

/* ------------------------------------------------------------------ */
/* Canvas 2D 节点式 surface 工厂（H5 / MP 2D / App 新内核共用绘制语义） */
/* ------------------------------------------------------------------ */

type Ctx2D = CanvasRenderingContext2D
type NodeCanvas = HTMLCanvasElement & {
  requestAnimationFrame?: (cb: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
  createImage?: () => CanvasImageSource & { src: string; onload: unknown; onerror: unknown }
}

interface NodeSurfaceInjects {
  /** 创建 cols×rows 离屏画布；返回 null 时采样降级为全幅读取 + JS 区域平均 */
  createDownscaleCanvas(): { canvas: unknown; ctx: Ctx2D } | null
  loadImage(src: string): Promise<CanvasImageSource>
  scheduleFrame(cb: (time: number) => void): number
  cancelFrame(handle: number): void
  /** onHide 导出涂层位图；不支持/失败返回 null，实现内部静默吞错 */
  exportBitmap(canvas: NodeCanvas): Promise<BitmapSnapshot | null>
}

function createNodeSurface(
  canvas: NodeCanvas,
  ctx: Ctx2D,
  opts: MountOpts,
  dpr: number,
  injects: NodeSurfaceInjects,
  autoScale: boolean,
): CanvasSurface {
  const w = opts.cssWidthPx
  const h = opts.cssHeightPx
  const downscale = injects.createDownscaleCanvas()
  // 逻辑坐标 → 物理像素：
  // MP/App 2D 用 ctx.scale(dpr,dpr)；
  // H5 uni 运行时给 CanvasRenderingContext2D 原型打了 hidpi 补丁（坐标自动 ×pixelRatio），
  // 再 scale 会双重放大，故 H5 不 scale。
  if (autoScale) ctx.scale(dpr, dpr)
  // 擦除专用复合模式：实测须在 save() 之前设置（部分内核在 save 后立即改 gco 不生效）。
  ctx.globalCompositeOperation = 'destination-out'

  // 合并在同一 beginPath 内提交（§9.1：减少 JSCore↦原生往返）。
  function tracePath(cmd: EraseCommand): void {
    ctx.lineWidth = cmd.radius * 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (const seg of cmd.segments) {
      if (seg.from.x === seg.to.x && seg.from.y === seg.to.y) {
        // 零长线段在部分实现上不画圆帽，用 moveTo/lineTo 同点 + 端点 arc 双保险。
        ctx.moveTo(seg.from.x + 0.001, seg.from.y)
        ctx.lineTo(seg.to.x, seg.to.y)
        ctx.moveTo(seg.from.x, seg.from.y)
        ctx.arc(seg.from.x, seg.from.y, cmd.radius, 0, Math.PI * 2)
      } else {
        ctx.moveTo(seg.from.x, seg.from.y)
        ctx.lineTo(seg.to.x, seg.to.y)
      }
    }
    ctx.stroke()
  }

  const surface: CanvasSurface = {
    logicalWidth: w,
    logicalHeight: h,

    isAlive(): boolean {
      return Boolean(canvas) && (canvas as NodeCanvas).width > 0 && (canvas as NodeCanvas).height > 0
    },

    async paintCover(color: string, image?: string): Promise<void> {
      // 物理像素坐标系下整幅重涂（H5 hidpi 补丁同样会 ×dpr，故统一传逻辑尺寸）。
      const drawW = w
      const drawH = h
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      if (autoScale) ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = color
      ctx.fillRect(0, 0, drawW, drawH)
      if (image) {
        try {
          const img = await injects.loadImage(image)
          ctx.drawImage(img, 0, 0, drawW, drawH)
        } catch {
          // 贴图失败：已垫不透明纯色，静默降级（R10）。
        }
      }
      if (autoScale) ctx.scale(dpr, dpr)
      // 复位为擦除模式。
      ctx.globalCompositeOperation = 'destination-out'
    },

    erase(cmd: EraseCommand): void {
      // gco 已在初始化时置为 destination-out 并保持（实测 save 后设置在部分内核失效）。
      tracePath(cmd)
    },

    sampleGrid(cols: number, rows: number): Uint8ClampedArray {
      // 源始终用主 canvas 的真实物理像素尺寸（离屏 ctx 无 __hidpi__，走未改写的原生 drawImage）。
      const nodeAny = canvas as unknown as { width: number; height: number }
      const srcW = nodeAny.width || Math.round(w * dpr)
      const srcH = nodeAny.height || Math.round(h * dpr)
      if (downscale) {
        const dCtx = downscale.ctx
        dCtx.clearRect(0, 0, cols, rows)
        // 缩放由原生/GPU 完成，天然带区域平均（§6.1[4]）。
        dCtx.drawImage(canvas as CanvasImageSource, 0, 0, srcW, srcH, 0, 0, cols, rows)
        return dCtx.getImageData(0, 0, cols, rows).data
      }
      // 回退（理论上 MP/H5 不触发）：全幅一次读取 + JS 区域平均 alpha。
      const full = ctx.getImageData(0, 0, srcW, srcH).data
      const out = new Uint8ClampedArray(cols * rows * 4)
      const cellW = srcW / cols
      const cellH = srcH / rows
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x0 = Math.floor(col * cellW)
          const x1 = Math.max(x0 + 1, Math.floor((col + 1) * cellW))
          const y0 = Math.floor(row * cellH)
          const y1 = Math.max(y0 + 1, Math.floor((row + 1) * cellH))
          let sum = 0
          let n = 0
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              sum += full[(y * srcW + x) * 4 + 3]
              n++
            }
          }
          const idx = (row * cols + col) * 4
          out[idx + 3] = n > 0 ? sum / n : 255
        }
      }
      return out
    },

    revealAll(): void {
      if (autoScale) ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (autoScale) ctx.scale(dpr, dpr)
    },

    async exportBitmap(): Promise<BitmapSnapshot | null> {
      try {
        return await injects.exportBitmap(canvas)
      } catch {
        // 静默：调用方按三级兜底降级（recoveryPolicy）。
        return null
      }
    },

    async restoreBitmap(snapshot: BitmapSnapshot): Promise<boolean> {
      const src = snapshot.kind === 'dataURL' ? snapshot.data : snapshot.path
      try {
        const img = await injects.loadImage(src)
        // 与 paintCover 相同的变换口径，保证导出/恢复物理像素 1:1。
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
        if (autoScale) ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        if (autoScale) ctx.scale(dpr, dpr)
        // 复位擦除复合模式。
        ctx.globalCompositeOperation = 'destination-out'
        return true
      } catch {
        // 图片加载/绘制失败：静默，调用方降级为重置为新卡。
        return false
      }
    },

    scheduleFrame(cb: (time: number) => void): number {
      return injects.scheduleFrame(cb)
    },

    cancelFrame(handle: number): void {
      injects.cancelFrame(handle)
    },

    dispose(): void {},
  }
  return surface
}

/* ------------------------------------------------------------------ */
/* SelectorQuery 节点查询（MP / App 共用）                             */
/* ------------------------------------------------------------------ */

interface QueriedNode {
  node: NodeCanvas
  width: number
  height: number
}

function queryCanvasNode(canvasId: string, instance: unknown): Promise<QueriedNode | null> {
  return new Promise((resolve) => {
    const query = uni.createSelectorQuery() as unknown as {
      in(inst: unknown): typeof query
      select(sel: string): {
        fields(f: unknown): { exec(cb: (res: unknown) => void): void }
        boundingClientRect(cb: (rect: unknown) => void): { exec(): void }
      }
    }
    const scoped = instance ? query.in(instance) : query
    scoped
      .select('#' + canvasId)
      .fields({ node: true, size: true, rect: true })
      .exec((resRaw: unknown) => {
        const res = resRaw as Array<Partial<QueriedNode>>
        const r = res && res[0]
        if (r && r.node) {
          resolve({ node: r.node, width: r.width || 0, height: r.height || 0 })
        } else {
          resolve(null)
        }
      })
  })
}

/** MP 2D / App 新内核共用：节点取尺寸 + 物理像素对齐 + 注入平台能力 */
function mountFromNode(
  queried: QueriedNode,
  opts: MountOpts,
  dpr: number,
): CanvasSurface {
  const node = queried.node
  node.width = Math.round(opts.cssWidthPx * dpr)
  node.height = Math.round(opts.cssHeightPx * dpr)
  const ctx = node.getContext('2d') as Ctx2D
  const cols = opts.gridCols || 25
  const rows = opts.gridRows || 14

  return createNodeSurface(node, ctx, opts, dpr, {
    createDownscaleCanvas(): { canvas: unknown; ctx: Ctx2D } | null {
      // MP 2D 离屏画布：uni/wx createOffscreenCanvas type=2d（仅出现在非 H5 分支）。
      try {
        const factory = (
          uni as unknown as {
            createOffscreenCanvas?: (o: {
              type: string
              width: number
              height: number
            }) => { getContext: (t: string) => Ctx2D }
          }
        ).createOffscreenCanvas
        if (typeof factory === 'function') {
          const off = factory.call(uni, { type: '2d', width: cols, height: rows })
          const offCtx = off.getContext('2d')
          if (offCtx) return { canvas: off, ctx: offCtx }
        }
      } catch {
        // 落到 surface 内建的全幅读取 + JS 平均回退。
      }
      return null
    },

    loadImage(src: string): Promise<CanvasImageSource> {
      return new Promise((resolve, reject) => {
        const creator = node.createImage
        if (typeof creator !== 'function') {
          reject(new Error('createImage unavailable'))
          return
        }
        const img = creator.call(node) as unknown as {
          src: string
          onload: (() => void) | null
          onerror: ((e: unknown) => void) | null
        }
        img.onload = () => resolve(img as unknown as CanvasImageSource)
        img.onerror = (e) => reject(e)
        img.src = src
      })
    },

    // R13：优先节点 rAF，不存在则 setTimeout(16) 兜底；禁止 window.rAF 进入小程序。
    scheduleFrame(cb: (time: number) => void): number {
      const raf = node.requestAnimationFrame
      if (typeof raf === 'function') {
        try {
          return raf.call(node, () => cb(Date.now()))
        } catch {
          /* fall through */
        }
      }
      return setTimeout(() => cb(Date.now()), FALLBACK_FRAME_MS) as unknown as number
    },

    cancelFrame(handle: number): void {
      const cancel = node.cancelAnimationFrame
      if (typeof cancel === 'function') {
        try {
          cancel.call(node, handle)
        } catch {
          /* ignore */
        }
      }
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    },

    // 进度保留：2D 节点经 uni.canvasToTempFilePath({ canvas }) 导出物理位图到临时文件。
    exportBitmap(targetNode: NodeCanvas): Promise<BitmapSnapshot | null> {
      return new Promise((resolve) => {
        const api = (
          uni as unknown as {
            canvasToTempFilePath?: (
              o: {
                canvas?: unknown
                success?: (r: { tempFilePath?: string }) => void
                fail?: () => void
              },
              inst?: unknown,
            ) => void
          }
        ).canvasToTempFilePath
        if (typeof api !== 'function') {
          resolve(null)
          return
        }
        try {
          api.call(
            uni,
            {
              canvas: targetNode,
              success: (r) =>
                resolve(r && r.tempFilePath ? { kind: 'tempFilePath', path: r.tempFilePath } : null),
              fail: () => resolve(null),
            },
            opts.instance,
          )
        } catch {
          resolve(null)
        }
      })
    },
  }, true /* autoScale：MP/App 2D 节点 */)
}

/* ------------------------------------------------------------------ */
/* App 旧内核回退 surface（uni.createCanvasContext，R14）              */
/* ------------------------------------------------------------------ */

// #ifdef APP-PLUS
function createLegacySurface(canvasId: string, opts: MountOpts, instance: unknown): CanvasSurface {
  const contextApi = uni as unknown as {
    createCanvasContext: (id: string, inst?: unknown) => CanvasRenderingContext2D
    canvasGetImageData: (o: {
      canvasId: string
      x: number
      y: number
      width: number
      height: number
      success?: (r: { width: number; height: number; data: Uint8ClampedArray }) => void
      fail?: () => void
    }, inst?: unknown) => void
  }
  const ctx = contextApi.createCanvasContext(canvasId, instance)
  const w = Math.round(opts.cssWidthPx)
  const h = Math.round(opts.cssHeightPx)
  const cols = opts.gridCols || 25
  const rows = opts.gridRows || 14
  const solid = new Uint8ClampedArray(cols * rows * 4)
  for (let i = 0; i < cols * rows; i++) solid[i * 4 + 3] = 255
  let cache: Uint8ClampedArray = solid
  let inflight = false

  function averageToGrid(
    data: Uint8ClampedArray,
    srcW: number,
    srcH: number,
  ): Uint8ClampedArray {
    const out = new Uint8ClampedArray(cols * rows * 4)
    const cellW = srcW / cols
    const cellH = srcH / rows
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x0 = Math.floor(col * cellW)
        const x1 = Math.max(x0 + 1, Math.floor((col + 1) * cellW))
        const y0 = Math.floor(row * cellH)
        const y1 = Math.max(y0 + 1, Math.floor((row + 1) * cellH))
        let sum = 0
        let n = 0
        for (let y = y0; y < y1 && y < srcH; y++) {
          for (let x = x0; x < x1 && x < srcW; x++) {
            sum += data[(y * srcW + x) * 4 + 3]
            n++
          }
        }
        out[(row * cols + col) * 4 + 3] = n > 0 ? sum / n : 255
      }
    }
    return out
  }

  function triggerRead(): void {
    if (inflight) return
    inflight = true
    // R14：旧 API draw 是批量异步指令，读像素必须在 draw(true) 回调内发起。
    ;(ctx as unknown as { draw: (reserve: boolean, cb?: () => void) => void }).draw(
      true,
      () => {
        contextApi.canvasGetImageData(
          {
            canvasId,
            x: 0,
            y: 0,
            width: w,
            height: h,
            success: (r) => {
              inflight = false
              cache = averageToGrid(r.data, r.width || w, r.height || h)
            },
            fail: () => {
              inflight = false
            },
          },
          instance,
        )
      },
    )
  }

  return {
    legacy: true,
    logicalWidth: opts.cssWidthPx,
    logicalHeight: opts.cssHeightPx,
    isAlive: () => true,
    async paintCover(color: string): Promise<void> {
      ;(ctx as unknown as { setFillStyle: (c: string) => void }).setFillStyle(color)
      ctx.fillRect(0, 0, w, h)
      await new Promise<void>((resolve) => {
        ;(ctx as unknown as { draw: (reserve: boolean, cb?: () => void) => void }).draw(
          false,
          () => resolve(),
        )
      })
    },
    erase(cmd: EraseCommand): void {
      const c = ctx as unknown as Ctx2D & {
        setLineCap?: (v: string) => void
        setLineJoin?: (v: string) => void
        setLineWidth?: (v: number) => void
      }
      c.globalCompositeOperation = 'destination-out'
      if (c.setLineCap) c.setLineCap('round')
      else ctx.lineCap = 'round'
      if (c.setLineJoin) c.setLineJoin('round')
      else ctx.lineJoin = 'round'
      if (c.setLineWidth) c.setLineWidth(cmd.radius * 2)
      else ctx.lineWidth = cmd.radius * 2
      ctx.beginPath()
      for (const seg of cmd.segments) {
        if (seg.from.x === seg.to.x && seg.from.y === seg.to.y) {
          ctx.moveTo(seg.from.x + 0.001, seg.from.y)
          ctx.lineTo(seg.to.x, seg.to.y)
          ctx.moveTo(seg.from.x, seg.from.y)
          ctx.arc(seg.from.x, seg.from.y, cmd.radius, 0, Math.PI * 2)
        } else {
          ctx.moveTo(seg.from.x, seg.from.y)
          ctx.lineTo(seg.to.x, seg.to.y)
        }
      }
      ctx.stroke()
      triggerRead()
    },
    sampleGrid(): Uint8ClampedArray {
      triggerRead()
      // 旧接口读取是异步回调：返回上一帧缓存（首帧为全不透明），下一帧生效。
      return cache
    },
    revealAll(): void {
      ctx.clearRect(0, 0, w, h)
      ;(ctx as unknown as { draw: (reserve: boolean, cb?: () => void) => void }).draw(false)
    },
    async exportBitmap(): Promise<BitmapSnapshot | null> {
      // 旧内核 createCanvasContext 分支无 2D 节点，位图导出不可用 → 网格圆点重放兜底。
      return null
    },
    async restoreBitmap(): Promise<boolean> {
      return false
    },
    scheduleFrame(cb): number {
      return setTimeout(() => cb(Date.now()), FALLBACK_FRAME_MS) as unknown as number
    },
    cancelFrame(handle): void {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    },
    dispose(): void {
      inflight = false
    },
  }
}
// #endif

/* ------------------------------------------------------------------ */
/* PlatformAdapter 单例：三段条件编译                                  */
/* ------------------------------------------------------------------ */


// #ifdef H5
/** uni-app H5 把 <canvas> 包成 <uni-canvas>，真实 2d 节点是其内部 <canvas>。 */
function resolveH5Canvas(canvasId: string): HTMLCanvasElement | null {
  const host = document.getElementById(canvasId)
  if (!host) return null
  if (host.tagName === 'CANVAS') return host as HTMLCanvasElement
  const inner = host.querySelector('canvas')
  return inner || null
}
// #endif

class ScratchPlatformAdapter implements PlatformAdapter {
  mount(canvasId: string, opts: MountOpts): Promise<CanvasSurface> {
    // #ifdef H5
    return this.mountH5(canvasId, opts)
    // #endif
    // #ifdef MP-WEIXIN
    return this.mountMp(canvasId, opts)
    // #endif
    // #ifdef APP-PLUS
    return this.mountApp(canvasId, opts)
    // #endif
    // #ifndef H5 || MP-WEIXIN || APP-PLUS
    return Promise.reject(new Error('unsupported platform for scratch-card'))
    // #endif
  }

  queryRect(canvasId: string, instance?: unknown): Promise<MeasuredRect> {
    // #ifdef H5
    return this.queryRectH5(canvasId)
    // #endif
    // #ifndef H5
    return new Promise((resolve, reject) => {
      const query = uni.createSelectorQuery() as unknown as {
        in(inst: unknown): typeof query
        select(sel: string): {
          boundingClientRect(cb: (rect: unknown) => void): { exec(): void }
        }
      }
      const scoped = instance ? query.in(instance) : query
      scoped
        .select('#' + canvasId)
        .boundingClientRect((rectRaw: unknown) => {
          const rect = rectRaw as MeasuredRect | null | undefined
          if (rect && rect.width > 0 && rect.height > 0) resolve(rect)
          else reject(new Error('scratch rect not ready'))
        })
        .exec()
    })
    // #endif
  }

  // #ifdef H5
  private queryRectH5(canvasId: string): Promise<MeasuredRect> {
    return new Promise((resolve, reject) => {
      const host = document.getElementById(canvasId)
      if (!host) {
        reject(new Error('scratch canvas element not found'))
        return
      }
      const r = host.getBoundingClientRect()
      resolve({ left: r.left, top: r.top, width: r.width, height: r.height })
    })
  }

  private mountH5(canvasId: string, opts: MountOpts): Promise<CanvasSurface> {
    return new Promise((resolve, reject) => {
      const canvas = resolveH5Canvas(canvasId)
      if (!canvas) {
        reject(new Error('scratch canvas element not found'))
        return
      }
      const dpr = getDpr()
      canvas.width = Math.round(opts.cssWidthPx * dpr)
      canvas.height = Math.round(opts.cssHeightPx * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('2d context unavailable'))
        return
      }
      const cols = opts.gridCols || 25
      const rows = opts.gridRows || 14
      resolve(
        createNodeSurface(canvas, ctx, opts, dpr, {
          createDownscaleCanvas(): { canvas: unknown; ctx: Ctx2D } | null {
            const off = document.createElement('canvas')
            off.width = cols
            off.height = rows
            const offCtx = off.getContext('2d')
            return offCtx ? { canvas: off, ctx: offCtx } : null
          },
          loadImage(src: string): Promise<CanvasImageSource> {
            return new Promise((resolveImg, rejectImg) => {
              const img = new Image()
              img.onload = () => resolveImg(img)
              img.onerror = (e) => rejectImg(e)
              img.src = src
            })
          },
          scheduleFrame(cb: (time: number) => void): number {
            return window.requestAnimationFrame(cb)
          },
          cancelFrame(handle: number): void {
            window.cancelAnimationFrame(handle)
          },
          // 进度保留：H5 直接 toDataURL 导出物理像素位图（PNG 保留 alpha）。
          exportBitmap(targetNode: NodeCanvas): Promise<BitmapSnapshot | null> {
            return new Promise((resolve) => {
              try {
                const url = (
                  targetNode as HTMLCanvasElement
                ).toDataURL('image/png')
                resolve(url ? { kind: 'dataURL', data: url } : null)
              } catch {
                resolve(null)
              }
            })
          },
        }, false /* autoScale：H5 由 uni hidpi 补丁处理，禁止再 scale */),
      )
    })
  }
  // #endif

  // #ifdef MP-WEIXIN
  private mountMp(canvasId: string, opts: MountOpts): Promise<CanvasSurface> {
    return queryCanvasNode(canvasId, opts.instance).then((queried) => {
      if (!queried) throw new Error('canvas 2d node unavailable on weixin')
      return mountFromNode(queried, opts, getDpr())
    })
  }
  // #endif

  // #ifdef APP-PLUS
  private mountApp(canvasId: string, opts: MountOpts): Promise<CanvasSurface> {
    return queryCanvasNode(canvasId, opts.instance).then((queried) => {
      if (queried) {
        // 新 XHTML5+ 内核：type=2d 节点可用，走与 MP 一致的主路径。
        return mountFromNode(queried, opts, getDpr())
      }
      // R14 旧内核探测不到 node：回退 uni.createCanvasContext。
      return createLegacySurface(canvasId, opts, opts.instance)
    })
  }
  // #endif
}

export const platformAdapter: PlatformAdapter = new ScratchPlatformAdapter()
