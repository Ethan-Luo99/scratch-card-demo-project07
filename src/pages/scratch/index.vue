<template>
  <view class="page">
    <view class="header">
      <text class="title">刮奖专区</text>
      <text class="subtitle">{{ periodIndexLabel }}</text>
    </view>

    <!-- 加载中 -->
    <view v-if="phase === 'loading'" class="state-box">
      <text class="state-text">奖品加载中…</text>
    </view>

    <!-- 拉取失败：活动暂停并显示重试；重试只重发当前期次 -->
    <view v-else-if="phase === 'failed'" class="state-box">
      <text class="state-text">第 {{ activity.period + 1 }} 张奖品加载失败，活动已暂停</text>
      <button class="retry-btn" @click="retryCurrentPeriod">重试本张（第 {{ activity.period + 1 }} 张）</button>
    </view>

    <!-- 活动结束：3 张全部刮完并结算完成 -->
    <view v-else-if="phase === 'finished'" class="state-box finish-box">
      <text class="state-text">活动已结束，3 张券均已刮完 🎉</text>
      <view class="prize-list">
        <text v-for="(item, idx) in wonPrizes" :key="item.id" class="prize-line">
          第 {{ idx + 1 }} 张：{{ item.title }}
        </text>
      </view>
    </view>

    <!-- 当前期次刮刮卡；:key 含期次，complete 结算后 800ms 挂载下一张走全新 Loading→Idle -->
    <scratch-card
      v-else
      :key="cardKey"
      ref="cardRef"
      :prize="currentPrize"
      :threshold="0.5"
      @complete="onComplete"
      @progress="onProgress"
    />

    <!-- H5 自测调试入口（真实接入时移除；通过 ?scenario= 控制） -->
    <!-- #ifdef H5 -->
    <view v-if="debugScenario" class="debug-bar">
      <text class="debug-text">调试场景：{{ debugScenario }}</text>
      <view class="debug-actions">
        <button class="debug-btn" @click="simulateHideShow">模拟切后台再回来</button>
        <button class="debug-btn" @click="retryCurrentPeriod">重试拉取</button>
      </view>
    </view>
    <!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import ScratchCard from '@/components/scratch-card/index.vue'
import type { PrizeInfo } from '@/components/scratch-card/types'
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
  startPeriod,
  type ScratchActivityState,
  type SettleRecord,
} from './scratchActivity'

/**
 * 页面职责（对齐 01 §2）：生命周期、拉奖品、传给组件、监听 complete 结算/上报、异常态 UI。
 * 不直接操作 canvas。
 *
 * 连刮活动：本地 3 张券池（id 互不相同），每张 complete 结算完成后 800ms
 * 自动挂载下一张；任一张 Failed 活动暂停并只重试当前期次。
 * 幂等键 = prizeId + 期次（period）：补偿队列 / 结算幂等标记 / completeCount 按期次区分。
 *
 * 奖品/结算接口为后端接入点：当前以本地 mock 实现（零依赖、可在无后端下自验），
 * 真机接入时把 fetchPrize / reportSettlement 替换为 uni.request 即可。
 */

const SETTLE_QUEUE_KEY = 'scratch_settle_queue'
const SETTLE_FLAG_PREFIX = 'scratch_settled_'

const activity = ref<ScratchActivityState>(createActivity(readCardTotal()))
const phase = computed(() => activity.value.phase)
const cardRef = ref<InstanceType<typeof ScratchCard> | null>(null)
/** 期次级 completeCount：每刮开一张对应位 +1（数组，按期次区分） */
const completeCount = ref<number[]>(completeCountByPeriod(activity.value))
/** 强制重挂载刮刮卡组件（新期次 = 全新 Loading→Idle 流程） */
const cardKey = ref(0)
const debugScenario = ref('')
let nextCardTimer: ReturnType<typeof setTimeout> | null = null
let advancing = false

const prizePool = createPrizePool()
const currentPrize = computed<PrizeInfo | null>(
  () => activity.value.periods[activity.value.period]?.prize ?? null,
)
const periodIndexLabel = computed(() => {
  const total = activity.value.periods.length
  if (activity.value.phase === 'finished') return total + '/' + total + ' 已完成'
  return `第 ${Math.min(activity.value.period + 1, total)} / ${total} 张`
})
const wonPrizes = computed<PrizeInfo[]>(() =>
  activity.value.periods
    .map((p) => p.prize)
    .filter((p): p is PrizeInfo => Boolean(p)),
)

function readCardTotal(): number {
  // #ifdef H5
  try {
    const params = new URLSearchParams()
    const fromSearch = new URL(window.location.href).searchParams.get('cards')
    const hash = window.location.hash || ''
    const qIndex = hash.indexOf('?')
    if (qIndex >= 0) {
      const hashParams = new URLSearchParams(hash.slice(qIndex + 1))
      if (hashParams.get('cards')) params.set('cards', hashParams.get('cards')!)
    }
    const raw = fromSearch || params.get('cards')
    if (raw) {
      const n = parseInt(raw, 10)
      if (!Number.isNaN(n)) return n
    }
  } catch {
    /* ignore */
  }
  // #endif
  return ACTIVITY_TOTAL_PERIODS
}

onMounted(() => {
  // #ifdef H5
  const scenario = readScenarioFromLocation()
  debugScenario.value = scenario
  // #endif
  void startCurrentPeriod()
  void flushSettleQueue()
  // #ifndef H5
  uni.onNetworkStatusChange((res) => {
    if (res.isConnected) void flushSettleQueue()
  })
  // #endif
  // #ifdef H5
  window.addEventListener('online', () => {
    void flushSettleQueue()
  })
  // #endif
})

onShow(() => {
  void cardRef.value?.resume()
  void flushSettleQueue()
})

onHide(() => {
  void cardRef.value?.pause()
})

/* ---------------- 奖品拉取（mock，接入点） ---------------- */

// #ifdef H5
function readScenarioFromLocation(): string {
  try {
    const fromSearch = new URL(window.location.href).searchParams.get('scenario')
    if (fromSearch) return fromSearch
    // hash 路由：#/pages/scratch/index?scenario=xxx
    const hash = window.location.hash || ''
    const qIndex = hash.indexOf('?')
    if (qIndex >= 0) {
      const params = new URLSearchParams(hash.slice(qIndex + 1))
      return params.get('scenario') || ''
    }
    return ''
  } catch {
    return ''
  }
}
// #endif

function fetchPrize(period: number): Promise<PrizeInfo> {
  // #ifdef H5
  const scenario = readScenarioFromLocation()
  if (scenario === 'prizeFail') {
    return new Promise((_, reject) => setTimeout(() => reject(new Error('mock 500')), 300))
  }
  // 连刮失败暂停场景：第 1 期成功、第 2 期拉取失败（活动暂停并显示重试）。
  if (scenario === 'prizeFailP2' && period === 1) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error('mock 500 p2')), 300))
  }
  if (scenario === 'prizeSlow') {
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(prizeFromPool(period)),
        3000,
      ),
    )
  }
  // #endif
  return new Promise((resolve) =>
    setTimeout(() => resolve(prizeFromPool(period)), 200),
  )
}

function prizeFromPool(period: number): PrizeInfo {
  return prizePool[period] || prizePool[prizePool.length - 1]
}

/** 开始当前期次（首次进入 / 失败重试均走这里；重试只重发当前期次）。 */
async function startCurrentPeriod(): Promise<void> {
  const period = activity.value.period
  activity.value = startPeriod(activity.value, period)
  try {
    const data = await fetchPrize(period)
    // 字段异常兜底：无 title 按「谢谢参与」处理（§8.3）。
    const safe = data && data.title ? data : { id: data?.id ?? 0, title: '谢谢参与' }
    // 异步返回时若已不是当前期次（极端重试竞态），丢弃过期结果。
    if (activity.value.period !== period || activity.value.phase !== 'loading') return
    activity.value = markPeriodFetched(activity.value, period, safe)
    cardKey.value++
  } catch (err) {
    console.error('[scratch page] fetch prize failed', err)
    if (activity.value.period === period) {
      activity.value = markPeriodFailed(activity.value, period)
    }
  }
}

/** 失败态重试：只重发当前期次，不影响已完成期次的结算状态。 */
function retryCurrentPeriod(): void {
  void startCurrentPeriod()
}

// #ifdef H5
/** H5 自测：模拟 onHide（导出位图）→ onShow（检测/恢复），无需真正切后台。 */
async function simulateHideShow(): Promise<void> {
  await cardRef.value?.pause()
  const scenario = readScenarioFromLocation()
  if (['recycle', 'noBitmap', 'exportFail', 'restoreFail'].includes(scenario)) {
    // 模拟画布被系统回收：置调试钩子，resume 检测到该标记后把同一 canvas 的
    // backing store 清空（位图随节点回收销毁），再走 bitmap/replay/reset 三级恢复。
    ;(window as unknown as { __scratchDebugRecycle?: boolean }).__scratchDebugRecycle = true
  }
  await cardRef.value?.resume()
}
// #endif

/* ---------------- 结算上报 + 本地补偿队列（§8.3 / T15） ---------------- */

function reportSettlement(record: SettleRecord): Promise<void> {
  // #ifdef H5
  if (readScenarioFromLocation() === 'settleFail') {
    return Promise.reject(new Error('mock settle 500'))
  }
  // #endif
  // 接入点：真机替换为 uni.request({ url: 结算接口, method: 'POST', data: record })
  console.log('[scratch page] report settlement', record)
  return Promise.resolve()
}

function readQueue(): SettleRecord[] {
  try {
    const raw = uni.getStorageSync(SETTLE_QUEUE_KEY)
    const parsed = raw ? (JSON.parse(raw as string) as unknown[]) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((r) => normalizeSettleRecord(r as Partial<SettleRecord>))
      .filter((r): r is SettleRecord => r !== null)
  } catch {
    return []
  }
}

function writeQueue(records: SettleRecord[]): void {
  uni.setStorageSync(SETTLE_QUEUE_KEY, JSON.stringify(records))
}

async function flushSettleQueue(): Promise<void> {
  const pending = readQueue()
  if (pending.length === 0) return
  const remain: SettleRecord[] = []
  for (const record of pending) {
    try {
      await reportSettlement(record)
      // 补报成功：补写该期幂等标记（prizeId+期次）。
      uni.setStorageSync(SETTLE_FLAG_PREFIX + periodKey(record.prizeId, record.period), 1)
    } catch {
      remain.push(record)
    }
  }
  writeQueue(dedupeQueue(remain))
}

async function onComplete(p: PrizeInfo): Promise<void> {
  const period = activity.value.period
  // 页面侧再守一层幂等：同一期次重复 complete 不重复结算（组件已保证 complete 只 emit 一次）。
  if (activity.value.periods[period]?.revealed) {
    cardRef.value?.markSettled()
    return
  }
  activity.value = markPeriodRevealed(activity.value, period)
  completeCount.value = completeCountByPeriod(activity.value)
  // #ifdef H5
  ;(window as unknown as { __scratchComplete?: number }).__scratchComplete =
    completeCount.value.reduce((a, b) => a + b, 0)
  ;(window as unknown as { __scratchCompleteByPeriod?: number[] }).__scratchCompleteByPeriod =
    completeCount.value.slice()
  // #endif
  const flagKey = SETTLE_FLAG_PREFIX + periodKey(p.id, period)
  if (uni.getStorageSync(flagKey)) {
    cardRef.value?.markSettled()
    finishPeriodAndMaybeAdvance(period)
    return
  }

  const record: SettleRecord = { prizeId: p.id, period, ts: Date.now() }
  try {
    await reportSettlement(record)
    uni.setStorageSync(flagKey, 1)
  } catch {
    // 上报失败：写期次级补偿队列，onShow/网络恢复时补报（不回滚视觉，仍进 Settled）。
    const pending = readQueue()
    if (!pending.some((r) => periodKey(r.prizeId, r.period) === periodKey(record.prizeId, period))) {
      pending.push(record)
      writeQueue(dedupeQueue(pending))
    }
  }
  cardRef.value?.markSettled()
  finishPeriodAndMaybeAdvance(period)
}

/** 本期结算完成：落 Settled；若还有后续期次，800ms 后自动挂载下一张新卡。 */
function finishPeriodAndMaybeAdvance(period: number): void {
  if (activity.value.period !== period) return
  activity.value = markPeriodSettled(activity.value, period)
  if (activity.value.phase === 'finished') return
  // 前一张未结算完成时 canAdvance=false，禁止发下一张。
  if (!canAdvance(activity.value) || advancing) return
  advancing = true
  nextCardTimer = setTimeout(() => {
    advancing = false
    nextCardTimer = null
    if (!canAdvance(activity.value)) return
    activity.value = advancePeriod(activity.value)
    void startCurrentPeriod()
  }, NEXT_CARD_DELAY_MS)
}

function onProgress(r: number): void {
  // 调试/埋点用（已在算法调度侧限频 ≤10fps）。
  // #ifdef H5
  ;(window as unknown as { __scratchRatio?: number }).__scratchRatio = r
  // #endif
}

onUnmounted(() => {
  if (nextCardTimer) {
    clearTimeout(nextCardTimer)
    nextCardTimer = null
  }
})
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 40rpx 32rpx;
  box-sizing: border-box;
  background: #f6f7fb;
}

.header {
  margin-bottom: 48rpx;
  text-align: center;
}

.title {
  font-size: 40rpx;
  font-weight: 600;
  color: #1f2329;
}

.subtitle {
  margin-top: 8rpx;
  font-size: 26rpx;
  color: #6b7280;
}

.state-box {
  width: 750rpx;
  max-width: 100%;
  height: 400rpx;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  border-radius: 16rpx;
}

.state-text {
  font-size: 30rpx;
  color: #6b7280;
  margin-bottom: 24rpx;
}

.finish-box {
  justify-content: flex-start;
  padding-top: 72rpx;
  box-sizing: border-box;
}

.prize-list {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.prize-line {
  font-size: 28rpx;
  color: #8a5a12;
  line-height: 1.9;
}

.retry-btn {
  min-width: 220rpx;
  font-size: 28rpx;
  color: #ffffff;
  background: #ff8a00;
  border-radius: 999rpx;
}

.debug-bar {
  margin-top: 32rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.debug-text {
  font-size: 24rpx;
  color: #9aa0a6;
  margin-bottom: 12rpx;
}

.debug-actions {
  display: flex;
  flex-direction: row;
  gap: 16rpx;
}

.debug-btn {
  min-width: 220rpx;
  font-size: 24rpx;
  color: #ffffff;
  background: #ff8a00;
  border-radius: 999rpx;
}
</style>
