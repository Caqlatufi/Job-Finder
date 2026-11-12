import {graphic, type EChartsType} from 'echarts/core';
import {projectMercator, roadPixel, type Coordinate, type RoadTransform} from './roads';
import {clipLine, viewportBounds} from './viewport';
import type {MetroData, MetroLabel, MetroRoute} from './metro';

const LinePath = graphic.extendShape({
  shape: {segments: []},
  buildPath(context, shape) {
    for (const points of shape.segments as Coordinate[][]) {
      context.moveTo(points[0][0], points[0][1]);
      for (let n = 1; n < points.length; n++) context.lineTo(points[n][0], points[n][1]);
    }
  },
});
const StationPath = graphic.extendShape({
  shape: {points: [], radius: 0},
  buildPath(context, shape) {
    for (const [x, y] of shape.points as Coordinate[]) {
      context.moveTo(x + shape.radius, y); context.arc(x, y, shape.radius, 0, 2 * Math.PI);
    }
  },
});

/** One cached path per line; independent of roads and below company markers. */
export class MetroLayer {
  private readonly root = new graphic.Group({silent: true});
  private readonly geometry = new graphic.Group({silent: true});
  private readonly clip = new graphic.Rect();
  private readonly paths = new Map<string, InstanceType<typeof LinePath>>();
  private readonly projected = new WeakMap<MetroRoute, Coordinate[][]>();
  private readonly stations = new StationPath({silent: true, z: 3, shape: {points: [], radius: 0},
    style: {fill: '#fff', stroke: '#51665d', lineWidth: 1.2, strokeNoScale: true}});

  constructor(private readonly chart: EChartsType) {
    this.root.add(this.geometry); this.root.setClipPath(this.clip);
    this.geometry.add(this.stations); chart.getZr().add(this.root);
  }

  update(data: MetroData | undefined, transform: RoadTransform, width: number, height: number,
    zoom: number, markers: number[][]): {labels: MetroLabel[]; segments: number; stations: number} {
    const bounds = viewportBounds(transform, width, height);
    const labels: MetroLabel[] = [];
    const fits = (x: number, y: number, name: string) => x > 12 && x + name.length * 12 + 12 < width
      && y > 16 && y < height - 95 && !labels.some(label => Math.abs(label.x - x) < 85 && Math.abs(label.y - y) < 28)
      && !markers.some(point => Math.abs(point[0] - x) < 65 && Math.abs(point[1] - y) < 24);
    let segmentCount = 0;
    for (const [ref, path] of this.paths) if (!data?.routes.some(route => route.ref === ref)) path.setShape({segments: []});
    for (const route of data?.routes ?? []) {
      let path = this.paths.get(route.ref);
      if (!path) {
        path = new LinePath({silent: true, z: 2, shape: {segments: []}, style: {fill: 'none', stroke: route.color,
          lineWidth: 2.6, opacity: 0.85, strokeNoScale: true, lineJoin: 'round', lineCap: 'round'}});
        this.paths.set(route.ref, path); this.geometry.add(path);
      }
      let projected = this.projected.get(route);
      if (!projected) { projected = route.segments.map(line => line.map(projectMercator)); this.projected.set(route, projected); }
      const segments = projected.flatMap(line => clipLine(line, bounds));
      path.setShape({segments}); segmentCount += segments.length;
      const candidates = [...segments].sort((a, b) => b.length - a.length).flatMap(line =>
        [0.5, 0.25, 0.75, 0.1, 0.9].map(fraction => line[Math.min(line.length - 1, Math.floor(line.length * fraction))]));
      const anchor = candidates.map(p => ({x: p[0] * transform.scaleX + transform.x,
        y: p[1] * transform.scaleY + transform.y})).find(p => fits(p.x, p.y, route.name));
      if (anchor) labels.push({key: route.ref, name: route.name, color: route.color, ...anchor, station: false});
    }
    const stations = zoom >= 3 ? (data?.stations ?? []).map(station => ({station, pixel: roadPixel(transform, station.coordinate)}))
      .filter(({pixel: [x, y]}) => x >= 0 && x <= width && y >= 0 && y <= height)
      .sort((a, b) => b.station.lines.length - a.station.lines.length) : [];
    this.stations.setShape({points: stations.map(({station}) => projectMercator(station.coordinate)),
      radius: 3 / Math.abs(transform.scaleX)});
    for (const {station, pixel: [x, y]} of stations) {
      if (labels.length >= 40) break;
      if (fits(x + 7, y - 9, station.name)) labels.push({key: `station:${station.name}:${x}`, name: station.name,
        color: '#365c4a', x: x + 7, y: y - 9, station: true});
    }
    this.move(transform, width, height);
    return {labels, segments: segmentCount, stations: stations.length};
  }

  move(transform: RoadTransform, width: number, height: number) {
    this.geometry.attr(transform); this.clip.setShape({x: 0, y: 0, width, height});
  }

  dispose() { this.chart.getZr().remove(this.root); }
}
