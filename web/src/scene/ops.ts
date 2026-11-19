/**
 * Pure operations on the scene document. Each takes a document and returns a
 * new one; nodes that an operation does not touch keep their identity, which
 * is what dirty tracking and undo rely on. Invalid input throws a SceneError.
 */
import {
  GRID, MIN_WALL, ROOM_TYPES,
  type BuildingNode, type Id, type LevelNode, type NodeOf, type NodeType, type RoomType,
  type SceneDoc, type SceneNode, type SlabNode, type Vec2, type WallNode, type ZoneNode,
} from './types';

export class SceneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneError';
  }
}

let counter = 0;
export function newId(type: NodeType): Id {
  counter += 1;
  return `${type}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export const snap = (v: number) => Math.round(v / GRID) * GRID;
export const snapPoint = (p: Vec2): Vec2 => [snap(p[0]), snap(p[1])];
const samePoint = (p: Vec2, q: Vec2) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new SceneError(`${what} must be a number`);
  return n;
}
function point(p: unknown, what: string): Vec2 {
  if (!Array.isArray(p) || p.length !== 2) throw new SceneError(`${what} must be [x, y]`);
  return snapPoint([finite(p[0], `${what}[0]`), finite(p[1], `${what}[1]`)]);
}
function polygon(points: unknown, what: string): Vec2[] {
  if (!Array.isArray(points) || points.length < 3) throw new SceneError(`${what} needs at least three points`);
  const out = points.map((p, i) => point(p, `${what}[${i}]`));
  if (Math.abs(area(out)) < GRID * GRID) throw new SceneError(`${what} has no area`);
  return out;
}
function positive(n: unknown, what: string, min = 0.05, max = 50): number {
  const v = finite(n, what);
  if (v < min || v > max) throw new SceneError(`${what} must be between ${min} and ${max} m`);
  return Math.round(v * 100) / 100;
}

export function area(points: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export const emptyDoc = (): SceneDoc => ({ nodes: {}, roots: [] });

export function get<T extends NodeType>(doc: SceneDoc, id: Id, type?: T): NodeOf<T> {
  const node = doc.nodes[id];
  if (!node) throw new SceneError(`No node ${id}`);
  if (type && node.type !== type) throw new SceneError(`${id} is a ${node.type}, not a ${type}`);
  return node as NodeOf<T>;
}

/** Ancestors from the node up: wall → level → building. */
export function ancestor<T extends NodeType>(doc: SceneDoc, id: Id, type: T): NodeOf<T> | null {
  let node: SceneNode | undefined = doc.nodes[id];
  while (node) {
    if (node.type === type) return node as NodeOf<T>;
    node = node.parent ? doc.nodes[node.parent] : undefined;
  }
  return null;
}

function put(doc: SceneDoc, ...changed: SceneNode[]): SceneDoc {
  const nodes = { ...doc.nodes };
  for (const n of changed) nodes[n.id] = n;
  return { nodes, roots: doc.roots };
}

function attach(doc: SceneDoc, node: SceneNode, index?: number): SceneDoc {
  if (node.parent === null) {
    const roots = [...doc.roots];
    roots.splice(index ?? roots.length, 0, node.id);
    return { nodes: { ...doc.nodes, [node.id]: node }, roots };
  }
  const parent = doc.nodes[node.parent];
  if (!parent || !('children' in parent)) throw new SceneError(`No parent ${node.parent}`);
  const children = [...parent.children];
  children.splice(index ?? children.length, 0, node.id);
  return put(doc, { ...parent, children } as SceneNode, node);
}

// ---- buildings and levels ----------------------------------------------------

export function addBuilding(doc: SceneDoc, input: { name?: string; origin?: Vec2 } = {}, id = newId('building')): [SceneDoc, Id] {
  const node: BuildingNode = {
    id, type: 'building', parent: null, children: [],
    name: input.name?.trim() || `Building ${doc.roots.length + 1}`,
    origin: input.origin ? point(input.origin, 'origin') : [0, 0],
  };
  return [attach(doc, node), id];
}

export function addLevel(doc: SceneDoc, buildingId: Id, input: { name?: string; elevation?: number; height?: number } = {}, id = newId('level')): [SceneDoc, Id] {
  const building = get(doc, buildingId, 'building');
  const below = building.children.map(c => get(doc, c, 'level')).sort((p, q) => p.elevation - q.elevation).at(-1);
  const height = input.height === undefined ? (below?.height ?? 3) : positive(input.height, 'height', 2, 10);
  const elevation = input.elevation === undefined
    ? (below ? below.elevation + below.height : 0)
    : Math.round(finite(input.elevation, 'elevation') * 100) / 100;
  const node: LevelNode = {
    id, type: 'level', parent: buildingId, children: [],
    name: input.name?.trim() || `Level ${building.children.length}`,
    elevation, height,
  };
  return [attach(doc, node), id];
}

/** A new level on top with a copy of the top level's slab outline, ready to draw on. */
export function addLevelAbove(doc: SceneDoc, buildingId: Id): [SceneDoc, Id] {
  const building = get(doc, buildingId, 'building');
  const top = building.children.map(c => get(doc, c, 'level')).sort((p, q) => p.elevation - q.elevation).at(-1);
  let [next, levelId] = addLevel(doc, buildingId);
  const slab = top?.children.map(c => doc.nodes[c]).find((n): n is SlabNode => n?.type === 'slab');
  if (slab) [next] = addSlab(next, levelId, { points: slab.points, thickness: slab.thickness });
  return [next, levelId];
}

// ---- walls -------------------------------------------------------------------

export interface WallInput { a: Vec2; b: Vec2; thickness?: number; height?: number; name?: string }

function wallFrom(level: LevelNode, input: WallInput, id: Id, prev?: WallNode): WallNode {
  const a = point(input.a, 'a');
  const b = point(input.b, 'b');
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_WALL - 1e-6) throw new SceneError(`A wall must be at least ${MIN_WALL} m long`);
  return {
    id, type: 'wall', parent: level.id,
    name: input.name?.trim() || prev?.name || 'Wall',
    a, b,
    thickness: input.thickness === undefined ? (prev?.thickness ?? 0.2) : positive(input.thickness, 'thickness', 0.05, 1),
    height: input.height === undefined ? (prev?.height ?? level.height) : positive(input.height, 'height', 0.5, 10),
  };
}

export function addWall(doc: SceneDoc, levelId: Id, input: WallInput, id = newId('wall')): [SceneDoc, Id] {
  const level = get(doc, levelId, 'level');
  return [attach(doc, wallFrom(level, input, id)), id];
}

export function updateWall(doc: SceneDoc, id: Id, patch: Partial<WallInput>): SceneDoc {
  const wall = get(doc, id, 'wall');
  const level = get(doc, wall.parent, 'level');
  return put(doc, wallFrom(level, { ...wall, ...patch }, id, wall));
}

/**
 * Moves one end of a wall. Every other wall on the level whose end sat on the
 * same point moves with it, so joined walls stay joined.
 */
export function moveWallEnd(doc: SceneDoc, id: Id, end: 'a' | 'b', to: Vec2): SceneDoc {
  const wall = get(doc, id, 'wall');
  const from = wall[end];
  const target = point(to, end);
  if (samePoint(from, target)) return doc;
  const level = get(doc, wall.parent, 'level');
  const changed: SceneNode[] = [];
  for (const childId of level.children) {
    const n = doc.nodes[childId];
    if (n?.type !== 'wall') continue;
    let next: WallNode = n;
    if (samePoint(n.a, from)) next = { ...next, a: target };
    if (samePoint(n.b, from)) next = { ...next, b: target };
    if (next === n) continue;
    if (Math.hypot(next.b[0] - next.a[0], next.b[1] - next.a[1]) < MIN_WALL - 1e-6) throw new SceneError(`A wall must be at least ${MIN_WALL} m long`);
    changed.push(next);
  }
  return put(doc, ...changed);
}

/**
 * Slides a wall sideways by `offset` metres along its normal. Its ends move
 * together, carrying the ends of joined walls, which stretch to follow.
 */
export function offsetWall(doc: SceneDoc, id: Id, offset: number): SceneDoc {
  const wall = get(doc, id, 'wall');
  const dx = wall.b[0] - wall.a[0];
  const dy = wall.b[1] - wall.a[1];
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const d = finite(offset, 'offset');
  const shift = (p: Vec2): Vec2 => snapPoint([p[0] + nx * d, p[1] + ny * d]);
  const a2 = shift(wall.a);
  const b2 = shift(wall.b);
  if (samePoint(a2, wall.a) && samePoint(b2, wall.b)) return doc;
  // Move b first while a still identifies the wall's other joints.
  let next = moveWallEnd(doc, id, 'b', b2);
  next = moveWallEnd(next, id, 'a', a2);
  return next;
}

// ---- zones and slabs -----------------------------------------------------------

export interface ZoneInput { points: readonly Vec2[]; name?: string; use?: RoomType }

export function addZone(doc: SceneDoc, levelId: Id, input: ZoneInput, id = newId('zone')): [SceneDoc, Id] {
  get(doc, levelId, 'level');
  if (input.use !== undefined && !ROOM_TYPES.includes(input.use)) throw new SceneError(`Unknown use ${input.use}`);
  const node: ZoneNode = {
    id, type: 'zone', parent: levelId,
    name: input.name?.trim() || 'Zone',
    points: polygon(input.points, 'points'),
    use: input.use ?? 'living',
  };
  return [attach(doc, node), id];
}

export function addSlab(doc: SceneDoc, levelId: Id, input: { points: readonly Vec2[]; thickness?: number; name?: string }, id = newId('slab')): [SceneDoc, Id] {
  get(doc, levelId, 'level');
  const node: SlabNode = {
    id, type: 'slab', parent: levelId,
    name: input.name?.trim() || 'Slab',
    points: polygon(input.points, 'points'),
    thickness: input.thickness === undefined ? 0.25 : positive(input.thickness, 'thickness', 0.05, 2),
  };
  return [attach(doc, node), id];
}

type Poly = ZoneNode | SlabNode;
function poly(doc: SceneDoc, id: Id): Poly {
  const n = doc.nodes[id];
  if (n?.type !== 'zone' && n?.type !== 'slab') throw new SceneError(`${id} has no outline`);
  return n;
}

export function setPoints(doc: SceneDoc, id: Id, points: readonly Vec2[]): SceneDoc {
  const n = poly(doc, id);
  return put(doc, { ...n, points: polygon(points, 'points') });
}

export function movePoint(doc: SceneDoc, id: Id, index: number, to: Vec2): SceneDoc {
  const n = poly(doc, id);
  if (!Number.isInteger(index) || index < 0 || index >= n.points.length) throw new SceneError(`No point ${index}`);
  const target = point(to, 'point');
  if (samePoint(n.points[index], target)) return doc;
  const points = [...n.points];
  points[index] = target;
  return setPoints(doc, id, points);
}

/** Splits the edge after `index` with a new point, which becomes `index + 1`. */
export function insertPoint(doc: SceneDoc, id: Id, index: number, at: Vec2): SceneDoc {
  const n = poly(doc, id);
  const points = [...n.points];
  points.splice(index + 1, 0, point(at, 'point'));
  return setPoints(doc, id, points);
}

export function removePoint(doc: SceneDoc, id: Id, index: number): SceneDoc {
  const n = poly(doc, id);
  if (n.points.length <= 3) throw new SceneError('An outline needs at least three points');
  return setPoints(doc, id, n.points.filter((_, i) => i !== index));
}

export function translate(doc: SceneDoc, id: Id, d: Vec2): SceneDoc {
  const n = poly(doc, id);
  const [dx, dy] = snapPoint(d);
  if (!dx && !dy) return doc;
  return put(doc, { ...n, points: n.points.map(([x, y]) => [x + dx, y + dy] as Vec2) });
}

export function updateZone(doc: SceneDoc, id: Id, patch: { name?: string; use?: RoomType }): SceneDoc {
  const z = get(doc, id, 'zone');
  if (patch.use !== undefined && !ROOM_TYPES.includes(patch.use)) throw new SceneError(`Unknown use ${patch.use}`);
  return put(doc, { ...z, name: patch.name?.trim() || z.name, use: patch.use ?? z.use });
}

export function updateLevel(doc: SceneDoc, id: Id, patch: { name?: string; elevation?: number; height?: number }): SceneDoc {
  const l = get(doc, id, 'level');
  return put(doc, {
    ...l,
    name: patch.name?.trim() || l.name,
    elevation: patch.elevation === undefined ? l.elevation : Math.round(finite(patch.elevation, 'elevation') * 100) / 100,
    height: patch.height === undefined ? l.height : positive(patch.height, 'height', 2, 10),
  });
}

export function rename(doc: SceneDoc, id: Id, name: string): SceneDoc {
  const n = get(doc, id);
  const trimmed = name.trim();
  if (!trimmed) throw new SceneError('A name cannot be empty');
  return put(doc, { ...n, name: trimmed.slice(0, 60) } as SceneNode);
}

// ---- removal -------------------------------------------------------------------

export function remove(doc: SceneDoc, id: Id): SceneDoc {
  const node = get(doc, id);
  const nodes = { ...doc.nodes };
  const drop = (nid: Id) => {
    const n = nodes[nid];
    if (n && 'children' in n) n.children.forEach(drop);
    delete nodes[nid];
  };
  drop(id);
  if (node.parent === null) return { nodes, roots: doc.roots.filter(r => r !== id) };
  const parent = nodes[node.parent] as BuildingNode | LevelNode;
  nodes[parent.id] = { ...parent, children: parent.children.filter(c => c !== id) };
  return { nodes, roots: doc.roots };
}

// ---- diffing -----------------------------------------------------------------

/** Ids whose node was added, changed or removed between two documents. */
export function diff(prev: SceneDoc, next: SceneDoc): Set<Id> {
  const out = new Set<Id>();
  if (prev === next) return out;
  if (prev.nodes === next.nodes) return out;
  for (const id in next.nodes) if (prev.nodes[id] !== next.nodes[id]) out.add(id);
  for (const id in prev.nodes) if (!(id in next.nodes)) out.add(id);
  return out;
}

/** Checks a document read from storage or a file before it is used. */
export function validate(doc: unknown): SceneDoc {
  if (!doc || typeof doc !== 'object') throw new SceneError('Not a scene');
  const d = doc as SceneDoc;
  if (!Array.isArray(d.roots) || !d.nodes || typeof d.nodes !== 'object') throw new SceneError('Not a scene');
  const seen = new Set<Id>();
  const walk = (id: Id, parent: Id | null, expect: NodeType[]) => {
    const n = d.nodes[id];
    if (!n || n.id !== id || n.parent !== parent || !expect.includes(n.type) || seen.has(id)) throw new SceneError(`Broken node ${id}`);
    seen.add(id);
    if (n.type === 'building') n.children.forEach(c => walk(c, id, ['level']));
    if (n.type === 'level') n.children.forEach(c => walk(c, id, ['wall', 'zone', 'slab']));
  };
  d.roots.forEach(r => walk(r, null, ['building']));
  if (seen.size !== Object.keys(d.nodes).length) throw new SceneError('The scene has loose nodes');
  return d;
}

export function setOrigin(doc: SceneDoc, id: Id, origin: Vec2): SceneDoc {
  const b = get(doc, id, 'building');
  const o = point(origin, 'origin');
  if (samePoint(o, b.origin)) return doc;
  return put(doc, { ...b, origin: o });
}

export function updateSlab(doc: SceneDoc, id: Id, patch: { thickness?: number }): SceneDoc {
  const s = get(doc, id, 'slab');
  return put(doc, { ...s, thickness: patch.thickness === undefined ? s.thickness : positive(patch.thickness, 'thickness', 0.05, 2) });
}
