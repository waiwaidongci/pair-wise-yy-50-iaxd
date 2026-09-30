import axios, { type AxiosAdapter, type AxiosResponse } from 'axios'
import type { ExportTask, BasisSnapshot, Shard } from '../stores/imposition'
import { defaultOutputManifest } from '../stores/imposition'

const LEASE_TTL_MS = 120_000 // 租约有效期 2 分钟

function computeBasisHash(data: unknown): string {
  const str = JSON.stringify(data)
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return `BASIS-${Math.abs(hash).toString(16).padStart(8, '0').toUpperCase()}`
}

function createShards(): Shard[] {
  return [
    { id: 'SH-1', index: 0, label: '封面与版权页 (P1-P2)', status: '待生成' },
    { id: 'SH-2', index: 1, label: '序言与剧照 (P3-P4)', status: '待生成' },
    { id: 'SH-3', index: 2, label: '曲目与创作团队 (P5-P6)', status: '待生成' },
    { id: 'SH-4', index: 3, label: '封底与输出校验 (P7-P8)', status: '待生成' },
  ]
}

function seedBasis(revision: string, proofDecision: string, proofRound: number): BasisSnapshot {
  const positions = [
    { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
    { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
    { id: 'P-03', pageNo: 6, x: 34, y: 548, rotation: 180, front: true },
    { id: 'P-04', pageNo: 3, x: 372, y: 548, rotation: 0, front: true },
    { id: 'P-05', pageNo: 2, x: 34, y: 44, rotation: 0, front: false },
    { id: 'P-06', pageNo: 7, x: 372, y: 44, rotation: 180, front: false },
    { id: 'P-07', pageNo: 4, x: 34, y: 548, rotation: 0, front: false },
    { id: 'P-08', pageNo: 5, x: 372, y: 548, rotation: 180, front: false },
  ]
  const basisHash = computeBasisHash({
    revision,
    positions,
    proofDecision,
    proofRound,
    outputManifest: defaultOutputManifest,
  })
  return {
    revision,
    positions,
    proofRound,
    proofDecision,
    outputManifest: structuredClone(defaultOutputManifest),
    capturedAt: '2026-09-25T16:42:00Z',
    basisHash,
  }
}

let tasks: ExportTask[] = [
  {
    id: 'EXP-0925-01',
    name: '印刷交付包 · PDF/X-4',
    progress: 72,
    status: '已中断',
    updatedAt: '09-25 16:42',
    resumable: true,
    basis: seedBasis('R6', '待决定', 2),
    reviewStatus: 'ok',
    lease: null,
    shards: [
      { id: 'SH-1', index: 0, label: '封面与版权页 (P1-P2)', status: '已完成', completedAt: '2026-09-25T16:30:00Z' },
      { id: 'SH-2', index: 1, label: '序言与剧照 (P3-P4)', status: '已完成', completedAt: '2026-09-25T16:35:00Z' },
      { id: 'SH-3', index: 2, label: '曲目与创作团队 (P5-P6)', status: '已完成', completedAt: '2026-09-25T16:40:00Z' },
      { id: 'SH-4', index: 3, label: '封底与输出校验 (P7-P8)', status: '待生成' },
    ],
  },
  {
    id: 'EXP-0925-02',
    name: '数字样张低分辨率预览',
    progress: 100,
    status: '已完成',
    updatedAt: '09-25 15:18',
    resumable: false,
    basis: seedBasis('R6', '待决定', 2),
    reviewStatus: 'ok',
    lease: null,
    shards: [
      { id: 'SH-1', index: 0, label: '封面与版权页 (P1-P2)', status: '已完成', completedAt: '2026-09-25T15:10:00Z' },
      { id: 'SH-2', index: 1, label: '序言与剧照 (P3-P4)', status: '已完成', completedAt: '2026-09-25T15:12:00Z' },
      { id: 'SH-3', index: 2, label: '曲目与创作团队 (P5-P6)', status: '已完成', completedAt: '2026-09-25T15:15:00Z' },
      { id: 'SH-4', index: 3, label: '封底与输出校验 (P7-P8)', status: '已完成', completedAt: '2026-09-25T15:18:00Z' },
    ],
  },
  {
    id: 'EXP-0924-03',
    name: '专色印刷包 · PANTONE 2965 C',
    progress: 0,
    status: '待复核',
    updatedAt: '09-24 10:15',
    resumable: false,
    basis: null,
    reviewStatus: 'pending_review',
    lease: null,
    shards: [],
  },
]

function isLeaseValid(lease: ExportTask['lease']): boolean {
  if (!lease) return false
  return new Date(lease.expiresAt).getTime() > Date.now()
}

function findTask(id: string): ExportTask {
  const task = tasks.find((item) => item.id === id)
  if (!task) throw new Error('任务不存在')
  return task
}

function createTask(name: string, basis: BasisSnapshot): ExportTask {
  return {
    id: `EXP-${Date.now().toString().slice(-6)}`,
    name,
    progress: 0,
    status: '排队中',
    updatedAt: '刚刚',
    resumable: true,
    basis,
    reviewStatus: 'ok',
    lease: null,
    shards: createShards(),
  }
}

// 领取租约 — 仅一个工位可持有有时限的执行权
function claimLease(id: string, stationId: string, stationName: string): ExportTask {
  const task = findTask(id)
  if (task.reviewStatus === 'pending_review') throw new Error('任务待复核，无法领取')
  if (task.status === '已完成') throw new Error('任务已完成')
  // 租约仍有效且持有人不同 → 拒绝
  if (task.lease && isLeaseValid(task.lease) && task.lease.holderId !== stationId) {
    const err = new Error(`租约已被 ${task.lease.holderName} 持有`) as Error & { code?: string; holder?: string }
    err.code = 'LEASE_HELD'
    err.holder = task.lease.holderName
    throw err
  }
  task.lease = {
    holderId: stationId,
    holderName: stationName,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
  }
  task.updatedAt = '刚刚'
  return task
}

// 续跑 — 领取租约并从最后完整分片继续
function resumeTask(id: string, stationId: string, stationName: string): ExportTask {
  const task = claimLease(id, stationId, stationName)
  task.status = '生成中'
  // 从最后完整分片续跑 — 找到第一个未完成且未失效的分片
  const nextShard = task.shards.find((s) => s.status !== '已完成' && s.status !== '已失效')
  if (nextShard) {
    nextShard.status = '生成中'
  }
  task.updatedAt = '刚刚'
  return task
}

// 心跳续约 — 仅持有人可续约
function heartbeat(id: string, stationId: string): ExportTask {
  const task = findTask(id)
  if (!task.lease || task.lease.holderId !== stationId) throw new Error('非租约持有人')
  task.lease.expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString()
  return task
}

// 释放租约 — 持有人主动释放，任务回到中断状态
function releaseLease(id: string, stationId: string): ExportTask {
  const task = findTask(id)
  if (task.lease?.holderId === stationId) {
    task.lease = null
    if (task.status === '生成中') task.status = '已中断'
    task.updatedAt = '刚刚'
  }
  return task
}

// 推进分片 — 仅租约持有人可写进度
function tickTask(id: string, stationId: string): ExportTask | null {
  const task = findTask(id)
  if (task.lease?.holderId !== stationId) return null
  if (!isLeaseValid(task.lease)) return null
  if (task.status !== '生成中') return null

  // 完成当前生成中的分片
  const generating = task.shards.find((s) => s.status === '生成中')
  if (generating) {
    generating.status = '已完成'
    generating.completedAt = new Date().toISOString()
  }

  // 开始下一个待生成分片
  const next = task.shards.find((s) => s.status === '待生成')
  if (next) {
    next.status = '生成中'
  } else {
    // 所有分片完成
    task.status = '已完成'
    task.progress = 100
    task.lease = null
    task.updatedAt = '刚刚'
    return task
  }

  // 更新进度
  const completed = task.shards.filter((s) => s.status === '已完成').length
  task.progress = Math.round((completed / task.shards.length) * 100)
  task.updatedAt = '刚刚'
  return task
}

// 依据变更 — 旧分片立即失效，返回受影响任务
function invalidateAffected(basis: BasisSnapshot): ExportTask[] {
  const affected: ExportTask[] = []
  for (const task of tasks) {
    if (task.reviewStatus === 'pending_review') continue
    if (!task.basis) continue
    if (task.basis.basisHash !== basis.basisHash) {
      // 旧分片立即失效
      for (const shard of task.shards) {
        if (shard.status !== '已完成') {
          shard.status = '已失效'
        }
      }
      // 已完成的分片也标记依据过期（需用新依据重跑）
      task.status = '已中断'
      task.lease = null
      task.updatedAt = '刚刚'
      affected.push(task)
    }
  }
  return affected
}

// 重试 — 用新依据重新生成
function retryTask(id: string, stationId: string, stationName: string, basis: BasisSnapshot): ExportTask {
  const task = findTask(id)
  task.basis = basis
  task.shards = createShards()
  task.lease = null
  task.status = '排队中'
  task.progress = 0
  task.updatedAt = '刚刚'
  return task
}

// 复核 — 补充依据后可继续
function reviewTask(id: string, basis: BasisSnapshot): ExportTask {
  const task = findTask(id)
  task.basis = basis
  task.reviewStatus = 'ok'
  task.status = '排队中'
  task.shards = createShards()
  task.progress = 0
  task.updatedAt = '刚刚'
  return task
}

const rawAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 160))

  // GET /api/print/export-tasks
  if (config.url === '/api/print/export-tasks' && config.method === 'get') {
    return { data: structuredClone(tasks), status: 200, statusText: 'OK', headers: {}, config }
  }

  // POST /api/print/export-tasks — 发起任务时固定依据
  if (config.url === '/api/print/export-tasks' && config.method === 'post') {
    const { name, basis } = JSON.parse(config.data) as { name: string; basis: BasisSnapshot }
    const task = createTask(name, basis)
    tasks.push(task)
    return { data: structuredClone(task), status: 201, statusText: 'Created', headers: {}, config }
  }

  // POST /api/print/export-tasks/basis-changed — 依据变更，旧分片失效
  if (config.url === '/api/print/export-tasks/basis-changed' && config.method === 'post') {
    const { basis } = JSON.parse(config.data) as { basis: BasisSnapshot }
    const affected = invalidateAffected(basis)
    return { data: structuredClone(affected), status: 200, statusText: 'OK', headers: {}, config }
  }

  // POST /api/print/export-tasks/:id/claim — 领取租约
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/claim$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)!
    const { stationId, stationName } = JSON.parse(config.data) as { stationId: string; stationName: string }
    try {
      const task = claimLease(id, stationId, stationName)
      return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
    } catch (e) {
      const err = e as Error & { code?: string; holder?: string }
      return { data: { error: err.message, code: err.code, holder: err.holder }, status: 409, statusText: 'Conflict', headers: {}, config }
    }
  }

  // POST /api/print/export-tasks/:id/resume — 续跑（领取租约 + 从最后完整分片继续）
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/resume$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)!
    const { stationId, stationName } = JSON.parse(config.data) as { stationId: string; stationName: string }
    try {
      const task = resumeTask(id, stationId, stationName)
      return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
    } catch (e) {
      const err = e as Error & { code?: string; holder?: string }
      return { data: { error: err.message, code: err.code, holder: err.holder }, status: 409, statusText: 'Conflict', headers: {}, config }
    }
  }

  // POST /api/print/export-tasks/:id/heartbeat — 心跳续约
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/heartbeat$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)!
    const { stationId } = JSON.parse(config.data) as { stationId: string }
    try {
      const task = heartbeat(id, stationId)
      return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
    } catch {
      return { data: null, status: 403, statusText: 'Forbidden', headers: {}, config }
    }
  }

  // POST /api/print/export-tasks/:id/release — 释放租约
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/release$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)!
    const { stationId } = JSON.parse(config.data) as { stationId: string }
    const task = releaseLease(id, stationId)
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
  }

  // POST /api/print/export-tasks/:id/tick — 推进分片进度
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/tick$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)!
    const { stationId } = JSON.parse(config.data) as { stationId: string }
    const task = tickTask(id, stationId)
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
  }

  // POST /api/print/export-tasks/:id/retry — 用新依据重试
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/retry$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)!
    const { stationId, stationName, basis } = JSON.parse(config.data) as { stationId: string; stationName: string; basis: BasisSnapshot }
    const task = retryTask(id, stationId, stationName, basis)
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
  }

  // POST /api/print/export-tasks/:id/review — 复核旧任务
  if (config.url?.match(/^\/api\/print\/export-tasks\/[^/]+\/review$/) && config.method === 'post') {
    const id = config.url.split('/').at(-2)!
    const { basis } = JSON.parse(config.data) as { basis: BasisSnapshot }
    const task = reviewTask(id, basis)
    return { data: structuredClone(task), status: 200, statusText: 'OK', headers: {}, config }
  }

  return { data: null, status: 404, statusText: 'Not Found', headers: {}, config }
}

// 包装适配器 — 执行状态码校验（4xx/5xx 抛错），模拟 axios 的 settle 行为
const adapter: AxiosAdapter = (config) => {
  return new Promise((resolve, reject) => {
    rawAdapter(config).then(
      (response) => {
        if (response.status >= 200 && response.status < 300) {
          resolve(response)
        } else {
          const err = new Error(`Request failed with status code ${response.status}`) as Error & { response?: AxiosResponse }
          err.response = response
          reject(err)
        }
      },
      (error) => reject(error),
    )
  })
}

const client = axios.create({ adapter })

export const exportApi = {
  list: () => client.get<ExportTask[]>('/api/print/export-tasks'),
  create: (name: string, basis: BasisSnapshot) => client.post<ExportTask>('/api/print/export-tasks', { name, basis }),
  reportBasisChanged: (basis: BasisSnapshot) => client.post<ExportTask[]>('/api/print/export-tasks/basis-changed', { basis }),
  claim: (id: string, station: { id: string; name: string }) => client.post<ExportTask>(`/api/print/export-tasks/${id}/claim`, { stationId: station.id, stationName: station.name }),
  resume: (id: string, station: { id: string; name: string }) => client.post<ExportTask>(`/api/print/export-tasks/${id}/resume`, { stationId: station.id, stationName: station.name }),
  heartbeat: (id: string, stationId: string) => client.post<ExportTask>(`/api/print/export-tasks/${id}/heartbeat`, { stationId }),
  release: (id: string, stationId: string) => client.post<ExportTask>(`/api/print/export-tasks/${id}/release`, { stationId }),
  tick: (id: string, stationId: string) => client.post<ExportTask | null>(`/api/print/export-tasks/${id}/tick`, { stationId }),
  retry: (id: string, station: { id: string; name: string }, basis: BasisSnapshot) => client.post<ExportTask>(`/api/print/export-tasks/${id}/retry`, { stationId: station.id, stationName: station.name, basis }),
  review: (id: string, basis: BasisSnapshot) => client.post<ExportTask>(`/api/print/export-tasks/${id}/review`, { basis }),
}
