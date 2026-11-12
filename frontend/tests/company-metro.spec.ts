import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {expect, test} from './native/harness.mjs';
import {parseMetro} from '../src/company/map/metro';

test('地铁快照含真实上海线路、中文站名和可核对的ODbL来源', async () => {
  const content = await readFile('src/company/assets/shanghai-metro.geojson');
  const data = parseMetro(JSON.parse(content.toString('utf8')));
  const metadata = JSON.parse(await readFile('src/company/assets/shanghai-metro.metadata.json', 'utf8'));
  expect(data.routes.length).toBeGreaterThanOrEqual(18);
  expect(data.stations.length).toBeGreaterThan(400);
  expect(data.routes.map(route => route.ref)).toContain('2');
  expect(data.stations.some(station => station.name === '人民广场' && station.lines.includes('2'))).toBe(true);
  expect(metadata.outputSha256).toBe(createHash('sha256').update(content).digest('hex'));
  expect(metadata.license).toContain('odbl');
  expect(metadata.lineCount).toBe(data.routes.length);
  expect(metadata.stationCount).toBe(data.stations.length);
});

test('地铁按真实坐标离线叠加、缩放显示站名，开关独立于道路且窄屏可用', async ({page}) => {
  await page.setViewportSize({width: 1560, height: 1300});
  const external: string[] = [];
  await page.route('**/*', async route => {
    const request = route.request();
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) {
      external.push(request.url()); return route.abort();
    }
    if (request.method() !== 'GET') return route.abort();
    if (request.url().includes('/api/')) {
      const companies = [{id: 1, name: '地铁旁的公司', address: '上海静安区南京西路', active: true,
        businessType: 'UNKNOWN', productOwnership: 'UNKNOWN', workLocations: [{address: '上海静安区南京西路', longitude: 121.459, latitude: 31.229}]}];
      return route.fulfill({json: {code: 200, result: new URL(request.url()).pathname.endsWith('/companies') ? companies : [],
        page: {totalElements: 1, totalPages: 1}}});
    }
    return route.continue();
  });
  await page.goto('./companies');
  await page.getByText('上海地图', {exact: true}).click();
  const map = page.locator('[data-testid="company-shanghai-map"]');
  const surface = map.locator('.map-canvas');
  const metroPixels = () => surface.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let n = 0; n < pixels.length; n += 4) if (pixels[n] > 160 && pixels[n + 1] < 100 && pixels[n + 2] < 140) count++;
    return count;
  });
  await expect(surface).toHaveAttribute('data-metro-segment-count', '0');
  await map.getByRole('switch', {name: '显示地铁', exact: true}).locator('..').click();
  await expect.poll(async () => Number(await surface.getAttribute('data-metro-segment-count'))).toBeGreaterThan(20);
  await expect.poll(metroPixels).toBeGreaterThan(100);
  await expect.poll(() => map.locator('.metro-label').count()).toBeGreaterThan(3);
  await expect(surface).toHaveAttribute('data-metro-station-count', '0');
  await expect.poll(async () => Number(await map.locator('.road-status').getAttribute('data-road-count'))).toBeGreaterThan(5000);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({path: 'test-results/company-metro-city.png'});
  await map.locator('.company-name').first().click();
  await expect.poll(async () => Number(await surface.getAttribute('data-metro-station-count'))).toBeGreaterThan(10);
  await expect.poll(() => map.locator('.metro-station-label').count()).toBeGreaterThan(3);
  await expect.poll(metroPixels).toBeGreaterThan(100);
  await page.screenshot({path: 'test-results/company-metro-street.png'});
  const labelStyle = await map.locator('.metro-label').first().getAttribute('style');
  const origin = await surface.evaluate(el => {
    const r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
  });
  await page.app.evaluate(({webContents}, {id, origin}) => {
    const target = webContents.fromId(id)!;
    target.sendInputEvent({type: 'mouseDown', ...origin, button: 'left', clickCount: 1});
    target.sendInputEvent({type: 'mouseMove', x: origin.x + 80, y: origin.y + 20, button: 'left'});
    target.sendInputEvent({type: 'mouseUp', x: origin.x + 80, y: origin.y + 20, button: 'left', clickCount: 1});
  }, {id: page.id, origin});
  await expect.poll(() => map.locator('.metro-label').first().getAttribute('style')).not.toBe(labelStyle);
  await expect.poll(metroPixels).toBeGreaterThan(100);
  await map.getByRole('switch', {name: '显示道路', exact: true}).locator('..').click();
  await expect(map.locator('.road-status')).toContainText('道路已隐藏');
  await expect.poll(metroPixels).toBeGreaterThan(100);
  await map.getByRole('switch', {name: '显示地铁', exact: true}).locator('..').click();
  await expect(surface).toHaveAttribute('data-metro-segment-count', '0');
  await expect(map.locator('.metro-label')).toHaveCount(0);
  await expect.poll(metroPixels).toBeLessThan(20);
  await map.getByRole('switch', {name: '显示地铁', exact: true}).locator('..').click();
  await page.setViewportSize({width: 768, height: 1100});
  await expect.poll(() => map.locator('.metro-label').count()).toBeGreaterThan(0);
  await expect.poll(metroPixels).toBeGreaterThan(100);
  await page.screenshot({path: 'test-results/company-metro-768.png'});
  expect(external).toEqual([]);
});

test('地铁加载失败可独立重试，保留公司与道路图层', async ({page}) => {
  let fail = true;
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.method() !== 'GET') return route.abort();
    if (request.url().includes('shanghai-metro-') && fail) return route.abort();
    if (request.url().includes('/api/')) return route.fulfill({json: {code: 200, result: [], page: {totalElements: 0}}});
    return route.continue();
  });
  await page.goto('./companies');
  await page.getByText('上海地图', {exact: true}).click();
  await page.getByRole('switch', {name: '显示地铁', exact: true}).locator('..').click();
  await expect(page.locator('.el-alert')).toContainText('本地地铁加载失败');
  await expect.poll(async () => Number(await page.locator('.road-status').getAttribute('data-road-count'))).toBeGreaterThan(5000);
  fail = false;
  await page.getByRole('button', {name: '重试地铁', exact: true}).click();
  await expect(page.locator('.el-alert')).toHaveCount(0);
  await expect.poll(async () => Number(await page.locator('.map-canvas').getAttribute('data-metro-segment-count'))).toBeGreaterThan(20);
});
