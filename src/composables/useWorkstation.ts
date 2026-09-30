import { ref } from 'vue'

// 当前工位：演示中两个浏览器标签切换不同工位，即可复现「两个工位同时续跑同一任务」。
const STATION_KEY = 'print-export-station'
export const WORKSTATIONS = ['工位 A · 甲班拼版台', '工位 B · 乙班打样台'] as const
export type Workstation = (typeof WORKSTATIONS)[number]

function readStation(): Workstation {
  const saved = localStorage.getItem(STATION_KEY)
  return (WORKSTATIONS as readonly string[]).includes(saved ?? '') ? (saved as Workstation) : WORKSTATIONS[0]
}

const station = ref<Workstation>(readStation())
/** 离线开关：用于演示租约心跳停止 → TTL 到期 → 另一工位接管 */
const offline = ref(false)

export function useWorkstation() {
  function setStation(value: Workstation) {
    station.value = value
    localStorage.setItem(STATION_KEY, value)
  }
  return { station, offline, setStation, WORKSTATIONS }
}
