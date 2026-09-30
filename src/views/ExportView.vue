<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import Tag from 'primevue/tag'
import Select from 'primevue/select'
import { useImpositionStore } from '../stores/imposition'
import { useExportTasks, useReconcileState } from '../composables/useExportTasks'
import { useExportRunner } from '../composables/useExportRunner'
import { useWorkstation } from '../composables/useWorkstation'
import { LEASE_TTL_MS } from '../api/exportServer'
import type { ExportTask } from '../api/exportModel'

const store = useImpositionStore()
const { tasks } = useExportTasks()
const { affected, lastCheckedAt } = useReconcileState()
const { setStation, WORKSTATIONS } = useWorkstation()
const runner = useExportRunner()
const stationOptions = WORKSTATIONS.map((value) => ({ label: value, value }))

// 每秒刷新租约倒计时显示
const nowTick = ref(Date.now())
const clockTimer = setInterval(() => (nowTick.value = Date.now()), 1_000)
onBeforeUnmount(() => clearInterval(clockTimer))

function statusSeverity(status: ExportTask['status']) {
  switch (status) {
    case '已完成': return 'success'
    case '已中断': return 'danger'
    case '生成中': return 'warn'
    case '依据失效': return 'danger'
    case '待复核': return 'warn'
    default: return 'info'
  }
}

function leaseRemaining(task: ExportTask) {
  if (!task.lease) return 0
  return Math.max(0, Math.ceil((task.lease.expiresAt - nowTick.value) / 1000))
}

function isHolder(task: ExportTask) {
  return task.lease?.station === runner.station.value
}

function shardSeverity(task: ExportTask, state: string) {
  if (state === '已完成') return 'done'
  if (state === '已失效') return task.status === '待复核' ? 'review' : 'invalid'
  return 'pending'
}

function shardTitle(task: ExportTask, shard: ExportTask['shards'][number]) {
  const parts = [shard.label, shard.state]
  if (shard.reason) parts.push(shard.reason)
  if (shard.state === '已完成' && shard.basisDigest) parts.push(`分片依据 ${shard.basisDigest.slice(0, 6)} / 任务 ${task.basisDigest?.slice(0, 6)}`)
  return parts.join(' · ')
}

const invalidCount = computed(() => tasks.value.reduce((sum, task) => sum + task.shards.filter((s) => s.state === '已失效').length, 0))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <p class="eyebrow">EXPORT JOBS / 导出任务</p>
        <h1>交付包、执行租约与分片续跑</h1>
        <p class="muted">任务发起时固定版位、打样结论与输出清单；同一任务只允许一个工位持有时限租约，租约丢失后从最后完整分片续跑。</p>
      </div>
      <div class="head-actions">
        <label class="station-pick"><span>当前工位</span>
          <Select v-model="runner.station.value" :options="stationOptions" optionLabel="label" optionValue="value" :style="{ width: '210px' }" @update:model-value="setStation" />
        </label>
        <label class="offline-switch" :class="{ on: runner.offline.value }">
          <input type="checkbox" v-model="runner.offline.value" />
          <i class="pi" :class="runner.offline.value ? 'pi-wifi-off' : 'pi-wifi'" />
          {{ runner.offline.value ? '已离线（停心跳）' : '在线' }}
        </label>
        <Button label="新建印刷交付包" icon="pi pi-plus" @click="runner.createPackage" />
      </div>
    </div>

    <div v-if="runner.notice.value" class="runner-notice" :class="runner.notice.value.type" @click="runner.clearNotice()">
      <i class="pi" :class="{ 'pi-check-circle': runner.notice.value.type === 'success', 'pi-times-circle': runner.notice.value.type === 'error', 'pi-info-circle': runner.notice.value.type === 'info' }" />
      {{ runner.notice.value.text }}
    </div>

    <div v-if="affected.length" class="affected-banner">
      <div class="affected-head">
        <strong><i class="pi pi-bolt" /> 依据已变更 · {{ affected.length }} 个任务受影响，旧分片立即失效（共 {{ invalidCount }} 片）</strong>
        <span class="muted">最近对账 {{ lastCheckedAt }}</span>
      </div>
      <ul>
        <li v-for="item in affected" :key="item.id">
          <Tag :value="item.status" :severity="item.status === '已完成' ? 'warn' : 'danger'" />
          <code>{{ item.id }}</code><span>{{ item.name }}</span>
          <em v-for="(reason, index) in item.changed.reasons" :key="index">{{ reason }}</em>
          <strong v-if="item.invalidatedShards">已作废 {{ item.invalidatedShards }} 个已完成分片</strong>
          <strong v-else class="done-note">已完成交付件被新依据取代</strong>
        </li>
      </ul>
    </div>

    <div class="export-grid">
      <section class="panel">
        <div class="panel-head"><h3>导出队列</h3><span class="muted">租约时限 {{ LEASE_TTL_MS / 1000 }} 秒 · 心跳续期 · 进度仅持有人可写</span></div>
        <div class="task-list">
          <article v-for="task in tasks" :key="task.id" :class="{ stale: task.basisStale, review: task.status === '待复核', superseded: task.basisSuperseded }">
            <div class="task-head">
              <div>
                <strong>{{ task.name }}</strong>
                <small>{{ task.id }} · {{ task.updatedAt }}
                  <template v-if="task.legacy"> · <Tag value="旧数据升级" severity="warn" /> </template>
                </small>
              </div>
              <Tag :value="task.status" :severity="statusSeverity(task.status)" />
            </div>

            <!-- 发起时固化的依据 -->
            <div class="basis-box">
              <div class="basis-line">
                <i class="pi pi-lock" />
                <span>固定依据</span>
                <template v-if="task.basis">
                  <code>{{ task.basis.revisionLabel }}</code>
                  <code>版位 {{ task.basis.positionsDigest.slice(0, 6) }}</code>
                  <code>打样 {{ task.basis.proofDigest.slice(0, 6) }}</code>
                  <code>清单 {{ task.basis.manifestDigest.slice(0, 6) }}</code>
                </template>
                <code v-else class="missing-basis">缺少发起依据</code>
              </div>
              <div v-if="task.basis" class="proof-snapshot">
                打样结论快照：
                <span v-for="proof in task.basis.proofs" :key="proof.round">第{{ proof.round }}轮「{{ proof.decision }}」ΔE{{ proof.deltaE }}</span>
              </div>
              <div v-if="task.basis" class="manifest-snapshot">
                输出清单（{{ task.basis.manifest.length }} 项，发起时锁定）：
                <span v-for="item in task.basis.manifest" :key="item.key">{{ item.label }}<em>{{ item.detail }}</em></span>
              </div>
            </div>

            <ProgressBar :value="task.progress" :showValue="false" :style="{ height: '8px' }" />

            <!-- 分片：完整分片才可在续跑时复用 -->
            <div class="shards">
              <span v-for="shard in task.shards" :key="shard.id" class="shard" :class="shardSeverity(task, shard.state)" :title="shardTitle(task, shard)">
                {{ shard.id }}<i class="pi" :class="{ 'pi-check': shard.state === '已完成', 'pi-ban': shard.state === '已失效', 'pi-clock': shard.state === '待生成' }" />
              </span>
            </div>

            <div v-if="task.status === '依据失效'" class="reason danger-reason">
              <i class="pi pi-exclamation-triangle" /> 依据已变更：{{ task.staleChangedFields?.reasons.join('；') }}（{{ task.staleSince }}）。旧分片不会复用，请用新依据重试。
            </div>
            <div v-else-if="task.basisSuperseded" class="reason warn-reason">
              <i class="pi pi-info-circle" /> 交付完成后依据又发生变化（{{ task.staleChangedFields?.reasons.join('；') }}），原交付件保留，可按新依据重新生成。
            </div>
            <div v-else-if="task.status === '待复核'" class="reason warn-reason">
              <i class="pi pi-search" /> {{ task.reviewReason }}
            </div>
            <div v-else-if="task.status === '已中断' && task.reviewReason" class="reason muted-reason">
              <i class="pi pi-clock" /> {{ task.reviewReason }}
            </div>

            <div class="task-foot">
              <span>
                {{ task.progress }}%
                <template v-if="task.lease">
                  · <i class="pi pi-key" /> {{ isHolder(task) ? '本工位持有' : `${task.lease.station} 持有` }} · 剩 {{ leaseRemaining(task) }}s
                </template>
                <template v-else-if="task.status !== '已完成'">· {{ task.progress === 0 ? '从首个分片开始' : `从最后完整分片续跑（${task.shards.filter((s) => s.state === '已完成').length}/${task.shards.length}）` }}</template>
                <template v-else>· 文件哈希已校验</template>
              </span>
              <div class="actions">
                <Button v-if="task.status === '排队中' || task.status === '已中断'" label="领取并恢复" icon="pi pi-play" size="small" :loading="runner.busy.value === task.id" @click="runner.claim(task.id)" />
                <Button v-if="task.status === '生成中' && isHolder(task)" label="释放租约" icon="pi pi-sign-out" size="small" severity="secondary" outlined :loading="runner.busy.value === task.id" @click="runner.release(task.id)" />
                <Button v-else-if="task.status === '生成中'" :label="`${task.lease?.station} 执行中`" icon="pi pi-lock" size="small" disabled />
                <Button v-if="task.status === '依据失效'" label="用新依据重试" icon="pi pi-refresh" size="small" severity="danger" outlined :loading="runner.busy.value === task.id" @click="runner.retryWithCurrentBasis(task.id)" />
                <Button v-if="task.status === '待复核'" label="确认当前依据" icon="pi pi-clipboard-check" size="small" severity="warn" outlined :loading="runner.busy.value === task.id" @click="runner.confirmLegacyBasis(task.id)" />
                <Button v-if="task.basisSuperseded" label="按新依据重新生成" icon="pi pi-refresh" size="small" severity="warn" outlined :loading="runner.busy.value === task.id" @click="runner.retryWithCurrentBasis(task.id)" />
                <Button v-if="task.status === '已完成'" label="打开结果" icon="pi pi-external-link" size="small" text />
              </div>
            </div>
          </article>
          <div v-if="!tasks.length" class="loading">暂无导出任务</div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>新任务将固定的依据</h3><Tag :value="store.revision" /></div>
          <div class="package-list">
            <div><i class="pi pi-sitemap" /><span>拼版版位（{{ store.positions.length }} 个位置）</span><strong>{{ store.currentBasis.positionsDigest.slice(0, 6) }}</strong></div>
            <div><i class="pi pi-image" /><span>打样结论（{{ store.proofs.length }} 轮）</span><strong>{{ store.currentBasis.proofDigest.slice(0, 6) }}</strong></div>
            <div v-for="item in store.currentBasis.manifest" :key="item.key"><i class="pi pi-check-circle" /><span>{{ item.label }}</span><strong>{{ item.detail }}</strong></div>
          </div>
          <p class="side-note">发起后清单与依据冻结；在途任务不受后续编辑影响，依据一变则旧分片失效。</p>
        </section>
        <section class="panel recovery">
          <div class="panel-head"><h3>租约与续跑规则</h3></div>
          <p>每个分片 2 页一组写入临时目录。领取任务获得 {{ LEASE_TTL_MS / 1000 }} 秒执行租约，在线时每 1.5 秒心跳续期；两个工位同时领取时，只有一个成功。</p>
          <p>离线（关闭心跳）或网络中断后租约到期，任务回到「已中断」，已完成分片保留并校验依据摘要，恢复时从最后<strong>完整</strong>分片的下一片继续；依据已变的分片不可复用。</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.head-actions { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.station-pick { display: grid; gap: 4px; font-size: 10px; color: #68777e; }
.offline-switch { display: inline-flex; align-items: center; gap: 6px; height: 41px; padding: 0 12px; border: 1px solid #bdc9cb; border-radius: 6px; color: #38666d; background: white; font-size: 12px; cursor: pointer; }
.offline-switch.on { color: #b84e35; border-color: #d9a99c; background: #fdf1ee; }
.offline-switch input { display: none; }
.runner-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding: 10px 14px; border-radius: 8px; font-size: 12px; cursor: pointer; }
.runner-notice.success { color: #2d735b; background: #e9f5ef; border: 1px solid #b9dccc; }
.runner-notice.error { color: #a3442f; background: #fdf0ec; border: 1px solid #e3b5a8; }
.runner-notice.info { color: #38606b; background: #edf4f6; border: 1px solid #c2d6db; }
.affected-banner { margin-bottom: 14px; padding: 13px 16px; border: 1px solid #e0b388; border-radius: 9px; background: #fff7ec; }
.affected-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 9px; }
.affected-head strong { font-size: 13px; color: #8a5320; }
.affected-head i { margin-right: 6px; }
.affected-banner ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.affected-banner li { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; color: #6d5a45; }
.affected-banner li code { color: #9c5a2a; font-weight: 700; }
.affected-banner li em { padding: 2px 7px; border-radius: 4px; color: #8a5320; background: #fbe9d2; font-style: normal; }
.affected-banner li strong { color: #b0472f; }
.affected-banner li strong.done-note { color: #9c7a33; }
.export-grid { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 14px; align-items: start; }
.task-list { padding: 8px 16px 16px; }
.task-list article { padding: 15px 0; border-bottom: 1px solid #e9eeee; }
.task-list article.stale { padding-left: 12px; padding-right: 12px; border: 1px solid #e7c2b4; border-radius: 8px; background: #fdf7f5; }
.task-list article.review { border-color: #e3d2a8; background: #fdfaf2; }
.task-list article.superseded { border-color: #e3d2a8; }
.task-head, .task-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-head { margin-bottom: 11px; }
.task-head strong, .task-head small { display: block; }
.task-head small { margin-top: 4px; color: #7c898f; font-size: 10px; }
.task-foot { margin-top: 9px; }
.task-foot span { color: #68777e; font-size: 10px; }
.task-foot .actions { display: flex; gap: 6px; }
.basis-box { margin-bottom: 10px; padding: 9px 11px; border-radius: 7px; background: #f3f6f5; border: 1px dashed #c6d2d0; }
.basis-line { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 10px; color: #5e7176; }
.basis-line i { color: #397d64; }
.basis-line code { padding: 2px 6px; border-radius: 4px; background: #e4ecea; color: #35595f; font-family: monospace; }
.basis-line .missing-basis { color: #a3442f; background: #fbe7e1; }
.proof-snapshot, .manifest-snapshot { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; font-size: 10px; color: #6b7b80; }
.proof-snapshot span, .manifest-snapshot span { padding: 2px 7px; border-radius: 10px; background: #e7eeec; color: #46636a; }
.manifest-snapshot span em { margin-left: 5px; color: #83929a; font-style: normal; }
.shards { display: flex; gap: 6px; margin: 9px 0 4px; flex-wrap: wrap; }
.shard { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 10px; font-family: monospace; font-size: 10px; font-weight: 700; }
.shard.done { color: #2d735b; background: #e2f2ea; }
.shard.pending { color: #7a878d; background: #edf1f1; }
.shard.invalid { color: #b0472f; background: #fbe7e1; }
.shard.review { color: #9c7a33; background: #f8efd8; }
.reason { margin-top: 8px; font-size: 10px; line-height: 1.6; }
.danger-reason { color: #a3442f; }
.warn-reason { color: #8a6622; }
.muted-reason { color: #78868c; }
aside { display: grid; gap: 14px; }
.package-list { padding: 8px 16px 8px; }
.package-list div { display: grid; grid-template-columns: 24px 1fr auto; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid #edf1f1; font-size: 11px; }
.package-list i { color: #397d64; }
.package-list strong { color: #536b72; font-size: 10px; }
.side-note { margin: 4px 16px 14px; color: #7a878d; font-size: 10px; line-height: 1.6; }
.recovery p { padding: 0 16px; color: #67767d; font-size: 11px; line-height: 1.7; }
.recovery p:first-of-type { padding-top: 4px; }
@media (max-width: 1000px) { .export-grid { grid-template-columns: 1fr; } }
</style>
