import type {AddressTask} from '@/company/api/companyAddressApi';

const reasons: Record<string, string> = {
  GEOCODING_NO_MATCH: '暂未匹配到可靠的地图位置', GEOCODING_FAILED: '地图位置匹配暂不可用',
  POSITION_READBACK_FAILED: '地图位置保存未确认', ADDRESS_READBACK_FAILED: '地址保存未确认',
  LOGIN_REQUIRED: '来源页面需要登录', VERIFICATION_REQUIRED: '来源页面需要验证',
  CLIENT_UPGRADE_REQUIRED: '客户端需要更新后才能读取页面', TAB_NOT_FOUND: '收录页面已关闭',
  PAGE_UNAVAILABLE: '来源页面无法打开', SOURCE_UNAVAILABLE: '来源页面无法读取',
  PAGE_LOAD_TIMEOUT: '来源页面加载超时', PAGE_UNREADABLE: '来源页面未能正常显示',
  PAGE_CHANGED: '来源页面变化，未能确认地址', INVALID_CAPTURE_RECT: '来源页面截图失败',
  VIEWPORT_TOO_SMALL: '来源页面截图范围不足', CAPTURE_LIMIT: '未能在页面中确认详细地址',
  ADDRESS_NEEDS_REVIEW: '办公地址暂无法确认', UNVERIFIED_ADDRESS: '地址或来源证据不足',
  UNVERIFIED_JOB_ADDRESS: '未能确认岗位办公地址', UNVERIFIED_COMPANY_ADDRESS: '未能确认公司办公地址',
  JD_ADDRESS_UNREADABLE: '岗位地址无法读取', INCOMPLETE_ADDRESS_PAGE: '来源页面未完整读取',
  WORKER_START_FAILED: '收录任务未能启动', COMPANY_CHANGED: '公司资料已变化',
  API_UNAVAILABLE: '收录服务暂不可用', API_REJECTED: '地址保存请求未通过校验',
  INVALID_RESULT: '来源页面识别结果无法确认', WORKER_EXIT_WITHOUT_COMPLETION: '收录进程意外结束',
};

export const intakeFailure = (task: AddressTask): string | undefined => {
  if (task.status === 'SUCCEEDED') return task.positioned === false ? '暂未匹配到可靠的地图位置' : undefined;
  if (!['FAILED', 'WAITING_USER', 'NEEDS_REVIEW', 'PARTIAL', 'OPTIMIZATION_PENDING', 'NOT_FOUND'].includes(task.status)) return;
  if (task.status === 'NOT_FOUND') return '未找到上海详细办公地址';
  const code = task.errorCode || task.optimizationTasks?.at(-1)?.errorCode;
  return (code && reasons[code]) || '收录未完成，已记录问题';
};
