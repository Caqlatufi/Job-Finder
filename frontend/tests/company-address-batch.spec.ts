import {expect, test} from './native/harness.mjs';

test('收录问题标黑并显示简短原因，新一轮清除旧提示，同任务新尝试完成后刷新地址与坐标（隔离模拟）', async ({page}) => {
  await page.setViewportSize({width: 1440, height: 1200});
  const companies = [{id: 1, name: '截图失败公司', address: '上海'}, {id: 2, name: '位置未匹配公司', address: '上海徐汇区虹梅路1801号'},
    {id: 3, name: '收录完成公司', address: '上海静安区南京西路100号'}]
    .map(row => ({...row, businessType: 'UNKNOWN', productOwnership: 'UNKNOWN', active: true}));
  let batch = {status: 'COMPLETED', unrecorded: 2, total: 2, completed: 2, succeeded: 0, skipped: 2, remaining: 0};
  let tasks = [{taskId: 'same-task', companyId: 1, status: 'OPTIMIZATION_PENDING', errorCode: 'INVALID_CAPTURE_RECT', attempt: 1},
    {taskId: 'position-task', companyId: 2, status: 'OPTIMIZATION_PENDING', errorCode: 'GEOCODING_NO_MATCH', attempt: 1},
    {taskId: 'done-task', companyId: 3, status: 'SUCCEEDED', errorCode: '', attempt: 1}];
  let discoveries: any[] = [], positions: any[] = [];
  const mutations: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/batch/start')) {
      mutations.push(path); batch = {...batch, status: 'RUNNING', remaining: 2};
      tasks = tasks.map(task => task.companyId === 3 ? task : {...task, status: 'QUEUED', errorCode: ''});
      return route.fulfill({json: {code: 200, result: batch}});
    }
    if (request.method() !== 'GET') { mutations.push(path); return route.abort(); }
    const result = path.endsWith('/batch') ? batch : path.endsWith('/companies') ? companies
      : path.endsWith('/company-address-tasks') ? tasks : path.endsWith('/address-discoveries') ? discoveries
      : path.endsWith('/location-positions') ? positions : [];
    return route.fulfill({json: {code: 200, result, page: {totalElements: companies.length, totalPages: 1}}});
  });
  await page.goto('./companies'); await page.getByText('上海地图', {exact: true}).click();
  const first = page.locator('.location-card[data-company-id="1"]'), second = page.locator('.location-card[data-company-id="2"]');
  await expect(first).toHaveClass(/address-failed/);
  await expect(first).toContainText('来源页面截图失败');
  await expect(second).toHaveClass(/address-failed/);
  await expect(second).toHaveCSS('border-left-color', 'rgb(23, 28, 25)');
  await expect(second).toContainText('暂未匹配到可靠的地图位置');
  await expect(page.locator('.location-card[data-company-id="3"]')).not.toHaveClass(/address-failed/);
  await expect(page.getByRole('button', {name: '新增公司', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: '匹配地图坐标', exact: true})).toHaveCount(0);
  await page.screenshot({path: 'test-results/address-intake-black.png'});
  await page.getByRole('button', {name: '开始收录地址', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止收录', exact: true})).toBeVisible();
  await expect(page.locator('.intake-failure')).toHaveCount(0);
  const address = '上海市徐汇区宜山路868号';
  discoveries = [{id: 1, companyId: 1, address, sourceType: 'COMPANY'}];
  positions = [{address, longitude: 121.43, latitude: 31.18}];
  tasks = tasks.map(task => task.companyId === 1 ? {...task, status: 'SUCCEEDED', attempt: 2}
    : task.companyId === 2 ? {...task, status: 'OPTIMIZATION_PENDING', errorCode: 'GEOCODING_FAILED', attempt: 2} : task);
  batch = {...batch, status: 'COMPLETED', unrecorded: 1, remaining: 0};
  await expect(first).toContainText(address);
  await expect(first).toHaveClass(/address-recorded/);
  await expect(first).not.toHaveClass(/address-failed/);
  await expect(second).toContainText('地图位置匹配暂不可用');
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 1 家');
  expect(mutations).toHaveLength(1);
});

test('历史批次不占页面，始终显示当前未收录数量，开始停止刷新后保持一致（隔离模拟）', async ({page}) => {
  await page.setViewportSize({width: 720, height: 1200});
  const companies = [{id: 1, name: '待收录夹具公司', address: '上海'}, {id: 2, name: '已有地址夹具公司', address: '上海徐汇区宜山路868号'}]
    .map(row => ({...row, businessType: 'UNKNOWN', productOwnership: 'UNKNOWN', active: true}));
  let batch = {batchId: 'previous', status: 'COMPLETED', unrecorded: 1, total: 66, completed: 66, succeeded: 6, skipped: 60, remaining: 0, currentCompany: ''};
  let tasks: any[] = [], discoveries: any[] = [], starts = 0, stops = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname.endsWith('/batch/start')) {
      starts++; batch = {...batch, batchId: 'fixture', status: 'RUNNING', unrecorded: 1, total: 1, remaining: 1, currentCompany: companies[0].name};
      return route.fulfill({json: {code: 200, result: batch}});
    }
    if (request.method() === 'POST' && pathname.endsWith('/batch/stop')) {
      stops++; batch = {...batch, status: 'STOPPED', currentCompany: ''};
      return route.fulfill({json: {code: 200, result: batch}});
    }
    if (request.method() !== 'GET') return route.abort();
    const result = pathname.endsWith('/batch') ? batch : pathname.endsWith('/companies') ? companies
      : pathname.endsWith('/company-address-tasks') ? tasks : pathname.endsWith('/address-discoveries') ? discoveries : [];
    return route.fulfill({json: {code: 200, result, page: {totalElements: 2, totalPages: 1}}});
  });
  await page.goto('./companies'); await page.getByText('上海地图', {exact: true}).click();
  await expect(page.getByRole('button', {name: '补全地址', exact: true})).toHaveCount(0);
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 1 家');
  await expect(page.locator('.address-batch-progress, .map-actions .el-progress')).toHaveCount(0);
  await expect(page.getByText('66/66', {exact: false})).toHaveCount(0);
  await expect(page.getByText('本轮完成', {exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: '开始收录地址', exact: true}).click();
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 1 家');
  await expect(page.getByRole('button', {name: '停止收录', exact: true})).toBeVisible();
  await page.getByRole('button', {name: '停止收录', exact: true}).click();
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 1 家');
  await expect(page.getByRole('button', {name: '停止收录', exact: true})).toHaveCount(0);
  await page.reload(); await page.getByText('上海地图', {exact: true}).click();
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 1 家');
  await page.getByRole('button', {name: '开始收录地址', exact: true}).click();
  await expect(page.getByRole('button', {name: '停止收录', exact: true})).toBeVisible();
  const address = '上海静安区南京西路100号';
  discoveries = [{id: 1, companyId: 1, address, sourceType: 'COMPANY', sourceUrl: 'https://example.com', evidenceText: address}];
  tasks = [{taskId: 'fixture', companyId: 1, status: 'SUCCEEDED'}];
  batch = {...batch, status: 'COMPLETED', unrecorded: 0, completed: 1, succeeded: 1, remaining: 0, currentCompany: ''};
  await expect(page.locator('.location-card[data-company-id="1"]')).toContainText(address);
  await expect(page.locator('.location-card[data-company-id="1"]')).toHaveClass(/address-recorded/);
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 0 家');
  await expect(page.getByRole('button', {name: '开始收录地址', exact: true})).not.toBeEnabled();
  expect(starts).toBe(2); expect(stops).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: 'test-results/address-batch-720.png'});
});

test('批次请求失败可再次开始，停止过程中不允许重复操作，空批次完成（隔离模拟）', async ({page}) => {
  let fail = true, batch = {status: 'IDLE', total: 0, unrecorded: 1, completed: 0, succeeded: 0, skipped: 0, remaining: 0};
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname.endsWith('/batch/start')) {
      if (fail) return route.fulfill({status: 500, json: {code: 50001, msg: '收录启动暂不可用'}});
      batch = {...batch, status: 'COMPLETED', unrecorded: 0};
      return route.fulfill({json: {code: 200, result: batch}});
    }
    if (request.method() !== 'GET') return route.abort();
    return route.fulfill({json: {code: 200, result: pathname.endsWith('/batch') ? batch : [], page: {totalElements: 0, totalPages: 1}}});
  });
  await page.goto('./companies'); await page.getByText('上海地图', {exact: true}).click();
  await page.getByRole('button', {name: '开始收录地址', exact: true}).click();
  await expect(page.getByText('收录启动暂不可用', {exact: true})).toBeVisible();
  fail = false; await page.getByRole('button', {name: '开始收录地址', exact: true}).click();
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 0 家');
  batch = {...batch, status: 'STOPPING'};
  await expect(page.getByRole('button', {name: '停止收录', exact: true})).not.toBeEnabled();
  await expect(page.locator('.address-unrecorded')).toHaveText('剩余未收录 0 家');
});
