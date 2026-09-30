import axios, { AxiosError } from 'axios'
import { exportAdapter } from './exportServer'
import type { AffectedTask, BasisInput, ExportBasis, ExportTask } from './exportModel'

const client = axios.create({
  adapter: exportAdapter,
  // 模拟通道始终收发 JSON，避免 axios 默认把对象 body 转成 FormData
  transformRequest: [(data) => JSON.stringify(data)],
  headers: { 'Content-Type': 'application/json' },
})

export class ExportClientError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(request: () => Promise<{ data: T | { code: string; message: string }; status: number }>): Promise<T> {
  try {
    const response = await request()
    if (response.status >= 400) {
      const error = response.data as { code: string; message: string }
      throw new ExportClientError(error.code, response.status, error.message)
    }
    return response.data as T
  } catch (error) {
    if (error instanceof ExportClientError) throw error
    const axiosError = error as AxiosError<{ code: string; message: string }>
    if (axiosError.response) {
      throw new ExportClientError(axiosError.response.data.code, axiosError.response.status, axiosError.response.data.message)
    }
    throw new ExportClientError('NETWORK', 0, axiosError.message || '网络异常')
  }
}

export type ClaimResult = { task: ExportTask; lease?: ExportTask['lease']; reason?: string }
export type ReconcileResult = { current: ExportBasis; affected: AffectedTask[] }

export const exportApi = {
  list: () => call<ExportTask[]>(() => client.get('/api/print/export-tasks')),
  create: (name: string, basisInput: BasisInput) =>
    call<ExportTask>(() => client.post('/api/print/export-tasks', { name, basisInput })),
  claim: (id: string, station: string) => call<ClaimResult>(() => client.post(`/api/print/export-tasks/${id}/claim`, { station })),
  heartbeat: (id: string, station: string, token: string) =>
    call<ExportTask>(() => client.post(`/api/print/export-tasks/${id}/heartbeat`, { station, token })),
  reportProgress: (id: string, station: string, token: string, shardId: string) =>
    call<ExportTask>(() => client.post(`/api/print/export-tasks/${id}/progress`, { station, token, shardId })),
  release: (id: string, station: string, token: string) =>
    call<ExportTask>(() => client.post(`/api/print/export-tasks/${id}/release`, { station, token })),
  retry: (id: string, basisInput: BasisInput) =>
    call<ExportTask>(() => client.post(`/api/print/export-tasks/${id}/retry`, { basisInput })),
  confirmBasis: (id: string, basisInput: BasisInput) =>
    call<ExportTask>(() => client.post(`/api/print/export-tasks/${id}/confirm-basis`, { basisInput })),
  reconcile: (basisInput: BasisInput) =>
    call<ReconcileResult>(() => client.post('/api/print/export-reconcile', { basisInput })),
}
