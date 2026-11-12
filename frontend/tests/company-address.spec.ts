import {expect, test} from './native/harness.mjs';

test('JD关闭和地址获取失败仅显示在对应岗位，详情可查看证据（隔离模拟）', async ({page}) => {
  await page.setViewportSize({width: 1000, height: 1200});
  const base = {companyId: 21, companyName: '多JD夹具公司', direction: 'FULL_STACK', source: 'OTHER',
    rawJd: '夹具岗位正文', stage: 'SCREENED', tier: 'B', totalScore: 50, location: '上海',
    matchScore: 25, companyScore: 10, freshnessScore: 5, commuteScore: 5, salaryScore: 5};
  const closedPosting = {...base, id: 11, title: '已关闭夹具岗位', sourceUrl: 'https://example.com/11',
    addressLookupStatus: 'JD_CLOSED', addressLookupMessage: 'JD 已关闭，地址获取失败',
    addressLookupCheckedAt: '2026-11-05T20:00:00', addressLookupSourceUrl: 'https://example.com/11',
    addressLookupEvidence: '已关闭夹具岗位：该职位已关闭；截图证据c1'};
  const postings = [closedPosting, {...base, id: 12, title: '正常夹具岗位'}];
  await page.route('**/api/**', async route => {
    const r = route.request(), url = new URL(r.url());
    if (r.method() !== 'GET') return route.abort();
    const result = url.pathname.endsWith('/postings') ? postings : url.pathname.endsWith('/postings/11') ? closedPosting : [];
    return route.fulfill({json: {code: 200, result, page: {totalElements: 2, totalPages: 1}}});
  });
  await page.goto('./postings');
  const row = page.locator('.el-table__row').filter({hasText: closedPosting.title});
  await expect(row.getByText('JD 已关闭 · 地址获取失败', {exact: true})).toBeVisible();
  await expect(page.locator('.el-table__row').filter({hasText: '正常夹具岗位'}).locator('.posting-address-lookup')).toHaveCount(0);
  await row.getByRole('button', {name: closedPosting.title, exact: true}).click();
  const detail = page.locator('.el-drawer');
  await expect(detail.getByText('JD 已关闭 · 地址获取失败', {exact: true})).toBeVisible();
  await detail.locator('.posting-address-lookup summary').click();
  await expect(detail.locator('.posting-address-lookup')).toContainText('该职位已关闭；截图证据c1');
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
  await page.screenshot({path: 'test-results/jd-address-closed-1000.png'});
});
