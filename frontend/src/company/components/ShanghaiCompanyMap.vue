<script setup lang="ts">
import {companyApi} from '@/company/api/companyApi';
import {companyAddressApi, type AddressDiscovery} from '@/company/api/companyAddressApi';
import {useCompanyAddressTasks} from '@/company/useCompanyAddressTasks';
import {intakeFailure} from '@/company/map/intake';
import shanghai from '@/company/assets/shanghai.json';
import {collectLocations, districts, isAreaOnly, precisionLabel,
  type LocationPosition, type MapLocation, type PostingLocation} from '@/company/map/locations';
import {parseRoads, projectMercator, unprojectMercator, RoadIndex, roadLabels, roadLevelLabel, roadPixel,
  roadTier, roadTransform, roadCoordinate, type Coordinate, type RoadLabel, type RoadTransform} from '@/company/map/roads';
import {RoadLayer} from '@/company/map/roadLayer';
import {parseMetro, type MetroData, type MetroLabel} from '@/company/map/metro';
import {MetroLayer} from '@/company/map/metroLayer';
import type {Company} from '@/common/model/domain';
import {ScatterChart} from 'echarts/charts';
import {GeoComponent, TooltipComponent} from 'echarts/components';
import {init, registerMap, use, type EChartsType} from 'echarts/core';
import {CanvasRenderer} from 'echarts/renderers';
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';

use([ScatterChart, GeoComponent, TooltipComponent, CanvasRenderer]);
registerMap('shanghai-workplaces', shanghai as unknown as Parameters<typeof registerMap>[1]);
// North-up Mercator coordinates; the same projection is used for boundaries, markers and focus.
const projection = {project: projectMercator, unproject: unprojectMercator};
const props = defineProps<{companies: Company[]}>();
const canvas = ref<HTMLDivElement>();
const postings = ref<PostingLocation[]>([]);
const positions = ref<LocationPosition[]>([]);
const discoveries = ref<AddressDiscovery[]>([]);
const loading = ref(true);
const error = ref('');
const search = ref('');
const district = ref('');
const status = ref('');
const selected = ref<string[]>([]);
const selectedCompanyId = ref<number>();
const roadsVisible = ref(true);
const roadsLoading = ref(false);
const roadsError = ref('');
const roadsCount = ref(0);
const roadVisibleCount = ref(0);
const roadVertexCount = ref(0);
const currentRoadTier = ref(0);
const labels = ref<RoadLabel[]>([]);
const metroVisible = ref(false);
const metroLoading = ref(false);
const metroError = ref('');
const metroLabels = ref<MetroLabel[]>([]);
const metroSegmentCount = ref(0);
const metroStationCount = ref(0);
let metroData: MetroData | undefined;
let metroLayer: MetroLayer | undefined;
let metroController: AbortController | undefined;
let metroLabelFrame: {transform: RoadTransform; labels: MetroLabel[]} | undefined;
let roadIndex: RoadIndex | undefined;
let roadLayer: RoadLayer | undefined;
let labelFrame: {transform: RoadTransform; labels: RoadLabel[]} | undefined;
let roadController: AbortController | undefined;
let roadTimer: ReturnType<typeof setTimeout> | undefined;
let roadFrame: number | undefined;
let chart: EChartsType | undefined;
let observer: ResizeObserver | undefined;
let disposed = false;
const getErrorMessage = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

const locations = computed(() => collectLocations(props.companies, postings.value, positions.value, discoveries.value));
const shanghaiLocations = computed(() => locations.value.filter(location => location.precision !== 'OUTSIDE'));
const companiesWithAddress = computed(() => new Set(shanghaiLocations.value
  .filter(location => !isAreaOnly(location.address)).map(location => location.company.id)));
const outsideCount = computed(() => locations.value.length - shanghaiLocations.value.length);
const locatedCount = computed(() => shanghaiLocations.value.filter(location => ['MANUAL', 'PLACE'].includes(location.precision)).length);
const areaCount = computed(() => shanghaiLocations.value.filter(location => location.precision === 'DISTRICT').length);
const pendingCount = computed(() => shanghaiLocations.value.filter(location => location.precision === 'PENDING').length);
const filtered = computed(() => shanghaiLocations.value.filter(location => {
  const keyword = search.value.trim().toLowerCase();
  return (!keyword || `${location.company.name} ${location.company.alias || ''} ${location.label} ${location.address}`.toLowerCase().includes(keyword))
    && (!district.value || location.district === district.value)
    && (!status.value || (status.value === 'LOCATED' ? ['MANUAL', 'PLACE'].includes(location.precision) : location.precision === status.value));
}));
const visibleList = computed(() => {
  if (selectedCompanyId.value != null) return filtered.value.filter(location => location.company.id === selectedCompanyId.value);
  return selected.value.length ? filtered.value.filter(location => selected.value.includes(location.key)) : filtered.value;
});
const groups = computed(() => {
  const groups = new Map<string, MapLocation[]>();
  for (const location of filtered.value) {
    if (location.longitude == null || location.latitude == null || location.precision === 'PENDING') continue;
    const key = `${location.longitude.toFixed(6)},${location.latitude.toFixed(6)}`;
    groups.set(key, [...(groups.get(key) ?? []), location]);
  }
  return [...groups.values()];
});

const moveRoads = () => {
  if (!chart || disposed) return;
  const transform = roadTransform(coordinate => chart!.convertToPixel({geoIndex: 0}, coordinate) as number[]);
  roadLayer?.move(transform, chart.getWidth(), chart.getHeight());
  metroLayer?.move(transform, chart.getWidth(), chart.getHeight());
  if (labelFrame) {
    const old = labelFrame.transform;
    labels.value = labelFrame.labels.map(label => ({name: label.name,
      x: (label.x - old.x) / old.scaleX * transform.scaleX + transform.x,
      y: (label.y - old.y) / old.scaleY * transform.scaleY + transform.y}));
  }
  if (metroLabelFrame) {
    const old = metroLabelFrame.transform;
    metroLabels.value = metroLabelFrame.labels.map(label => ({...label,
      x: (label.x - old.x) / old.scaleX * transform.scaleX + transform.x,
      y: (label.y - old.y) / old.scaleY * transform.scaleY + transform.y}));
  }
};
const refreshRoads = () => {
  if (!chart || disposed) return;
  const geo = (chart.getOption().geo as {zoom?: number}[] | undefined)?.[0];
  if (!geo) return;
  currentRoadTier.value = roadTier(geo.zoom ?? 1);
  const width = chart.getWidth(), height = chart.getHeight();
  const transform = roadTransform(coordinate => chart!.convertToPixel({geoIndex: 0}, coordinate) as number[]);
  const project = (coordinate: Coordinate) => roadPixel(transform, coordinate);
  const a = roadCoordinate(transform, [0, 0]);
  const b = roadCoordinate(transform, [width, height]);
  const entries = roadsVisible.value ? roadIndex?.query([[Math.min(a[0], b[0]), Math.min(a[1], b[1])],
    [Math.max(a[0], b[0]), Math.max(a[1], b[1])]], currentRoadTier.value) ?? [] : [];
  const stats = roadLayer?.setRoads(entries, transform, width, height);
  roadVisibleCount.value = stats?.visible ?? 0;
  roadVertexCount.value = stats?.vertices ?? 0;
  roadLayer?.move(transform, width, height);
  const markers = groups.value.map(group => project([group[0].longitude!, group[0].latitude!]));
  const metro = metroLayer?.update(metroVisible.value ? metroData : undefined, transform, width, height,
    geo.zoom ?? 1, markers);
  metroLabels.value = metro?.labels ?? [];
  metroSegmentCount.value = metro?.segments ?? 0;
  metroStationCount.value = metro?.stations ?? 0;
  metroLabelFrame = {transform, labels: metroLabels.value};
  labels.value = roadLabels(entries, project, width, height,
    [...markers, ...metroLabels.value.map(label => [label.x, label.y])]);
  labelFrame = {transform, labels: labels.value};
};
const scheduleRoads = () => {
  if (roadFrame == null) roadFrame = requestAnimationFrame(() => { roadFrame = undefined; moveRoads(); });
  // Refill at most once per 150 ms during a continuous drag; transforms stay frame-synchronous.
  if (roadTimer == null) roadTimer = setTimeout(() => { roadTimer = undefined; refreshRoads(); }, 150);
};
const loadRoads = async () => {
  roadController?.abort();
  roadController = new AbortController();
  roadsLoading.value = true;
  roadsError.value = '';
  try {
    const response = await fetch(new URL('../assets/shanghai-roads.geojson', import.meta.url), {signal: roadController.signal});
    if (!response.ok) throw new Error('道路文件加载失败');
    const entries = parseRoads(await response.json());
    if (disposed) return;
    if (!entries.length) throw new Error('道路文件没有可显示的道路');
    roadIndex = new RoadIndex(entries);
    roadsCount.value = entries.length;
    refreshRoads();
  } catch (failure) {
    if (!disposed && !(failure instanceof DOMException && failure.name === 'AbortError')) roadsError.value = '本地道路加载失败，可重试；公司地点仍可查看';
  } finally {
    if (!disposed) roadsLoading.value = false;
  }
};
const loadMetro = async () => {
  metroController?.abort();
  const controller = new AbortController();
  metroController = controller;
  metroLoading.value = true; metroError.value = '';
  try {
    const response = await fetch(new URL('../assets/shanghai-metro.geojson', import.meta.url), {signal: controller.signal});
    if (!response.ok) throw new Error('地铁文件加载失败');
    const data = parseMetro(await response.json());
    if (disposed || controller !== metroController) return;
    metroData = data; refreshRoads();
  } catch (failure) {
    if (!disposed && !controller.signal.aborted) metroError.value = '本地地铁加载失败，可重试；公司地点仍可查看';
  } finally {
    if (!disposed && controller === metroController) metroLoading.value = false;
  }
};
const render = (reset = false) => {
  if (!chart) return;
  const previous = (chart.getOption()?.geo as {center?: number[]; zoom?: number}[] | undefined)?.[0];
  chart.setOption({
    animation: false,
    tooltip: {renderMode: 'richText', trigger: 'item', formatter: (raw: unknown) => {
      const param = raw as {data?: {locations?: MapLocation[]}; name?: string};
      const entries = param.data?.locations;
      if (!entries) return param.name || '';
      const names = [...new Set(entries.map(location => location.company.name))];
      return `${names.slice(0, 5).join('\n')}${names.length > 5 ? `\n等 ${names.length} 家公司` : ''}\n${entries.length} 个地点 · 点击查看\n${precisionLabel[entries[0].precision]}`;
    }},
    geo: {
      map: 'shanghai-workplaces', roam: true, zoom: reset ? 1 : previous?.zoom ?? 1,
      center: reset ? undefined : previous?.center, scaleLimit: {min: 0.8, max: 18},
      projection, layoutCenter: ['50%', '50%'], layoutSize: '94%',
      label: {show: true, color: '#697a70', fontSize: 11},
      itemStyle: {areaColor: '#edf2eb', borderColor: '#a9b9a9', borderWidth: 1},
      emphasis: {label: {color: '#263d32'}, itemStyle: {areaColor: '#dce7da'}},
    },
    series: [{
      id: 'workplaces', type: 'scatter', coordinateSystem: 'geo', z: 5,
      label: {show: true, color: '#fff', fontSize: 10, fontWeight: 'bold', formatter: (raw: unknown) => {
        const data = (raw as {data: {locations: MapLocation[]}}).data;
        return data.locations.length > 1 ? String(data.locations.length) : '';
      }},
      data: groups.value.map(entries => {
        const active = entries.some(location => selected.value.includes(location.key) || location.company.id === selectedCompanyId.value);
        const area = entries.every(location => location.precision === 'DISTRICT');
        return {
          name: entries[0].company.name, value: [entries[0].longitude, entries[0].latitude, entries.length], locations: entries,
          symbol: area ? 'diamond' : 'circle', symbolSize: active ? 25 : Math.min(32, 12 + Math.sqrt(entries.length) * 3),
          itemStyle: {color: active ? '#d18422' : area ? '#8b95a5' : '#2e7763', borderColor: '#fff', borderWidth: 2, opacity: 0.95},
        };
      }),
    }],
  }, true);
  refreshRoads();
};

const clearSelection = () => { selected.value = []; selectedCompanyId.value = undefined; };
const focusCompany = (location: MapLocation) => {
  selected.value = [];
  selectedCompanyId.value = location.company.id;
  const points = filtered.value.filter(item => item.company.id === location.company.id && item.longitude != null);
  if (points.length) chart?.setOption({geo: {center: projection.project([points[0].longitude!, points[0].latitude!]), zoom: 6}});
  scheduleRoads();
};
const zoomMap = (factor: number) => {
  if (!chart) return;
  const current = (chart.getOption().geo as {zoom?: number}[])[0].zoom ?? 1;
  chart.setOption({geo: {zoom: Math.min(18, Math.max(0.8, current * factor))}});
  refreshRoads();
};
const resetMap = () => { clearSelection(); render(true); };

const load = async () => {
  loading.value = true;
  error.value = '';
  try {
    const [postingRows, cachedPositions, foundAddresses] = await Promise.all([companyApi.postingLocations(), companyApi.positions(), companyAddressApi.discoveries()]);
    if (disposed) return;
    postings.value = postingRows;
    positions.value = cachedPositions;
    discoveries.value = foundAddresses;
    await nextTick();
    render();
  } catch (failure) {
    if (!disposed) error.value = getErrorMessage(failure, '工作地点加载失败');
  } finally {
    if (!disposed) loading.value = false;
  }
};
const {batch: addressBatch, tasks: addressTasks, busy: addressBusy, active: addressActive, error: addressError,
  refresh: refreshAddressTasks, start: startAddressBatch, stop: stopAddressBatch} = useCompanyAddressTasks(load);
const addressFailures = computed(() => {
  const failures = new Map<number, string>();
  for (const task of addressTasks.value) {
    const reason = intakeFailure(task);
    if (reason && !failures.has(task.companyId)) failures.set(task.companyId, reason);
  }
  return failures;
});

watch([filtered, selected, selectedCompanyId], () => render(), {deep: true});
watch([search, district, status], clearSelection);
watch(roadsVisible, refreshRoads);
watch(metroVisible, visible => {
  if (visible && !metroData && !metroLoading.value) void loadMetro();
  refreshRoads();
});
onMounted(async () => {
  if (canvas.value) {
    chart = init(canvas.value);
    roadLayer = new RoadLayer(chart);
    metroLayer = new MetroLayer(chart);
    chart.on('georoam', scheduleRoads);
    chart.on('click', raw => {
      const params = raw as {componentType?: string; name?: string; data?: {locations?: MapLocation[]}};
      if (params.data?.locations) {
        selectedCompanyId.value = undefined;
        selected.value = params.data.locations.map(location => location.key);
      } else if (params.componentType === 'geo' && params.name) {
        district.value = params.name;
      }
    });
    observer = new ResizeObserver(() => { chart?.resize(); scheduleRoads(); });
    observer.observe(canvas.value);
  }
  await Promise.all([load(), loadRoads()]);
});
onBeforeUnmount(() => {
  disposed = true; roadController?.abort(); metroController?.abort(); clearTimeout(roadTimer);
  if (roadFrame != null) cancelAnimationFrame(roadFrame);
  observer?.disconnect(); roadLayer?.dispose(); metroLayer?.dispose(); chart?.dispose();
});
</script>

<template>
  <div class="workplace-panel" data-testid="company-shanghai-map">
    <div class="map-heading">
      <div><h2>上海工作地点</h2></div>
      <div class="map-actions">
        <span v-if="addressBatch" class="address-unrecorded" role="status">剩余未收录 {{ addressBatch.unrecorded }} 家</span>
        <el-button v-if="addressActive" :loading="addressBusy || addressBatch?.status === 'STOPPING'"
          :disabled="addressBusy || addressBatch?.status === 'STOPPING'" @click="stopAddressBatch">停止收录</el-button>
        <el-button v-else type="primary" :loading="addressBusy" :disabled="loading || !!error || addressBatch?.unrecorded === 0" @click="startAddressBatch">开始收录地址</el-button>
        <el-switch v-model="roadsVisible" active-text="道路" aria-label="显示道路" />
        <el-switch v-model="metroVisible" active-text="地铁" aria-label="显示地铁" />
        <el-button @click="resetMap">全上海</el-button>
      </div>
    </div>
    <div class="map-summary">
      <span>{{ new Set(shanghaiLocations.map(item => item.company.id)).size }} 家公司</span>
      <span>{{ shanghaiLocations.length }} 个地点</span>
      <span class="located">● {{ locatedCount }} 个已定位</span>
      <span>◆ {{ areaCount }} 个区域参考</span>
      <span>{{ pendingCount }} 个待补充</span>
    </div>
    <div class="map-filters">
      <el-input v-model="search" clearable placeholder="搜索公司、园区或地址" aria-label="地图搜索" />
      <el-select v-model="district" clearable placeholder="全部行政区" aria-label="地图行政区">
        <el-option v-for="name in districts" :key="name" :label="name" :value="name" />
      </el-select>
      <el-select v-model="status" clearable placeholder="全部定位状态" aria-label="地图定位状态">
        <el-option label="已定位" value="LOCATED" /><el-option label="区域参考" value="DISTRICT" /><el-option label="待补充地址" value="PENDING" />
      </el-select>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><el-button link @click="load">重新加载</el-button></el-alert>
    <el-alert v-if="addressError" :title="addressError" type="warning" :closable="false" show-icon><el-button link @click="refreshAddressTasks">重新加载进度</el-button></el-alert>
    <el-alert v-if="roadsError" :title="roadsError" type="warning" :closable="false" show-icon><el-button link @click="loadRoads">重试道路</el-button></el-alert>
    <el-alert v-if="metroVisible && metroError" :title="metroError" type="warning" :closable="false" show-icon><el-button link @click="loadMetro">重试地铁</el-button></el-alert>
    <div v-loading="loading" class="map-layout">
      <div class="map-surface">
        <div ref="canvas" class="map-canvas" role="img" aria-label="上海市公司工作地点地图，可拖动与缩放"
          :data-road-visible-count="roadVisibleCount" :data-road-vertex-count="roadVertexCount"
          :data-metro-segment-count="metroSegmentCount" :data-metro-station-count="metroStationCount" />
        <div class="map-north" aria-label="正北朝上">↑ 北</div>
        <div class="road-labels" aria-hidden="true"><span v-for="label in labels" :key="label.name" class="road-label" :style="{left: `${label.x}px`, top: `${label.y}px`}">{{ label.name }}</span></div>
        <div class="metro-labels" aria-hidden="true"><span v-for="label in metroLabels" :key="label.key"
          class="metro-label" :class="{'metro-station-label': label.station}"
          :style="{left: `${label.x}px`, top: `${label.y}px`, color: label.color}">{{ label.name }}</span></div>
        <div class="map-zoom"><button aria-label="放大地图" @click="zoomMap(1.6)">＋</button><button aria-label="缩小地图" @click="zoomMap(1 / 1.6)">−</button></div>
        <div class="map-tip"><span class="road-status" role="status" :data-road-tier="currentRoadTier" :data-road-count="roadsCount">{{ roadsLoading ? '本地路网加载中…' : roadsError ? '本地路网未加载' : !roadsVisible ? '道路已隐藏' : `本地路网 · ${roadLevelLabel(currentRoadTier)}` }}</span><br/>滚轮缩放 · 拖动平移 · 点击标记查看地点<br/>灰色菱形仅表示所在区域，不代表实际办公楼。</div>
      </div>
      <aside class="location-sidebar">
        <div class="sidebar-heading"><strong>{{ selected.length || selectedCompanyId != null ? '选中的工作地点' : '工作地点清单' }} · {{ visibleList.length }}</strong><el-button v-if="selected.length || selectedCompanyId != null" link @click="clearSelection">查看全部</el-button></div>
        <el-empty v-if="!loading && !visibleList.length" description="没有符合条件的上海工作地点" :image-size="65" />
        <div class="location-scroll">
          <article v-for="location in visibleList" :key="location.key" class="location-card"
            :class="{selected: location.company.id === selectedCompanyId, 'address-recorded': companiesWithAddress.has(location.company.id), 'address-failed': addressFailures.has(location.company.id)}"
            :aria-label="`${location.company.name}，${addressFailures.get(location.company.id) || (companiesWithAddress.has(location.company.id) ? '已收录地址' : '尚未收录详细地址')}`"
            :data-company-id="location.company.id">
            <button class="company-name" @click="focusCompany(location)">{{ location.company.name }}</button>
            <p>{{ location.address }}</p>
            <p v-if="addressFailures.has(location.company.id)" class="intake-failure">{{ addressFailures.get(location.company.id) }}</p>
          </article>
        </div>
      </aside>
    </div>
    <p v-if="metroVisible && metroLoading" class="metro-loading" role="status">地铁加载中…</p>
    <p class="map-footnote">区划：阿里云 DataV；道路 / 地铁：<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors · ODbL</a>（道路 / Geofabrik，地铁 / Overpass）<span v-if="roadsCount"> · {{ roadsCount.toLocaleString() }} 段道路</span>；地点匹配：Photon。地铁为本地数据快照，非实时运营图。楼宇匹配供参考，以招聘方确认的办公点为准。<span v-if="outsideCount">已隐藏 {{ outsideCount }} 个上海市外地点。</span></p>
  </div>
</template>

<style scoped lang="scss">
.map-north { position: absolute; right: 20px; top: 18px; color: #526b5c; font-size: 13px; font-weight: 700; pointer-events: none; }
.road-labels { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.road-label { position: absolute; transform: translate(-50%, -50%); font-size: 11px; line-height: 18px; white-space: nowrap; color: #837b67; text-shadow: 1px 0 #fafbf7, -1px 0 #fafbf7, 0 1px #fafbf7, 0 -1px #fafbf7; }
.metro-labels { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.metro-label { position: absolute; transform: translateY(-50%); padding: 0 4px; border: 1px solid currentColor; border-radius: 4px; background: #ffffffed; font-size: 11px; font-weight: 700; line-height: 18px; white-space: nowrap; }
.metro-station-label { border: 0; padding: 0 2px; background: #ffffffe0; font-weight: 400; }
.metro-loading { margin: 8px 24px 0; font-size: 12px; color: #67756b; }
.map-zoom { position: absolute; right: 16px; top: 52px; display: grid; border: 1px solid #dfe4db; border-radius: 6px; overflow: hidden; button { width: 32px; height: 32px; border: 0; background: #fff; color: #42614e; font-size: 20px; cursor: pointer; &:hover { background: #edf2eb; } + button { border-top: 1px solid #e5e9e1; } } }
.road-status { color: #536a5c; }
.workplace-panel { background: #fff; border: 1px solid #dfe4db; border-radius: 16px; overflow: hidden; }
.map-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 24px 12px; h2 { margin: 0 0 6px; font-size: 21px; color: #213a2e; } p { margin: 0; color: #78847b; font-size: 13px; } }
.map-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; .el-button + .el-button { margin-left: 0; } }
.address-unrecorded { color: #67756b; font-size: 12px; white-space: nowrap; }
.map-summary { padding: 0 24px 16px; display: flex; flex-wrap: wrap; gap: 10px 22px; color: #77817b; font-size: 13px; span:first-child { color: #243f30; font-weight: 700; } .located { color: #2e7763; } }
.map-filters { display: grid; grid-template-columns: minmax(180px, 1fr) 170px 180px; gap: 10px; padding: 0 24px 18px; }
.map-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; border-top: 1px solid #e5e9e1; min-height: 640px; }
.map-surface { position: relative; min-width: 0; background: #f9faf6; }
.map-canvas { height: 640px; width: 100%; }
.map-tip { position: absolute; bottom: 15px; left: 18px; padding: 9px 12px; background: #fffffff0; border: 1px solid #e6e8df; border-radius: 8px; color: #7a8179; font-size: 11px; line-height: 1.7; pointer-events: none; }
.location-sidebar { min-width: 0; border-left: 1px solid #e5e9e1; display: flex; flex-direction: column; max-height: 640px; }
.sidebar-heading { padding: 15px 16px; border-bottom: 1px solid #e9ece6; display: flex; justify-content: space-between; align-items: center; font-size: 13px; min-height: 50px; }
.location-scroll { overflow: auto; min-height: 0; }
.location-card { padding: 15px 16px 12px 12px; border-left: 4px solid transparent; border-bottom: 1px solid #edf0e9; &.address-recorded { border-left-color: #2e7763; } &.selected { background: #fcf5e8; } p { margin: 7px 0; font-size: 12px; line-height: 1.7; color: #67756b; overflow-wrap: anywhere; } }
.company-name { cursor: pointer; text-align: left; padding: 0; border: 0; background: none; color: #264d3c; font: inherit; font-size: 13px; font-weight: 700; line-height: 1.6; }
.location-card.address-failed { border-left-color: #171c19; .intake-failure { color: #454c47; font-size: 11px; } }
.map-footnote { font-size: 11px; color: #8b948c; padding: 12px 24px; margin: 0; line-height: 1.8; }
@media (max-width: 1100px) { .map-layout { grid-template-columns: minmax(0, 1fr) 280px; } }
@media (max-width: 850px) { .map-heading { align-items: flex-start; flex-direction: column; }.map-filters { grid-template-columns: minmax(0, 1fr) 140px 155px; }.map-layout { grid-template-columns: minmax(0, 1fr); }.map-canvas { height: 500px; }.location-sidebar { border-left: 0; border-top: 1px solid #e5e9e1; max-height: 380px; } }
</style>
