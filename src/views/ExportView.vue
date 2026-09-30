<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import Message from 'primevue/message'
import { useImpositionStore, type ExportTask } from '../stores/imposition'
import { exportApi } from '../api/exportApi'

const store = useImpositionStore()
const queryClient = useQueryClient()
const { data: tasks, isPending } = useQuery({
  queryKey: ['export-tasks'],
  queryFn: async () => (await exportApi.list()).data,
  initialData: store.tasks,
})

const busy = ref<string | null>(null)
const errorMsg = ref<string | null>(null)

function invalidate() {
  return queryClient.invalidateQueries({ queryKey: ['export-tasks'] })
}

async function runAction(id: string, action: () => Promise<unknown>) {
  busy.value = id
  errorMsg.value = null
  try {
    await action()
    await invalidate()
  } catch (e) {
    const err = e as { response?: { data?: { error?: string; holder?: string } } }
    errorMsg.value = err.response?.data?.error ?? '操作失败'
  } finally {
    busy.value = null
  }
}

function claimTask(id: string) {
  return runAction(id, () => store.claimTask(id))
}
function resumeTask(id: string) {
  return runAction(id, () => store.resumeTask(id))
}
function releaseTask(id: string) {
  return runAction(id, () => store.releaseTask(id))
}
function retryTask(id: string) {
  return runAction(id, () => store.retryTask(id))
}
function reviewTask(id: string) {
  return runAction(id, () => store.reviewTask(id))
}

function statusSeverity(status?: string) {
  return status === '已完成' ? 'success' : status === '已中断' ? 'danger' : status === '生成中' ? 'warn' : status === '待复核' ? 'danger' : 'info'
}

function leaseRemaining(task: ExportTask): string {
  if (!task.lease) return ''
  const ms = new Date(task.lease.expiresAt).getTime() - Date.now()
  if (ms <= 0) return '已过期'
  const sec = Math.ceil(ms / 1000)
  return `${sec}s`
}

function isLeaseValid(task: ExportTask): boolean {
  if (!task.lease) return false
  return new Date(task.lease.expiresAt).getTime() > Date.now()
}

function isMyLease(task: ExportTask): boolean {
  return task.lease?.holderId === store.stationId && isLeaseValid(task)
}

function shardStatusIcon(status: string): string {
  if (status === '已完成') return 'pi pi-check-circle'
  if (status === '生成中') return 'pi pi-spin pi-spinner'
  if (status === '已失效') return 'pi pi-times-circle'
  return 'pi pi-circle'
}

function shardStatusColor(status: string): string {
  if (status === '已完成') return '#3b8a67'
  if (status === '生成中') return '#c4872f'
  if (status === '已失效') return '#bb4c35'
  return '#b0bec5'
}

const affectedTasks = computed(() => (tasks.value ?? []).filter((t) => store.affectedTaskIds.includes(t.id)))
const pendingReviewTasks = computed(() => (tasks.value ?? []).filter((t) => t.reviewStatus === 'pending_review'))
const activeLeaseTasks = computed(() => (tasks.value ?? []).filter((t) => isMyLease(t)))

// 全局轮询：推进租约任务进度 + 续约 + 刷新租约倒计时
let tickTimer: ReturnType<typeof setInterval> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  // 每 3 秒推进一次进度
  tickTimer = setInterval(async () => {
    for (const task of activeLeaseTasks.value) {
      await store.tickTask(task.id)
    }
    await invalidate()
  }, 3000)

  // 每秒刷新租约倒计时
  refreshTimer = setInterval(() => {
    // 触发响应式更新
    tasks.value = [...(tasks.value ?? [])]
  }, 1000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  if (refreshTimer) clearInterval(refreshTimer)
})

const outputCount = computed(() => store.currentBasis.outputManifest.filter((o) => o.included).length)
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">EXPORT JOBS / 导出任务</p>
        <h1>交付包与断点恢复</h1>
        <p class="muted">任务发起时固定版位、打样结论和输出清单；租约独占执行，丢失后从最后完整分片续跑。</p>
      </div>
      <Button label="新建印刷交付包" icon="pi pi-plus" @click="store.createExportTask('印刷交付包 · PDF/X-4')" />
    </div>

    <!-- 工位切换 -->
    <div class="station-bar panel">
      <div class="station-label"><i class="pi pi-id-card" /><span>当前工位</span></div>
      <div class="station-switch">
        <button
          v-for="s in store.stations"
          :key="s.id"
          :class="{ active: s.id === store.stationId }"
          @click="store.stationId = s.id"
        >
          <i class="pi pi-desktop" />{{ s.name }}
        </button>
      </div>
      <div class="station-hint">两个工位同时续跑同一任务时，仅一个工位可获得有时限的执行租约。</div>
    </div>

    <Message v-if="errorMsg" severity="error" :closable="true" class="mb-3" @close="errorMsg = null">
      {{ errorMsg }}
    </Message>

    <!-- 受影响任务 -->
    <Message v-if="affectedTasks.length" severity="warn" :closable="false" class="mb-3">
      <template #default>
        <strong>依据已变更，{{ affectedTasks.length }} 个排队中的包受影响：</strong>
        版位或打样结论已更新，旧分片立即失效。请用新依据重试。
        <div class="affected-list">
          <span v-for="t in affectedTasks" :key="t.id" class="affected-chip">
            {{ t.id }} · {{ t.name }}
            <Button label="重试" icon="pi pi-refresh" size="small" text @click="retryTask(t.id)" />
          </span>
        </div>
      </template>
    </Message>

    <!-- 待复核任务 -->
    <Message v-if="pendingReviewTasks.length" severity="error" :closable="false" class="mb-3">
      <template #default>
        <strong>{{ pendingReviewTasks.length }} 个旧任务缺少依据，留作待复核：</strong>
        升级前的导出任务未固定版位与打样结论，需补充依据后才能继续。
        <div class="affected-list">
          <span v-for="t in pendingReviewTasks" :key="t.id" class="affected-chip">
            {{ t.id }} · {{ t.name }}
            <Button label="补充依据并复核" icon="pi pi-check" size="small" text @click="reviewTask(t.id)" />
          </span>
        </div>
      </template>
    </Message>

    <div class="export-grid">
      <section class="panel">
        <div class="panel-head"><h3>导出队列</h3><span class="muted">Axios 模拟 REST</span></div>
        <div v-if="isPending" class="loading">正在加载导出任务…</div>
        <div v-else class="task-list">
          <article v-for="task in (tasks ?? store.tasks)" :key="task.id" :class="{ 'lease-mine': isMyLease(task) }">
            <div class="task-head">
              <div>
                <strong>{{ task.name }}</strong>
                <small>{{ task.id }} · {{ task.updatedAt }}</small>
              </div>
              <Tag :value="task.status" :severity="statusSeverity(task.status)" />
            </div>

            <!-- 依据快照 -->
            <div v-if="task.basis" class="basis-snapshot">
              <div class="basis-title"><i class="pi pi-bookmark" />发起依据</div>
              <div class="basis-grid">
                <span><i class="pi pi-copy" />版本 {{ task.basis.revision }}</span>
                <span><i class="pi pi-image" />打样第 {{ task.basis.proofRound }} 轮 · {{ task.basis.proofDecision }}</span>
                <span><i class="pi pi-list" />输出清单 {{ task.basis.outputManifest.filter((o) => o.included).length }} 项</span>
                <span><i class="pi pi-hashtag" />{{ task.basis.basisHash }}</span>
              </div>
            </div>
            <div v-else class="basis-snapshot basis-empty">
              <i class="pi pi-exclamation-triangle" />未固定依据 · 待复核
            </div>

            <!-- 租约状态 -->
            <div class="lease-row">
              <template v-if="isMyLease(task)">
                <span class="lease-badge mine"><i class="pi pi-lock" />{{ task.lease?.holderName }} 持有中 · 剩余 {{ leaseRemaining(task) }}</span>
              </template>
              <template v-else-if="task.lease && isLeaseValid(task)">
                <span class="lease-badge other"><i class="pi pi-lock" />{{ task.lease.holderName }} 持有中 · 剩余 {{ leaseRemaining(task) }}</span>
              </template>
              <template v-else>
                <span class="lease-badge none"><i class="pi pi-lock-open" />无租约</span>
              </template>
            </div>

            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '8px' }" />

            <!-- 分片进度 -->
            <div v-if="task.shards.length" class="shard-list">
              <div v-for="shard in task.shards" :key="shard.id" class="shard-item" :class="shard.status">
                <i :class="shardStatusIcon(shard.status)" :style="{ color: shardStatusColor(shard.status) }" />
                <span>{{ shard.label }}</span>
                <Tag :value="shard.status" :severity="shard.status === '已完成' ? 'success' : shard.status === '生成中' ? 'warn' : shard.status === '已失效' ? 'danger' : 'info'" />
              </div>
            </div>

            <div class="task-foot">
              <span>{{ task.progress }}% · {{ task.progress === 100 ? '文件哈希已校验' : task.shards.some((s) => s.status === '已失效') ? '依据已变更，需重试' : '保留已完成分片' }}</span>
              <div class="task-actions">
                <!-- 待复核 -->
                <Button v-if="task.reviewStatus === 'pending_review'" label="补充依据并复核" icon="pi pi-check" size="small" :loading="busy === task.id" @click="reviewTask(task.id)" />
                <!-- 已完成 -->
                <Button v-else-if="task.status === '已完成'" label="打开结果" icon="pi pi-external-link" size="small" text />
                <!-- 我的租约中 -->
                <template v-else-if="isMyLease(task)">
                  <Button label="释放租约" icon="pi pi-stop" size="small" severity="secondary" outlined :loading="busy === task.id" @click="releaseTask(task.id)" />
                </template>
                <!-- 他人租约中 -->
                <template v-else-if="task.lease && isLeaseValid(task)">
                  <Button label="租约被占用" icon="pi pi-lock" size="small" severity="secondary" disabled />
                </template>
                <!-- 可领取/续跑 -->
                <template v-else>
                  <Button v-if="task.shards.some((s) => s.status === '已失效')" label="重试" icon="pi pi-refresh" size="small" :loading="busy === task.id" @click="retryTask(task.id)" />
                  <Button v-else label="领取并续跑" icon="pi pi-play" size="small" :loading="busy === task.id" @click="resumeTask(task.id)" />
                </template>
              </div>
            </div>
          </article>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>交付包内容</h3><Tag :value="store.currentBasis.revision" /></div>
          <div class="package-list">
            <div v-for="item in store.currentBasis.outputManifest" :key="item.key">
              <i :class="item.included ? 'pi pi-check-circle' : 'pi pi-circle'" />
              <span>{{ item.label }}</span>
              <strong>{{ item.included ? item.format : '未包含' }}</strong>
            </div>
          </div>
        </section>
        <section class="panel recovery">
          <div class="panel-head"><h3>恢复说明</h3></div>
          <p>任务发起时固定版位、打样结论和输出清单。分片按页组写入，租约丢失后从最后完整分片续跑。依据一变，旧分片立即失效，需用新依据重试。</p>
          <Button label="清理已完成任务" severity="secondary" outlined fluid />
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.export-grid { display: grid; grid-template-columns: minmax(0,1fr) 330px; gap: 14px; align-items: start; }
.loading { padding: 30px; color: #75838a; text-align: center; }
.mb-3 { margin-bottom: 12px; }
.station-bar { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; padding: 12px 16px; }
.station-label { display: flex; align-items: center; gap: 6px; color: #5d7077; font-size: 12px; font-weight: 700; }
.station-label i { color: #c4872f; }
.station-switch { display: flex; gap: 6px; }
.station-switch button { display: flex; align-items: center; gap: 6px; padding: 7px 14px; border: 1px solid #cbd5d7; border-radius: 6px; background: white; color: #5d7077; font-size: 12px; cursor: pointer; }
.station-switch button.active { border-color: #337b79; background: #eaf4f3; color: #2c6b69; font-weight: 700; }
.station-hint { margin-left: auto; color: #8a979c; font-size: 10px; }
.affected-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.affected-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; background: rgba(255,255,255,.7); font-size: 11px; }
.task-list { padding: 8px 16px 16px; }
.task-list article { padding: 15px 0; border-bottom: 1px solid #e9eeee; }
.task-list article.lease-mine { padding-left: 10px; border-left: 3px solid #337b79; }
.task-head, .task-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-head { margin-bottom: 11px; }
.task-head strong, .task-head small { display: block; }
.task-head small { margin-top: 4px; color: #7c898f; font-size: 10px; }
.basis-snapshot { margin-bottom: 10px; padding: 9px 12px; border: 1px solid #e3eceb; border-radius: 7px; background: #f6faf9; }
.basis-snapshot.basis-empty { display: flex; align-items: center; gap: 6px; color: #b84e35; font-size: 11px; background: #fdf3ef; border-color: #f0d5cc; }
.basis-title { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; color: #5d7077; font-size: 10px; font-weight: 700; }
.basis-title i { color: #c4872f; }
.basis-grid { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.basis-grid span { display: inline-flex; align-items: center; gap: 4px; color: #4a5d63; font-size: 10px; }
.basis-grid i { color: #8a979c; }
.lease-row { margin-bottom: 8px; }
.lease-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 5px; font-size: 10px; font-weight: 600; }
.lease-badge.mine { background: #e3f2ee; color: #2c6b69; }
.lease-badge.other { background: #fdf3ef; color: #b84e35; }
.lease-badge.none { background: #eef1f1; color: #7c898f; }
.shard-list { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; margin-top: 9px; }
.shard-item { display: flex; align-items: center; gap: 6px; font-size: 10px; color: #5d7077; }
.shard-item span { flex: 1; }
.shard-item .p-tag { font-size: 9px; padding: 1px 6px; }
.task-foot { margin-top: 9px; }
.task-foot > span { color: #68777e; font-size: 10px; }
.task-actions { display: flex; gap: 6px; }
aside { display: grid; gap: 14px; }
.package-list { padding: 8px 16px 16px; }
.package-list div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid #edf1f1; font-size: 11px; }
.package-list i { color: #397d64; }
.package-list strong { color: #536b72; font-size: 10px; }
.recovery p { padding: 0 16px; color: #67767d; font-size: 11px; line-height: 1.6; }
.recovery :deep(.p-button) { width: calc(100% - 32px); margin: 0 16px 16px; }
@media (max-width: 1000px) { .export-grid { grid-template-columns: 1fr; } }
</style>
