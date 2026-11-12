import {companyAddressApi, type AddressBatch, type AddressTask} from '@/company/api/companyAddressApi';
import {computed, onBeforeUnmount, onMounted, ref} from 'vue';

export function useCompanyAddressTasks(onCompleted: () => Promise<void>) {
  const batch = ref<AddressBatch>();
  const tasks = ref<AddressTask[]>([]);
  const busy = ref(false);
  const error = ref('');
  const completed = new Set<string>();
  const active = computed(() => !!batch.value && ['RUNNING', 'PREPARING', 'STOPPING'].includes(batch.value.status));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let revision = 0;
  const refresh = async () => {
    const started = revision;
    try {
      const [rows, current] = await Promise.all([companyAddressApi.list(), companyAddressApi.batch()]);
      if (disposed || started !== revision) return;
      if (current?.status) batch.value = current;
      tasks.value = rows;
      let changed = false;
      for (const task of rows) {
        const key = `${task.taskId}:${task.attempt ?? 0}:${task.status}`;
        if (!['QUEUED', 'STARTING', 'RUNNING'].includes(task.status) && !completed.has(key)) {
          completed.add(key); changed = true;
        }
      }
      if (changed) await onCompleted();
      error.value = '';
    } catch (failure) {
      if (!disposed) error.value = failure instanceof Error ? failure.message : '收录进度加载失败';
    }
  };
  const poll = async () => {
    await refresh();
    if (!disposed) timer = setTimeout(poll, 2000);
  };
  const change = async (stop: boolean) => {
    if (busy.value) return;
    busy.value = true; error.value = ''; revision++;
    try {
      const current = await (stop ? companyAddressApi.stopBatch() : companyAddressApi.startBatch());
      if (!disposed) { batch.value = current; await refresh(); }
    } catch (failure) {
      if (!disposed) error.value = failure instanceof Error ? failure.message : '地址收录操作失败';
    } finally {
      revision++;
      if (!disposed) busy.value = false;
    }
  };
  onMounted(poll);
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
  return {batch, tasks, busy, active, error, refresh, start: () => change(false), stop: () => change(true)};
}
