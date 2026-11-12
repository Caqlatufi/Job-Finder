export type Coordinate = [number, number];
export interface Road {
  name: string;
  tier: number;
  coordinates: Coordinate[];
  bounds: [Coordinate, Coordinate];
}
export interface RoadLabel {name: string; x: number; y: number}
export type RoadBounds = [Coordinate, Coordinate];
export interface RoadTransform {scaleX: number; scaleY: number; x: number; y: number}
const radians = Math.PI / 180;
export const projectMercator = ([longitude, latitude]: number[]): Coordinate =>
  [longitude * radians, -Math.log(Math.tan(Math.PI / 4 + latitude * radians / 2))];
export const unprojectMercator = ([x, y]: number[]): Coordinate =>
  [x / radians, (2 * Math.atan(Math.exp(-y)) - Math.PI / 2) / radians];

// A north-up Mercator map is affine after projection. Sample ECharts only twice per frame.
export const roadTransform = (project: (point: Coordinate) => number[]): RoadTransform => {
  const a: Coordinate = [121, 31], b: Coordinate = [122, 32];
  const origin = project(a), diagonal = project(b), worldA = projectMercator(a), worldB = projectMercator(b);
  const scaleX = (diagonal[0] - origin[0]) / (worldB[0] - worldA[0]);
  const scaleY = (diagonal[1] - origin[1]) / (worldB[1] - worldA[1]);
  return {scaleX, scaleY, x: origin[0] - scaleX * worldA[0], y: origin[1] - scaleY * worldA[1]};
};
export const roadPixel = (transform: RoadTransform, coordinate: Coordinate): Coordinate => {
  const world = projectMercator(coordinate);
  return [world[0] * transform.scaleX + transform.x, world[1] * transform.scaleY + transform.y];
};

// ECharts 5.6 applies custom unprojection before its inverse pixel transform. Invert our affine frame instead.
export const roadCoordinate = (transform: RoadTransform, [x, y]: Coordinate): Coordinate =>
  unprojectMercator([(x - transform.x) / transform.scaleX, (y - transform.y) / transform.scaleY]);

/** Geographic grid built once; viewport queries visit nearby cells instead of the whole city. */
export class RoadIndex {
  private readonly cells = new Map<string, Road[]>();
  private readonly extent = [Infinity, Infinity, -Infinity, -Infinity];
  private readonly size = 0.02;

  constructor(roads: Road[]) {
    for (const road of roads) {
      const [min, max] = road.bounds;
      const left = Math.floor(min[0] / this.size), bottom = Math.floor(min[1] / this.size);
      const right = Math.floor(max[0] / this.size), top = Math.floor(max[1] / this.size);
      this.extent = [Math.min(this.extent[0], left), Math.min(this.extent[1], bottom),
        Math.max(this.extent[2], right), Math.max(this.extent[3], top)];
      for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) {
        const key = `${x}:${y}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(road); else this.cells.set(key, [road]);
      }
    }
  }

  query([min, max]: RoadBounds, tier: number): Road[] {
    const found = new Set<Road>();
    const left = Math.max(this.extent[0], Math.floor(min[0] / this.size));
    const bottom = Math.max(this.extent[1], Math.floor(min[1] / this.size));
    const right = Math.min(this.extent[2], Math.floor(max[0] / this.size));
    const top = Math.min(this.extent[3], Math.floor(max[1] / this.size));
    for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) {
      for (const road of this.cells.get(`${x}:${y}`) ?? []) {
        if (road.tier <= tier && road.bounds[1][0] >= min[0] && road.bounds[0][0] <= max[0]
          && road.bounds[1][1] >= min[1] && road.bounds[0][1] <= max[1]) found.add(road);
      }
    }
    return [...found];
  }
}
const tiers: Record<string, number> = {
  motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 0, primary_link: 0,
  secondary: 1, secondary_link: 1, tertiary: 1, tertiary_link: 1,
  residential: 2, unclassified: 2, living_street: 2, service: 3,
};
export const roadTier = (zoom: number) => zoom >= 10 ? 3 : zoom >= 5 ? 2 : zoom >= 2 ? 1 : 0;
export const roadLevelLabel = (tier: number) => ['主干路', '主次干路', '街道路网', '街道与支路'][tier];

export const parseRoads = (raw: unknown): Road[] => {
  const collection = raw as {type?: string; features?: {properties: {name?: string; ref?: string; highway: string};
    geometry: {type: string; coordinates: Coordinate[]}}[]};
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('本地道路数据格式不正确');
  return collection.features.flatMap(feature => {
    const coordinates = feature.geometry?.coordinates;
    const tier = tiers[feature.properties?.highway];
    if (feature.geometry?.type !== 'LineString' || tier == null || !Array.isArray(coordinates) || coordinates.length < 2
      || coordinates.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) return [];
    const xs = coordinates.map(point => point[0]);
    const ys = coordinates.map(point => point[1]);
    return [{name: feature.properties.name || feature.properties.ref || '', tier, coordinates,
      bounds: [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]] as [Coordinate, Coordinate]}];
  });
};

// Select road names in screen space, avoiding repeated names, overlaps and company markers.
export const roadLabels = (roads: Road[], project: (point: Coordinate) => number[], width: number, height: number,
  markers: number[][] = []): RoadLabel[] => {
  const candidates = roads.filter(road => road.name && !road.name.includes('匝道')).flatMap(road => {
    let longest = 0;
    let anchor: number[] | undefined;
    let previous = project(road.coordinates[0]);
    for (const coordinate of road.coordinates.slice(1)) {
      const next = project(coordinate);
      const length = Math.hypot(next[0] - previous[0], next[1] - previous[1]);
      const x = (previous[0] + next[0]) / 2;
      const y = (previous[1] + next[1]) / 2;
      const halfWidth = road.name.length * 6 + 8;
      if (length > longest && x > halfWidth && x < width - halfWidth && y > 24 && y < height - 65) {
        longest = length;
        anchor = [x, y];
      }
      previous = next;
    }
    return anchor && longest >= 12 ? [{name: road.name, tier: road.tier, length: longest, x: anchor[0], y: anchor[1]}] : [];
  }).sort((a, b) => a.tier - b.tier || b.length - a.length);
  const labels: RoadLabel[] = [];
  for (const candidate of candidates) {
    if (labels.length >= 45) break;
    if (labels.some(label => label.name === candidate.name
      || (Math.abs(label.x - candidate.x) < (label.name.length + candidate.name.length) * 6 + 16 && Math.abs(label.y - candidate.y) < 28))) continue;
    if (markers.some(point => Math.abs(point[0] - candidate.x) < candidate.name.length * 6 + 20
      && Math.abs(point[1] - candidate.y) < 25)) continue;
    labels.push({name: candidate.name, x: candidate.x, y: candidate.y});
  }
  return labels;
};
