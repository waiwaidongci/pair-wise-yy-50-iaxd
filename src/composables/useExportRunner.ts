import { ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import { exportApi, ExportClientError } from '../api/exportApi'
import { useExportTasks } from './useExportTasks'
import { useWorkstation } from './useWorkstation'
import { useImpositionStore } from '../stores/imposition'

export type Notice = { type: 'success' | 'error' | 'info'; text: string }

const QUERY_KEY = ['export-tasks']

// 模块级单例状态：避免多个视图调用 composable 时重复启动节拍
const busy = ref<string | null>(null)
const notice = ref<Notice | null>(null)
let tickStarted = false

function inform(type: Notice['type'], text: string) {
  notice.value = { type, text }
}

/**
 * 导出执行器：以固定节拍驱动「当前持有的租约」。
 * - 在线时每 1.5s 为持有的任务心跳，并完成下一个待生成分片（进度只由租约持有人写入）；
 * - 离线时停止心跳，租约在 TTL 后丢失，任务回到已中断，只能从最后完整分片续跑。
 */
export function useExportRunner() {
  const queryClient = useQueryClient()
  const { tasks } = useExportTasks()
  const { station, offline } = useWorkstation()

  function clearNotice() {
    notice.value = null
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  }

  /** 领取 / 恢复同一任务：服务端保证同一时刻只有一个工位拿到租约 */
  async function claim(id: string) {
    clearNotice()
    busy.value = id
    try {
      const result = await exportApi.claim(id, station.value)
      inform('success', result.reason ?? `已领取任务，租约 8 秒有效，心跳自动续期（${result.lease?.station}）`)
      await refresh()
    } catch (error) {
      if (error instanceof ExportClientError) inform('error', error.message)
    } finally {
      busy.value = null
    }
  }

  async function release(id: string) {
    clearNotice()
    const task = tasks.value.find((item) => item.id === id)
    if (!task?.lease) return
    busy.value = id
    try {
      await exportApi.release(id, task.lease.station, task.lease.token)
      inform('info', '租约已释放，任务保留在最后完整分片')
      await refresh()
    } catch (error) {
      if (error instanceof ExportClientError) inform('error', error.message)
    } finally {
      busy.value = null
    }
  }

  /** 依据失效后：以新依据重试，旧分片全部丢弃 */
  async function retryWithCurrentBasis(id: string) {
    clearNotice()
    busy.value = id
    try {
      const store = useImpositionStore()
      const task = await exportApi.retry(id, store.basisInput())
      inform('success', `已按新依据 ${store.revision} 重置任务（${task.shards.length} 个分片重新生成）`)
      await refresh()
    } catch (error) {
      if (error instanceof ExportClientError) inform('error', error.message)
    } finally {
      busy.value = null
    }
  }

  /** 旧数据升级后补录依据：缺少依据的旧分片不沿用 */
  async function confirmLegacyBasis(id: string) {
    clearNotice()
    busy.value = id
    try {
      const store = useImpositionStore()
      await exportApi.confirmBasis(id, store.basisInput())
      inform('success', `已补录当前依据 ${store.revision}，旧分片缺少依据未复用，可重新领取`)
      await refresh()
    } catch (error) {
      if (error instanceof ExportClientError) inform('error', error.message)
    } finally {
      busy.value = null
    }
  }

  async function createPackage() {
    clearNotice()
    const store = useImpositionStore()
    try {
      const task = await exportApi.create('印刷交付包 · PDF/X-4', store.basisInput())
      inform('success', `任务已发起：版位、打样结论与输出清单已固定（${task.basis?.revisionLabel}，${task.shards.length} 个分片）`)
      await refresh()
    } catch (error) {
      if (error instanceof ExportClientError) inform('error', error.message)
    }
  }

  if (!tickStarted) {
    tickStarted = true
    setInterval(async () => {
      if (offline.value) return
      const mine = tasks.value.filter((task) => task.lease?.station === station.value && task.status === '生成中')
      for (const task of mine) {
        const lease = task.lease!
        const pending = task.shards.find((shard) => shard.state === '待生成')
        try {
          if (pending) {
            await exportApi.reportProgress(task.id, lease.station, lease.token, pending.id)
          } else {
            await exportApi.heartbeat(task.id, lease.station, lease.token)
          }
        } catch {
          // 租约丢失（409）：停止写入，列表轮询会显示「已中断 · 从最后完整分片续跑」
        }
      }
      if (mine.length) await refresh()
    }, 1_500)
  }

  return {
    station, offline, busy, notice,
    claim, release, retryWithCurrentBasis, confirmLegacyBasis, createPackage, clearNotice,
  }
}
