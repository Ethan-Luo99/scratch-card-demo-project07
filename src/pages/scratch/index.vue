<template>
  <view class="page">
    <view class="header">
      <text class="title">连刮 3 次 · 刮奖专区</text>
      <text v-if="!isFinished" class="subtitle">
        第 {{ streak.period }} / {{ streakTotal }} 张
      </text>
    </view>

    <!-- 加载中 -->
    <view v-if="streak.stage === 'loading'" class="state-box">
      <text class="state-text">第 {{ streak.period }} 张奖品加载中…</text>
    </view>

    <!-- 当前期拉取失败：活动暂停，只重试当前期次 -->
    <view v-else-if="streak.stage === 'failed'" class="state-box">
      <text class="state-text">第 {{ streak.period }} 张奖品加载失败，请重试</text>
      <button class="retry-btn" @click="retryCurrentPeriod">重试第 {{ streak.period }} 张</button>
    </view>

    <!-- 活动结束 -->
    <view v-else-if="isFinished" class="state-box">
      <text class="state-text">活动已结束，感谢参与！</text>
    </view>

    <!-- 刮刮卡组件：期次切换走 v-if + :key 全量重挂载（Loading→Idle 全流程） -->
    <scratch-card
      v-else
      :key="streak.period"
      ref="cardRef"
      :prize="prize"
      :threshold="0.5"
      @complete="onComplete"
      @progress="onProgress"
    />

    <!-- H5 自测调试入口（真实接入时移除；通过 ?scenario= 控制） -->
    <!-- #ifdef H5 -->
    <view v-if="debugScenario" class="debug-bar">
      <text class="debug-text">
        调试场景：{{ debugScenario }} ｜ complete 总计 {{ totalComplete }}
      </text>
      <view class="debug-row">
        <button class="retry-btn debug-btn" @click="retryCurrentPeriod">重试拉取</button>
        <button class="retry-btn debug-btn" @click="debugRecycle">模拟画布回收</button>
        <button class="retry-btn debug-btn" @click="debugExportFail">
          {{ debugExportFailOn ? '恢复位图导出' : '模拟导出失败' }}
        </button>
      </view>
    </view>
    <!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { onHide, onShow } from '@dcloudio/uni-app'
import ScratchCard from '@/components/scratch-card/index.vue'
import type { PrizeInfo } from '@/components/scratch-card/types'
import {
  STREAK_TOTAL,
  NEXT_CARD_DELAY_MS,
  buildLocalPrizePool,
  createStreakState,
  transitionStreak,
  canMountNext,
  advanceToNextPeriod,
  finishStreak,
  settleFlagKey,
  settleKey,
  enqueueSettleRecord,
  PeriodCompleteGuard,
  bumpCompleteCount,
  type SettleRecord,
  type StreakState,
} from './scratchStreak'
import {
  ACTIVITY_STATE_KEY,
  SETTLE_QUEUE_KEY,
  FallbackStorage,
  createActivityState,
  parseActivityState,
  serializeActivityState,
  markPeriodRevealed,
  markPeriodSettled,
  setActivityPeriod,
  deriveStreakState,
  revealedPeriods,
  prizePeriodMapper,
  migrateLegacyStorage,
  hasSettleFlag,
  legacySettleFlagKey,
  SettleCoordinator,
  EpochGuard,
  type ActivityStateV1,
  type ActivityStorageLike,
} from './scratchActivity'

/**
 * 页面职责（对齐 01 §2）：生命周期、拉奖品、传给组件、监听 complete 结算/上报、异常态 UI。
 * 不直接操作 canvas。
 *
 * 本轮升级：
 * - 连刮 3 次：本地券池 3 张（id 互不相同），每期结算完成 800ms 后自动挂下一张；
 * - 幂等键 prizeId+期次：补偿队列、结算幂等标记、completeCount 全部按期次区分；
 * - 任一期 Failed：活动暂停，重试只重发当前期次，不影响已完成期次结算状态。
 *
 * 断点续刮升级：
 * - 活动状态（当前期次、每期 revealed/settled）持久化，刷新/杀进程重进恢复到正确期次；
 * - 旧数据迁移（旧幂等标记/旧队列记录）幂等可重入，中断重跑不重复、不丢失、不算错期次；
 * - storage 写失败静默降级纯内存模式，活动可完整刮完，重进按无历史处理；
 * - 跨会话恢复一律发新卡新涂层（位图/网格恢复仅限同会话 onShow，组件快照不持久化）；
 * - 结算竞态：SettleCoordinator 保证同一 (prizeId, 期次) 恰好生效一次，
 *   EpochGuard 丢弃过期拉取响应。
 *
 * 奖品/结算接口为后端接入点：当前以本地 mock 实现（零依赖、可在无后端下自验），
 * 真机接入时把 fetchPrize / reportSettlement 替换为 uni.request 即可。
 */

const streakTotal = STREAK_TOTAL
const prizePool = buildLocalPrizePool()
const completeGuard = new PeriodCompleteGuard()
const settleCoordinator = new SettleCoordinator()
const fetchEpoch = new EpochGuard()

/**
 * uni 存储适配器（读/写异常由 FallbackStorage 静默兜底，降级纯内存模式）。
 * H5 自测：?scenario=storageFail 时 set 抛错，验证降级路径。
 */
const uniStorage: ActivityStorageLike = {
  get(key: string): string | null {
    const v = uni.getStorageSync(key)
    return v === '' || v === null || v === undefined ? null : String(v)
  },
  set(key: string, value: string): void {
    // #ifdef H5
    if (readScenarioFromLocation() === 'storageFail') {
      throw new Error('mock QuotaExceededError')
    }
    // #endif
    uni.setStorageSync(key, value)
  },
  keys(): string[] {
    return (uni.getStorageInfoSync().keys || []) as string[]
  },
}
const storage = new FallbackStorage(uniStorage)

const streak = ref<StreakState>(createStreakState())
const activityState = ref<ActivityStateV1>(createActivityState())
const prize = ref<PrizeInfo | null>(null)
const cardRef = ref<InstanceType<typeof ScratchCard> | null>(null)
const completeCounts = ref<Record<number, number>>({})
const totalComplete = ref(0)
const settleInFlight = ref(false)
let nextCardTimer: ReturnType<typeof setTimeout> | null = null
const debugScenario = ref('')
const debugExportFailOn = ref(false)

const isFinished = computed(() => streak.value.stage === 'finished')

onMounted(() => {
  // #ifdef H5
  const scenario = readScenarioFromLocation()
  debugScenario.value = scenario
  // #endif
  restoreActivity()
  if (streak.value.stage !== 'finished') void mountCurrentPeriod()
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

/* ---------------- 期次流转（活动状态机） ---------------- */

function persistActivityState(): void {
  // 写失败由 FallbackStorage 静默降级，绝不阻断活动流程。
  storage.set(ACTIVITY_STATE_KEY, serializeActivityState(activityState.value))
}

/**
 * 断点恢复：旧数据迁移（幂等可重入）→ 读快照 → 推导期次。
 * 已完成期次预置 completeGuard / SettleCoordinator：不重刮、不重结算、不重复入队。
 * 跨会话恢复只恢复「期次状态」，涂层一律新发（位图/网格恢复仅限同会话 onShow）。
 */
function restoreActivity(): void {
  try {
    migrateLegacyStorage(storage, prizePeriodMapper(prizePool))
  } catch (err) {
    // FallbackStorage 已吞写错误；此处仅防御未知异常，按无历史继续。
    console.error('[scratch page] migration failed, continue without history', err)
  }
  const restored = parseActivityState(storage.get(ACTIVITY_STATE_KEY))
  if (!restored) return
  activityState.value = restored
  for (const period of revealedPeriods(restored)) {
    completeGuard.mark(period)
    const p = restored.periods[String(period)]
    if (p && p.prizeId !== null && p.settled) {
      settleCoordinator.markDone(settleKey(p.prizeId, period))
    }
  }
  streak.value = deriveStreakState(restored)
}

function setStage(stage: StreakState['stage']): void {
  const next = transitionStreak(streak.value, stage)
  if (next) streak.value = next
}

/** 挂载/重试当前期：走完整 Loading→Idle（Failed 重试同样只重发当前期次）。 */
async function mountCurrentPeriod(): Promise<void> {
  if (nextCardTimer) {
    clearTimeout(nextCardTimer)
    nextCardTimer = null
  }
  setStage('loading')
  prize.value = null
  activityState.value = setActivityPeriod(activityState.value, streak.value.period)
  persistActivityState()
  // 纪元令牌：慢响应/旧重试返回时若已发起新一轮，一律丢弃，不污染当前期。
  const epoch = fetchEpoch.next()
  try {
    const data = await fetchPrize(streak.value.period)
    if (!fetchEpoch.isCurrent(epoch)) return
    // 字段异常兜底：无 title 按「谢谢参与」处理（§8.3）。
    prize.value =
      data && data.title ? data : { id: data?.id ?? 0, title: '谢谢参与' }
    setStage('ready')
  } catch (err) {
    if (!fetchEpoch.isCurrent(epoch)) return
    console.error('[scratch page] fetch prize failed', err)
    prize.value = null
    // 任一期 Failed：活动暂停（不清空已完成期次的结算/补偿状态）。
    setStage('failed')
  }
}

/** 重试只重发当前期次。 */
function retryCurrentPeriod(): void {
  void mountCurrentPeriod()
}

/** complete 结算完成后 800ms 自动挂下一张；最后一张则进结束态。 */
function scheduleNextAfterSettle(): void {
  if (nextCardTimer) clearTimeout(nextCardTimer)
  nextCardTimer = setTimeout(() => {
    nextCardTimer = null
    // 硬守卫：前一张未结算完成（in-flight）或已离开 Revealed，禁止发下一张。
    if (settleInFlight.value || streak.value.stage !== 'revealed') return
    if (canMountNext(streak.value)) {
      streak.value = advanceToNextPeriod(streak.value)
      void mountCurrentPeriod()
    } else {
      streak.value = finishStreak(streak.value)
    }
  }, NEXT_CARD_DELAY_MS)
}

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
  if (scenario === 'prizeFail' && period === 1) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error('mock 500')), 300))
  }
  // prizeFail2：第 2 期拉取失败（验证「已完成期次不受影响、只重试当前期」）。
  if (scenario === 'prizeFail2' && period === 2) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error('mock 500 p2')), 300))
  }
  if (scenario === 'prizeSlow') {
    return new Promise((resolve) =>
      setTimeout(() => resolve({ ...prizePool[period - 1] }), 3000),
    )
  }
  // #endif
  const index = Math.min(Math.max(period, 1), prizePool.length) - 1
  return new Promise((resolve) =>
    setTimeout(() => resolve({ ...prizePool[index] }), 200),
  )
}

/* ---------------- 结算上报 + 本地补偿队列（期次级幂等） ---------------- */

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
    const raw = storage.get(SETTLE_QUEUE_KEY)
    const arr = raw ? (JSON.parse(raw) as SettleRecord[]) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function writeQueue(records: SettleRecord[]): void {
  // 写失败静默降级（FallbackStorage 内存镜像仍保留本会话记录）。
  storage.set(SETTLE_QUEUE_KEY, JSON.stringify(records))
}

/**
 * 补报队列：幂等键为 prizeId+期次；补报成功再写该期幂等标记，
 * 保证「同一条记录无论走直报还是补偿，服务端/本地恰好生效一次」。
 * 与直报并发时由 SettleCoordinator 互斥；已生效记录直接出队不重复上报。
 * 旧版无期次记录（period=0）原样补报，成功后写回旧式标记，不丢失、不错判期次。
 */
async function flushSettleQueue(): Promise<void> {
  const pending = readQueue()
  if (pending.length === 0) return
  const remain: SettleRecord[] = []
  for (const record of pending) {
    const knownPeriod = record.period >= 1
    const key = knownPeriod ? settleKey(record.prizeId, record.period) : null
    if (
      key &&
      (settleCoordinator.isDone(key) ||
        hasSettleFlag(storage, record.prizeId, record.period))
    ) {
      // 已生效（直报成功/标记已写）：直接出队，不重复上报。
      continue
    }
    if (key && !settleCoordinator.tryBegin(key)) {
      // 直报正在 in-flight：本轮跳过，留队列下轮再补。
      remain.push(record)
      continue
    }
    try {
      await reportSettlement(record)
      if (key) {
        storage.set(settleFlagKey(record.prizeId, record.period), '1')
        settleCoordinator.succeed(key)
      } else {
        // 旧版无期次记录：补报成功写回旧式标记，保持旧语义。
        storage.set(legacySettleFlagKey(record.prizeId), '1')
      }
    } catch {
      if (key) settleCoordinator.fail(key)
      remain.push(record)
    }
  }
  writeQueue(remain)
}

async function onComplete(p: PrizeInfo): Promise<void> {
  const period = streak.value.period
  // 期次级幂等：同一期 complete 只结算一次（组件已保证单卡 complete 仅 emit 一次）。
  if (!completeGuard.mark(period)) return
  // 状态机：ready → revealed；非法阶段（如已推进）直接忽略。
  if (streak.value.stage !== 'ready') return
  streak.value = { period, stage: 'revealed' }
  // 断点续刮：揭晓即持久化，刷新/杀进程重进后本期不重刮、不重结算。
  activityState.value = markPeriodRevealed(activityState.value, period, p.id)
  persistActivityState()

  bumpCompleteCount(completeCounts.value, period)
  totalComplete.value++
  // #ifdef H5
  // CDP 自验沿用全局钩子：单卡周期内计数恰为 1。
  ;(window as unknown as { __scratchComplete?: number }).__scratchComplete = 1
  ;(window as unknown as { __scratchStreak?: Record<string, unknown> }).__scratchStreak = {
    period,
    total: totalComplete.value,
    key: settleKey(p.id, period),
  }
  // #endif

  // 前一张 Revealed 未结算完成前禁止发下一张：settleInFlight + 阶段守卫双保险。
  settleInFlight.value = true
  const key = settleKey(p.id, period)
  // 已生效（持久化标记 / 会话内已完成）：直接收尾，不重复上报、不重复入队。
  if (hasSettleFlag(storage, p.id, period) || settleCoordinator.isDone(key)) {
    finishSettleLocally(period)
    return
  }

  const record: SettleRecord = { prizeId: p.id, period, ts: Date.now() }
  // 与补偿队列补报互斥：同一 (prizeId, 期次) 恰好生效一次。
  if (!settleCoordinator.tryBegin(key)) {
    writeQueue(enqueueSettleRecord(readQueue(), record))
    finishSettleLocally(period)
    return
  }
  try {
    await reportSettlement(record)
    storage.set(settleFlagKey(p.id, period), '1')
    settleCoordinator.succeed(key)
  } catch {
    settleCoordinator.fail(key)
    // 上报失败：写期次级补偿队列，onShow/网络恢复时按期补报（不回滚视觉，仍进 Settled）。
    writeQueue(enqueueSettleRecord(readQueue(), record))
  }
  finishSettleLocally(period)
}

/** 结算本地收尾：持久化 settled → 解锁 → Settled → 排期下一张。 */
function finishSettleLocally(period: number): void {
  activityState.value = markPeriodSettled(activityState.value, period)
  persistActivityState()
  settleInFlight.value = false
  cardRef.value?.markSettled()
  scheduleNextAfterSettle()
}

function onProgress(r: number): void {
  // 调试/埋点用（已在算法调度侧限频 ≤10fps）。
  // #ifdef H5
  ;(window as unknown as { __scratchRatio?: number }).__scratchRatio = r
  // #endif
}

/* ---------------- H5 自验钩子 ---------------- */
// #ifdef H5
async function debugRecycle(): Promise<void> {
  // 触发组件「onHide 导出位图 + 节点回收」，随后立即 resume 验证位图恢复。
  const card = cardRef.value as unknown as {
    debugSimulateRecycled?: () => Promise<void>
    resume?: () => Promise<void>
  } | null
  if (!card) return
  await card.debugSimulateRecycled?.()
  await card.resume?.()
}

function debugExportFail(): void {
  debugExportFailOn.value = !debugExportFailOn.value
  const card = cardRef.value as unknown as {
    debugSetExportFail?: (on: boolean) => void
  } | null
  card?.debugSetExportFail?.(debugExportFailOn.value)
}
// #endif
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
  display: block;
  margin-top: 12rpx;
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

.debug-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12rpx;
}

.debug-btn {
  min-width: 200rpx;
  font-size: 24rpx;
}

.debug-text {
  font-size: 24rpx;
  color: #9aa0a6;
  margin-bottom: 12rpx;
}
</style>
