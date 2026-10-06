<template>
  <view class="page">
    <view class="header">
      <text class="title">刮奖专区</text>
    </view>

    <!-- 加载中 -->
    <view v-if="phase === 'loading'" class="state-box">
      <text class="state-text">奖品加载中…</text>
    </view>

    <!-- 拉取失败：禁止刮卡（约束 2.6） -->
    <view v-else-if="phase === 'failed'" class="state-box">
      <text class="state-text">奖品加载失败，请稍后重试</text>
      <button class="retry-btn" @click="loadPrize">重新加载</button>
    </view>

    <!-- 刮刮卡组件 -->
    <scratch-card
      v-else
      ref="cardRef"
      :prize="prize"
      :threshold="0.5"
      @complete="onComplete"
      @progress="onProgress"
    />

    <!-- H5 自测调试入口（真实接入时移除；通过 ?scenario= 控制） -->
    <!-- #ifdef H5 -->
    <view v-if="debugScenario" class="debug-bar">
      <text class="debug-text">调试场景：{{ debugScenario }}</text>
      <button class="retry-btn" @click="loadPrize">重试拉取</button>
    </view>
    <!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import ScratchCard from '@/components/scratch-card/index.vue'
import type { PrizeInfo } from '@/components/scratch-card/types'

/**
 * 页面职责（对齐 01 §2）：生命周期、拉奖品、传给组件、监听 complete 结算/上报、异常态 UI。
 * 不直接操作 canvas。
 *
 * 奖品/结算接口为后端接入点：当前以本地 mock 实现（零依赖、可在无后端下自验），
 * 真机接入时把 fetchPrize / reportSettlement 替换为 uni.request 即可。
 */

type Phase = 'loading' | 'ready' | 'failed'

const SETTLE_QUEUE_KEY = 'scratch_settle_queue'
const SETTLE_FLAG_PREFIX = 'scratch_settled_'

const phase = ref<Phase>('loading')
const prize = ref<PrizeInfo | null>(null)
const cardRef = ref<InstanceType<typeof ScratchCard> | null>(null)
const completeCount = ref(0)
const debugScenario = ref('')

onMounted(() => {
  // #ifdef H5
  const scenario = readScenarioFromLocation()
  debugScenario.value = scenario
  // #endif
  loadPrize()
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
  cardRef.value?.pause()
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

function fetchPrize(): Promise<PrizeInfo> {
  // #ifdef H5
  const scenario = readScenarioFromLocation()
  if (scenario === 'prizeFail') {
    return new Promise((_, reject) => setTimeout(() => reject(new Error('mock 500')), 300))
  }
  if (scenario === 'prizeSlow') {
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            id: 88,
            title: '优惠券 ¥10',
            subTitle: '满 100 可用',
          }),
        3000,
      ),
    )
  }
  // #endif
  return new Promise((resolve) =>
    setTimeout(() => resolve({ id: 88, title: '优惠券 ¥10', subTitle: '满 100 可用' }), 200),
  )
}

async function loadPrize(): Promise<void> {
  phase.value = 'loading'
  try {
    const data = await fetchPrize()
    // 字段异常兜底：无 title 按「谢谢参与」处理（§8.3）。
    prize.value =
      data && data.title ? data : { id: data?.id ?? 0, title: '谢谢参与' }
    phase.value = 'ready'
  } catch (err) {
    console.error('[scratch page] fetch prize failed', err)
    prize.value = null
    phase.value = 'failed'
  }
}

/* ---------------- 结算上报 + 本地补偿队列（§8.3 / T15） ---------------- */

interface SettleRecord {
  prizeId: string | number
  ts: number
}

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
    const arr = raw ? (JSON.parse(raw as string) as SettleRecord[]) : []
    return Array.isArray(arr) ? arr : []
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
    } catch {
      remain.push(record)
    }
  }
  writeQueue(remain)
}

async function onComplete(p: PrizeInfo): Promise<void> {
  // 页面侧再守一层幂等：同一 prizeId 只结算一次（组件已保证 complete 只 emit 一次）。
  completeCount.value++
  // #ifdef H5
  ;(window as unknown as { __scratchComplete?: number }).__scratchComplete =
    completeCount.value
  // #endif
  const flagKey = SETTLE_FLAG_PREFIX + p.id
  if (uni.getStorageSync(flagKey)) {
    cardRef.value?.markSettled()
    return
  }

  const record: SettleRecord = { prizeId: p.id, ts: Date.now() }
  try {
    await reportSettlement(record)
    uni.setStorageSync(flagKey, 1)
  } catch {
    // 上报失败：写补偿队列，onShow/网络恢复时补报（不回滚视觉，仍进 Settled）。
    const pending = readQueue()
    if (!pending.some((r) => r.prizeId === record.prizeId)) {
      pending.push(record)
      writeQueue(pending)
    }
  }
  cardRef.value?.markSettled()
}

function onProgress(r: number): void {
  // 调试/埋点用（已在算法调度侧限频 ≤10fps）。
  // #ifdef H5
  ;(window as unknown as { __scratchRatio?: number }).__scratchRatio = r
  // #endif
}
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
</style>
