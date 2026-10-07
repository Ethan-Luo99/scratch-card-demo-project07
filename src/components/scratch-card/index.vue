<template>
  <view
    class="scratch-card"
    :style="cardStyle"
    :class="{ 'is-disabled': mergedDisabled }"
  >
    <!-- 下层：奖品结果（canvas 同层渲染后透过透明像素可见，§7.2） -->
    <view class="prize-layer">
      <image v-if="prize && prize.icon" class="prize-icon" :src="prize.icon" />
      <text v-if="prize" class="prize-title">{{ prize.title }}</text>
      <text v-if="prize && prize.subTitle" class="prize-subtitle">{{ prize.subTitle }}</text>
    </view>

    <!-- 上层：涂层 canvas（position:absolute 与奖品层同尺寸对齐） -->
    <canvas
      v-if="!canvasHidden"
      :id="canvasId"
      canvas-id="legacyScratchCanvas"
      type="2d"
      class="cover-canvas"
      :class="{ 'cover-canvas--fade': fadeOut }"
      :style="canvasStyle"
      @touchstart="onTouchStart"
      @touchmove.stop.prevent="onTouchMove"
      @touchend="onTouchEnd"
      @touchcancel="onTouchEnd"
      @mousedown="onMouseDown"
    />
  </view>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, onMounted, ref, watch } from 'vue'
import { useScratchCard } from './useScratchCard'
import type { PrizeInfo } from './types'

const props = withDefaults(
  defineProps<{
    prize: PrizeInfo | null
    widthRpx?: number
    heightRpx?: number
    brushRadiusRpx?: number
    threshold?: number
    coverColor?: string
    coverImage?: string
    gridCols?: number
    gridRows?: number
    disabled?: boolean
  }>(),
  {
    widthRpx: 750,
    heightRpx: 400,
    brushRadiusRpx: 28,
    threshold: 0.5,
    coverColor: '#B5B5B5',
    coverImage: undefined,
    gridCols: 25,
    gridRows: 14,
    disabled: false,
  },
)

const emit = defineEmits<{
  (e: 'progress', ratio: number): void
  (e: 'complete', prize: PrizeInfo): void
  (e: 'scratch-start'): void
}>()

const canvasId = 'scratchCanvas'
const instance = getCurrentInstance()
const mouseDown = ref(false)

const cardStyle = computed(() => ({
  width: props.widthRpx + 'rpx',
  height: props.heightRpx + 'rpx',
}))

const canvasStyle = computed(() => ({
  width: props.widthRpx + 'rpx',
  height: props.heightRpx + 'rpx',
}))

const mergedDisabled = computed(
  () => props.disabled || !props.prize,
)

const prizeRef = computed(() => props.prize)
const widthRef = computed(() => props.widthRpx)
const heightRef = computed(() => props.heightRpx)
const brushRef = computed(() => props.brushRadiusRpx)
const thresholdRef = computed(() => props.threshold)
const colorRef = computed(() => props.coverColor)
const imageRef = computed(() => props.coverImage)
const colsRef = computed(() => props.gridCols)
const rowsRef = computed(() => props.gridRows)
const disabledRef = computed(() => props.disabled)

const card = useScratchCard({
  canvasId,
  widthRpx: widthRef,
  heightRpx: heightRef,
  brushRadiusRpx: brushRef,
  threshold: thresholdRef,
  coverColor: colorRef,
  coverImage: imageRef,
  gridCols: colsRef,
  gridRows: rowsRef,
  disabled: disabledRef,
  prize: prizeRef,
  getInstance: () => instance?.proxy,
  // H5 自测：?scenario=exportFail / restoreFail 验证静默降级（真实接入时移除）。
  debugExportFail: () => {
    // #ifdef H5
    return readDebugScenario() === 'exportFail'
    // #endif
    // #ifndef H5
    return false
    // #endif
  },
  debugNoBitmap: () => {
    // #ifdef H5
    return readDebugScenario() === 'noBitmap'
    // #endif
    // #ifndef H5
    return false
    // #endif
  },
  debugRestoreFail: () => {
    // #ifdef H5
    return readDebugScenario() === 'restoreFail'
    // #endif
    // #ifndef H5
    return false
    // #endif
  },
  onProgress: (r) => emit('progress', r),
  onScratchStart: () => emit('scratch-start'),
  onComplete: (p) => emit('complete', p),
})

// #ifdef H5
function readDebugScenario(): string {
  try {
    const fromSearch = new URL(window.location.href).searchParams.get('scenario')
    if (fromSearch) return fromSearch
    const hash = window.location.hash || ''
    const qIndex = hash.indexOf('?')
    if (qIndex >= 0) {
      return new URLSearchParams(hash.slice(qIndex + 1)).get('scenario') || ''
    }
  } catch {
    /* ignore */
  }
  return ''
}
// #endif

onMounted(() => {
  void card.init()

  // H5 桌面鼠标：move/up 绑到 window，保证拖出 canvas 也能收束（mouseleave≈touchend）。
  // #ifdef H5
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  // #endif
})

watch(
  () => props.prize,
  () => card.notifyPrizeReady(),
)

function onTouchStart(e: Event): void {
  card.normalizeAndHandle('start', e as never)
}

function onTouchMove(e: Event): void {
  card.normalizeAndHandle('move', e as never)
}

function onTouchEnd(e: Event): void {
  card.normalizeAndHandle('end', e as never)
}

/* H5 鼠标（平台打包时条件编译裁剪；vue-tsc 下以 typeof window 守卫，不重复定义） */
// #ifdef H5
function onMouseDown(e: MouseEvent): void {
  mouseDown.value = true
  card.onMouseDown({ clientX: e.clientX, clientY: e.clientY })
}
function onMouseMove(e: MouseEvent): void {
  if (!mouseDown.value) return
  card.onMouseMove({ clientX: e.clientX, clientY: e.clientY })
}
function onMouseUp(): void {
  if (!mouseDown.value) return
  mouseDown.value = false
  card.onMouseUp()
}
// #endif

// 模板需要直接读取的响应式状态
const canvasHidden = card.canvasHidden
const fadeOut = card.fadeOut

defineExpose({
  pause: card.pause,
  resume: card.resume,
  retry: card.retry,
  markSettled: card.markSettled,
  setFailed: card.setFailed,
  status: card.status,
  ratio: card.ratio,
})
</script>

<style scoped>
.scratch-card {
  position: relative;
  margin: 0 auto;
  border-radius: 16rpx;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  background: #ffffff;
}

.scratch-card.is-disabled {
  opacity: 0.85;
}

.prize-layer {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #fff7e6 0%, #ffe7b3 100%);
}

.prize-icon {
  width: 120rpx;
  height: 120rpx;
  margin-bottom: 12rpx;
}

.prize-title {
  font-size: 40rpx;
  font-weight: 600;
  color: #8a5a12;
  line-height: 1.3;
}

.prize-subtitle {
  margin-top: 8rpx;
  font-size: 26rpx;
  color: #b08333;
}

.cover-canvas {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2;
  opacity: 1;
  transition: opacity 260ms ease-out;
}

.cover-canvas--fade {
  opacity: 0;
}
</style>
