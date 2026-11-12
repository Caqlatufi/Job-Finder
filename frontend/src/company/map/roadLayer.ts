import {graphic, type EChartsType} from 'echarts/core';
import {projectMercator, type Coordinate, type Road, type RoadTransform} from './roads';
import {clipLine, viewportBounds} from './viewport';

const styles = [
  {stroke: '#d0b588', lineWidth: 1.5}, {stroke: '#d8cbb0', lineWidth: 1.1},
  {stroke: '#d2d6c9', lineWidth: 0.9}, {stroke: '#dcdfd6', lineWidth: 0.7},
];

/** Four cached paths share the map transform; pan/zoom never relayout individual roads. */
export class RoadLayer {
  private readonly root = new graphic.Group({silent: true});
  private readonly geometry = new graphic.Group({silent: true});
  private readonly clip = new graphic.Rect();
  private readonly projected = new WeakMap<Road, Coordinate[]>();
  private readonly paths = styles.map(style => new (graphic.extendShape({
    shape: {segments: []},
    buildPath(context, shape) {
      for (const points of shape.segments as Coordinate[][]) {
        context.moveTo(points[0][0], points[0][1]);
        for (let n = 1; n < points.length; n++) context.lineTo(points[n][0], points[n][1]);
      }
    },
  }))({
    silent: true, z: 1, shape: {segments: []},
    style: {...style, fill: 'none', strokeNoScale: true},
  }));
  private width = 0;
  private height = 0;

  constructor(private readonly chart: EChartsType) {
    this.root.add(this.geometry);
    this.root.setClipPath(this.clip);
    // Draw minor roads first, keeping main roads above intersections and below company markers.
    for (const path of [...this.paths].reverse()) this.geometry.add(path);
    chart.getZr().add(this.root);
  }

  setRoads(roads: Road[], transform: RoadTransform, width: number, height: number) {
    const segments: Coordinate[][][] = [[], [], [], []];
    const bounds = viewportBounds(transform, width, height);
    let visible = 0, vertices = 0;
    for (const road of roads) {
      let points = this.projected.get(road);
      if (!points) { points = road.coordinates.map(projectMercator); this.projected.set(road, points); }
      const clipped = clipLine(points, bounds);
      if (clipped.length) visible++;
      for (const line of clipped) { segments[road.tier].push(line); vertices += line.length; }
    }
    this.paths.forEach((path, tier) => path.setShape({segments: segments[tier]}));
    return {visible, vertices};
  }

  move(transform: RoadTransform, width: number, height: number) {
    this.geometry.attr(transform);
    if (width !== this.width || height !== this.height) {
      this.width = width; this.height = height;
      this.clip.setShape({x: 0, y: 0, width, height});
    }
  }

  dispose() { this.chart.getZr().remove(this.root); }
}
