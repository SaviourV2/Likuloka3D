/**
 * Pure operations on the scene document. Each takes a document and returns a
 * new one; nodes that an operation does not touch keep their identity, which
 * is what dirty tracking and undo rely on. Invalid input throws a SceneError.
 */
import {
  GRID, MIN_ARCH_SIDE, MIN_WALL, OPENING_DEFAULTS, OPENING_FINISHES, OPENING_MARGIN, OPENING_SHAPES, ROOM_TYPES, UNTITLED,
  type BuildingNode, type Id, type LevelNode, type NodeOf, type NodeType, type OpeningFinish, type OpeningKind, type OpeningNode,
  type OpeningShape, type OpeningState, type RoomType, type SceneDoc, type SceneNode, type SlabNode, type Vec2, type WallNode, type ZoneNode,
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

export const emptyDoc = (name = UNTITLED): SceneDoc => ({ name, nodes: {}, roots: [] });

export function renameProject(doc: SceneDoc, name: string): SceneDoc {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) throw new SceneError('A project needs a name');
  return trimmed === doc.name ? doc : { ...doc, name: trimmed };
}

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
  return { ...doc, nodes };
}

function attach(doc: SceneDoc, node: SceneNode, index?: number): SceneDoc {
  if (node.parent === null) {
    const roots = [...doc.roots];
    roots.splice(index ?? roots.length, 0, node.id);
    return { ...doc, nodes: { ...doc.nodes, [node.id]: node }, roots };
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
    children: prev?.children ?? [],
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
  const next = put(doc, wallFrom(level, { ...wall, ...patch }, id, wall));
  return reanchor(doc, next, [id]);
}

/** Moves every wall end on the level that sits on `from`, without touching openings. */
function moveEnds(doc: SceneDoc, level: LevelNode, from: Vec2, target: Vec2, moved: Set<Id>): SceneDoc {
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
    moved.add(n.id);
  }
  return put(doc, ...changed);
}

/**
 * Moves one end of a wall. Every other wall on the level whose end sat on the
 * same point moves with it, so joined walls stay joined. Doors and windows in
 * the walls that changed keep their place in the room.
 */
export function moveWallEnd(doc: SceneDoc, id: Id, end: 'a' | 'b', to: Vec2): SceneDoc {
  const wall = get(doc, id, 'wall');
  const from = wall[end];
  const target = point(to, end);
  if (samePoint(from, target)) return doc;
  const moved = new Set<Id>();
  const next = moveEnds(doc, get(doc, wall.parent, 'level'), from, target, moved);
  return reanchor(doc, next, moved);
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
  // Move b first while a still identifies the wall's other joints, then
  // place openings once, against the walls as they were before.
  const level = get(doc, wall.parent, 'level');
  const moved = new Set<Id>();
  let next = moveEnds(doc, level, wall.b, b2, moved);
  next = moveEnds(next, get(next, level.id, 'level'), wall.a, a2, moved);
  return reanchor(doc, next, moved);
}

// ---- doors and windows -----------------------------------------------------------

const wallLength = (w: WallNode) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
const openingsOf = (doc: SceneDoc, w: WallNode) => w.children.map(c => doc.nodes[c]).filter((n): n is OpeningNode => n?.type === 'opening');

/** Throws unless every opening fits inside the wall and clear of the others. */
function checkFits(wall: WallNode, openings: readonly OpeningNode[]) {
  const len = wallLength(wall);
  const sorted = [...openings].sort((p, q) => p.offset - q.offset);
  let end = 0;
  for (const o of sorted) {
    const what = o.kind === 'door' ? 'door' : 'window';
    if (o.sill + o.height > wall.height + 1e-6) throw new SceneError(`The ${what} is taller than the wall`);
    if (o.shape === 'arched' && o.height < o.width / 2 + MIN_ARCH_SIDE - 1e-6) {
      throw new SceneError(`A rounded ${what} must be at least ${(o.width / 2 + MIN_ARCH_SIDE).toFixed(2)} m tall at this width`);
    }
    if (o.offset - o.width / 2 < OPENING_MARGIN - 1e-6 || o.offset + o.width / 2 > len - OPENING_MARGIN + 1e-6) {
      throw new SceneError(`The ${what} does not fit in the wall`);
    }
    if (o.offset - o.width / 2 < end - 1e-6) throw new SceneError(`The ${what} overlaps another opening`);
    end = o.offset + o.width / 2 + OPENING_MARGIN;
  }
}

/**
 * After walls change, keeps each of their openings at the same point in the
 * room: the opening's centre on the old wall is projected onto the new one.
 */
function reanchor(before: SceneDoc, after: SceneDoc, walls: Iterable<Id>): SceneDoc {
  const changed: SceneNode[] = [];
  for (const id of walls) {
    const old = before.nodes[id];
    const now = after.nodes[id];
    if (old?.type !== 'wall' || now?.type !== 'wall') continue;
    const oldLen = wallLength(old);
    const len = wallLength(now);
    const ux = (now.b[0] - now.a[0]) / len, uy = (now.b[1] - now.a[1]) / len;
    const placed = openingsOf(after, now).map(o => {
      const t = o.offset / oldLen;
      const cx = old.a[0] + (old.b[0] - old.a[0]) * t;
      const cy = old.a[1] + (old.b[1] - old.a[1]) * t;
      const offset = snapOffset((cx - now.a[0]) * ux + (cy - now.a[1]) * uy);
      return offset === o.offset ? o : { ...o, offset };
    });
    checkFits(now, placed);
    placed.forEach((o, i) => { if (o !== openingsOf(after, now)[i]) changed.push(o); });
  }
  return changed.length ? put(after, ...changed) : after;
}

const snapOffset = (v: number) => Math.round(v / (GRID / 2)) * (GRID / 2);

export interface OpeningInput {
  kind: OpeningKind; offset: number; width?: number; height?: number; sill?: number; name?: string;
  shape?: OpeningShape; finish?: OpeningFinish; state?: OpeningState;
}

function openingFrom(wall: WallNode, input: OpeningInput, id: Id, prev?: OpeningNode): OpeningNode {
  if (input.kind !== 'door' && input.kind !== 'window') throw new SceneError('An opening is a door or a window');
  const d = OPENING_DEFAULTS[input.kind];
  const kindChanged = prev && prev.kind !== input.kind;
  const pick = (v: number | undefined, fallback: number) => (v === undefined ? fallback : v);
  const width = positive(pick(input.width, kindChanged ? d.width : (prev?.width ?? d.width)), 'width', GRID, 10);
  const height = positive(pick(input.height, kindChanged ? d.height : (prev?.height ?? d.height)), 'height', 0.3, 10);
  const sillIn = pick(input.sill, kindChanged ? d.sill : (prev?.sill ?? d.sill));
  const sill = Math.round(finite(sillIn, 'sill') * 100) / 100;
  if (sill < 0) throw new SceneError('sill cannot be below the floor');
  const shape = input.shape ?? prev?.shape ?? 'square';
  if (!OPENING_SHAPES.includes(shape)) throw new SceneError('The shape is square or arched');
  const finish = input.finish ?? prev?.finish ?? d.finish;
  if (!OPENING_FINISHES.includes(finish)) throw new SceneError('The finish is timber, steel, aluminium or uPVC');
  const state = input.state ?? prev?.state ?? 'closed';
  if (state !== 'open' && state !== 'closed') throw new SceneError('An opening is open or closed');
  return {
    id, type: 'opening', parent: wall.id, kind: input.kind,
    name: input.name?.trim() || (kindChanged || !prev ? (input.kind === 'door' ? 'Door' : 'Window') : prev.name),
    offset: snapOffset(finite(input.offset, 'offset')),
    width: Math.round(width / GRID) * GRID || GRID,
    height, sill, shape, finish, state,
  };
}

export function addOpening(doc: SceneDoc, wallId: Id, input: OpeningInput, id = newId('opening')): [SceneDoc, Id] {
  const wall = get(doc, wallId, 'wall');
  const node = openingFrom(wall, input, id);
  checkFits(wall, [...openingsOf(doc, wall), node]);
  return [attach(doc, node), id];
}

/** Adds a door or window centred on the point of the wall nearest to `at`, kept inside the wall. */
export function addOpeningAt(doc: SceneDoc, wallId: Id, kind: OpeningKind, at: Vec2, input: Partial<OpeningInput> = {}): [SceneDoc, Id] {
  const wall = get(doc, wallId, 'wall');
  const len = wallLength(wall);
  const width = input.width ?? OPENING_DEFAULTS[kind].width;
  const ux = (wall.b[0] - wall.a[0]) / len, uy = (wall.b[1] - wall.a[1]) / len;
  const s = (at[0] - wall.a[0]) * ux + (at[1] - wall.a[1]) * uy;
  const lo = width / 2 + OPENING_MARGIN, hi = len - width / 2 - OPENING_MARGIN;
  if (hi < lo) throw new SceneError(`This wall is too short for a ${kind}`);
  let offset = snapOffset(Math.min(hi, Math.max(lo, s)));
  if (offset < lo) offset += GRID / 2;
  if (offset > hi) offset -= GRID / 2;
  return addOpening(doc, wallId, { ...input, kind, offset, width });
}

export function updateOpening(doc: SceneDoc, id: Id, patch: Partial<OpeningInput>): SceneDoc {
  const o = get(doc, id, 'opening');
  const wall = get(doc, o.parent, 'wall');
  // A door turned into a window (or back) takes that kind's height and sill, and keeps its place and width.
  let base: OpeningInput = patch.kind && patch.kind !== o.kind
    ? { kind: patch.kind, offset: o.offset, width: o.width, shape: o.shape, finish: o.finish, state: o.state }
    : o;
  // Rounding a head that is too short for its arch raises it just enough, unless a height is given.
  const shape = patch.shape ?? base.shape;
  const width = patch.width ?? base.width ?? o.width;
  if (shape === 'arched' && patch.height === undefined) {
    const need = Math.ceil((width / 2 + MIN_ARCH_SIDE) * 20 - 1e-6) / 20;
    if ((base.height ?? o.height) < need) base = { ...base, height: need };
  }
  const next = openingFrom(wall, { ...base, ...patch }, id, o);
  const same = (Object.keys(next) as (keyof OpeningNode)[]).every(k => next[k] === o[k]);
  if (same) return doc;
  checkFits(wall, openingsOf(doc, wall).map(x => (x.id === id ? next : x)));
  return put(doc, next);
}

/** Slides an opening along its wall by `delta` metres. */
export function slideOpening(doc: SceneDoc, id: Id, delta: number): SceneDoc {
  const o = get(doc, id, 'opening');
  return updateOpening(doc, id, { offset: o.offset + finite(delta, 'delta') });
}

/** The wall on a level whose centre line passes through `p`, if any. */
export function wallAt(doc: SceneDoc, levelId: Id, p: Vec2): WallNode | null {
  for (const c of get(doc, levelId, 'level').children) {
    const w = doc.nodes[c];
    if (w?.type !== 'wall') continue;
    const len = wallLength(w);
    const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
    const s = (p[0] - w.a[0]) * ux + (p[1] - w.a[1]) * uy;
    const d = Math.abs((p[0] - w.a[0]) * -uy + (p[1] - w.a[1]) * ux);
    if (s >= -1e-6 && s <= len + 1e-6 && d < 1e-6) return w;
  }
  return null;
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
  if (node.parent === null) return { ...doc, nodes, roots: doc.roots.filter(r => r !== id) };
  const parent = nodes[node.parent] as BuildingNode | LevelNode | WallNode;
  nodes[parent.id] = { ...parent, children: parent.children.filter(c => c !== id) };
  return { ...doc, nodes };
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
/**
 * Brings a scene saved by an older version up to date: walls before openings
 * had no `children`, openings before their options had no shape, finish or
 * state, and scenes before projects had no name. Returns a new object.
 */
export function migrate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const doc = raw as { name?: unknown; nodes?: Record<string, Record<string, unknown>>; roots?: unknown };
  if (!doc.nodes || typeof doc.nodes !== 'object') return raw;
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (n?.type === 'wall' && !n.children) nodes[id] = { ...n, children: [] };
    else if (n?.type === 'opening') {
      const kind = n.kind === 'window' ? 'window' : 'door';
      nodes[id] = { shape: 'square', finish: OPENING_DEFAULTS[kind].finish, state: 'closed', ...n };
    } else nodes[id] = n;
  }
  return { ...doc, name: typeof doc.name === 'string' && doc.name.trim() ? doc.name : UNTITLED, nodes };
}

export function validate(doc: unknown): SceneDoc {
  if (!doc || typeof doc !== 'object') throw new SceneError('Not a scene');
  const d = doc as SceneDoc;
  if (typeof d.name !== 'string') throw new SceneError('The project has no name');
  if (!Array.isArray(d.roots) || !d.nodes || typeof d.nodes !== 'object') throw new SceneError('Not a scene');
  const seen = new Set<Id>();
  const walk = (id: Id, parent: Id | null, expect: NodeType[]) => {
    const n = d.nodes[id];
    if (!n || n.id !== id || n.parent !== parent || !expect.includes(n.type) || seen.has(id)) throw new SceneError(`Broken node ${id}`);
    seen.add(id);
    if (n.type === 'building') n.children.forEach(c => walk(c, id, ['level']));
    if (n.type === 'level') n.children.forEach(c => walk(c, id, ['wall', 'zone', 'slab']));
    if (n.type === 'wall') {
      if (!Array.isArray(n.children)) throw new SceneError(`Broken node ${id}`);
      n.children.forEach(c => walk(c, id, ['opening']));
    }
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
