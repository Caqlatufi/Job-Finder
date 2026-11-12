import client from '@/common/api/request';
import type {RestResultResponse} from '@/common/model/response';

export interface AddressTask {
  taskId: string;
  companyId: number;
  companyName: string;
  tabKey: string;
  attempt?: number;
  status: 'QUEUED' | 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'WAITING_USER' | 'NEEDS_REVIEW' | 'PARTIAL' | 'OPTIMIZATION_PENDING' | 'NOT_FOUND' | 'STOPPED';
  optimizationTasks?: {optimizationId: string; taskFile: string; errorCode: string; node: string}[];
  message?: string;
  phase?: string;
  errorCode?: string;
  address?: string;
  sourceType?: string;
  positioned?: boolean;
}
export interface AddressDiscovery {
  id: number;
  companyId: number;
  postingId?: number;
  address: string;
  sourceType: 'JD' | 'COMPANY';
  sourceUrl: string;
  evidenceText: string;
}
export interface AddressBatch {
  batchId?: string;
  status: 'IDLE' | 'PREPARING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'COMPLETED';
  unrecorded: number; total: number; completed: number; succeeded: number; skipped: number; remaining: number;
  currentCompany: string;
}
export const companyAddressApi = {
  batch: async () => (await client.get<RestResultResponse<AddressBatch>>('/company-address-tasks/batch')).data.result,
  startBatch: async () => (await client.post<RestResultResponse<AddressBatch>>('/company-address-tasks/batch/start')).data.result,
  stopBatch: async () => (await client.post<RestResultResponse<AddressBatch>>('/company-address-tasks/batch/stop')).data.result,
  list: async () => (await client.get<RestResultResponse<AddressTask[]>>('/company-address-tasks')).data.result,
  create: async (companyId: number) => (await client.post<RestResultResponse<AddressTask>>('/company-address-tasks', {companyId})).data.result,
  retry: async (taskId: string) => (await client.post<RestResultResponse<AddressTask>>(`/company-address-tasks/${taskId}/retry`)).data.result,
  discoveries: async () => (await client.get<RestResultResponse<AddressDiscovery[]>>('/companies/address-discoveries')).data.result,
};
