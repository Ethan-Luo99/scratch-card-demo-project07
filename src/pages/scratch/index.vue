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
      :session-id="sessionId"
      @complete="onComplete"
      @progress="onProgress"
    />

    <!-- H5 自测调试入口（真实接入时移除；通过 ?scenario= 控制） -->
    <!-- #ifdef H5 -->
    <view v-if="debugScenario" class="debug-bar">
      <text class="debug-text">
        调试场景：{{ debugScenario }} ｜ complete 总计 {{ totalComplete }}
        {{ storageDegraded() ? ' ｜ storage 已降级（内存模式）' : '' }}
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
  ACTIVITY_STORAGE_KEY,
  QUEUE_STORAGE_KEY,
  FallbackStore,
  computeResumeSnapshot,
  createInitialSnapshot,
  deriveSnapshotFromProgress,
  isStalePeriodResponse,
  isSettleEffectivelyDone,
  migrateQueueRecords,
  parseSnapshot,
  readQueueRecords,
  removeSettledFromQueue,
  runMigration,
  serializeSnapshot,
  type ActivitySnapshot,
  type KVStore,
} from './scratchActivity'

/**
 * 页面职责（对齐 01 §2）：生命周期、拉奖品、传给组件、监听 complete 结算/上报、异常态 UI。
 * 不直接操作 canvas。
 *
 * 本轮升级：
 * - 连刮 3 次：本地券池 3 张（id 互不相同），每期结算完成 800ms 后自动挂下一张；
 * - 幂等键 prizeId+期次：补偿队列、结算幂等标记、completeCount 全部按期次区分；
 * - 任一期 Failed：活动暂停，重试只重发当前期次，不影响已完成期次结算状态。
 * - 断点续刮：活动状态持久化（scratchActivity），刷新/杀进程重进恢复到正确期次，
 *   已完成期次不重刮、不重结算、不重复入队；
 * - 旧数据迁移：旧幂等标记（无期次后缀）与旧补偿队列记录幂等迁移，崩溃可重入；
 * - storage 失败静默降级纯内存模式；跨会话恢复一律发新卡新涂层（防串卡）。
 *
 * 奖品/结算接口为后端接入点：当前以本地 mock 实现（零依赖、可在无后端下自验），
 * 真机接入时把 fetchPrize / reportSettlement 替换为 uni.request 即可。
 */

const streakTotal = STREAK_TOTAL
const prizePool = buildLocalPrizePool()
const completeGuard = new PeriodCompleteGuard()

/* ---------------- 存储（失败静默降级纯内存模式） ---------------- */

function createUniStore(): KVStore {
  return {
    get(key) {
      const v = uni.getStorageSync(key)
      return v === '' || v === undefined || v === null ? null : String(v)
    },
    set(key, value) {
      uni.setStorageSync(key, value)
    },
    remove(key) {
      uni.removeStorageSync(key)
    },
    keys() {
      return uni.getStorageInfoSync().keys || []
    },
  }
}

function createPrimaryStore(): KVStore {
  const base = createUniStore()
  // #ifdef H5
  // 调试场景 storageFail：写入一律抛错，验证静默降级纯内存模式。
  if (readScenarioFromLocation() === 'storageFail') {
    return {
      get: (key) => base.get(key),
      set: () => {
        throw new Error('mock storage quota exceeded')
      },
      remove: (key) => base.remove(key),
      keys: () => base.keys(),
    }
  }
  // #endif
  return base
}

const store = new FallbackStore(createPrimaryStore())
/** 页面会话标识：位图/网格进度仅同会话 onShow 可恢复，跨会话一律发新卡 */
const sessionId =
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

const streak = ref<StreakState>(createStreakState())
const prize = ref<PrizeInfo | null>(null)
const cardRef = ref<InstanceType<typeof ScratchCard> | null>(null)
const completeCounts = ref<Record<number, number>>({})
const totalComplete = ref(0)
const settleInFlight = ref(false)
let snapshot: ActivitySnapshot = createInitialSnapshot()
const completedKeys = new Set<string>()
let fetchSeq = 0
let flushInFlight = false
let nextCardTimer: ReturnType<typeof setTimeout> | null = null
const debugScenario = ref('')
const debugExportFailOn = ref(false)

const isFinished = computed(() => streak.value.stage === 'finished')
// store.degraded 非响应式：模板里用方法取值（仅调试展示）。
function storageDegraded(): boolean {
  return store.degraded
}

onMounted(() => {
  // #ifdef H5
  const scenario = readScenarioFromLocation()
  debugScenario.value = scenario
  // #endif
  restoreActivity()
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

/* ---------------- 断点恢复（持久化 → 期次状态） ---------------- */

/**
 * 进入页面：迁移（幂等可重入）→ 推导恢复快照 → 恢复到正确期次。
 * 已完成期次不重刮、不重结算、不重复入队；跨会话一律发新卡新涂层
 * （组件按 :key="streak.period" 全新挂载，位图/网格进度不带入）。
 */
function restoreActivity(): void {
  const migration = runMigration(store, prizePool)
  const stored = parseSnapshot(store.get(ACTIVITY_STORAGE_KEY))
  // 快照与「标记+队列」双源取并集后重新推导，任一源落后都不丢进度。
  const derived = computeResumeSnapshot({
    settledFlagKeys: migration.settledFlagKeys,
    queue: migration.queue,
    pool: prizePool,
  })
  const union = new Set<string>([
    ...derived.completedKeys,
    ...(stored ? stored.completedKeys : []),
  ])
  snapshot = deriveSnapshotFromProgress([...union], prizePool)
  for (const key of snapshot.completedKeys) completedKeys.add(key)
  persistActivity()
  // 已完成期次的 complete 守卫预标记：恢复后期次绝不重复结算。
  const doneThrough = snapshot.finished ? STREAK_TOTAL : snapshot.period - 1
  for (let p = 1; p <= doneThrough; p++) completeGuard.mark(p)

  if (snapshot.finished) {
    streak.value = { period: snapshot.period, stage: 'finished' }
    syncDebugActivity()
    return
  }
  streak.value = { period: snapshot.period, stage: 'loading' }
  syncDebugActivity()
  void mountCurrentPeriod()
}

function syncDebugActivity(): void {
  // #ifdef H5
  ;(window as unknown as { __scratchActivity?: Record<string, unknown> }).__scratchActivity = {
    period: snapshot.period,
    finished: snapshot.finished,
    completed: [...completedKeys],
    degraded: store.degraded,
  }
  // #endif
}

function persistActivity(): void {
  store.set(ACTIVITY_STORAGE_KEY, serializeSnapshot(snapshot))
}

/* ---------------- 期次流转（活动状态机） ---------------- */

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
  // 竞态守卫：重试连点/慢响应时，只有最新一次请求且期次未推进的响应才生效。
  const reqSeq = ++fetchSeq
  const reqPeriod = streak.value.period
  const isStale = (): boolean =>
    isStalePeriodResponse({
      requestSeq: reqSeq,
      latestSeq: fetchSeq,
      requestPeriod: reqPeriod,
      currentPeriod: streak.value.period,
    })
  try {
    const data = await fetchPrize(reqPeriod)
    if (isStale()) return
    // 字段异常兜底：无 title 按「谢谢参与」处理（§8.3）。
    prize.value =
      data && data.title ? data : { id: data?.id ?? 0, title: '谢谢参与' }
    setStage('ready')
  } catch (err) {
    if (isStale()) return
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
  // 迁移已保证格式；此处再走一遍纯函数迁移做兜底（幂等），兼容主键撕裂回退备份。
  return migrateQueueRecords(readQueueRecords(store), prizePool).queue
}

function writeQueue(records: SettleRecord[]): void {
  store.set(QUEUE_STORAGE_KEY, JSON.stringify(records))
}

/**
 * 补报队列：幂等键为 prizeId+期次；补报成功再写该期幂等标记，
 * 保证「同一条记录无论走直报还是补偿，服务端/本地恰好生效一次」。
 * 并发加固：flush 单飞；结束时只移除本次成功的记录，
 * flush 期间新入队的记录必须保留（防并发覆盖丢失）。
 */
async function flushSettleQueue(): Promise<void> {
  if (flushInFlight) return
  flushInFlight = true
  try {
    const pending = readQueue()
    if (pending.length === 0) return
    const succeeded: SettleRecord[] = []
    for (const record of pending) {
      try {
        await reportSettlement(record)
        store.set(settleFlagKey(record.prizeId, record.period), '1')
        succeeded.push(record)
      } catch {
        /* 保留在队列，下次补报 */
      }
    }
    if (succeeded.length > 0) {
      writeQueue(removeSettledFromQueue(readQueue(), succeeded))
      // 补报成功的期次计入已完成并落盘（断点恢复不重复入队）。
      let changed = false
      for (const record of succeeded) {
        const key = settleKey(record.prizeId, record.period)
        if (record.period >= 1 && !completedKeys.has(key)) {
          completedKeys.add(key)
          changed = true
        }
      }
      if (changed) {
        snapshot = deriveSnapshotFromProgress([...completedKeys], prizePool)
        persistActivity()
      }
    }
  } finally {
    flushInFlight = false
  }
}

async function onComplete(p: PrizeInfo): Promise<void> {
  const period = streak.value.period
  // 期次级幂等：同一期 complete 只结算一次（组件已保证单卡 complete 仅 emit 一次）。
  if (!completeGuard.mark(period)) return
  // 状态机：ready → revealed；非法阶段（如已推进）直接忽略。
  if (streak.value.stage !== 'ready') return
  streak.value = { period, stage: 'revealed' }

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
  // 已生效（持久化标记/补偿队列/本次会话记录）→ 不重复直报、不重复入队。
  if (
    isSettleEffectivelyDone({
      settledFlagKeys: store.keys(),
      queue: readQueue(),
      prizeId: p.id,
      period,
    }) ||
    completedKeys.has(settleKey(p.id, period))
  ) {
    finishCurrentSettle(p.id, period)
    return
  }

  const record: SettleRecord = { prizeId: p.id, period, ts: Date.now() }
  try {
    await reportSettlement(record)
    store.set(settleFlagKey(p.id, period), '1')
  } catch {
    // 上报失败：写期次级补偿队列，onShow/网络恢复时按期补报（不回滚视觉，仍进 Settled）。
    writeQueue(enqueueSettleRecord(readQueue(), record))
  }
  finishCurrentSettle(p.id, period)
}

/** 当前期结算生效后的统一收尾：记录完成键、落盘快照、解锁并调度下一张。 */
function finishCurrentSettle(prizeId: string | number, period: number): void {
  completedKeys.add(settleKey(prizeId, period))
  snapshot = deriveSnapshotFromProgress([...completedKeys], prizePool)
  persistActivity()
  syncDebugActivity()
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
