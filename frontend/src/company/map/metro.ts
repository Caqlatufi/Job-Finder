import type {Coordinate} from './roads';

export interface MetroRoute {ref: string; name: string; color: string; segments: Coordinate[][]}
export interface MetroStation {name: string; lines: string[]; coordinate: Coordinate}
export interface MetroData {routes: MetroRoute[]; stations: MetroStation[]}
export interface MetroLabel {key: string; name: string; color: string; x: number; y: number; station: boolean}

export const parseMetro = (raw: unknown): MetroData => {
  const collection = raw as {type?: string; features?: {properties?: Record<string, unknown>;
    geometry?: {type?: string; coordinates?: unknown}}[]};
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('地铁数据格式不正确');
  const point = (value: unknown): value is Coordinate => Array.isArray(value) && value.length === 2
    && value.every(Number.isFinite) && value[0] > 120 && value[0] < 123 && value[1] > 30 && value[1] < 33;
  const routes: MetroRoute[] = [], stations: MetroStation[] = [];
  for (const feature of collection.features) {
    const properties = feature.properties ?? {}, geometry = feature.geometry;
    if (typeof properties.name !== 'string') throw new Error('缺少地铁名称');
    if (properties.kind === 'route' && geometry?.type === 'MultiLineString') {
      const segments = geometry.coordinates;
      if (typeof properties.ref !== 'string' || typeof properties.color !== 'string'
        || !/^#[0-9a-f]{6}$/i.test(properties.color) || !Array.isArray(segments) || !segments.length
        || !segments.every(line => Array.isArray(line) && line.length >= 2 && line.every(point))) throw new Error('地铁线路数据不完整');
      routes.push({ref: properties.ref, name: properties.name, color: properties.color, segments: segments as Coordinate[][]});
    } else if (properties.kind === 'station' && geometry?.type === 'Point') {
      if (!point(geometry.coordinates) || !Array.isArray(properties.lines)
        || !properties.lines.length || !properties.lines.every(line => typeof line === 'string')) throw new Error('地铁站数据不完整');
      stations.push({name: properties.name, lines: properties.lines, coordinate: geometry.coordinates});
    } else throw new Error('不支持的地铁数据');
  }
  if (!routes.length || !stations.length || stations.some(station => station.lines.some(ref => !routes.some(route => route.ref === ref))))
    throw new Error('地铁线路与站点不匹配');
  return {routes, stations};
};
