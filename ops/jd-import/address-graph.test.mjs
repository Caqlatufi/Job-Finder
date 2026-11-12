import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverCompanyAddress} from './address-graph.mjs';
import {FileCheckpointer} from './checkpointer.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const task = {taskId: 'c48a6fba-9110-483d-b74a-4f2881fc6e25', companyId: 1, companyName: '地址夹具公司', tabKey: 'company-address:fixture'};
const posting = {id: 2, companyId: 1, sourceUrl: 'https://careers.example.com/jobs/42', title: '数据工程师', location: '上海'};
const address = '上海市徐汇区虹梅路1801号';
const found = (type = 'JOB_OFFICE') => ({taskId: task.taskId, action: 'FOUND', pageType: type === 'JOB_OFFICE' ? 'OFFICIAL' : 'SEARCH',
  companyConfirmed: true, companyName: task.companyName, title: posting.title, address, addressType: type,
  evidenceText: '地址夹具公司上海办公地点：' + address, evidenceCaptureIds: ['c-1']});
function fixture(decisions = [found()], noJd = false) {
  const calls = [], frames = [], issues = []; let sourceUrl = ''; let location = posting.location; let saved, lookup, position;
  const deps = {wait: async () => {}, remember: async () => {}, progress: async () => {},
    reportIssue: async issue => { issues.push(issue); return {optimizationId: 'fixture-' + issues.length, errorCode: issue.errorCode}; },
    workflow: async (action, data) => {
      calls.push({action, data});
      if (action === 'info') return {genericJobCapture: true, companyAddressCapture: true};
      if (action === 'openJob') { sourceUrl = data.url; return {}; }
      if (action === 'tabs') return [{key: task.tabKey, status: 'ready'}];
      if (action === 'capture') return {captureId: 'c-1', key: task.tabKey, sourceUrl, pageRevision: sourceUrl,
        sha256: 'pixels', viewport: {width: 1000, height: 800}, rect: {x: 0, y: 0, width: 1000, height: 800}, zoomFactor: 1};
      return {};
    },
    model: async input => {
      frames.push(input);
      const value = structuredClone(decisions.shift() || found());
      if (value.action === 'NO_ADDRESS' && !value.coverage) value.coverage = {start: true, end: true, continuous: true,
        captureIds: input.captures.map(c => c.captureId)};
      return value;
    },
    api: async (method, route, body) => {
      calls.push({method, route, body});
      if (route === '/companies/1') return {id: 1, name: task.companyName};
      if (route === '/company-address-tasks/companies/1/plan') return {company: {id: 1, name: task.companyName},
        addresses: saved ? [saved.address] : [], pendingAddresses: saved && !position ? [saved.address] : []};
      if (route === '/companies/address-discoveries') return saved ? [saved] : [];
      if (route.startsWith('/postings?')) return {result: noJd ? [] : [posting], page: {totalPages: 1}};
      if (route === '/postings/2/address-lookup' && method === 'POST') {
        lookup = {addressLookupStatus: body.status, addressLookupSourceUrl: body.expectedSourceUrl};
        return {...posting, ...lookup};
      }
      if (route.endsWith('/address-discoveries') && method === 'POST') {
        const isJd = route.startsWith('/postings/');
        saved = {id: 3, companyId: 1, taskId: task.taskId, address: body.address, sourceType: isJd ? 'JD' : 'COMPANY'};
        if (isJd) location = body.address;
        return saved;
      }
      if (route === '/postings/2') return {...posting, location, ...lookup};
      if (route === '/companies/location-positions') {
        if (method === 'GET') return position ? [position] : [];
        return position = {address: body.address, longitude: 121.4, latitude: 31.2};
      }
      throw Error('Unexpected route ' + route);
    },
  };
  return {deps, calls, frames, issues, writes: () => calls.filter(c => c.method === 'POST')};
}

test('reads JD first and saves only the exact posting address plus provenance', async () => {
  const f = fixture();
  const result = await discoverCompanyAddress(task, f.deps);
  assert.equal(result.sourceType, 'JD');
  assert.equal(result.address, address);
  assert.equal(f.calls.find(c => c.action === 'openJob').data.url, posting.sourceUrl);
  assert.equal(f.writes()[0].route, '/postings/2/address-discoveries');
  assert.equal(f.writes()[0].body.expectedLocation, '上海');
  assert.equal(f.writes()[0].body.expectedCompanyName, task.companyName);
});
test('official JD without an address goes directly to company search and preserves JD location', async () => {
  const f = fixture([{taskId: task.taskId, action: 'NO_ADDRESS', pageType: 'OFFICIAL'}, found('COMPANY_OFFICE')]);
  const result = await discoverCompanyAddress(task, f.deps);
  assert.equal(result.sourceType, 'COMPANY');
  const opened = f.calls.filter(c => c.action === 'openJob');
  assert.equal(opened[0].data.url, posting.sourceUrl);
  assert(opened[1].data.url.startsWith('https://cn.bing.com/search?q='));
  assert.equal(f.writes()[0].route, '/postings/2/address-lookup');
  assert.equal(f.writes()[0].body.status, 'NO_ADDRESS');
  assert.equal(f.writes()[1].route, '/companies/1/address-discoveries');
  assert.equal(f.writes()[1].body.expectedPostingUrl, undefined);
  assert.equal(f.writes().some(c => c.route === '/postings/2/address-discoveries'), false);
});
test('no JD link queries company address directly', async () => {
  const f = fixture([found('COMPANY_OFFICE')], true);
  assert.equal((await discoverCompanyAddress(task, f.deps)).sourceType, 'COMPANY');
  assert.equal(f.frames[0].target.kind, 'SEARCH');
});
const closed = () => ({taskId: task.taskId, action: 'CLOSED', pageType: 'CLOSED', companyConfirmed: true,
  companyName: task.companyName, title: posting.title, evidenceText: '该职位已关闭，停止招聘', evidenceCaptureIds: ['c-1']});

test('requests newest collected JD explicitly instead of the score-ordered list', async () => {
  const f = fixture();
  await discoverCompanyAddress(task, f.deps);
  const request = f.calls.find(c => c.route?.startsWith('/postings?'));
  assert.match(request.route, /sortBy=LATEST/);
  assert.match(request.route, /number=1&size=1/);
  assert.equal(f.calls.filter(c => c.route?.startsWith('/postings?')).length, 1);
});

test('closed JD is recorded on that JD, then company search can succeed independently', async () => {
  const f = fixture([closed(), found('COMPANY_OFFICE')]);
  const result = await discoverCompanyAddress(task, f.deps);
  assert.equal(result.sourceType, 'COMPANY');
  const lookup = f.writes()[0];
  assert.equal(lookup.route, '/postings/2/address-lookup');
  assert.equal(lookup.body.status, 'JD_CLOSED');
  assert.equal(lookup.body.expectedSourceUrl, posting.sourceUrl);
  assert.match(lookup.body.evidence, /该职位已关闭/);
  assert.match(lookup.body.evidence, /c-1/);
  assert.equal(f.writes()[1].route, '/companies/1/address-discoveries');
  assert.equal(f.frames.length, 2);
});

test('already recorded closure skips that latest link and does not substitute an older JD', async () => {
  const f = fixture([found('COMPANY_OFFICE')]), api = f.deps.api;
  f.deps.api = (method, route, body) => route.startsWith('/postings?')
    ? {result: [{...posting, addressLookupStatus: 'JD_CLOSED', addressLookupSourceUrl: posting.sourceUrl}], page: {totalPages: 1}}
    : api(method, route, body);
  await discoverCompanyAddress(task, f.deps);
  assert(f.calls.find(c => c.action === 'openJob').data.url.startsWith('https://cn.bing.com/'));
  assert.equal(f.frames[0].target.kind, 'SEARCH');
});

test('unreadable JD failure is attached to JD while company lookup continues', async () => {
  for (const decision of [{taskId: task.taskId, action: 'REVIEW', pageType: 'RECRUITING', reason: '职位描述折叠，无法读取地址'},
    {taskId: task.taskId, action: 'NO_ADDRESS', pageType: 'UNAVAILABLE', reason: '页面失效'}]) {
    const f = fixture([decision, found('COMPANY_OFFICE')]);
    assert.equal((await discoverCompanyAddress(task, f.deps)).sourceType, 'COMPANY');
    assert.equal(f.writes()[0].body.status, 'FAILED');
  }
});

test('closure requires the current JD identity and real screenshot evidence', async () => {
  for (const override of [{title: '推荐职位'}, {companyName: '其他公司'}, {companyConfirmed: false},
    {evidenceCaptureIds: ['invented']}, {pageType: 'RECRUITING'}]) {
    const f = fixture([{...closed(), ...override}]);
    assert.equal((await discoverCompanyAddress(task, f.deps)).status, 'OPTIMIZATION_PENDING');
    assert.equal(f.issues[0].errorCode, 'UNVERIFIED_CLOSED_JD');
    assert.equal(f.writes().length, 0);
  }
});

test('closure is not recorded after screenshot page navigation', async () => {
  const f = fixture([closed()]), workflow = f.deps.workflow;
  let captures = 0;
  f.deps.workflow = async (action, data) => {
    const value = await workflow(action, data);
    if (action === 'capture' && ++captures > 1) return {...value, pageRevision: `changed-${captures}`};
    return value;
  };
  assert.equal((await discoverCompanyAddress(task, f.deps)).status, 'OPTIMIZATION_PENDING');
  assert.equal(f.writes().length, 0);
});

test('registration, other companies, other cities, districts and wrong jobs never write', async () => {
  for (const override of [{addressType: 'REGISTERED'}, {companyName: '另一家公司'}, {address: '上海·闵行区'},
    {address: '北京市朝阳区建国路1号'}, {title: '其他岗位'}, {evidenceCaptureIds: ['invented']}, {companyConfirmed: false}]) {
    const f = fixture([{...found(), ...override}]);
    assert.equal((await discoverCompanyAddress(task, f.deps)).status, 'OPTIMIZATION_PENDING');
    assert.equal(f.writes().length, 0);
  }
});
test('missing page coverage records an optimization before trying another source', async () => {
  const f = fixture([{taskId: task.taskId, action: 'NO_ADDRESS', pageType: 'OFFICIAL', coverage: {start: true, end: false}}]);
  assert.equal((await discoverCompanyAddress(task, f.deps)).status, 'OPTIMIZATION_PENDING');
  assert.equal(f.issues[0].errorCode, 'INCOMPLETE_ADDRESS_PAGE');
  assert.equal(f.writes().length, 0);
});
test('login ends as optimization pending and developer replay retains the checkpoint', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'address-graph-'));
  try {
    const file = path.join(directory, 'graph.checkpoint');
    const f = fixture(Array.from({length: 3}, () => ({taskId: task.taskId, action: 'LOGIN', pageType: 'LOGIN'})));
    f.deps.checkpointer = new FileCheckpointer(file);
    assert.equal((await discoverCompanyAddress(task, f.deps)).status, 'OPTIMIZATION_PENDING');
    assert.equal(f.issues[0].errorCode, 'LOGIN_REQUIRED');
    assert.equal(f.writes().length, 0);
    const resumed = fixture(); resumed.deps.checkpointer = new FileCheckpointer(file);
    assert.equal((await discoverCompanyAddress(task, resumed.deps)).address, address);
    assert(resumed.calls.some(c => c.action === 'openJob'));
  } finally { await fs.rm(directory, {force: true, recursive: true}); }
});
test('unsafe scroll and navigation before save do not execute stale input or mutation', async () => {
  const f = fixture([{taskId: task.taskId, action: 'SCROLL', pageType: 'OFFICIAL', scroll: {x: 1, y: 1, deltaY: -9000}}]);
  assert.equal((await discoverCompanyAddress(task, f.deps)).status, 'OPTIMIZATION_PENDING');
  assert.equal(f.issues[0].errorCode, 'INVALID_SCROLL');
  assert.equal(f.calls.some(c => c.action === 'scroll'), false);
  assert.equal(f.writes().length, 0);
});
test('required geocoding failure preserves the address and records an optimization instead of success', async () => {
  const f = fixture(); const api = f.deps.api;
  f.deps.api = async (m, r, b) => { if (r === '/companies/location-positions') throw Error('offline'); return api(m, r, b); };
  const result = await discoverCompanyAddress(task, f.deps);
  assert.equal(result.address, address); assert.equal(result.positioned, false);
  assert.equal(result.status, 'OPTIMIZATION_PENDING');
  assert.equal(f.issues.at(-1).node, 'position');
});

test('existing detailed addresses go directly to serial positioning without opening pages or invoking the model', async () => {
  const f = fixture(), api = f.deps.api;
  const other = '上海市静安区南京西路100号';
  const positions = [];
  f.deps.api = async (method, route, body) => {
    if (route.endsWith('/plan')) return {company: {id: 1, name: task.companyName},
      addresses: [address, other], pendingAddresses: [address, other]};
    if (route === '/companies/location-positions') {
      if (method === 'GET') return positions;
      const p = {address: body.address, longitude: 121.4, latitude: 31.2}; positions.push(p); return p;
    }
    return api(method, route, body);
  };
  const result = await discoverCompanyAddress(task, f.deps);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.positioned, true);
  assert.deepEqual(positions.map(p => p.address), [address, other]);
  assert.equal(f.calls.some(call => call.action), false);
  assert.equal(f.frames.length, 0);
});

test('empty coordinate matches and mismatched readbacks cannot count as completed intake', async () => {
  for (const empty of [true, false]) {
    const f = fixture(), api = f.deps.api;
    f.deps.api = async (method, route, body) => {
      if (route === '/companies/location-positions') return method === 'GET' ? []
        : empty ? {address} : {address, longitude: 121.4, latitude: 31.2};
      return api(method, route, body);
    };
    const result = await discoverCompanyAddress(task, f.deps);
    assert.equal(result.address, address);
    assert.equal(result.status, 'OPTIMIZATION_PENDING');
    assert.equal(f.issues.at(-1).errorCode, empty ? 'GEOCODING_NO_MATCH' : 'POSITION_READBACK_FAILED');
    assert.equal(f.writes().filter(call => call.route.endsWith('/address-discoveries')).length, 1);
  }
});
