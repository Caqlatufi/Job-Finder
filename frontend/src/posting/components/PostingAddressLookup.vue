<script setup lang="ts">
import type {Posting} from '@/common/model/domain';

defineProps<{posting: Posting; expanded?: boolean}>();
const labels = {JD_CLOSED: 'JD 已关闭 · 地址获取失败', FAILED: 'JD 地址获取失败',
  NO_ADDRESS: 'JD 未提供详细地址', SUCCEEDED: 'JD 地址已补全'};
</script>

<template>
  <div v-if="posting.addressLookupStatus" class="posting-address-lookup" :data-posting-id="posting.id">
    <el-tag size="small" :type="posting.addressLookupStatus === 'SUCCEEDED' ? 'success' : 'warning'"
      :title="posting.addressLookupMessage">{{ labels[posting.addressLookupStatus] }}</el-tag>
    <template v-if="expanded">
      <p v-if="posting.addressLookupCheckedAt" class="checked-at">{{ posting.addressLookupCheckedAt.replace('T', ' ').slice(0, 16) }}</p>
      <details v-if="posting.addressLookupEvidence"><summary>查看证据</summary><p>{{ posting.addressLookupEvidence }}</p></details>
    </template>
  </div>
</template>

<style scoped>
.posting-address-lookup { margin-top: 6px; font-size: 12px; overflow-wrap: anywhere; }
.posting-address-lookup p { white-space: pre-wrap; line-height: 1.7; margin: 6px 0; }
.checked-at { color: #78847b; }
summary { cursor: pointer; color: #67756b; }
</style>
