// 端到端逻辑测试：在 Node 中用内存 localStorage 运行模拟服务端，
// 验证依据固化、旧数据升级、租约排他、丢失续跑、依据失效与重试。
// 通过 esbuild 打包为 ESM 后由 node 执行：见 scripts/run-export-test.mjs
import assert from 'node:assert/strict'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  setItem(key: string, value: string) { this.map.set(key, String(value)) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
}
;(globalThis as { localStorage: unknown }).localStorage = new MemoryStorage()

const { exportApi, ExportClientError } = await import('../src/api/exportApi.ts')
const { exportServer, LEASE_TTL_MS } = await import('../src/api/exportServer.ts')

import type { BasisInput } from '../src/api/exportModel.ts'

function basisInput(over: Partial<BasisInput> = {}): BasisInput {
  const base: BasisInput = {
    revision: 'R6',
    positions: [
      { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
      { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
    ],
    pages: [
      { pageNo: 1, bleed: 3 },
      { pageNo: 8, bleed: 3 },
    ],
    proofs: [
      { id: 'PRF-02', round: 2, decision: '待决定', deltaE: 1.9 },
    ],
    validations: [],
    locked: false,
    createdAt: '2026-09-30T10:00:00.000Z',
  }
  return { ...base, ...over }
}

async function expectError(code: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    assert.fail(`应当抛出 ${code}`)
  } catch (error) {
    assert.ok(error instanceof ExportClientError, `期望 ExportClientError，收到 ${error}`)
    assert.equal((error as ExportClientError).code, code)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let passed = 0
async function test(name: string, fn: () => Promise<void>) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// ---------- 场景 1：旧数据升级（必须在首次创建任务的干净状态下验证） ----------
await test('旧任务缺少依据 → 待复核，旧分片留待复核，确认前不可领取', async () => {
  localStorage.clear()
  // 预置旧版 v1 数据（旧客户端曾把任务存在这里）
  localStorage.setItem('print-imposition-v1', JSON.stringify({
    tasks: [
      { id: 'EXP-OLD-1', name: '旧版中断任务', progress: 75, status: '已中断', updatedAt: '09-25 16:42', resumable: true },
      { id: 'EXP-OLD-2', name: '旧版已完成', progress: 100, status: '已完成', updatedAt: '09-25 15:18', resumable: false },
    ],
  }))
  exportServer.reset()

  const tasks = await exportApi.list()
  const interrupted = tasks.find((t) => t.id === 'EXP-OLD-1')!
  const completed = tasks.find((t) => t.id === 'EXP-OLD-2')!
  assert.equal(interrupted.status, '待复核')
  assert.equal(interrupted.legacy, true)
  assert.ok(interrupted.reviewReason?.includes('缺少发起依据'))
  assert.ok(interrupted.shards.some((s) => s.state === '已失效' && s.reason?.includes('旧分片缺少依据')))
  assert.equal(completed.status, '待复核') // 已完成但无依据同样留复核
  await expectError('NEEDS_REVIEW', () => exportApi.claim('EXP-OLD-1', '工位 A'))

  const confirmed = await exportApi.confirmBasis('EXP-OLD-1', basisInput())
  assert.equal(confirmed.status, '排队中')
  assert.ok(confirmed.basis, '补录后应有依据快照')
  assert.equal(confirmed.shards.every((s) => s.state === '待生成'), true, '旧分片无依据不复用')
  assert.equal(confirmed.legacy, false)
})

// ---------- 场景 2：内置旧依据任务，首次对账即列出 ----------
await test('依据落后于当前版本的旧任务，对账时立即失效并列出', async () => {
  const result = await exportApi.reconcile(basisInput())
  const stale = result.affected.find((t) => t.id === 'EXP-0924-03')
  assert.ok(stale, '受影响清单必须包含 EXP-0924-03')
  assert.equal(stale!.changed.imposition, true)
  assert.ok(stale!.invalidatedShards >= 2)
  const tasks = await exportApi.list()
  const task = tasks.find((t) => t.id === 'EXP-0924-03')!
  assert.equal(task.status, '依据失效')
  assert.ok(task.shards.filter((s) => s.state === '已失效').length >= 2)
  await expectError('BASIS_STALE', () => exportApi.claim('EXP-0924-03', '工位 A'))

  const retried = await exportApi.retry('EXP-0924-03', basisInput())
  assert.equal(retried.status, '排队中')
  assert.equal(retried.progress, 0)
  assert.equal(retried.shards.every((s) => s.state === '待生成'), true)
  assert.equal(retried.basis!.revision, 'R6')
  const again = await exportApi.reconcile(basisInput())
  assert.equal(again.affected.find((t) => t.id === 'EXP-0924-03'), undefined, '新依据重试后不再受影响')
})

// ---------- 场景 3：发起固定依据 + 租约排他 + 进度仅持有人可写 ----------
await test('发起即固定依据；两工位同时领取只有一个成功；非持有人无法写进度', async () => {
  const task = await exportApi.create('测试交付包', basisInput())
  assert.equal(task.basis!.revision, 'R6')
  assert.equal(task.basis!.manifest.length, 5)
  assert.equal(task.shards.length, 1) // 2 页 / 每页 2 片 → 1 个分片
  assert.equal(task.status, '排队中')

  const a = await exportApi.claim(task.id, '工位 A')
  assert.ok(a.lease && a.lease.station === '工位 A')
  await expectError('LEASE_HELD', () => exportApi.claim(task.id, '工位 B'))
  await expectError('LEASE_LOST', () =>
    exportApi.reportProgress(task.id, '工位 B', 'fake-token', task.shards[0].id))
  await expectError('NOT_HOLDER', () =>
    exportApi.release(task.id, '工位 B', 'fake-token'))

  // 错误 token 也被拒
  await expectError('LEASE_LOST', () =>
    exportApi.reportProgress(task.id, '工位 A', 'wrong-token', task.shards[0].id))

  // 持有人写进度 → 完成并释放
  const done = await exportApi.reportProgress(task.id, '工位 A', a.lease!.token, task.shards[0].id)
  assert.equal(done.status, '已完成')
  assert.equal(done.progress, 100)
  assert.equal(done.lease, undefined)
  assert.equal(done.shards[0].basisDigest, done.basisDigest, '分片记录任务依据摘要')
})

// ---------- 场景 4：租约丢失 → 从最后完整分片续跑 ----------
await test('租约到期后任务中断；另一工位可领取并从最后完整分片续跑', async () => {
  const task = await exportApi.create(
    '8 页交付包',
    basisInput({
      pages: Array.from({ length: 8 }, (_, i) => ({ pageNo: i + 1, bleed: 3 })),
      positions: Array.from({ length: 8 }, (_, i) => ({ id: `P-${i}`, pageNo: i + 1, x: 10, y: 10, rotation: 0, front: i % 2 === 0 })),
    }),
  )
  assert.equal(task.shards.length, 4)
  const a = await exportApi.claim(task.id, '工位 A')
  await exportApi.reportProgress(task.id, '工位 A', a.lease!.token, 'S1')
  await exportApi.reportProgress(task.id, '工位 A', a.lease!.token, 'S2')

  // 工位 A 离线，等待租约超时
  await sleep(LEASE_TTL_MS + 100)
  const interrupted = (await exportApi.list()).find((t) => t.id === task.id)!
  assert.equal(interrupted.status, '已中断')
  assert.equal(interrupted.lease, undefined)
  assert.equal(interrupted.progress, 50)
  assert.deepEqual(interrupted.shards.filter((s) => s.state === '已完成').map((s) => s.id), ['S1', 'S2'])

  // 工位 B 接管，从 S3 续跑
  const b = await exportApi.claim(task.id, '工位 B')
  assert.equal(b.lease!.station, '工位 B')
  await exportApi.reportProgress(task.id, '工位 B', b.lease!.token, 'S3')
  await exportApi.reportProgress(task.id, '工位 B', b.lease!.token, 'S4')
  const finished = (await exportApi.list()).find((t) => t.id === task.id)!
  assert.equal(finished.status, '已完成')
  assert.equal(finished.progress, 100)

  // A 的旧 token 已失效
  await expectError('LEASE_LOST', () => exportApi.heartbeat(task.id, '工位 A', a.lease!.token))
})

// ---------- 场景 5：执行中依据变更 → 旧分片立即失效 ----------
await test('生成中依据一变：租约解除、旧分片失效、重试以新依据重跑', async () => {
  const task = await exportApi.create(
    '8 页交付包',
    basisInput({
      pages: Array.from({ length: 8 }, (_, i) => ({ pageNo: i + 1, bleed: 3 })),
      positions: Array.from({ length: 8 }, (_, i) => ({ id: `P-${i}`, pageNo: i + 1, x: 10, y: 10, rotation: 0, front: i % 2 === 0 })),
    }),
  )
  const a = await exportApi.claim(task.id, '工位 A')
  await exportApi.reportProgress(task.id, '工位 A', a.lease!.token, 'S1')

  // 拼版版本由 R6 → R7（位置变化）
  const result = await exportApi.reconcile(
    basisInput({
      revision: 'R7',
      positions: Array.from({ length: 8 }, (_, i) => ({ id: `P-${i}`, pageNo: i + 1, x: 52, y: 10, rotation: 0, front: i % 2 === 0 })),
      pages: Array.from({ length: 8 }, (_, i) => ({ pageNo: i + 1, bleed: 3 })),
    }),
  )
  const hit = result.affected.find((t) => t.id === task.id)!
  assert.ok(hit.changed.imposition)
  assert.equal(hit.invalidatedShards, 1)
  const stale = (await exportApi.list()).find((t) => t.id === task.id)!
  assert.equal(stale.status, '依据失效')
  assert.equal(stale.lease, undefined, '在途任务立即停租约')
  assert.equal(stale.shards[0].state, '已失效')
  assert.equal(stale.progress, 0)

  // 持有人的旧写入路径已断
  await expectError('BASIS_STALE', () => exportApi.claim(task.id, '工位 A'))

  const retried = await exportApi.retry(task.id, basisInput({ revision: 'R7' }))
  assert.equal(retried.basis!.revision, 'R7')
  assert.equal(retried.shards.every((s) => s.state === '待生成'), true)
})

// ---------- 场景 6：打样结论变更 ----------
await test('仅打样结论改变也使在途任务失效', async () => {
  const task = await exportApi.create('打样敏感包', basisInput())
  await exportApi.claim(task.id, '工位 A')
  const result = await exportApi.reconcile(
    basisInput({ proofs: [{ id: 'PRF-02', round: 2, decision: '通过', deltaE: 1.2 }] }),
  )
  const hit = result.affected.find((t) => t.id === task.id)!
  assert.equal(hit.changed.imposition, false)
  assert.equal(hit.changed.proof, true)
  const stale = (await exportApi.list()).find((t) => t.id === task.id)!
  assert.equal(stale.status, '依据失效')
})

// ---------- 场景 7：已完成任务被新依据取代 ----------
await test('已完成任务依据过时 → 标记取代并列出，但结果保留', async () => {
  const task = await exportApi.create('已完成包', basisInput())
  const a = await exportApi.claim(task.id, '工位 A')
  await exportApi.reportProgress(task.id, '工位 A', a.lease!.token, task.shards[0].id)
  const finished = (await exportApi.list()).find((t) => t.id === task.id)!
  assert.equal(finished.status, '已完成')

  const result = await exportApi.reconcile(basisInput({ revision: 'R8' }))
  const hit = result.affected.find((t) => t.id === task.id)!
  assert.equal(hit.status, '已完成')
  const superseded = (await exportApi.list()).find((t) => t.id === task.id)!
  assert.equal(superseded.status, '已完成', '已完成结果不被强删')
  assert.equal(superseded.basisSuperseded, true)
})

console.log(`\n全部 ${passed} 个场景通过`)
