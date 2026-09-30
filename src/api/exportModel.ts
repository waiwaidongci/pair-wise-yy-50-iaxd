// 导出领域模型：依据快照（版位 / 打样结论 / 输出清单）、摘要、分片与旧数据升级。
// 任务一旦发起即固化自身依据（basis），运行期只能通过重试（retry）整体切换到新依据。

export type TaskStatus = '排队中' | '生成中' | '已完成' | '已中断' | '依据失效' | '待复核'
export type ShardState = '待生成' | '已完成' | '已失效'
export type Decision = '待决定' | '通过' | '退回'

export type ManifestItem = {
  key: string
  label: string
  // 依据是否可判定（数量/内容来源于实时数据时为 false，快照时取当时的事实值）
  detail: string
}

/** 导出任务发起时固化的依据，运行期不可变 */
export type PositionSnapshot = { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }
export type PageSnapshot = { pageNo: number; bleed: number }
export type ProofSnapshot = { round: number; decision: Decision; deltaE: number }

export type ExportBasis = {
  revision: string
  // 版位（拼版）：含坐标、旋转、正反面，按位置 id 排序后摘要
  revisionLabel: string
  positionsDigest: string
  positions: PositionSnapshot[]
  pages: PageSnapshot[]
  // 打样结论：每一轮的决定 + ΔE，按轮次顺序固化
  proofDigest: string
  proofs: ProofSnapshot[]
  // 输出清单：发起时锁定，后续在拼版页增删条目不影响在途任务
  manifest: ManifestItem[]
  manifestDigest: string
  createdAt: string
}

export type AffectedTask = {
  id: string
  name: string
  status: TaskStatus
  changed: ChangedFields
  invalidatedShards: number
}

export type Shard = {
  id: string
  label: string
  state: ShardState
  // 完整分片：已完成且仍匹配任务依据；旧数据升级产生的无依据分片用 reused 标记
  basisDigest?: string
  reused?: boolean
  reason?: string
  finishedAt?: string
}

export type Lease = {
  station: string
  token: string
  expiresAt: number
}

export type ExportTask = {
  id: string
  name: string
  status: TaskStatus
  progress: number
  updatedAt: string
  resumable: boolean
  basis?: ExportBasis
  /** 整体依据摘要：分片完成时必须与之匹配，否则不允许写入 */
  basisDigest?: string
  shards: Shard[]
  lease?: Lease
  basisStale?: boolean
  /** 已完成任务被新依据取代时置位，任务本身仍可打开 */
  basisSuperseded?: boolean
  /** 旧数据升级：缺少发起依据 */
  legacy?: boolean
  reviewReason?: string
  staleChangedFields?: ChangedFields
  staleSince?: string
}

export type ChangedFields = {
  imposition: boolean
  proof: boolean
  /** 受影响依据维度的中文说明 */
  reasons: string[]
}

/** 捕获依据所需的实时数据（由 store 提供，避免与 store 产生类型循环） */
export type BasisInput = {
  revision: string
  positions: Array<{ id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }>
  pages: Array<{ pageNo: number; bleed: number }>
  proofs: Array<{ id: string; round: number; decision: Decision; deltaE: number }>
  validations: Array<{ severity: '错误' | '警告' }>
  locked: boolean
  createdAt: string
}

/** 稳定 JSON：键排序，去除格式化差异，使同一逻辑内容产生同一摘要 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

/** FNV-1a 32 位，用于派生稳定的内容摘要（演示用途的轻量哈希） */
export function hash32(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 发起时锁定的输出清单模板 */
export function buildManifest(input: BasisInput): ManifestItem[] {
  const errors = input.validations.filter((item) => item.severity === '错误').length
  return [
    { key: 'imposition-pdf', label: '拼版 PDF/X-4', detail: '待生成' },
    { key: 'preflight', label: '预检报告 JSON', detail: `${input.validations.length} 项（错误 ${errors}）` },
    { key: 'color-bar', label: '色彩控制条报告', detail: '已包含' },
    { key: 'proof-approval', label: '打样审批记录', detail: `${input.proofs.length} 轮 · ${input.proofs.filter((p) => p.decision === '通过').length} 轮通过` },
    { key: 'paper-spec', label: '纸张与折手规格', detail: '已包含' },
  ]
}

/** 在导出任务发起瞬间固化版位、打样结论与输出清单 */
export function captureBasis(input: BasisInput): ExportBasis {
  const positions = input.positions
    .map((p) => ({ id: p.id, pageNo: p.pageNo, x: p.x, y: p.y, rotation: p.rotation, front: p.front }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const proofs = input.proofs
    .map((p) => ({ round: p.round, decision: p.decision, deltaE: p.deltaE }))
    .sort((a, b) => a.round - b.round)
  const pages = input.pages
    .map((p) => ({ pageNo: p.pageNo, bleed: p.bleed }))
    .sort((a, b) => a.pageNo - b.pageNo)
  const manifest = buildManifest(input)
  return {
    revision: input.revision,
    revisionLabel: `${input.revision}${input.locked ? '（已锁定）' : '（草稿）'}`,
    positionsDigest: hash32(stableStringify({ positions, pages })),
    positions,
    pages,
    proofDigest: hash32(stableStringify(proofs)),
    proofs,
    manifest,
    manifestDigest: hash32(stableStringify(manifest)),
    createdAt: input.createdAt,
  }
}

/** 任务级依据摘要：任一分片完成时都必须与之匹配 */
export function digestBasis(basis: ExportBasis): string {
  return hash32(stableStringify({ p: basis.positionsDigest, f: basis.proofDigest, m: basis.manifestDigest }))
}

/** 比对当前依据与任务依据；输出清单为任务私有快照，不参与对账 */
export function diffBasis(task: ExportTask, current: ExportBasis): ChangedFields {
  if (!task.basis) return { imposition: false, proof: false, reasons: [] }
  const imposition = current.positionsDigest !== task.basis.positionsDigest || current.revision !== task.basis.revision
  const proof = current.proofDigest !== task.basis.proofDigest
  const reasons: string[] = []
  if (imposition) reasons.push(`拼版版本 ${task.basis.revision} → ${current.revision}（版位已变）`)
  if (proof) reasons.push(`打样结论已更新（${current.revision} 时刻）`)
  return { imposition, proof, reasons }
}

/** 分片规划：每 2 页一组（演示用固定小分片，便于观察断点续跑） */
export function planShards(pageCount: number): Array<{ id: string; label: string }> {
  const size = 2
  const total = Math.max(1, Math.ceil(pageCount / size))
  return Array.from({ length: total }, (_, index) => {
    const start = index * size + 1
    const end = Math.min(start + size - 1, pageCount)
    return { id: `S${index + 1}`, label: `分片 ${index + 1} · P${start}–P${end}` }
  })
}

export function shardProgress(shards: Shard[]): number {
  if (shards.length === 0) return 0
  const done = shards.filter((s) => s.state === '已完成').length
  return Math.round((done / shards.length) * 100)
}

/**
 * 旧数据升级：v1 任务没有依据快照。
 * - 未完成任务：保留进度但转为「待复核」，已完成分片因缺少依据留待复核；
 * - 已完成任务：同样缺少交付依据，留作待复核，确认后才能作为正式交付。
 */
export function migrateLegacyTask(task: ExportTask, basis?: ExportBasis): ExportTask {
  const upgraded: ExportTask = {
    ...task,
    status: '待复核',
    resumable: false,
    legacy: true,
    reviewReason: '旧版任务缺少发起依据（版位 / 打样结论 / 输出清单），已完成分片无法校验。',
    shards: task.shards.map((shard) =>
      shard.state === '已完成'
        ? { ...shard, state: '已失效', basisDigest: undefined, reused: false, reason: '旧分片缺少依据摘要，等待人工确认' }
        : shard,
    ),
  }
  if (basis) {
    upgraded.basis = basis
    upgraded.basisDigest = digestBasis(basis)
  }
  return upgraded
}

export function formatStamp(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
