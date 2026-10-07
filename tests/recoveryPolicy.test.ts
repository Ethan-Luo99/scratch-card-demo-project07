/**
 * onShow 画布回收恢复策略（三级兜底）纯逻辑单测。
 * 运行：node --test tests/recoveryPolicy.test.ts
 *
 * 覆盖：
 * 1. 位图可用 → bitmap（drawImage 恢复，ratio 不回退）
 * 2. 旧内核无导出能力 → replay（网格圆点二级兜底）
 * 3. 节点式内核未尝试导出（onHide 时 surface 未就绪）→ replay
 * 4. 节点式内核导出失败 → fresh（静默重置新卡，不报错/不留脏状态）
 * 5. 位图恢复失败 → fresh
 * 6. 网格重放无指令 → fresh
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideRecoveryTier,
  fallbackAfterRestoreFailure,
  tierAfterReplayUnavailable,
  type RecoveryDecisionInput,
} from '../src/components/scratch-card/recoveryPolicy.ts'

function base(over: Partial<RecoveryDecisionInput> = {}): RecoveryDecisionInput {
  return {
    legacy: false,
    exportAttempted: false,
    snapshot: null,
    ...over,
  }
}

const dataUrl = { kind: 'dataURL', data: 'data:image/png;base64,AAAA' } as const
const tempFile = { kind: 'tempFilePath', path: 'http://tmp/a.png' } as const

test('位图可用（H5 dataURL）→ bitmap 恢复，ratio/网格保持不回退', () => {
  assert.equal(
    decideRecoveryTier(base({ snapshot: dataUrl, exportAttempted: true })),
    'bitmap',
  )
})

test('位图可用（MP/App tempFilePath）→ bitmap 恢复', () => {
  assert.equal(
    decideRecoveryTier(base({ snapshot: tempFile, exportAttempted: true })),
    'bitmap',
  )
})

test('旧内核不具备导出能力 → replay 网格圆点二级兜底（buildReplayCommand 保留）', () => {
  assert.equal(
    decideRecoveryTier(
      base({ legacy: true, exportAttempted: false, snapshot: null }),
    ),
    'replay',
  )
  // 即便误带快照，旧内核也不具备 drawImage 恢复条件，统一走 replay。
  assert.equal(
    decideRecoveryTier(base({ legacy: true, snapshot: dataUrl })),
    'replay',
  )
})

test('节点式内核未尝试导出（onHide 时 surface 未就绪）→ replay 二级兜底', () => {
  assert.equal(decideRecoveryTier(base()), 'replay')
})

test('节点式内核导出被尝试但失败（无快照）→ 直接 fresh 静默重置为新卡', () => {
  assert.equal(
    decideRecoveryTier(base({ exportAttempted: true })),
    'fresh',
  )
})

test('快照存在即代表导出成功 → bitmap（导出成功优先）', () => {
  assert.equal(
    decideRecoveryTier(base({ exportAttempted: true, snapshot: dataUrl })),
    'bitmap',
  )
})

test('位图恢复失败 → fresh（不报错、不留脏状态）', () => {
  assert.equal(fallbackAfterRestoreFailure(), 'fresh')
})

test('网格重放拿不到指令（无任何已擦格）→ fresh', () => {
  assert.equal(tierAfterReplayUnavailable(), 'fresh')
})
