import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJson, projectRoot} from '../recognition/queue.mjs';
import {ImportError} from './importer.mjs';
import {discoverCompanyAddress} from './address-graph.mjs';
import {desktopWorkflow, localApi} from './worker.mjs';
import {readPage} from './model.mjs';
import {FileCheckpointer} from './checkpointer.mjs';
import {recordOptimization} from '../workflows/optimization.mjs';

export async function work(directory, attempt, settings, dependencies = {}) {
  const run = path.join(directory, 'attempt-' + attempt);
  await fs.mkdir(run, {recursive: true});
  await atomicJson(path.join(run, 'worker.json'), {pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()});
  let calls = 0;
  let task, context = {node: 'worker'}, lastProgress = {}, opened = false;
  const controller = new AbortController();
  const stopFile = path.join(run, 'stop.requested');
  const checkStopped = async () => {
    const stopped = await fs.access(stopFile).then(() => true, () => false);
    if (stopped) { controller.abort(); throw new ImportError('ADDRESS_STOPPED', '地址收录已停止', 'STOPPED'); }
  };
  const stopTimer = setInterval(() => { void checkStopped().catch(() => {}); }, 300);
  const workflow = dependencies.workflow || desktopWorkflow;
  const reportIssue = issue => recordOptimization({root: settings.optimizationRoot || path.join(projectRoot, 'local/workflow-optimizations'),
    runDirectory: run, task, attempt, ...issue});
  try {
    task = JSON.parse(await fs.readFile(path.join(directory, 'task.json'), 'utf8'));
    const standard = await fs.readFile(path.join(projectRoot, '.agents/skills/company-address-prompt.md'), 'utf8');
    const api = dependencies.api || localApi(settings.apiBase);
    const result = await discoverCompanyAddress(task, {api: async (...args) => { await checkStopped(); return api(...args); },
      workflow: async (action, payload) => {
        await checkStopped();
        if (action === 'openJob') opened = true;
        return workflow(action, payload);
      },
      remember: (name, data) => atomicJson(path.join(run, name + '.json'), data),
      progress: data => { lastProgress = {...lastProgress, ...data}; return atomicJson(path.join(run, 'progress.json'), {...lastProgress, updatedAt: new Date().toISOString()}); },
      trace: async (node, state) => { await checkStopped(); context = {node, target: state.target, captures: state.captures, decision: state.decision}; },
      checkStopped,
      reportIssue, wait: dependencies.wait,
      checkpointer: new FileCheckpointer(path.join(directory, 'graph.checkpoint')),
      model: dependencies.model || (input => readPage(input, path.join(run, 'model-' + ++calls), {...settings, signal: controller.signal, promptVersion: 'company-address-v3'}, standard))});
    const completion = {status: 'SUCCEEDED', ...result, attempt, completedAt: new Date().toISOString()};
    await atomicJson(path.join(run, 'completion.json'), completion);
    return completion;
  } catch (error) {
    if (controller.signal.aborted || error.code === 'ADDRESS_STOPPED') {
      const completion = {status: 'STOPPED', attempt, message: '地址收录已停止', completedAt: new Date().toISOString()};
      await atomicJson(path.join(run, 'completion.json'), completion);
      return completion;
    }
    const safe = error instanceof ImportError ? error : new ImportError('ADDRESS_LOOKUP_FAILED', '地址流程发生未覆盖异常');
    let optimizationTasks = [];
    try {
      if (task) optimizationTasks = [await reportIssue({...context, errorCode: safe.code, message: safe.message})];
    } catch { /* A failed recorder remains a real failure, never a fictitious optimization task. */ }
    const completion = {status: optimizationTasks.length ? 'OPTIMIZATION_PENDING' : 'FAILED', attempt,
      errorCode: optimizationTasks.length ? safe.code : 'OPTIMIZATION_RECORD_FAILED',
      message: optimizationTasks.length ? '已记录优化任务' : '优化任务记录失败，日志已保留',
      optimizationTasks, completedAt: new Date().toISOString()};
    await atomicJson(path.join(run, 'completion.json'), completion);
    return completion;
  } finally {
    clearInterval(stopTimer);
    if (opened && task?.tabKey === 'company-address:' + task.taskId) {
      try { await workflow('close', {key: task.tabKey}); }
      catch (error) {
        if (error.code !== 'TAB_NOT_FOUND') {
          try {
            const reference = await reportIssue({...context, node: 'cleanup', errorCode: 'TAB_CLOSE_FAILED', message: '任务结束后关闭自有标签失败'});
            const completionFile = path.join(run, 'completion.json');
            const completion = JSON.parse(await fs.readFile(completionFile, 'utf8'));
            completion.optimizationTasks = [...(completion.optimizationTasks || []), reference];
            await atomicJson(completionFile, completion);
          } catch { await atomicJson(path.join(run, 'tab-cleanup.json'), {errorCode: 'TAB_CLOSE_FAILED'}); }
        }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, attempt, codex = '', timeout = '120000', model = 'gpt-6-astra', effort = 'medium',
    apiBase = 'http://127.0.0.1:7890/jd-collector/api'] = process.argv.slice(2);
  const result = await work(path.resolve(directory), Number(attempt), {codex, timeout: Number(timeout), model, effort, apiBase});
  console.log(JSON.stringify({taskId: path.basename(directory), status: result.status, errorCode: result.errorCode}));
}
