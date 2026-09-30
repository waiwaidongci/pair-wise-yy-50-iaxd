import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { exportApi } from '../api/exportApi'
import type { AffectedTask, ExportBasis } from '../api/exportModel'
// 依据对账结果为跨页面共享的模块级状态：任何页面触发，导航徽标与受影响清单同步更新。
const lastBasis = ref<ExportBasis | null>(null)
const affected = ref<AffectedTask[]>([])
const lastCheckedAt = ref<string | null>(null)

export function useExportTasks() {
  // 1 秒轮询：租约到期、其他工位写入的进度都能及时反映
  const query = useQuery({
    queryKey: ['export-tasks'],
    queryFn: () => exportApi.list(),
    refetchInterval: 1_000,
    initialData: [],
  })
  const tasks = computed(() => query.data.value ?? [])
  return { tasks, ...query }
}

export function useReconcileState() {
  return { lastBasis, affected, lastCheckedAt }
}

export function setReconcileResult(result: { current: ExportBasis; affected: AffectedTask[] }, stamp: string) {
  lastBasis.value = result.current
  affected.value = result.affected
  lastCheckedAt.value = stamp
}
