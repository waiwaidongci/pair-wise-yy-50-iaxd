// 导出任务的「服务端」模拟：共享内存 + localStorage 持久化（同一浏览器扮演服务端存储）。
// 职责：任务唯一事实源、有时限的执行租约（领取/心跳/丢失）、分片进度、依据对账与旧数据升级。

import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import {
  captureBasis,
  digestBasis,
  diffBasis,
  formatStamp,
  migrateLegacyTask,
  planShards,
  shardProgress,
  type AffectedTask,
  type ChangedFields,
  type ExportBasis,
  type ExportTask,
  type Shard,
} from './exportModel'
import type { BasisInput } from './exportModel'

const STORE_KEY = 'print-export-server-v1'
const LEGACY_STORE_KEY = 'print-imposition-v1'

/** 租约时限：实际生产通常为数分钟，演示环境压缩到 8 秒，便于观察丢失与接管 */
export const LEASE_TTL_MS = 8_000

export type ServerState = {
  tasks: ExportTask[]
  bootstrapped: boolean
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

type LegacyTaskShape = {
  id: string
  name: string
  progress: number
  status: string
  updatedAt: string
  resumable: boolean
}

// 内置的旧版演示任务：模拟「升级前」队列里残留的、没有依据快照的任务，
// 以及一个依据已与当前 R6 不一致的中断任务。
const legacySeeds: Array<LegacyTaskShape & { basis?: ExportBasis; shards?: Shard[] }> = [
  {
    id: 'EXP-0925-01',
    name: '印刷交付包 · PDF/X-4',
    progress: 72,
    status: '已中断',
    updatedAt: '09-25 16:42',
    resumable: true,
  },
  {
    id: 'EXP-0925-02',
    name: '数字样张低分辨率预览',
    progress: 100,
    status: '已完成',
    updatedAt: '09-25 15:18',
    resumable: false,
  },
  {
    // 依据失效演示：该任务发起自 R5（P7 出血 1mm、rotation 0°），当前已为 R6
    id: 'EXP-0924-03',
    name: '追印小批量 · 封面专色包',
    progress: 50,
    status: '已中断',
    updatedAt: '09-24 18:07',
    resumable: true,
    basis: {
      revision: 'R5',
      revisionLabel: 'R5（已锁定）',
      positionsDigest: 'stale-r5-positions',
      positions: [],
      pages: [],
      proofDigest: 'stale-r5-proofs',
      proofs: [],
      manifest: [
        { key: 'imposition-pdf', label: '拼版 PDF/X-4', detail: '待生成' },
        { key: 'proof-approval', label: '打样审批记录', detail: '1 轮 · 0 轮通过' },
      ],
      manifestDigest: 'stale-r5-manifest',
      createdAt: '2026-09-24 18:00:00',
    },
    shards: [
      { id: 'S1', label: '分片 1 · P1–P2', state: '已完成', basisDigest: hashStale('stale-r5') },
      { id: 'S2', label: '分片 2 · P3–P4', state: '已完成', basisDigest: hashStale('stale-r5') },
      { id: 'S3', label: '分片 3 · P5–P6', state: '待生成' },
      { id: 'S4', label: '分片 4 · P7–P8', state: '待生成' },
    ],
  },
]

function hashStale(seed: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function now(): number {
  return Date.now()
}

function persist(state: ServerState) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时退化为仅内存态
  }
}

function shardsForLegacy(): Shard[] {
  return ['S1', 'S2', 'S3', 'S4'].map((id, index) => ({
    id,
    label: `分片 ${index + 1} · P${index * 2 + 1}–P${index * 2 + 2}`,
    state: index < 3 ? '已完成' : '待生成',
  }))
}

function completedShardsForLegacy(): Shard[] {
  return ['S1', 'S2', 'S3', 'S4'].map((id, index) => ({
    id,
    label: `分片 ${index + 1} · P${index * 2 + 1}–P${index * 2 + 2}`,
    state: '已完成' as const,
  }))
}

function asLegacyTask(seed: (typeof legacySeeds)[number]): ExportTask {
  return {
    id: seed.id,
    name: seed.name,
    progress: seed.progress,
    status: seed.status as ExportTask['status'],
    updatedAt: seed.updatedAt,
    resumable: seed.resumable,
    basis: seed.basis,
    basisDigest: seed.basis ? digestBasis(seed.basis) : undefined,
    shards: seed.shards ?? (seed.progress >= 100 ? completedShardsForLegacy() : shardsForLegacy()),
  }
}

function normalizeTask(raw: ExportTask): ExportTask {
  const task = structuredClone(raw)
  if (task.basis) {
    task.basis.positions ??= []
    task.basis.pages ??= []
    task.basis.proofs ??= []
    task.basis.manifest ??= []
  }
  task.shards ??= []
  return task
}

/**
 * 启动升级：读取旧版 v1 数据（含用户在旧版本中新建的任务），连同内置旧任务一起迁移。
 * 幂等：服务端状态一旦建立即不再重复迁移。
 */
function bootstrap(): ServerState {
  const raw = localStorage.getItem(STORE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ServerState
      if (parsed?.bootstrapped && Array.isArray(parsed.tasks)) {
        parsed.tasks = parsed.tasks.map(normalizeTask)
        return parsed
      }
    } catch {
      // 损坏的服务端状态落到重建分支
    }
  }

  const migrated = new Map<string, ExportTask>()
  const absorb = (task: ExportTask) => {
    if (!migrated.has(task.id)) migrated.set(task.id, task)
  }

  // 1. 升级旧版本地存储中的任务
  const legacyRaw = localStorage.getItem(LEGACY_STORE_KEY)
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as { tasks?: LegacyTaskShape[] }
      for (const item of legacy.tasks ?? []) {
        absorb(migrateLegacyTask(asLegacyTask({ ...item })))
      }
    } catch {
      // 忽略无法解析的旧数据，继续使用内置种子
    }
  }
  // 2. 内置旧版演示任务（无依据 → 待复核；旧依据 → 由首次对账判失效）
  for (const seed of legacySeeds) {
    const task = asLegacyTask(seed)
    absorb(task.basis ? task : migrateLegacyTask(task))
  }

  const state: ServerState = { tasks: [...migrated.values()], bootstrapped: true }
  persist(state)
  return state
}

let state: ServerState = bootstrap()

function save(task?: ExportTask) {
  if (task) task.updatedAt = formatStamp(now())
  persist(state)
}

function findTask(id: string): ExportTask {
  const task = state.tasks.find((item) => item.id === id)
  if (!task) throw new ApiError(404, 'NOT_FOUND', `导出任务 ${id} 不存在`)
  return task
}

/** 过期租约清理：租约丢失后，任务回到已中断，只能从最后完整分片续跑 */
function expireLeases() {
  const time = now()
  let touched = false
  for (const task of state.tasks) {
    if (task.lease && task.lease.expiresAt <= time) {
      task.lease = undefined
      if (task.status === '生成中') {
        task.status = '已中断'
        task.reviewReason = `租约已于 ${formatStamp(time)} 到期，等待从最后完整分片续跑`
      }
      touched = true
    }
  }
  if (touched) persist(state)
}

function assertHolder(task: ExportTask, station: string, token: string) {
  if (!task.lease || task.lease.station !== station || task.lease.token !== token) {
    throw new ApiError(409, 'LEASE_LOST', '租约已失效或由其他工位持有，进度写入被拒绝')
  }
}

function renew(task: ExportTask) {
  if (task.lease) task.lease.expiresAt = now() + LEASE_TTL_MS
}

// ---------- 业务操作 ----------

function createTask(body: { name: string; basisInput: BasisInput }): ExportTask {
  const basis = captureBasis({ ...body.basisInput, createdAt: new Date(now()).toISOString() })
  const task: ExportTask = {
    id: `EXP-${Date.now().toString().slice(-6)}`,
    name: body.name,
    status: '排队中',
    progress: 0,
    updatedAt: formatStamp(now()),
    resumable: true,
    basis,
    basisDigest: digestBasis(basis),
    shards: planShards(body.basisInput.pages.length).map((shard) => ({ ...shard, state: '待生成' })),
  }
  state.tasks.unshift(task)
  save(task)
  return task
}

/**
 * 领取任务（排队中 / 已中断 / 依据失效后的重新领取都走这里）。
 * 租约已被其他工位持有时返回 409：同一任务同一时刻只允许一个工位执行。
 */
function claim(body: { id: string; station: string }): { task: ExportTask; lease?: ExportTask['lease']; reason?: string } {
  expireLeases()
  const task = findTask(body.id)
  if (task.status === '已完成') throw new ApiError(409, 'ALREADY_DONE', '任务已完成，无需领取')
  if (task.status === '待复核') throw new ApiError(409, 'NEEDS_REVIEW', '旧任务缺少依据，须先确认依据并复核分片')
  if (task.status === '依据失效') throw new ApiError(409, 'BASIS_STALE', '依据已变更，须先用新依据重试，旧分片不会复用')
  if (task.lease) {
    if (task.lease.station === body.station) {
      renew(task)
      save(task)
      return { task, lease: task.lease, reason: '续租成功（同一工位恢复）' }
    }
    throw new ApiError(409, 'LEASE_HELD', `任务正由工位 ${task.lease.station} 执行（租约至 ${formatStamp(task.lease.expiresAt)}）`)
  }
  task.lease = { station: body.station, token: `${task.id}-${now()}-${Math.random().toString(36).slice(2, 8)}`, expiresAt: now() + LEASE_TTL_MS }
  task.status = '生成中'
  task.reviewReason = undefined
  save(task)
  return { task, lease: task.lease }
}

/** 心跳续租：仅当前持有人可续 */
function heartbeat(body: { id: string; station: string; token: string }): ExportTask {
  expireLeases()
  const task = findTask(body.id)
  assertHolder(task, body.station, body.token)
  renew(task)
  persist(state)
  return task
}

/**
 * 进度写入：仅当前租约持有人可写。
 * 完成分片时强制比对依据摘要；依据已变则拒绝写入（分片应先经对账置失效）。
 */
function reportProgress(body: { id: string; station: string; token: string; shardId: string }): ExportTask {
  expireLeases()
  const task = findTask(body.id)
  assertHolder(task, body.station, body.token)
  const shard = task.shards.find((item) => item.id === body.shardId)
  if (!shard) throw new ApiError(404, 'SHARD_NOT_FOUND', `分片 ${body.shardId} 不存在`)
  if (shard.state === '已失效') throw new ApiError(409, 'SHARD_INVALID', `分片 ${body.shardId} 已因依据变更失效，请用新依据重试`)
  if (shard.state !== '已完成') {
    shard.state = '已完成'
    shard.basisDigest = task.basisDigest
    shard.finishedAt = formatStamp(now())
  }
  task.progress = shardProgress(task.shards)
  if (task.shards.every((item) => item.state === '已完成')) {
    task.status = '已完成'
    task.lease = undefined
  }
  renew(task)
  save(task)
  return task
}

/** 主动释放租约（工位正常退出 / 交班） */
function release(body: { id: string; station: string; token: string }): ExportTask {
  const task = findTask(body.id)
  if (task.lease) {
    if (task.lease.station !== body.station || task.lease.token !== body.token) {
      throw new ApiError(409, 'NOT_HOLDER', '只有当前租约持有工位可以释放')
    }
    task.lease = undefined
    if (task.status === '生成中') task.status = '已中断'
    save(task)
  }
  return task
}

/**
 * 用新依据重试：立即丢弃全部旧分片（包括已完成的），回到排队状态等待重新领取。
 */
function retry(body: { id: string; basisInput: BasisInput }): ExportTask {
  const task = findTask(body.id)
  const basis = captureBasis({ ...body.basisInput, createdAt: new Date(now()).toISOString() })
  task.basis = basis
  task.basisDigest = digestBasis(basis)
  task.shards = planShards(body.basisInput.pages.length).map((shard) => ({ ...shard, state: '待生成' }))
  task.status = '排队中'
  task.progress = 0
  task.resumable = true
  task.lease = undefined
  task.basisStale = false
  task.basisSuperseded = false
  task.staleChangedFields = undefined
  task.staleSince = undefined
  task.reviewReason = undefined
  save(task)
  return task
}

/**
 * 旧数据升级后的人工确认：为待复核任务补录当前依据。
 * 旧分片缺少依据，一律不沿用，从空分片重新生成（演示中保留行记录并标注原因）。
 */
function confirmBasis(body: { id: string; basisInput: BasisInput }): ExportTask {
  const task = findTask(body.id)
  if (task.status !== '待复核') throw new ApiError(409, 'NOT_REVIEW', '只有待复核任务需要确认依据')
  const basis = captureBasis({ ...body.basisInput, createdAt: new Date(now()).toISOString() })
  task.basis = basis
  task.basisDigest = digestBasis(basis)
  task.shards = planShards(body.basisInput.pages.length).map((shard) => ({ ...shard, state: '待生成' }))
  task.status = '排队中'
  task.progress = 0
  task.resumable = true
  task.legacy = false
  task.reviewReason = '依据已由人工补录，旧分片缺少依据未复用，等待重新生成'
  save(task)
  return task
}

export type { AffectedTask } from './exportModel'

/**
 * 依据对账：拼版版本或打样结论一变即调用。
 * - 在途（排队/生成/中断）任务：旧分片立即失效，任务转为「依据失效」并列进 affected；
 * - 已完成任务：交付件被新依据取代，标记 basisSuperseded 并列出，由用户决定是否重跑；
 * - 待复核任务（无依据）不参与比对。
 */
function reconcile(basisInput: BasisInput): { current: ExportBasis; affected: AffectedTask[] } {
  expireLeases()
  const current = captureBasis({ ...basisInput, createdAt: new Date(now()).toISOString() })
  const affected: AffectedTask[] = []
  for (const task of state.tasks) {
    if (!task.basis) continue
    const changed = diffBasis(task, current)
    if (!changed.imposition && !changed.proof) {
      task.basisStale = false
      task.basisSuperseded = false
      task.staleChangedFields = undefined
      continue
    }
    task.staleChangedFields = changed
    task.staleSince = task.staleSince ?? formatStamp(now())
    let invalidated = 0
    if (task.status === '已完成') {
      task.basisSuperseded = true
    } else {
      task.basisStale = true
      task.status = '依据失效'
      task.lease = undefined
      for (const shard of task.shards) {
        if (shard.state === '已完成') {
          shard.state = '已失效'
          shard.reason = '依据已变更（' + changed.reasons.join('；') + '）'
          invalidated += 1
        }
      }
      task.progress = shardProgress(task.shards)
    }
    affected.push({ id: task.id, name: task.name, status: task.status, changed, invalidatedShards: invalidated })
    save(task)
  }
  if (affected.length) persist(state)
  return { current, affected }
}

// 供 UI 与测试读取 / 重置服务端状态
export const exportServer = {
  getState: (): ServerState => {
    expireLeases()
    return state
  },
  reset(next?: ServerState) {
    state = next ?? bootstrap()
    if (!next) persist(state)
  },
  LEASE_TTL_MS,
}

// ---------- Axios 适配器（REST 形态的模拟通道） ----------

type Body = Record<string, unknown>

function parseBody(data: unknown): Body {
  if (typeof data === 'string') {
    try {
      return (JSON.parse(data) ?? {}) as Body
    } catch {
      return {}
    }
  }
  return (data ?? {}) as Body
}

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data: structuredClone(data), status: 200, statusText: 'OK', headers: {}, config }
}

function fail(config: InternalAxiosRequestConfig, error: unknown): AxiosResponse {
  if (error instanceof ApiError) {
    return { data: { code: error.code, message: error.message }, status: error.status, statusText: error.code, headers: {}, config }
  }
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  return { data: { code: 'INTERNAL', message }, status: 500, statusText: 'Internal Error', headers: {}, config }
}

export const exportAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => setTimeout(resolve, 120))
  const body = parseBody(config.data)
  try {
    const url = config.url ?? ''
    const method = (config.method ?? 'get').toLowerCase()

    if (url === '/api/print/export-tasks' && method === 'get') return ok(config, exportServer.getState().tasks)
    if (url === '/api/print/export-tasks' && method === 'post') return ok(config, createTask(body as never))

    const byAction = (action: string) => new RegExp(`^/api/print/export-tasks/([^/]+)/${action}$`).exec(url)
    let match: RegExpExecArray | null

    if ((match = byAction('claim')) && method === 'post') return ok(config, claim({ id: match[1], station: String(body.station) }))
    if ((match = byAction('heartbeat')) && method === 'post')
      return ok(config, heartbeat({ id: match[1], station: String(body.station), token: String(body.token) }))
    if ((match = byAction('progress')) && method === 'post')
      return ok(config, reportProgress({ id: match[1], station: String(body.station), token: String(body.token), shardId: String(body.shardId) }))
    if ((match = byAction('release')) && method === 'post')
      return ok(config, release({ id: match[1], station: String(body.station), token: String(body.token) }))
    if ((match = byAction('retry')) && method === 'post') return ok(config, retry({ id: match[1], basisInput: body.basisInput as BasisInput }))
    if ((match = byAction('confirm-basis')) && method === 'post')
      return ok(config, confirmBasis({ id: match[1], basisInput: body.basisInput as BasisInput }))

    if (url === '/api/print/export-reconcile' && method === 'post') return ok(config, reconcile(body.basisInput as BasisInput))

    return { data: { code: 'NOT_FOUND', message: `未知接口：${method} ${url}` }, status: 404, statusText: 'Not Found', headers: {}, config }
  } catch (error) {
    return fail(config, error)
  }
}
