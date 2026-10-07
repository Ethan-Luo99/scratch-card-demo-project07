/**
 * 刮刮卡全部接口与类型定义（对齐 01-技术方案 §4）。
 * 纯类型文件，不含任何运行时实现。
 */

export interface PrizeInfo {
  id: string | number
  title: string
  subTitle?: string
  icon?: string
}

export interface ScratchCardProps {
  /** 奖品数据；null 时显示 loading 涂层，禁止刮动 */
  prize: PrizeInfo | null
  widthRpx?: number
  heightRpx?: number
  /** 擦除笔刷半径，默认 28rpx */
  brushRadiusRpx?: number
  /** 自动揭晓阈值 0~1，默认 0.5 */
  threshold?: number
  /** 涂层纯色，默认 #B5B5B5 */
  coverColor?: string
  /** 可选涂层贴图（临时路径/网络路径，需先 uni.getImageInfo） */
  coverImage?: string
  /** 采样网格列数，默认 25 */
  gridCols?: number
  /** 采样网格行数，默认 14 */
  gridRows?: number
  /** 网络失败/已结算后置灰 */
  disabled?: boolean
}

export type ScratchStatus =
  | 'loading'
  | 'idle'
  | 'scratching'
  | 'revealing'
  | 'revealed'
  | 'settled'
  | 'failed'

/** canvas 逻辑像素坐标（CSS px） */
export interface Point {
  x: number
  y: number
}

/** 插值后相邻两点，间距 ≤ 步长 */
export interface StrokeSegment {
  from: Point
  to: Point
}

/** 一帧内要擦的线 */
export interface EraseCommand {
  segments: StrokeSegment[]
  radius: number
}

/** 采样区域（逻辑 px） */
export interface SampleRect {
  x: number
  y: number
  w: number
  h: number
}

/** 网格快照：cells 取值 0=有涂层 1=已擦净 2=可疑 */
export interface GridSnapshot {
  cols: number
  rows: number
  cells: Uint8Array
  cleanCount: number
  fuzzyCount: number
  /** 严格净格占比（用于揭晓附加守卫） */
  cleanRatio: number
  ratio: number
}

export interface ScratchEngineLike {
  beginStroke(p: Point): void
  /** 起笔圆点（单击/长按也有擦除区） */
  dotAt(p: Point): EraseCommand
  feedPoint(p: Point): EraseCommand | null
  endStroke(): void
  applySamples(samples: Uint8ClampedArray, rect: SampleRect): GridSnapshot
  buildReplayCommand(): EraseCommand | null
  reset(): void
  readonly ratio: number
  readonly cleanRatio: number
  readonly cells: Uint8Array
  readonly cols: number
  readonly rows: number
}

/** 由组件从 touches/changedTouches 归一 */
export interface TouchEventLike {
  clientX: number
  clientY: number
  identifier?: number
}

export interface DomRectLike {
  left: number
  top: number
}

export interface MountOpts {
  cssWidthPx: number
  cssHeightPx: number
  brushRadiusPx: number
  /** 离屏采样画布尺寸（25×14） */
  gridCols?: number
  gridRows?: number
  /** SelectorQuery / createCanvasContext 需要的逻辑层实例 */
  instance?: unknown
}

/** onHide 导出的涂层位图快照（仅内存、当前生命周期有效，不做持久化） */
export type BitmapSnapshot =
  | { kind: 'dataURL'; data: string }
  | { kind: 'tempFilePath'; path: string }

/** 涂层表面，屏蔽三端 canvas 差异 */
export interface CanvasSurface {
  readonly logicalWidth: number
  readonly logicalHeight: number
  /** 节点是否仍有效且尺寸非 0（onShow 回收检测） */
  isAlive(): boolean
  paintCover(color: string, image?: string): Promise<void>
  /** destination-out 画线，同一路径一次提交 */
  erase(cmd: EraseCommand): void
  /** 经离屏小画布缩放后读 alpha，长度 cols*rows*4 */
  sampleGrid(cols: number, rows: number): Uint8ClampedArray
  /** 整幅清空（fade 由组件用 CSS opacity 驱动；旧内核可直接隐藏节点） */
  revealAll(): void
  /**
   * onHide：导出当前涂层位图到内存。
   * H5 走 canvas.toDataURL；MP-WEIXIN / APP-PLUS 2D 节点走
   * uni.canvasToTempFilePath({ canvas: node })。
   * 平台不支持或导出失败时返回 null（调用方静默降级），不得抛错。
   */
  exportBitmap(): Promise<BitmapSnapshot | null>
  /**
   * onShow：节点被回收重建后，用 drawImage 把位图整体画回新节点。
   * 恢复失败（图片加载失败等）返回 false，调用方按「重置为新卡」静默降级。
   */
  restoreBitmap(snapshot: BitmapSnapshot): Promise<boolean>
  /** App 旧内核 createCanvasContext 回退分支标记（揭晓时需隐藏原生节点） */
  readonly legacy?: boolean
  /** rAF：MP 2D 用 node.requestAnimationFrame，H5 用全局 rAF，回退 setTimeout(16) */
  scheduleFrame(cb: (time: number) => void): number
  cancelFrame(handle: number): void
  dispose(): void
}

export interface QueryRectOpts {
  instance?: unknown
}

export interface MeasuredRect extends DomRectLike {
  width: number
  height: number
}

export interface PlatformAdapter {
  mount(canvasId: string, opts: MountOpts): Promise<CanvasSurface>
  /** SelectorQuery / getBoundingClientRect 实测视口 rect 与布局尺寸 */
  queryRect(canvasId: string, instance?: unknown): Promise<MeasuredRect>
}
