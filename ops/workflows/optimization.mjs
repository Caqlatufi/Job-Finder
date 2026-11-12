import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin + url.pathname : ''; }
  catch { return ''; }
}
const safeText = (value, limit = 500) => String(value || '')
  .replace(/https?:\/\/[^\s"<>]+/gi, value => safeUrl(value))
  .replace(/\b(password|passwd|token|access_token|authorization|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
  .replace(/[\r\n]+/g, ' ').slice(0, limit);
const code = value => /^[A-Z][A-Z0-9_]{0,79}$/.test(value || '') ? value : 'UNEXPECTED_BRANCH';

/** Append each occurrence separately; simultaneous workers never overwrite each other's evidence. */
export async function recordOptimization({root, runDirectory, workflow = 'company-address', task, attempt, node,
  errorCode, message, target, captures = [], decision, historical = false}) {
  const error = code(errorCode), sourceUrl = safeUrl(target?.url || captures.at(-1)?.sourceUrl);
  const host = sourceUrl ? new URL(sourceUrl).hostname : '';
  const fingerprint = createHash('sha256').update(JSON.stringify([workflow, node, error, target?.kind || '', host]))
    .digest('hex').slice(0, 20);
  const optimizationId = 'wf-' + fingerprint;
  const issueDirectory = path.join(root, optimizationId);
  const eventId = randomUUID(), createdAt = new Date().toISOString();
  const event = {schemaVersion: 1, event: 'workflow.branch_failed', eventId, createdAt, workflow,
    optimizationId, taskId: task.taskId, companyId: task.companyId, postingId: target?.postingId,
    attempt, node: safeText(node, 80), errorCode: error, message: safeText(message), historical, sourceUrl,
    targetKind: target?.kind, actual: {action: safeText(decision?.action, 80), pageType: safeText(decision?.pageType, 80)},
    captures: captures.map(c => ({captureId: c.captureId, filePath: c.filePath, sha256: c.sha256,
      capturedAt: c.capturedAt, sourceUrl: safeUrl(c.sourceUrl)})),
    checkpoint: path.join(path.dirname(runDirectory), 'graph.checkpoint')};
  await fs.mkdir(runDirectory, {recursive: true});
  // Write the log first. A failed task-sheet write must never be reported as a recorded optimization.
  await fs.appendFile(path.join(runDirectory, 'branch-events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  await fs.mkdir(path.join(issueDirectory, 'events'), {recursive: true});
  const acceptance = ['复现本任务记录的节点、错误码及截图证据', '补齐明确分支或有界恢复策略，不要求用户继续/重试',
    '身份、地址及来源校验继续生效，不保存猜测地址', '增加该分支回归用例，修复后由开发侧重放原任务'];
  const sheet = {schemaVersion: 1, optimizationId, status: 'OPEN', createdAt, workflow, node: event.node,
    errorCode: error, host, title: `${workflow} / ${event.node} / ${error}`, acceptance};
  const writeOnce = async (file, content) => {
    try { await fs.writeFile(file, content, {encoding: 'utf8', flag: 'wx'}); }
    catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
  };
  await writeOnce(path.join(issueDirectory, 'task.json'), JSON.stringify(sheet, null, 2) + '\n');
  await writeOnce(path.join(issueDirectory, 'TASK.md'), `# ${sheet.title}\n\n状态：OPEN\n\n`
    + `工作流：${workflow}\n节点：${event.node}\n错误码：${error}\n站点：${host || '不适用'}\n\n`
    + '## 优化要求\n\n' + acceptance.map(item => '- ' + item).join('\n')
    + '\n\n## 发生记录\n\n见同目录 events/*.json，每次发生独立留档；原始证据保留在对应任务目录。\n');
  await fs.writeFile(path.join(issueDirectory, 'events', eventId + '.json'), JSON.stringify(event, null, 2) + '\n', {flag: 'wx'});
  const reference = {optimizationId, taskFile: path.join(issueDirectory, 'TASK.md'), eventId, errorCode: error, node: event.node};
  await fs.writeFile(path.join(runDirectory, 'optimization-' + eventId + '.json'), JSON.stringify(reference, null, 2) + '\n', {flag: 'wx'});
  return reference;
}
