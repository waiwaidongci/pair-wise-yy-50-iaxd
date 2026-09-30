import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { exportApi } from '../api/exportApi'

export type Page = { pageNo: number; name: string; width: number; height: number; bleed: number; content: string }
export type Position = { id: string; pageNo: number; x: number; y: number; rotation: number; front: boolean }
export type Validation = { id: string; severity: '错误' | '警告'; pageNo?: number; title: string; detail: string }
export type Proof = { id: string; round: number; date: string; sample: string; deltaE: number; feedback: string; correction: string; owner: string; decision: '待决定' | '通过' | '退回' }

// 输出清单项 — 任务发起时固定的交付内容
export type OutputItem = { key: string; label: string; format: string; included: boolean }

// 依据快照 — 导出任务发起时固定的版位、打样结论和输出清单
export type BasisSnapshot = {
  revision: string
  positions: Position[]
  proofRound: number
  proofDecision: string
  outputManifest: OutputItem[]
  capturedAt: string
  basisHash: string
}

// 执行租约 — 有时限的独占执行权
export type Lease = {
  holderId: string
  holderName: string
  acquiredAt: string
  expiresAt: string
}

// 分片 — 可独立完成、可续跑的导出片段
export type Shard = {
  id: string
  index: number
  label: string
  status: '待生成' | '生成中' | '已完成' | '已失效'
  completedAt?: string
}

export type ExportTask = {
  id: string
  name: string
  progress: number
  status: '排队中' | '生成中' | '已完成' | '已中断' | '待复核'
  updatedAt: string
  resumable: boolean
  basis: BasisSnapshot | null
  reviewStatus: 'ok' | 'pending_review'
  lease: Lease | null
  shards: Shard[]
}

export const sheetSpec = {
  width: 720,
  height: 1020,
  bleed: 3,
  safe: 5,
  gutter: 6,
  binding: '骑马订',
  grain: '纵向',
}

export const defaultOutputManifest: OutputItem[] = [
  { key: 'pdf', label: '拼版 PDF/X-4', format: 'PDF/X-4', included: true },
  { key: 'precheck', label: '预检报告 JSON', format: 'JSON', included: true },
  { key: 'colorbar', label: '色彩控制条报告', format: 'PDF', included: true },
  { key: 'proofs', label: '打样审批记录', format: 'PDF', included: true },
  { key: 'specs', label: '纸张与折手规格', format: 'JSON', included: true },
]

export function computeBasisHash(data: unknown): string {
  const str = JSON.stringify(data)
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return `BASIS-${Math.abs(hash).toString(16).padStart(8, '0').toUpperCase()}`
}

// 旧数据升级 — 缺少依据的任务留作待复核
function migrateTask(task: Partial<ExportTask>): ExportTask {
  const hasBasis = task.basis != null
  return {
    id: task.id ?? '',
    name: task.name ?? '未命名任务',
    progress: task.progress ?? 0,
    status: task.status ?? (hasBasis ? '排队中' : '待复核'),
    updatedAt: task.updatedAt ?? '刚刚',
    resumable: task.resumable ?? false,
    basis: task.basis ?? null,
    reviewStatus: task.reviewStatus ?? (hasBasis ? 'ok' : 'pending_review'),
    lease: task.lease ?? null,
    shards: task.shards ?? [],
  }
}

const seedPages: Page[] = [
  { pageNo: 1, name: '封面', width: 210, height: 297, bleed: 3, content: '潮汐来信 / 节目册' },
  { pageNo: 2, name: '版权页', width: 210, height: 297, bleed: 2, content: '版权与演职人员' },
  { pageNo: 3, name: '序言', width: 210, height: 297, bleed: 3, content: '导演手记' },
  { pageNo: 4, name: '剧照跨页左', width: 210, height: 297, bleed: 3, content: '第一幕剧照' },
  { pageNo: 5, name: '剧照跨页右', width: 210, height: 297, bleed: 3, content: '第一幕剧照延伸' },
  { pageNo: 6, name: '曲目表', width: 210, height: 297, bleed: 3, content: '曲目与时长' },
  { pageNo: 7, name: '创作团队', width: 210, height: 297, bleed: 1, content: '主创与制作团队' },
  { pageNo: 8, name: '封底', width: 210, height: 297, bleed: 3, content: '巡演信息' },
]

const seedPositions: Position[] = [
  { id: 'P-01', pageNo: 8, x: 34, y: 44, rotation: 0, front: true },
  { id: 'P-02', pageNo: 1, x: 372, y: 44, rotation: 180, front: true },
  { id: 'P-03', pageNo: 6, x: 34, y: 548, rotation: 180, front: true },
  { id: 'P-04', pageNo: 3, x: 372, y: 548, rotation: 0, front: true },
  { id: 'P-05', pageNo: 2, x: 34, y: 44, rotation: 0, front: false },
  { id: 'P-06', pageNo: 7, x: 372, y: 44, rotation: 180, front: false },
  { id: 'P-07', pageNo: 4, x: 34, y: 548, rotation: 0, front: false },
  { id: 'P-08', pageNo: 5, x: 372, y: 548, rotation: 180, front: false },
]

const seedProofs: Proof[] = [
  { id: 'PRF-01', round: 1, date: '2026-09-18', sample: '数字样张 v1', deltaE: 3.8, feedback: '封面夜空蓝偏紫，剧照暗部层次压缩。', correction: '调整 CMYK 曲线，黑色通道减少 4%。', owner: '周默 / 色彩管理', decision: '退回' },
  { id: 'PRF-02', round: 2, date: '2026-09-25', sample: '数字样张 v2', deltaE: 1.9, feedback: '整体色差改善，P7 出血仍不足。', correction: '重排 P7 版位并增加 2mm 出血。', owner: '林青 / 拼版', decision: '待决定' },
]

export const useImpositionStore = defineStore('imposition', () => {
  const saved = localStorage.getItem('print-imposition-v1')
  const restored = saved ? JSON.parse(saved) : null
  const pages = ref<Page[]>(restored?.pages ?? structuredClone(seedPages))
  const positions = ref<Position[]>(restored?.positions ?? structuredClone(seedPositions))
  const proofs = ref<Proof[]>(restored?.proofs ?? structuredClone(seedProofs))
  const tasks = ref<ExportTask[]>((restored?.tasks ?? []).map(migrateTask))
  const side = ref<'front' | 'back'>('front')
  const zoom = ref(72)
  const revision = ref(restored?.revision ?? 'R6')
  const locked = ref(restored?.locked ?? false)
  const selectedPosition = ref<string | null>(null)
  const selectedProof = ref('PRF-02')

  // 工位与依据状态
  const stationId = ref(restored?.stationId ?? 'ST-A')
  const stations = ref([
    { id: 'ST-A', name: '工位 A' },
    { id: 'ST-B', name: '工位 B' },
  ])
  const outputManifest = ref<OutputItem[]>(restored?.outputManifest ?? structuredClone(defaultOutputManifest))
  const affectedTaskIds = ref<string[]>([])

  const validations = computed<Validation[]>(() => {
    const issues: Validation[] = []
    const placedPages = positions.value.map((position) => position.pageNo)
    pages.value.forEach((page) => {
      if (!placedPages.includes(page.pageNo)) issues.push({ id: `missing-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 尚未拼版`, detail: `${page.name} 未出现在正反版位中。` })
      if (page.bleed < sheetSpec.bleed) issues.push({ id: `bleed-${page.pageNo}`, severity: '错误', pageNo: page.pageNo, title: `P${page.pageNo} 出血不足`, detail: `页面出血 ${page.bleed}mm，低于印刷要求 ${sheetSpec.bleed}mm。` })
    })
    for (let index = 0; index < positions.value.length; index += 1) {
      for (let next = index + 1; next < positions.value.length; next += 1) {
        const a = positions.value[index]
        const b = positions.value[next]
        if (a.front === b.front && Math.abs(a.x - b.x) < 320 && Math.abs(a.y - b.y) < 430) {
          issues.push({ id: `overlap-${a.id}-${b.id}`, severity: '错误', pageNo: a.pageNo, title: `${a.id} 与 ${b.id} 版位重叠`, detail: '当前纸张尺寸下页面之间不足安全间隙。' })
        }
      }
    }
    const frontOrder = positions.value.filter((item) => item.front).sort((a, b) => a.x - b.x || a.y - b.y).map((item) => item.pageNo)
    if (frontOrder[0] !== 1) issues.push({ id: 'binding-order', severity: '警告', pageNo: 1, title: '骑马订正版页序需要复核', detail: `当前首位为 P${frontOrder[0]}，装订方向规则期望封面位于首版位。` })
    return issues
  })

  watch([pages, positions, proofs, tasks, revision, locked, stationId, outputManifest], () => {
    localStorage.setItem('print-imposition-v1', JSON.stringify({
      pages: pages.value,
      positions: positions.value,
      proofs: proofs.value,
      tasks: tasks.value,
      revision: revision.value,
      locked: locked.value,
      stationId: stationId.value,
      outputManifest: outputManifest.value,
    }))
  }, { deep: true })

  // 当前工位
  const currentStation = computed(() => stations.value.find((s) => s.id === stationId.value) ?? stations.value[0])

  // 当前依据 — 任务发起时固定的版位、打样结论和输出清单
  const currentBasis = computed<BasisSnapshot>(() => {
    const proofDecision = proofs.value.find((p) => p.decision !== '待决定')?.decision ?? '待决定'
    const proofRound = proofs.value.length
    const basisHash = computeBasisHash({
      revision: revision.value,
      positions: positions.value,
      proofDecision,
      proofRound,
      outputManifest: outputManifest.value.filter((o) => o.included),
    })
    return {
      revision: revision.value,
      positions: structuredClone(positions.value),
      proofRound,
      proofDecision,
      outputManifest: structuredClone(outputManifest.value),
      capturedAt: new Date().toISOString(),
      basisHash,
    }
  })

  function buildBasisSnapshot(): BasisSnapshot {
    return structuredClone(currentBasis.value)
  }

  // 从 API 刷新任务列表
  async function refreshTasks() {
    try {
      const response = await exportApi.list()
      tasks.value = response.data.map(migrateTask)
    } catch {
      // 离线时保留本地状态
    }
  }

  // 创建导出任务 — 发起时固定依据
  async function createExportTask(name: string) {
    const basis = buildBasisSnapshot()
    const response = await exportApi.create(name, basis)
    tasks.value.push(response.data)
    return response.data
  }

  // 依据变更 — 旧分片立即失效，列出受影响任务
  async function reportBasisChange() {
    const basis = buildBasisSnapshot()
    const response = await exportApi.reportBasisChanged(basis)
    affectedTaskIds.value = response.data.map((t) => t.id)
    await refreshTasks()
  }

  // 复核旧任务 — 补充依据后可继续
  async function reviewTask(id: string) {
    const basis = buildBasisSnapshot()
    const response = await exportApi.review(id, basis)
    const idx = tasks.value.findIndex((t) => t.id === id)
    if (idx >= 0) tasks.value[idx] = response.data
    return response.data
  }

  // 重试受影响任务 — 用新依据重新生成
  async function retryTask(id: string) {
    const basis = buildBasisSnapshot()
    const response = await exportApi.retry(id, currentStation.value, basis)
    const idx = tasks.value.findIndex((t) => t.id === id)
    if (idx >= 0) tasks.value[idx] = response.data
    affectedTaskIds.value = affectedTaskIds.value.filter((tid) => tid !== id)
    return response.data
  }

  // 领取租约
  async function claimTask(id: string) {
    const response = await exportApi.claim(id, currentStation.value)
    const idx = tasks.value.findIndex((t) => t.id === id)
    if (idx >= 0) tasks.value[idx] = response.data
    return response.data
  }

  // 续跑任务 — 领取租约并从最后完整分片继续
  async function resumeTask(id: string) {
    const response = await exportApi.resume(id, currentStation.value)
    const idx = tasks.value.findIndex((t) => t.id === id)
    if (idx >= 0) tasks.value[idx] = response.data
    return response.data
  }

  // 心跳续约
  async function heartbeatTask(id: string) {
    const response = await exportApi.heartbeat(id, currentStation.value.id)
    const idx = tasks.value.findIndex((t) => t.id === id)
    if (idx >= 0) tasks.value[idx] = response.data
    return response.data
  }

  // 释放租约
  async function releaseTask(id: string) {
    const response = await exportApi.release(id, currentStation.value.id)
    const idx = tasks.value.findIndex((t) => t.id === id)
    if (idx >= 0) tasks.value[idx] = response.data
    return response.data
  }

  // 推进分片进度 — 仅租约持有人可写
  async function tickTask(id: string) {
    const response = await exportApi.tick(id, currentStation.value.id)
    if (response.data) {
      const idx = tasks.value.findIndex((t) => t.id === id)
      if (idx >= 0) tasks.value[idx] = response.data
    }
    return response.data
  }

  function updatePosition(id: string, patch: Partial<Position>) {
    if (locked.value) return
    const position = positions.value.find((item) => item.id === id)
    if (position) Object.assign(position, patch)
  }

  function addPosition(pageNo: number) {
    if (locked.value || positions.value.some((item) => item.pageNo === pageNo && item.front === (side.value === 'front'))) return
    positions.value.push({ id: `P-${Date.now().toString().slice(-3)}`, pageNo, x: 34, y: 44, rotation: 0, front: side.value === 'front' })
  }

  function updateProof(id: string, patch: Partial<Proof>) {
    const proof = proofs.value.find((item) => item.id === id)
    if (proof) Object.assign(proof, patch)
  }

  function createProof() {
    proofs.value.push({ id: `PRF-${String(proofs.value.length + 1).padStart(2, '0')}`, round: proofs.value.length + 1, date: new Date().toISOString().slice(0, 10), sample: `数字样张 v${proofs.value.length + 1}`, deltaE: 0, feedback: '', correction: '', owner: '当前用户', decision: '待决定' })
  }

  function lockBaseline() {
    locked.value = true
    revision.value = `R${Number(revision.value.slice(1)) + 1}`
  }

  function unlock() {
    locked.value = false
  }

  // 依据变更监听 — 版位、打样结论或输出清单一变，旧分片立即失效
  watch([positions, proofs, revision, outputManifest], () => {
    reportBasisChange()
  }, { deep: true })

  // 启动时从 API 同步任务
  refreshTasks()

  return {
    pages, positions, proofs, tasks, side, zoom, revision, locked, selectedPosition, selectedProof,
    stationId, stations, outputManifest, affectedTaskIds, currentStation, currentBasis,
    validations,
    buildBasisSnapshot, refreshTasks, createExportTask, reportBasisChange,
    reviewTask, retryTask, claimTask, resumeTask, heartbeatTask, releaseTask, tickTask,
    updatePosition, addPosition, updateProof, createProof, lockBaseline, unlock,
  }
})
