import type {Coordinate, RoadBounds, RoadTransform} from './roads';

export const viewportBounds = (transform: RoadTransform, width: number, height: number): RoadBounds => {
  const a = [-transform.x / transform.scaleX, -transform.y / transform.scaleY];
  const b = [(width - transform.x) / transform.scaleX, (height - transform.y) / transform.scaleY];
  return [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
};

/** Liang–Barsky clipping retains crossing edges and splits paths that leave and re-enter the view. */
export const clipLine = (points: Coordinate[], [min, max]: RoadBounds): Coordinate[][] => {
  const result: Coordinate[][] = [];
  let current: Coordinate[] | undefined;
  for (let n = 1; n < points.length; n++) {
    const a = points[n - 1], b = points[n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let start = 0, end = 1, visible = true;
    const edges = [[-dx, a[0] - min[0]], [dx, max[0] - a[0]], [-dy, a[1] - min[1]], [dy, max[1] - a[1]]];
    for (const [p, q] of edges) {
      if (p === 0) { if (q < 0) { visible = false; break; } continue; }
      const fraction = q / p;
      if (p < 0) start = Math.max(start, fraction); else end = Math.min(end, fraction);
      if (start >= end) { visible = false; break; }
    }
    if (!visible || (dx === 0 && dy === 0)) { current = undefined; continue; }
    const from: Coordinate = [a[0] + start * dx, a[1] + start * dy];
    const to: Coordinate = [a[0] + end * dx, a[1] + end * dy];
    // Consecutive original segments can join only if their shared vertex is inside the viewport.
    if (!current || start > 0) { current = [from]; result.push(current); }
    current.push(to);
    if (end < 1) current = undefined;
  }
  return result;
};
