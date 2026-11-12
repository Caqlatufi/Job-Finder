import {Annotation, StateGraph, START, END, MemorySaver, Command, interrupt} from '@langchain/langgraph';
import {ImportError, jobUrl, sameFrame} from './importer.mjs';

const fail = (code, message, status = 'FAILED') => { throw new ImportError(code, message, status); };
const key = text => typeof text === 'string' ? text.normalize('NFKC').replace(/\s/g, '').toLowerCase() : '';
const State = Annotation.Root(Object.fromEntries(['company', 'targets', 'index', 'target', 'captures', 'decision',
  'candidate', 'changed', 'waits', 'pause', 'route', 'result', 'issues', 'addresses'].map(name => [name, Annotation()])));
const searchTargets = company => [
  `${company.name} 上海 办公地址`, `${company.name} 上海 联系我们 办公地点`,
].map(query => ({kind: 'SEARCH', url: 'https://cn.bing.com/search?q=' + encodeURIComponent(query)}));

export function validateAddressDecision(result, task, state) {
  const {captures, target, company} = state;
  const ids = new Set(captures.map(c => c.captureId));
  if (!result || result.taskId !== task.taskId || !['FOUND', 'CLOSED', 'SCROLL', 'NO_ADDRESS', 'WAIT', 'LOGIN', 'CHALLENGE', 'REVIEW'].includes(result.action)
      || !['RECRUITING', 'OFFICIAL', 'SEARCH', 'CLOSED', 'INVALID', 'UNAVAILABLE', 'LOGIN', 'CHALLENGE', 'LOADING'].includes(result.pageType))
    fail('INVALID_RESULT', '地址识别结果格式无效，尚未保存');
  if (result.action === 'CLOSED' || result.pageType === 'CLOSED') {
    if (result.action !== 'CLOSED' || result.pageType !== 'CLOSED' || target.kind !== 'JD'
        || result.companyConfirmed !== true || ![company.name, company.alias].filter(Boolean).map(key).includes(key(result.companyName))
        || key(result.title) !== key(target.title) || typeof result.evidenceText !== 'string'
        || !result.evidenceText.trim() || result.evidenceText.length > 1800
        || !Array.isArray(result.evidenceCaptureIds) || !result.evidenceCaptureIds.length
        || result.evidenceCaptureIds.some(id => !ids.has(id)))
      fail('UNVERIFIED_CLOSED_JD', '尚未确认当前公司岗位已关闭，未写入关闭标记', 'NEEDS_REVIEW');
  }
  if (result.action === 'SCROLL') {
    const s = result.scroll, c = captures.at(-1);
    if (!s || !['x', 'y', 'deltaY'].every(k => Number.isInteger(s[k])) || s.x < c.rect.x || s.y < c.rect.y
        || s.x >= c.rect.x + c.rect.width || s.y >= c.rect.y + c.rect.height || s.deltaY >= 0
        || Math.abs(s.deltaY) > Math.floor(c.viewport.height * 0.65)) fail('INVALID_SCROLL', '地址读取请求了无效滚动，未执行');
  }
  if (result.action === 'NO_ADDRESS' && !['INVALID', 'UNAVAILABLE'].includes(result.pageType)) {
    const coverage = result.coverage;
    if (!coverage?.start || !coverage?.end || !coverage?.continuous || !Array.isArray(coverage.captureIds)
        || coverage.captureIds.length !== ids.size || new Set(coverage.captureIds).size !== ids.size
        || coverage.captureIds.some(id => !ids.has(id)))
      fail('INCOMPLETE_ADDRESS_PAGE', '尚未确认地址区域已完整读取，未推断页面没有地址', 'NEEDS_REVIEW');
  }
  if (result.action !== 'FOUND') return result;
  const address = result.address;
  const names = [company.name, company.alias].filter(Boolean).map(key);
  if (result.companyConfirmed !== true || !names.includes(key(result.companyName)) || typeof address !== 'string'
      || address.length > 255 || !address.includes('上海') || key(address).length < 8
      || /^上海市?([·-]?[\p{Script=Han}]{2,4}区)?$/u.test(key(address))
      || typeof result.evidenceText !== 'string' || !result.evidenceText.trim() || result.evidenceText.length > 1800
      || !Array.isArray(result.evidenceCaptureIds) || !result.evidenceCaptureIds.length || result.evidenceCaptureIds.some(id => !ids.has(id)))
    fail('UNVERIFIED_ADDRESS', '公司身份、上海详细地址或截图证据不完整，尚未保存', 'NEEDS_REVIEW');
  if (target.kind === 'JD') {
    if (!['RECRUITING', 'OFFICIAL'].includes(result.pageType) || result.addressType !== 'JOB_OFFICE'
        || key(result.title) !== key(target.title))
      fail('UNVERIFIED_JOB_ADDRESS', '地址并非当前岗位的明确办公点，尚未保存', 'NEEDS_REVIEW');
  } else if (result.pageType !== 'SEARCH' || result.addressType !== 'COMPANY_OFFICE') {
    fail('UNVERIFIED_COMPANY_ADDRESS', '查询结果未确认公司上海办公地址，注册地址或其他城市地址不会保存', 'NEEDS_REVIEW');
  }
  return result;
}

export function createAddressGraph(task, deps) {
  const {api, workflow, model, remember, progress, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = deps;
  let observedDecision;
  const capture = async () => {
    const c = await workflow('capture', {key: task.tabKey});
    if (c.viewport.width < 420 || c.viewport.height < 220) fail('VIEWPORT_TOO_SMALL', '客户端视口过小，请调整后继续', 'WAITING_USER');
    await remember('capture-' + c.captureId, c);
    return c;
  };
  const guard = (node, fn) => async state => {
    if (node === 'read') observedDecision = undefined;
    await deps.trace?.(node, state);
    try { return await fn(state); }
    catch (error) {
      await deps.checkStopped?.();
      if (error.code === 'ADDRESS_STOPPED') throw error;
      if (!deps.reportIssue) throw error;
      const errorCode = error instanceof ImportError ? error.code : 'UNEXPECTED_BRANCH';
      const message = error instanceof ImportError ? error.message : '节点发生未覆盖异常';
      const issue = await deps.reportIssue({node, errorCode, message, target: state.target,
        captures: state.captures || [], decision: node === 'read' ? observedDecision : state.decision});
      const issues = [...(state.issues || []), issue];
      // Only advance before address writes. An uncertain save/readback must stop, preserving evidence.
      if (['open', 'capture', 'read', 'scroll'].includes(node) && state.targets && state.index + 1 < state.targets.length) {
        await progress({phase: 'TRYING_NEXT_SOURCE', message: '异常已记录，正在尝试下一来源'});
        return {issues, index: state.index + 1, route: 'select'};
      }
      return {issues, result: {status: 'OPTIMIZATION_PENDING', errorCode,
        message: '已记录优化任务', optimizationTasks: issues}, route: 'done'};
    }
  };
  const graph = new StateGraph(State)
    .addNode('prepare', guard('prepare', async () => {
      const plan = await api('GET', `/company-address-tasks/companies/${task.companyId}/plan`);
      const company = plan.company;
      if (company.name !== task.companyName) fail('COMPANY_CHANGED', '公司名称已变化，请重新发起地址查询', 'NEEDS_REVIEW');
      if (company.id !== task.companyId || !Array.isArray(plan.addresses) || !Array.isArray(plan.pendingAddresses)
          || plan.pendingAddresses.some(address => !plan.addresses.includes(address))) fail('INVALID_INTAKE_PLAN', '收录计划与公司地址不一致');
      if (plan.addresses.length) return {company, addresses: plan.pendingAddresses, issues: [],
        result: {address: plan.addresses[0], sourceType: 'EXISTING'}, route: 'position'};
      // The normal JD list is score-ordered. Ask the server explicitly for the newest collected JD.
      const data = await api('GET', `/postings?companyId=${company.id}&sortBy=LATEST&number=1&size=1`, undefined, true);
      const posting = data.result[0], targets = [];
      if (posting?.companyId === company.id && posting.sourceUrl
          && !(posting.addressLookupStatus === 'JD_CLOSED' && posting.addressLookupSourceUrl === posting.sourceUrl)) {
        try {
          targets.push({kind: 'JD', url: jobUrl(posting.sourceUrl), postingId: posting.id, title: posting.title,
            expectedPostingUrl: posting.sourceUrl, expectedLocation: posting.location ?? null});
        } catch { /* The newest JD has no usable link; do not silently substitute an older job. */ }
      }
      return {company, targets: [...targets, ...searchTargets(company)], index: 0, changed: 0,
        issues: [], result: null, route: 'select'};
    }))
    .addNode('select', guard('select', async state => {
      if (state.index >= state.targets.length) return {result: {status: state.issues?.length ? 'OPTIMIZATION_PENDING' : 'NOT_FOUND',
        message: state.issues?.length ? '已记录优化任务' : '未找到详细办公地址', optimizationTasks: state.issues || []}, route: 'done'};
      return {target: state.targets[state.index], captures: [], waits: 0, changed: 0, candidate: null, route: 'open'};
    }))
    .addNode('open', guard('open', async state => {
      const capabilities = await workflow('info');
      if (!capabilities?.genericJobCapture || !capabilities?.companyAddressCapture)
        fail('CLIENT_UPGRADE_REQUIRED', '请保存输入并重启客户端后继续地址查询', 'WAITING_USER');
      await progress({phase: state.target.kind === 'JD' ? 'READING_JD' : 'SEARCHING_COMPANY',
        message: state.target.kind === 'JD' ? '正在从最新 JD 核对工作地址' : '正在查询公司在上海的办公地址'});
      await workflow('openJob', {key: task.tabKey, url: state.target.url});
      for (let n = 0; n < 15; n++) {
        const tab = (await workflow('tabs')).find(t => t.key === task.tabKey);
        if (!tab) fail('TAB_NOT_FOUND', '地址查询标签已关闭，请继续查询', 'WAITING_USER');
        if (tab.status === 'ready') { await wait(1500); return {route: 'capture'}; }
        if (['failed', 'blank'].includes(tab.status)) fail('PAGE_UNAVAILABLE', '来源页面加载失败或空白');
        await wait(1000);
      }
      fail('PAGE_LOAD_TIMEOUT', '地址页面仍在加载，请稍后继续', 'WAITING_USER');
    }))
    .addNode('capture', guard('capture', async state => {
      if (state.captures.length >= 10) fail('CAPTURE_LIMIT', '达到截图上限，尚未取得可确认地址');
      const c = await capture(), first = state.captures[0];
      if (first && (c.sourceUrl !== first.sourceUrl || c.pageRevision !== first.pageRevision))
        fail('PAGE_CHANGED', '地址读取期间页面发生导航，请重新核对', 'NEEDS_REVIEW');
      return {captures: [...state.captures, c], route: 'read'};
    }))
    .addNode('read', guard('read', async state => {
      const input = {taskId: task.taskId, mode: 'ADDRESS', company: {name: state.company.name, alias: state.company.alias},
        target: state.target, captures: state.captures};
      observedDecision = await model(input);
      await remember('decision-' + state.index + '-' + state.captures.length, observedDecision);
      const decision = validateAddressDecision(observedDecision, task, state);
      if (decision.action === 'LOGIN' || decision.pageType === 'LOGIN') fail('LOGIN_REQUIRED', '来源需要登录，已跳过');
      if (decision.action === 'CHALLENGE' || decision.pageType === 'CHALLENGE') fail('VERIFICATION_REQUIRED', '来源出现验证，已跳过');
      if (decision.action === 'WAIT') {
        if (state.waits >= 2) fail('PAGE_UNREADABLE', '地址页面仍未显示，请检查后继续', 'WAITING_USER');
        await wait(2000);
        return {captures: state.captures.slice(0, -1), waits: state.waits + 1, route: 'capture'};
      }
      if (state.target.kind === 'JD' && ['CLOSED', 'REVIEW', 'NO_ADDRESS'].includes(decision.action))
        return {decision, route: 'recordJdFailure'};
      if (decision.action === 'NO_ADDRESS' && ['INVALID', 'UNAVAILABLE'].includes(decision.pageType))
        fail('SOURCE_UNAVAILABLE', '来源失效或无法读取，不能认定完整页面没有地址');
      if (decision.action === 'REVIEW') fail('ADDRESS_NEEDS_REVIEW', decision.reason || '地址存在歧义，需人工核实', 'NEEDS_REVIEW');
      if (decision.action === 'FOUND') return {candidate: decision, route: 'save'};
      if (decision.action === 'SCROLL') return {decision, route: 'scroll'};
      let index = state.index + 1;
      // An official JD with no office address goes directly to company address search.
      if (state.target.kind === 'JD' && decision.pageType === 'OFFICIAL') index = state.targets.findIndex(t => t.kind === 'SEARCH');
      return {index, route: 'select'};
    }))
    .addNode('recordJdFailure', guard('recordJdFailure', async state => {
      const fresh = await capture();
      if (!sameFrame(state.captures.at(-1), fresh)) {
        if (state.changed >= 3) fail('PAGE_CHANGED', '记录前岗位页面持续变化，请稳定后继续', 'WAITING_USER');
        return {captures: [], changed: state.changed + 1, route: 'capture'};
      }
      const decision = state.decision;
      const status = decision.action === 'CLOSED' ? 'JD_CLOSED'
        : decision.action === 'NO_ADDRESS' && !['INVALID', 'UNAVAILABLE'].includes(decision.pageType) ? 'NO_ADDRESS' : 'FAILED';
      const message = (status === 'JD_CLOSED' ? 'JD 已关闭，地址获取失败'
        : decision.reason || (status === 'NO_ADDRESS' ? 'JD 未提供详细工作地址' : 'JD 地址获取失败')).slice(0, 500);
      const request = {expectedCompanyId: state.company.id, expectedTitle: state.target.title,
        expectedSourceUrl: state.target.expectedPostingUrl, status, message,
        evidence: ((decision.evidenceText || decision.reason || message).slice(0, 1800)
          + '\n截图证据：' + state.captures.map(c => c.captureId).join('、')).slice(0, 2000)};
      await remember('jd-address-lookup-' + state.target.postingId, request);
      await api('POST', `/postings/${state.target.postingId}/address-lookup`, request);
      const verified = await api('GET', '/postings/' + state.target.postingId);
      if (verified.addressLookupStatus !== status || verified.addressLookupSourceUrl !== state.target.expectedPostingUrl)
        fail('JD_LOOKUP_READBACK_FAILED', 'JD地址获取结果回读不一致，请核对后重试');
      await progress({phase: 'SEARCHING_COMPANY', message: '正在查询公司在上海的办公地址'});
      const issues = [...(state.issues || [])];
      if (status === 'FAILED' && deps.reportIssue) issues.push(await deps.reportIssue({node: 'read',
        errorCode: 'JD_ADDRESS_UNREADABLE', message: 'JD地址无法自动确认，已记录岗位获取失败并转公司搜索',
        target: state.target, captures: state.captures, decision}));
      return {issues, index: state.targets.findIndex(t => t.kind === 'SEARCH'), route: 'select'};
    }))
    .addNode('scroll', guard('scroll', async state => {
      const fresh = await capture();
      if (!sameFrame(state.captures.at(-1), fresh)) {
        if (state.changed >= 3) fail('PAGE_CHANGED', '地址页面持续变化，请稳定后继续', 'WAITING_USER');
        return {captures: state.captures.slice(0, -1), changed: state.changed + 1, route: 'capture'};
      }
      await workflow('scroll', {key: task.tabKey, captureId: fresh.captureId, ...state.decision.scroll, deltaX: 0});
      await wait(700);
      return {route: 'capture'};
    }))
    .addNode('save', guard('save', async state => {
      const fresh = await capture();
      if (!sameFrame(state.captures.at(-1), fresh)) {
        if (state.changed >= 3) fail('PAGE_CHANGED', '保存前页面持续变化，请稳定后继续', 'WAITING_USER');
        return {captures: [], candidate: null, changed: state.changed + 1, route: 'capture'};
      }
      const c = state.candidate, isJd = state.target.kind === 'JD';
      const request = {expectedCompanyName: state.company.name, address: c.address,
        sourceUrl: isJd ? state.target.expectedPostingUrl : state.target.url, taskId: task.taskId,
        evidenceText: c.evidenceText + '\n截图证据：' + c.evidenceCaptureIds.join('、'),
        ...(isJd ? {expectedPostingUrl: state.target.expectedPostingUrl, expectedLocation: state.target.expectedLocation} : {})};
      await progress({phase: 'SAVING', message: '正在保存地址与来源证据并回读验证'});
      await remember('validated-address', {target: state.target, request});
      const path = isJd ? `/postings/${state.target.postingId}/address-discoveries` : `/companies/${state.company.id}/address-discoveries`;
      const saved = await api('POST', path, request);
      const verified = (await api('GET', '/companies/address-discoveries')).find(row => row.id === saved.id);
      if (!verified || verified.companyId !== state.company.id || key(verified.address) !== key(c.address)
          || verified.sourceType !== (isJd ? 'JD' : 'COMPANY')) fail('ADDRESS_READBACK_FAILED', '地址回读不一致，请核对；重试不会覆盖其他资料');
      if (isJd && key((await api('GET', '/postings/' + state.target.postingId)).location) !== key(saved.address))
        fail('ADDRESS_READBACK_FAILED', '岗位地址回读不一致，请核对后重试');
      return {result: {address: saved.address, sourceType: saved.sourceType}, addresses: [saved.address], route: 'position'};
    }))
    .addNode('position', guard('position', async state => {
      await progress({phase: 'POSITIONING', message: '正在匹配地理位置并回读验证'});
      const issues = [...(state.issues || [])];
      let failed = false, index = 0;
      for (const address of state.addresses) {
        try {
          const position = await api('POST', '/companies/location-positions', {address});
          const {longitude, latitude} = position;
          if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < 120.8 || longitude > 122.2
              || latitude < 30.65 || latitude > 31.95) fail('GEOCODING_NO_MATCH', '地址已保存，未匹配到可信的上海办公位置');
          const verified = (await api('GET', '/companies/location-positions')).find(row => key(row.address) === key(address));
          if (!verified || verified.longitude !== longitude || verified.latitude !== latitude)
            fail('POSITION_READBACK_FAILED', '地址已保存，位置回读不一致');
          await remember('position-' + index++, {address, longitude, latitude});
        } catch (error) {
          await deps.checkStopped?.();
          if (error.code === 'ADDRESS_STOPPED') throw error;
          if (!deps.reportIssue) throw error;
          failed = true;
          issues.push(await deps.reportIssue({node: 'position', errorCode: error.code || 'GEOCODING_FAILED',
            message: error instanceof ImportError ? error.message : '地址已保存，位置匹配调用失败',
            target: {kind: 'POSITION', address}, captures: state.captures || []}));
        }
      }
      return {result: {...state.result, status: failed ? 'OPTIMIZATION_PENDING' : 'SUCCEEDED', positioned: !failed,
        optimizationTasks: issues, message: failed ? '地址已保存，位置匹配已记录优化任务' : '地址与地理位置已收录'}, route: 'done'};
    }))
    // Kept only to replay historical interrupted checkpoints; new runs never route here.
    .addNode('waitForUser', state => { interrupt(state.pause); return {route: 'prepare'}; })
    .addEdge(START, 'prepare').addEdge('waitForUser', 'prepare');
  const routes = {select: 'select', open: 'open', capture: 'capture', read: 'read', recordJdFailure: 'recordJdFailure',
    scroll: 'scroll', save: 'save', position: 'position', pause: 'waitForUser', done: END};
  for (const node of ['prepare', 'select', 'open', 'capture', 'read', 'recordJdFailure', 'scroll', 'save', 'position']) graph.addConditionalEdges(node, s => s.route, routes);
  return graph.compile({checkpointer: deps.checkpointer || new MemorySaver()});
}

export async function discoverCompanyAddress(task, deps) {
  const graph = createAddressGraph(task, deps);
  const config = {configurable: {thread_id: task.taskId}, recursionLimit: 220};
  const prior = await graph.getState(config);
  let input = {};
  if (prior.tasks?.some(t => t.interrupts?.length)) input = new Command({resume: true});
  else if (prior.createdAt) { await graph.updateState(config, {route: 'prepare', result: null, issues: []}, 'waitForUser'); input = null; }
  const state = await graph.invoke(input, config);
  if (state.result) return state.result;
  const pause = (await graph.getState(config)).values.pause;
  if (pause) fail(pause.code, pause.message, 'WAITING_USER');
  fail('ADDRESS_LOOKUP_FAILED', '地址流程未返回结果，请重试');
}
