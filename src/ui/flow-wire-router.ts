import type { FlowPoint } from "../flow/index.js";

export interface FlowWireObstacle {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface QueueEntry {
  readonly state: number;
  readonly cost: number;
}

const ROUTE_CLEARANCE = 10;
const TURN_PENALTY = 18;
const PORT_DIRECTION_PENALTY = 48;

export function createFlowWirePath(
  from: FlowPoint,
  to: FlowPoint,
  lane = 0,
  obstacles: readonly FlowWireObstacle[] = [],
): string {
  return createFlowWirePathFromRoute(createFlowWireRoute(from, to, lane, obstacles));
}

export function flowWireLabelPoint(
  from: FlowPoint,
  to: FlowPoint,
  lane = 0,
  obstacles: readonly FlowWireObstacle[] = [],
): FlowPoint {
  if (!isFinitePoint(from) || !isFinitePoint(to)) {
    throw new TypeError("连线标签需要有限端点");
  }
  return flowWireLabelPointFromRoute(createFlowWireRoute(from, to, lane, obstacles));
}

export function distanceToFlowWire(
  value: FlowPoint,
  from: FlowPoint,
  to: FlowPoint,
  lane = 0,
  obstacles: readonly FlowWireObstacle[] = [],
): number {
  if (!isFinitePoint(value) || !isFinitePoint(from) || !isFinitePoint(to)) {
    throw new TypeError("wire 距离需要有限坐标");
  }
  return distanceToFlowWireRoute(value, createFlowWireRoute(from, to, lane, obstacles));
}

/**
 * Builds a deterministic Manhattan route. With obstacles it uses a sparse visibility grid, so a
 * control cable cannot cut through an unrelated node. Without obstacles it keeps the compact
 * route used by existing saved views and unit fixtures.
 */
export function createFlowWireRoute(
  from: FlowPoint,
  to: FlowPoint,
  lane = 0,
  obstacles: readonly FlowWireObstacle[] = [],
): readonly FlowPoint[] {
  if (!isFinitePoint(from) || !isFinitePoint(to)) {
    throw new TypeError("wire 端点必须是有限坐标");
  }
  const safeLane = Number.isFinite(lane) ? Math.max(-6, Math.min(6, lane)) : 0;
  if (obstacles.length === 0) return simpleOrthogonalRoute(from, to, safeLane);
  const blocked = obstacles.map(normalizeObstacle);
  return visibilityRoute(from, to, safeLane, blocked) ?? simpleOrthogonalRoute(from, to, safeLane);
}

export function createFlowWirePathFromRoute(route: readonly FlowPoint[]): string {
  if (route.some((candidate) => !isFinitePoint(candidate))) {
    throw new TypeError("wire 路由必须使用有限坐标");
  }
  const first = route[0];
  if (first === undefined) return "";
  let path = `M ${formatCoordinate(first.x)} ${formatCoordinate(first.y)}`;
  for (let index = 1; index < route.length; index += 1) {
    const current = route[index]!;
    const next = route[index + 1];
    if (next === undefined) {
      path += ` L ${formatCoordinate(current.x)} ${formatCoordinate(current.y)}`;
      continue;
    }
    const previous = route[index - 1]!;
    const incoming = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y);
    if (incoming === 0 || outgoing === 0) continue;
    const radius = Math.min(7, incoming / 2, outgoing / 2);
    const before = point(
      current.x + ((previous.x - current.x) / incoming) * radius,
      current.y + ((previous.y - current.y) / incoming) * radius,
    );
    const after = point(
      current.x + ((next.x - current.x) / outgoing) * radius,
      current.y + ((next.y - current.y) / outgoing) * radius,
    );
    path += ` L ${formatCoordinate(before.x)} ${formatCoordinate(before.y)} Q ${formatCoordinate(current.x)} ${formatCoordinate(current.y)} ${formatCoordinate(after.x)} ${formatCoordinate(after.y)}`;
  }
  return path;
}

export function flowWireLabelPointFromRoute(route: readonly FlowPoint[]): FlowPoint {
  const first = route[0];
  const last = route.at(-1);
  if (first === undefined || last === undefined || route.some((item) => !isFinitePoint(item))) {
    throw new TypeError("连线标签需要有限端点");
  }
  let best: readonly [FlowPoint, FlowPoint] | null = null;
  let bestScore = -1;
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1]!;
    const end = route[index]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const score = length + (Math.abs(end.y - start.y) < 0.001 ? 10_000 : 0);
    if (score > bestScore) {
      best = [start, end];
      bestScore = score;
    }
  }
  const segment = best ?? [first, last];
  return point((segment[0].x + segment[1].x) / 2, (segment[0].y + segment[1].y) / 2);
}

export function distanceToFlowWireRoute(value: FlowPoint, route: readonly FlowPoint[]): number {
  if (!isFinitePoint(value) || route.some((item) => !isFinitePoint(item))) {
    throw new TypeError("wire 距离需要有限坐标");
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < route.length; index += 1) {
    minimum = Math.min(minimum, distanceToSegment(value, route[index - 1]!, route[index]!));
  }
  return minimum;
}

function visibilityRoute(
  from: FlowPoint,
  to: FlowPoint,
  lane: number,
  obstacles: readonly FlowWireObstacle[],
): readonly FlowPoint[] | null {
  const xs = new Set<number>([from.x, to.x]);
  const ys = new Set<number>([from.y, to.y]);
  const preferredY = (from.y + to.y) / 2 + lane * 8;
  const preferredX = (from.x + to.x) / 2 + lane * 10;
  xs.add(preferredX);
  ys.add(preferredY);
  for (const obstacle of obstacles) {
    xs.add(obstacle.left);
    xs.add(obstacle.right);
    ys.add(obstacle.top);
    ys.add(obstacle.bottom);
  }
  const orderedX = [...xs].sort((left, right) => left - right);
  const orderedY = [...ys].sort((left, right) => left - right);
  const points: FlowPoint[] = [];
  const pointIndex = new Map<string, number>();
  for (const y of orderedY) {
    for (const x of orderedX) {
      const candidate = point(x, y);
      if (insideAnyObstacle(candidate, obstacles)) continue;
      pointIndex.set(pointKey(candidate), points.length);
      points.push(candidate);
    }
  }
  const start = pointIndex.get(pointKey(from));
  const end = pointIndex.get(pointKey(to));
  if (start === undefined || end === undefined) return null;

  const neighbours = Array.from({ length: points.length }, () => [] as number[]);
  for (const y of orderedY) {
    const row = orderedX
      .map((x) => pointIndex.get(pointKey(point(x, y))))
      .filter((index): index is number => index !== undefined);
    connectVisibleNeighbours(row, points, neighbours, obstacles);
  }
  for (const x of orderedX) {
    const column = orderedY
      .map((y) => pointIndex.get(pointKey(point(x, y))))
      .filter((index): index is number => index !== undefined);
    connectVisibleNeighbours(column, points, neighbours, obstacles);
  }

  const stateCount = points.length * 3;
  const distances = new Float64Array(stateCount);
  distances.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(stateCount);
  previous.fill(-1);
  const startState = start * 3;
  distances[startState] = 0;
  const queue: QueueEntry[] = [];
  pushQueue(queue, { state: startState, cost: 0 });
  let endState = -1;
  while (queue.length > 0) {
    const current = popQueue(queue)!;
    if (current.cost !== distances[current.state]) continue;
    const currentPointIndex = Math.floor(current.state / 3);
    const currentDirection = current.state % 3;
    if (currentPointIndex === end) {
      endState = current.state;
      break;
    }
    const currentPoint = points[currentPointIndex]!;
    for (const nextPointIndex of neighbours[currentPointIndex]!) {
      const nextPoint = points[nextPointIndex]!;
      const nextDirection = currentPoint.x === nextPoint.x ? 2 : 1;
      const length =
        Math.abs(nextPoint.x - currentPoint.x) + Math.abs(nextPoint.y - currentPoint.y);
      const bend = currentDirection !== 0 && currentDirection !== nextDirection ? TURN_PENALTY : 0;
      const wrongDeparture =
        currentPointIndex === start && nextDirection === 1 ? PORT_DIRECTION_PENALTY : 0;
      const wrongArrival =
        nextPointIndex === end && nextDirection === 1 ? PORT_DIRECTION_PENALTY : 0;
      const laneBias =
        nextDirection === 1
          ? Math.abs(currentPoint.y - preferredY) * 0.035
          : Math.abs(currentPoint.x - preferredX) * 0.012;
      const nextCost = current.cost + length + bend + wrongDeparture + wrongArrival + laneBias;
      const nextState = nextPointIndex * 3 + nextDirection;
      if (nextCost >= distances[nextState]!) continue;
      distances[nextState] = nextCost;
      previous[nextState] = current.state;
      pushQueue(queue, { state: nextState, cost: nextCost });
    }
  }
  if (endState < 0) return null;
  const reversed: FlowPoint[] = [];
  for (let state = endState; state >= 0; state = previous[state]!) {
    reversed.push(points[Math.floor(state / 3)]!);
    if (state === startState) break;
  }
  if (reversed.at(-1)?.x !== from.x || reversed.at(-1)?.y !== from.y) return null;
  return compactOrthogonalPoints(reversed.reverse());
}

function connectVisibleNeighbours(
  indexes: readonly number[],
  points: readonly FlowPoint[],
  neighbours: number[][],
  obstacles: readonly FlowWireObstacle[],
): void {
  for (let index = 1; index < indexes.length; index += 1) {
    const firstIndex = indexes[index - 1]!;
    const secondIndex = indexes[index]!;
    if (!segmentIsClear(points[firstIndex]!, points[secondIndex]!, obstacles)) continue;
    neighbours[firstIndex]!.push(secondIndex);
    neighbours[secondIndex]!.push(firstIndex);
  }
}

function segmentIsClear(
  from: FlowPoint,
  to: FlowPoint,
  obstacles: readonly FlowWireObstacle[],
): boolean {
  return obstacles.every((obstacle) => {
    if (from.x === to.x) {
      if (from.x <= obstacle.left || from.x >= obstacle.right) return true;
      const top = Math.min(from.y, to.y);
      const bottom = Math.max(from.y, to.y);
      return bottom <= obstacle.top || top >= obstacle.bottom;
    }
    if (from.y <= obstacle.top || from.y >= obstacle.bottom) return true;
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    return right <= obstacle.left || left >= obstacle.right;
  });
}

function normalizeObstacle(obstacle: FlowWireObstacle): FlowWireObstacle {
  if (
    ![obstacle.left, obstacle.top, obstacle.right, obstacle.bottom].every(Number.isFinite) ||
    obstacle.right < obstacle.left ||
    obstacle.bottom < obstacle.top
  ) {
    throw new TypeError("wire 障碍物必须是有效有限矩形");
  }
  return Object.freeze({
    left: obstacle.left - ROUTE_CLEARANCE,
    top: obstacle.top - ROUTE_CLEARANCE,
    right: obstacle.right + ROUTE_CLEARANCE,
    bottom: obstacle.bottom + ROUTE_CLEARANCE,
  });
}

function insideAnyObstacle(value: FlowPoint, obstacles: readonly FlowWireObstacle[]): boolean {
  return obstacles.some(
    (obstacle) =>
      value.x > obstacle.left &&
      value.x < obstacle.right &&
      value.y > obstacle.top &&
      value.y < obstacle.bottom,
  );
}

function simpleOrthogonalRoute(from: FlowPoint, to: FlowPoint, lane: number): readonly FlowPoint[] {
  const deltaY = to.y - from.y;
  const deltaX = to.x - from.x;
  if (Math.abs(deltaX) < 0.001 && deltaY >= 0) return Object.freeze([from, to]);
  if (deltaY >= 52) {
    const channelY = Math.max(from.y + 18, Math.min(to.y - 18, from.y + 26 + lane * 8));
    return compactOrthogonalPoints([from, point(from.x, channelY), point(to.x, channelY), to]);
  }
  const side = deltaX >= 0 ? 1 : -1;
  const outsideX =
    (side > 0 ? Math.max(from.x, to.x) : Math.min(from.x, to.x)) +
    side * (48 + Math.abs(lane) * 12);
  return compactOrthogonalPoints([
    from,
    point(from.x, from.y + 22 + lane * 3),
    point(outsideX, from.y + 22 + lane * 3),
    point(outsideX, to.y - 22 - lane * 3),
    point(to.x, to.y - 22 - lane * 3),
    to,
  ]);
}

function compactOrthogonalPoints(points: readonly FlowPoint[]): readonly FlowPoint[] {
  const compacted: FlowPoint[] = [];
  for (const candidate of points) {
    const previous = compacted.at(-1);
    if (previous !== undefined && previous.x === candidate.x && previous.y === candidate.y)
      continue;
    const beforePrevious = compacted.at(-2);
    if (
      beforePrevious !== undefined &&
      previous !== undefined &&
      ((beforePrevious.x === previous.x && previous.x === candidate.x) ||
        (beforePrevious.y === previous.y && previous.y === candidate.y))
    ) {
      compacted[compacted.length - 1] = candidate;
    } else {
      compacted.push(candidate);
    }
  }
  return Object.freeze(compacted);
}

function pushQueue(queue: QueueEntry[], entry: QueueEntry): void {
  queue.push(entry);
  let index = queue.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (queue[parent]!.cost <= entry.cost) break;
    queue[index] = queue[parent]!;
    index = parent;
  }
  queue[index] = entry;
}

function popQueue(queue: QueueEntry[]): QueueEntry | undefined {
  const first = queue[0];
  const last = queue.pop();
  if (first === undefined || last === undefined || queue.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= queue.length) break;
    const child = right < queue.length && queue[right]!.cost < queue[left]!.cost ? right : left;
    if (queue[child]!.cost >= last.cost) break;
    queue[index] = queue[child]!;
    index = child;
  }
  queue[index] = last;
  return first;
}

function pointKey(value: FlowPoint): string {
  return `${String(value.x)},${String(value.y)}`;
}

function point(x: number, y: number): FlowPoint {
  return Object.freeze({ x, y });
}

function isFinitePoint(value: FlowPoint): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y);
}

function formatCoordinate(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

function distanceToSegment(value: FlowPoint, start: FlowPoint, end: FlowPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(value.x - start.x, value.y - start.y);
  const ratio = Math.max(
    0,
    Math.min(1, ((value.x - start.x) * dx + (value.y - start.y) * dy) / lengthSquared),
  );
  return Math.hypot(value.x - (start.x + ratio * dx), value.y - (start.y + ratio * dy));
}
