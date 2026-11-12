import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {work} from './address-worker.mjs';
import {recordOptimization} from '../workflows/optimization.mjs';

const task = {taskId: 'fixture-address-task', companyId: 1, companyName: 'Fixture', tabKey: 'company-address:fixture-address-task'};
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function environment(body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'address-worker-'));
  try {
    const directory = path.join(root, 'jobs', task.taskId);
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, 'task.json'), JSON.stringify(task));
    await body({root, directory, settings: {optimizationRoot: path.join(root, 'optimizations')}});
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}
function scenario(decision) {
  let sourceUrl, saved, position;
  const writes = [], opened = [];
  const dependencies = {wait: async () => {}, model: input => decision(input),
    workflow: async (action, input) => {
      if (action === 'info') return {genericJobCapture: true, companyAddressCapture: true};
      if (action === 'openJob') { sourceUrl = input.url; opened.push(sourceUrl); return {}; }
      if (action === 'close') return {};
      if (action === 'tabs') return [{key: task.tabKey, status: 'ready'}];
      if (action === 'capture') return {captureId: 'c1', sourceUrl, pageRevision: sourceUrl, sha256: 'pixels',
        filePath: '/fixture/c1.png', viewport: {width: 1000, height: 800}, rect: {x: 0, y: 0, width: 1000, height: 800}, zoomFactor: 1};
      throw Error('Unexpected native action');
    },
    api: async (method, route, body) => {
      if (method === 'POST') writes.push(route);
      if (route === '/companies/1') return {id: 1, name: task.companyName};
      if (route === '/company-address-tasks/companies/1/plan') return {company: {id: 1, name: task.companyName},
        addresses: saved ? [saved.address] : [], pendingAddresses: saved && !position ? [saved.address] : []};
      if (route === '/companies/address-discoveries') return saved ? [saved] : [];
      if (route.startsWith('/postings?')) return {result: [], page: {totalPages: 0}};
      if (route === '/companies/1/address-discoveries') return saved = {id: 1, companyId: 1, taskId: task.taskId,
        address: body.address, sourceType: 'COMPANY'};
      if (route === '/companies/location-positions') {
        if (method === 'GET') return position ? [position] : [];
        return position = {address: body.address, longitude: 121.4, latitude: 31.2};
      }
      throw Error('Unexpected API route');
    }};
  return {dependencies, writes, opened};
}
const found = () => ({taskId: task.taskId, action: 'FOUND', pageType: 'SEARCH', companyConfirmed: true,
  companyName: task.companyName, address: '上海市徐汇区虹梅路1801号', addressType: 'COMPANY_OFFICE',
  evidenceText: 'Fixture 上海办公地址：上海市徐汇区虹梅路1801号', evidenceCaptureIds: ['c1']});

test('stopping during positioning does not dispatch the next address or open or close any browser tab', async () => {
  await environment(async ({directory, settings}) => {
    let writes = 0, native = 0;
    const addresses = ['上海徐汇区虹梅路1801号', '上海静安区南京西路100号'];
    const result = await work(directory, 1, settings, {
      workflow: async () => { native++; throw Error('Position-only intake must not access browser'); },
      api: async (method, route) => {
        if (route.endsWith('/plan')) return {company: {id: 1, name: task.companyName}, addresses, pendingAddresses: addresses};
        if (route === '/companies/location-positions' && method === 'POST') {
          writes++; await fs.writeFile(path.join(directory, 'attempt-1/stop.requested'), 'stop');
          return {address: addresses[0], longitude: 121.4, latitude: 31.2};
        }
        throw Error('Unexpected API request');
      },
    });
    assert.equal(result.status, 'STOPPED');
    assert.equal(writes, 1); assert.equal(native, 0);
    await assert.rejects(fs.access(settings.optimizationRoot));
  });
});

test('illegal decisions persist logs before deduplicated optimization sheets and never save guessed addresses', async () => {
  await environment(async ({root, directory, settings}) => {
    const f = scenario(() => ({taskId: task.taskId, action: 'UNSUPPORTED', pageType: 'SEARCH'}));
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, 'OPTIMIZATION_PENDING');
    assert.equal(f.writes.length, 0);
    assert.equal(f.opened.length, 2);
    const issues = await fs.readdir(settings.optimizationRoot);
    assert.equal(issues.length, 1);
    const issue = path.join(settings.optimizationRoot, issues[0]);
    assert.equal((await readJson(path.join(issue, 'task.json'))).status, 'OPEN');
    assert.equal((await fs.readdir(path.join(issue, 'events'))).length, 2);
    assert.match(await fs.readFile(path.join(issue, 'TASK.md'), 'utf8'), /不要求用户继续/);
    const log = (await fs.readFile(path.join(directory, 'attempt-1/branch-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(log.length, 2);
    assert.equal(log[0].node, 'read');
    assert.equal(log[0].actual.action, 'UNSUPPORTED');
    assert.equal(log[0].captures[0].captureId, 'c1');
    const completion = await readJson(path.join(directory, 'attempt-1/completion.json'));
    assert.equal(completion.status, 'OPTIMIZATION_PENDING');
    assert.equal(completion.optimizationTasks.length, 2);
    await fs.access(completion.optimizationTasks[0].taskFile);
    await fs.access(path.join(directory, 'graph.checkpoint'));
    // Another attempt adds occurrences to the same task instead of overwriting it.
    assert.equal((await work(directory, 2, settings, f.dependencies)).status, 'OPTIMIZATION_PENDING');
    assert.equal((await fs.readdir(settings.optimizationRoot)).length, 1);
    assert.equal((await fs.readdir(path.join(issue, 'events'))).length, 4);
  });
});

test('login and captcha skip sources and end without human continuation', async () => {
  for (const action of ['LOGIN', 'CHALLENGE']) await environment(async ({directory, settings}) => {
    const f = scenario(() => ({taskId: task.taskId, action, pageType: action}));
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, 'OPTIMIZATION_PENDING');
    assert.equal(f.writes.length, 0);
    assert.equal(f.opened.length, 2);
    assert(result.optimizationTasks.every(item => item.errorCode === (action === 'LOGIN' ? 'LOGIN_REQUIRED' : 'VERIFICATION_REQUIRED')));
  });
});

test('a valid fallback succeeds while retaining the earlier optimization evidence', async () => {
  await environment(async ({directory, settings}) => {
    let decisions = 0;
    const f = scenario(() => ++decisions === 1 ? {taskId: task.taskId, action: 'LOGIN', pageType: 'LOGIN'} : found());
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.address, found().address);
    assert.equal(result.optimizationTasks.length, 1);
    assert.equal(f.writes.filter(route => route.endsWith('/address-discoveries')).length, 1);
  });
});

test('completion and cancellation close only this task tab; stopping creates no optimization task', async () => {
  for (const stop of [false, true]) await environment(async ({directory, settings}) => {
    const closed = [];
    const f = scenario(async () => {
      if (stop) await fs.writeFile(path.join(directory, 'attempt-1/stop.requested'), 'stop');
      return found();
    });
    const workflow = f.dependencies.workflow;
    f.dependencies.workflow = async (action, input) => {
      if (action === 'close') { closed.push(input.key); return {}; }
      return workflow(action, input);
    };
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, stop ? 'STOPPED' : 'SUCCEEDED');
    assert.deepEqual(closed, [task.tabKey]);
    if (stop) { assert.equal(f.writes.length, 0); await assert.rejects(fs.access(settings.optimizationRoot)); }
  });
});

test('complete pages without addresses are business not-found results with no optimization task', async () => {
  await environment(async ({directory, settings}) => {
    const f = scenario(input => ({taskId: task.taskId, action: 'NO_ADDRESS', pageType: 'SEARCH',
      coverage: {start: true, end: true, continuous: true, captureIds: input.captures.map(c => c.captureId)}}));
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, 'NOT_FOUND');
    assert.deepEqual(result.optimizationTasks, []);
    await assert.rejects(fs.access(settings.optimizationRoot));
  });
});

test('invalid or unavailable sources cannot become normal business not-found results', async () => {
  for (const pageType of ['INVALID', 'UNAVAILABLE']) await environment(async ({directory, settings}) => {
    const f = scenario(() => ({taskId: task.taskId, action: 'NO_ADDRESS', pageType}));
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, 'OPTIMIZATION_PENDING');
    assert.equal(f.writes.length, 0);
    assert.equal(f.opened.length, 2);
    assert(result.optimizationTasks.every(item => item.errorCode === 'SOURCE_UNAVAILABLE'));
  });
});

test('an uncertain address write/readback stops the task without trying another save', async () => {
  await environment(async ({directory, settings}) => {
    const f = scenario(found), api = f.dependencies.api;
    f.dependencies.api = async (method, route, body) => {
      if (method === 'POST' && route.endsWith('/address-discoveries')) throw Error('private diagnostic token=never-log-this');
      return api(method, route, body);
    };
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, 'OPTIMIZATION_PENDING');
    assert.equal(f.opened.length, 1);
    assert.equal(result.optimizationTasks[0].node, 'save');
    const log = await fs.readFile(path.join(directory, 'attempt-1/branch-events.jsonl'), 'utf8');
    assert(!log.includes('never-log-this'));
  });
});

test('concurrent occurrences keep one task and separate evidence, redacting credential-like data', async () => {
  await environment(async ({directory, settings}) => {
    const references = await Promise.all(Array.from({length: 6}, (_, i) => recordOptimization({root: settings.optimizationRoot,
      runDirectory: path.join(directory, 'attempt-' + i), task, attempt: i, node: 'read', errorCode: 'INVALID_RESULT',
      target: {kind: 'JD', url: 'https://user:password@example.com/jobs/1?token=secret'},
      message: 'token=secret password=hidden https://example.com/jobs/1?access_token=secret'})));
    assert.equal(new Set(references.map(ref => ref.optimizationId)).size, 1);
    const issue = path.dirname(references[0].taskFile);
    assert.equal((await fs.readdir(path.join(issue, 'events'))).length, 6);
    const event = await fs.readFile(path.join(issue, 'events', references[0].eventId + '.json'), 'utf8');
    assert(!event.includes('secret'));
    assert(!event.includes('hidden'));
    assert(!event.includes('user:password'));
  });
});

test('task-sheet storage failure keeps the log and reports a real failure instead of fictitious pending work', async () => {
  await environment(async ({directory, settings}) => {
    await fs.writeFile(settings.optimizationRoot, 'blocks-directory-creation');
    const f = scenario(() => ({taskId: task.taskId, action: 'INVALID', pageType: 'SEARCH'}));
    const result = await work(directory, 1, settings, f.dependencies);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'OPTIMIZATION_RECORD_FAILED');
    assert.deepEqual(result.optimizationTasks, []);
    await fs.access(path.join(directory, 'attempt-1/branch-events.jsonl'));
    assert.equal(f.writes.length, 0);
  });
});
