/**
 * Reads a Roomlines plan (see the repository README, "Plan format") into a
 * building with one level:
 *
 * - each room becomes a zone with the room's name and use;
 * - every room edge becomes wall, with edges that two rooms share merged into
 *   one wall, and collinear runs joined into one wall;
 * - the outline of all rooms together becomes the level's slab;
 * - a room with `points` keeps its shape, with each corner moved onto the grid
 *   (at most half a grid step), so walls can run at an angle;
 * - with `openings`, doors, a front door and windows are added by Roomlines'
 *   own rules, so the building arrives with every room reachable.
 *
 * Roomlines' finishes, plot and furniture have no place in the scene document
 * yet and are not carried over.
 */
import { FLOOR_KEYS, GRID, ROOM_TYPES, type FloorFinish, type Id, type RoomType, type SceneDoc, type Vec2 } from './types';
import { SceneError, addBuilding, addLevel, addOpeningAt, addSlab, addWall, addZone, setPlot, snap } from './ops';

interface Room { name: string; type?: string; floor?: string; x: number; y: number; w: number; h: number; points?: Vec2[] }
interface Split { size: number; dir?: 'row' | 'col'; name?: string; type?: string; children?: Split[] }
export interface RoomlinesPlan {
  name?: string;
  /** Roomlines' plot: the corners of the land, in the plan's coordinates. */
  plot?: unknown;
  rooms?: Room[];
  width?: number;
  depth?: number;
  layout?: Split;
}

const GUESS: [RegExp, RoomType][] = [
  [/kitchen/i, 'kitchen'], [/dining/i, 'dining'], [/bed|master|guest/i, 'bedroom'],
  [/bath|wc|toilet|shower|ensuite/i, 'bathroom'], [/office|study/i, 'office'],
  [/hall|entry|corridor|foyer/i, 'hallway'], [/laundry|utility/i, 'laundry'],
  [/storage|store|closet|pantry/i, 'storage'], [/studio/i, 'studio'], [/pool|kolam/i, 'pool'],
];
/** A floor the room was given in Roomlines, when this editor has that finish; otherwise the colour of its use. */
const floorOf = (r: Room): FloorFinish => (FLOOR_KEYS as readonly string[]).includes(r.floor ?? '') ? r.floor as FloorFinish : 'none';

function useOf(room: { name?: string; type?: string }): RoomType {
  if (room.type && (ROOM_TYPES as readonly string[]).includes(room.type)) return room.type as RoomType;
  for (const [re, t] of GUESS) if (re.test(room.name ?? '')) return t;
  return 'living';
}

/** Flattens the nested `layout` form into rectangles. */
function flatten(split: Split, x: number, y: number, w: number, h: number, dir: 'row' | 'col', out: Room[]) {
  if (!split.children?.length) {
    out.push({ name: split.name ?? `Room ${out.length + 1}`, type: split.type, x, y, w, h });
    return;
  }
  const along = split.dir ?? dir;
  let at = 0;
  for (const child of split.children) {
    const size = child.size;
    if (along === 'row') flatten(child, x + at, y, size, h, along === 'row' ? 'col' : 'row', out);
    else flatten(child, x, y + at, w, size, along === 'col' ? 'row' : 'col', out);
    at += size;
  }
}

export function roomsOf(plan: RoomlinesPlan): Room[] {
  let rooms: Room[];
  if (Array.isArray(plan.rooms)) rooms = plan.rooms;
  else if (plan.layout && plan.width && plan.depth) {
    rooms = [];
    flatten(plan.layout, 0, 0, plan.width, plan.depth, plan.layout.dir ?? 'row', rooms);
  } else throw new SceneError('A Roomlines plan needs `rooms`, or `layout` with `width` and `depth`');
  const out = rooms.map((r, i) => {
    const n = (v: unknown, what: string) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new SceneError(`Room ${i + 1}: ${what} must be a number`);
      return snap(v);
    };
    if (Array.isArray(r.points)) { // a shaped room: its corners, each moved onto the grid
      const P: Vec2[] = [];
      for (const q of r.points) {
        if (!Array.isArray(q)) throw new SceneError(`Room ${i + 1}: every point must be [x, y]`);
        const at: Vec2 = [n(q[0], 'a point'), n(q[1], 'a point')];
        if (!P.length || P[P.length - 1][0] !== at[0] || P[P.length - 1][1] !== at[1]) P.push(at);
      }
      if (P.length > 1 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1]) P.pop();
      if (P.length < 3 || Math.abs(signed(P)) < GRID * GRID) throw new SceneError(`Room ${i + 1} has no area`);
      if (signed(P) < 0) P.reverse();
      const xs = P.map(q => q[0]), ys = P.map(q => q[1]), x = Math.min(...xs), y = Math.min(...ys);
      const box = P.length === 4 && P.every(q => (q[0] === x || q[0] === Math.max(...xs)) && (q[1] === y || q[1] === Math.max(...ys)));
      return { name: String(r.name ?? `Room ${i + 1}`), type: r.type, floor: r.floor, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, ...(box ? {} : { points: P }) };
    }
    const room = { name: String(r.name ?? `Room ${i + 1}`), type: r.type, floor: r.floor, x: n(r.x, 'x'), y: n(r.y, 'y'), w: n(r.w, 'w'), h: n(r.h, 'h') };
    if (room.w < GRID || room.h < GRID) throw new SceneError(`Room ${i + 1} has no area`);
    return room;
  });
  if (!out.length) throw new SceneError('The plan has no rooms');
  return out;
}

/** Twice-signed area: positive for corners listed clockwise on screen. */
function signed(P: readonly Vec2[]) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
const cornersOf = (r: Room): Vec2[] => r.points ?? [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];

/**
 * Every room edge, described on its line so that edges of different rooms on
 * the same line can be compared: `u` is the line's direction (the same
 * whichever way the room runs along it), `o` a point on it, `t0..t1` the
 * stretch the edge covers, `side` which side of the line the room is on, and
 * `fwd` whether the room runs along the line in the direction of `u`.
 */
interface Edge { room: number; key: string; u: Vec2; o: Vec2; t0: number; t1: number; side: 1 | -1; fwd: boolean }
function edgesOf(rooms: Room[]): Edge[] {
  const out: Edge[] = [];
  rooms.forEach((r, room) => {
    const P = cornersOf(r);
    P.forEach((A, i) => {
      const B = P[(i + 1) % P.length], len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (len < 1e-9) return;
      let ux = (B[0] - A[0]) / len, uy = (B[1] - A[1]) / len;
      const flip = ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0);
      if (flip) { ux = -ux; uy = -uy; }
      const k = A[0] * ux + A[1] * uy, o: Vec2 = [A[0] - ux * k, A[1] - uy * k], tB = B[0] * ux + B[1] * uy;
      const r6 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;
      out.push({ room, key: `${r6(ux)},${r6(uy)},${r6(o[0])},${r6(o[1])}`, u: [ux, uy], o, t0: Math.min(k, tB), t1: Math.max(k, tB), side: flip ? -1 : 1, fwd: !flip });
    });
  });
  return out;
}
const at = (e: { o: Vec2; u: Vec2 }, t: number): Vec2 => [snap(e.o[0] + e.u[0] * t), snap(e.o[1] + e.u[1] * t)];
function byLine(edges: Edge[]): Edge[][] { const m = new Map<string, Edge[]>(); for (const e of edges) { const l = m.get(e.key) ?? []; l.push(e); m.set(e.key, l); } return [...m.values()]; }
/** The parts of `e` that no room on the other side of its line covers. */
function bare(e: Edge, line: Edge[]): Interval[] {
  const cuts = union(line.filter(q => q.side !== e.side).map(q => [Math.max(e.t0, q.t0), Math.min(e.t1, q.t1)] as Interval).filter(iv => iv[1] - iv[0] > 1e-6));
  const out: Interval[] = []; let cur = e.t0;
  for (const [a, b] of cuts) { if (a - cur > 1e-6) out.push([cur, a]); cur = Math.max(cur, b); }
  if (e.t1 - cur > 1e-6) out.push([cur, e.t1]);
  return out;
}

/** Wall segments for rooms of any shape: every edge, with stretches on one line joined into one wall. */
function wallsOfShapes(rooms: Room[]): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (const line of byLine(edgesOf(rooms))) for (const [s, e] of union(line.map(q => [q.t0, q.t1] as Interval))) out.push([at(line[0], s), at(line[0], e)]);
  return out;
}

/** The outer outline of rooms of any shape: the bare stretches of every edge, chained into loops; the largest loop wins. */
function outlineOfShapes(rooms: Room[]): Vec2[] {
  const next = new Map<string, Vec2[]>(), key = (p: Vec2) => `${p[0]},${p[1]}`;
  for (const line of byLine(edgesOf(rooms))) for (const e of line) for (const [s, t] of bare(e, line)) {
    const a = at(e, e.fwd ? s : t), b = at(e, e.fwd ? t : s), l = next.get(key(a)) ?? [];
    l.push(b); next.set(key(a), l);
  }
  let best: Vec2[] = [], bestArea = 0;
  while (next.size) {
    const start = next.keys().next().value as string, first = start.split(',').map(Number) as unknown as Vec2;
    const loop: Vec2[] = [first]; let cur = first;
    for (let guard = 0; guard < 4000; guard++) {
      const l = next.get(key(cur)); if (!l?.length) break;
      const to = l.shift()!; if (!l.length) next.delete(key(cur));
      if (to[0] === first[0] && to[1] === first[1]) break;
      loop.push(to); cur = to;
    }
    const a = Math.abs(signed(loop));
    if (loop.length >= 3 && a > bestArea) { bestArea = a; best = loop; }
  }
  return best.filter((p, k) => { const a = best[(k - 1 + best.length) % best.length], c = best[(k + 1) % best.length]; return Math.abs((p[0] - a[0]) * (c[1] - p[1]) - (p[1] - a[1]) * (c[0] - p[0])) > 1e-9; });
}

/**
 * Where Roomlines would put doors and windows: a door tree grown from the most
 * corridor-like room so every room is reachable, a wide opening between living,
 * kitchen and dining rooms (drawn here as an open door), a front door on the
 * entry room's longest outside wall, and windows on outside walls by room use.
 */
const CIRC: Record<RoomType, number> = { hallway: 0, living: 1, studio: 1, dining: 2, kitchen: 3, office: 5, bedroom: 6, laundry: 7, storage: 8, bathroom: 9, pool: 10 };
const WINDOWS: Record<RoomType, number> = { living: 2, studio: 2, kitchen: 1, dining: 1, bedroom: 1, bathroom: 1, office: 1, laundry: 1, hallway: 0, storage: 0, pool: 0 };
export interface PlannedOpening { kind: 'door' | 'window'; at: Vec2; width: number; height: number; sill: number; open?: boolean }
export function openingsOf(rooms: Room[]): PlannedOpening[] {
  const uses = rooms.map(useOf), areaOf = (i: number) => Math.abs(signed(cornersOf(rooms[i])));
  interface Piece { e: Edge; t0: number; t1: number; a: number; b?: number }
  const shared: Piece[] = [], outside: Piece[] = [];
  for (const line of byLine(edgesOf(rooms))) for (const e of line) {
    for (const q of line) if (q.side !== e.side && e.room < q.room) { const a = Math.max(e.t0, q.t0), b = Math.min(e.t1, q.t1); if (b - a > 0.05) shared.push({ e, t0: a, t1: b, a: e.room, b: q.room }); }
    for (const [a, b] of bare(e, line)) if (b - a > 0.05) outside.push({ e, t0: a, t1: b, a: e.room });
  }
  const order = rooms.map((_, i) => i).sort((p, q) => CIRC[uses[p]] - CIRC[uses[q]] || areaOf(q) - areaOf(p));
  const reached = new Set([order[0]]), doors = new Set<Piece>();
  for (;;) {
    let best: Piece | null = null, to = -1, cost = Infinity;
    for (const p of shared) {
      const len = p.t1 - p.t0; if (len < 0.9) continue;
      const ia = reached.has(p.a), ib = reached.has(p.b!); if (ia === ib) continue;
      const from = ia ? p.a : p.b!, other = ia ? p.b! : p.a;
      const c = CIRC[uses[from]] * 10 - Math.min(len, 3) + (uses[other] === 'bathroom' && uses[from] === 'kitchen' ? 40 : 0);
      if (c < cost) { cost = c; best = p; to = other; }
    }
    if (!best) break;
    reached.add(to); doors.add(best);
  }
  const out: PlannedOpening[] = [], OPEN = new Set<RoomType>(['living', 'kitchen', 'dining', 'studio']);
  const mid = (p: Piece, t: number): Vec2 => [p.e.o[0] + p.e.u[0] * t, p.e.o[1] + p.e.u[1] * t];
  for (const p of shared) {
    const len = p.t1 - p.t0;
    if (OPEN.has(uses[p.a]) && OPEN.has(uses[p.b!]) && len >= 1.6) out.push({ kind: 'door', at: mid(p, (p.t0 + p.t1) / 2), width: Math.min(len - 0.6, 2.5), height: 2.2, sill: 0, open: true });
    else if (doors.has(p)) {
      const small = [uses[p.a], uses[p.b!]].some(t => t === 'bathroom' || t === 'storage' || t === 'laundry'), w = small ? 0.8 : 0.9;
      out.push({ kind: 'door', at: mid(p, len >= w + 1.6 ? p.t0 + 0.4 + w / 2 : (p.t0 + p.t1) / 2), width: w, height: 2.05, sill: 0 });
    }
  }
  const outsideOf = (i: number) => outside.filter(p => p.a === i).sort((p, q) => (q.t1 - q.t0) - (p.t1 - p.t0));
  let entry: Piece | null = null;
  for (const i of order) { entry = outsideOf(i).find(p => p.t1 - p.t0 >= 1.2) ?? null; if (entry) break; }
  if (entry) { const len = entry.t1 - entry.t0; out.push({ kind: 'door', at: mid(entry, len >= 3.2 ? entry.t0 + 1.1 : (entry.t0 + entry.t1) / 2), width: 1, height: 2.1, sill: 0 }); }
  rooms.forEach((_, i) => {
    let n = 0;
    for (const p of outsideOf(i)) {
      if (n >= WINDOWS[uses[i]]) break;
      const len = p.t1 - p.t0; if (p === entry || len < 1.4) continue;
      const u = uses[i];
      const [w, sill, head] = u === 'bathroom' || u === 'laundry' ? [0.7, 1.3, 2.0] : u === 'living' || u === 'studio' || u === 'dining' ? [Math.min(2.6, len - 0.8), 0.45, 2.15] : [Math.min(1.6, len - 0.8), 0.9, 2.1];
      if (w < 0.6) continue;
      out.push({ kind: 'window', at: mid(p, (p.t0 + p.t1) / 2), width: w, height: head - sill, sill }); n++;
    }
  });
  return out;
}

type Interval = [number, number];
function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.slice().sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Wall segments along every room edge, with shared edges merged. */
export function wallsOf(rooms: Room[]): [Vec2, Vec2][] {
  const horizontal = new Map<number, Interval[]>();
  const vertical = new Map<number, Interval[]>();
  const add = (m: Map<number, Interval[]>, k: number, iv: Interval) => {
    const list = m.get(k) ?? [];
    list.push(iv);
    m.set(k, list);
  };
  for (const r of rooms) {
    add(horizontal, r.y, [r.x, r.x + r.w]);
    add(horizontal, r.y + r.h, [r.x, r.x + r.w]);
    add(vertical, r.x, [r.y, r.y + r.h]);
    add(vertical, r.x + r.w, [r.y, r.y + r.h]);
  }
  const out: [Vec2, Vec2][] = [];
  for (const [y, list] of [...horizontal].sort((p, q) => p[0] - q[0])) for (const [s, e] of union(list)) out.push([[s, y], [e, y]]);
  for (const [x, list] of [...vertical].sort((p, q) => p[0] - q[0])) for (const [s, e] of union(list)) out.push([[x, s], [x, e]]);
  return out;
}

/**
 * The outer outline of the rooms together: the rooms are rasterised on the
 * grid, the cell edges between inside and outside are chained into loops and
 * the loop with the largest area is kept, with straight runs merged.
 */
export function outlineOf(rooms: Room[]): Vec2[] {
  const minX = Math.min(...rooms.map(r => r.x));
  const minY = Math.min(...rooms.map(r => r.y));
  const maxX = Math.max(...rooms.map(r => r.x + r.w));
  const maxY = Math.max(...rooms.map(r => r.y + r.h));
  const cols = Math.round((maxX - minX) / GRID);
  const rows = Math.round((maxY - minY) / GRID);
  if (cols * rows > 400_000) throw new SceneError('The plan is too large to outline');
  const cell = new Uint8Array(cols * rows);
  for (const r of rooms) {
    const c0 = Math.round((r.x - minX) / GRID), c1 = Math.round((r.x + r.w - minX) / GRID);
    const r0 = Math.round((r.y - minY) / GRID), r1 = Math.round((r.y + r.h - minY) / GRID);
    for (let j = r0; j < r1; j++) for (let i = c0; i < c1; i++) cell[j * cols + i] = 1;
  }
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows && cell[j * cols + i] === 1;
  // Directed boundary edges with the inside on the left (clockwise in screen
  // coordinates), keyed by start corner.
  const next = new Map<string, [number, number][]>();
  const key = (i: number, j: number) => `${i},${j}`;
  const edge = (a: [number, number], b: [number, number]) => {
    const list = next.get(key(...a)) ?? [];
    list.push(b);
    next.set(key(...a), list);
  };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (!inside(i, j)) continue;
    if (!inside(i, j - 1)) edge([i, j], [i + 1, j]);
    if (!inside(i + 1, j)) edge([i + 1, j], [i + 1, j + 1]);
    if (!inside(i, j + 1)) edge([i + 1, j + 1], [i, j + 1]);
    if (!inside(i - 1, j)) edge([i, j + 1], [i, j]);
  }
  let best: [number, number][] = [];
  let bestArea = 0;
  while (next.size) {
    const startKey = next.keys().next().value as string;
    const start = startKey.split(',').map(Number) as [number, number];
    const loop: [number, number][] = [start];
    let at = start;
    for (let guard = 0; guard < cols * rows * 4 + 8; guard++) {
      const list = next.get(key(...at));
      if (!list?.length) break;
      const to = list.shift()!;
      if (!list.length) next.delete(key(...at));
      if (to[0] === start[0] && to[1] === start[1]) break;
      loop.push(to);
      at = to;
    }
    let a = 0;
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k], q = loop[(k + 1) % loop.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = loop; }
  }
  const corners = best.filter((p, k) => {
    const prev = best[(k - 1 + best.length) % best.length];
    const nxt = best[(k + 1) % best.length];
    return (p[0] - prev[0]) * (nxt[1] - p[1]) - (p[1] - prev[1]) * (nxt[0] - p[0]) !== 0;
  });
  return corners.map(([i, j]) => [minX + i * GRID, minY + j * GRID] as Vec2);
}

/** Adds the plan to the document as a new building. */
export function importRoomlines(doc: SceneDoc, plan: RoomlinesPlan, opts: { origin?: Vec2; levels?: number; openings?: boolean } = {}): [SceneDoc, Id] {
  const rooms = roomsOf(plan);
  let [next, buildingId] = addBuilding(doc, { name: plan.name || 'Imported plan', origin: opts.origin });
  // plain rectangles keep the original, grid-exact route; any shaped room switches to the edge-based one
  const shaped = rooms.some(r => r.points);
  const walls = shaped ? wallsOfShapes(rooms) : wallsOf(rooms);
  const outline = shaped ? outlineOfShapes(rooms) : outlineOf(rooms);
  if (outline.length < 3) throw new SceneError('The rooms of this plan do not form an outline');
  const planned = opts.openings ? openingsOf(rooms) : [];
  // The plan's plot becomes the project's, unless the project already has one.
  if (!doc.plot && Array.isArray(plan.plot)) {
    const o = (next.nodes[buildingId] as { origin: Vec2 }).origin;
    try { next = setPlot(next, (plan.plot as Vec2[]).map(p => [p[0] + o[0], p[1] + o[1]] as Vec2)); }
    catch (e) { if (!(e instanceof SceneError)) throw e; } // not a usable outline: the rooms still import
  }
  for (let l = 0; l < Math.max(1, opts.levels ?? 1); l++) {
    let levelId: Id;
    [next, levelId] = addLevel(next, buildingId, { name: l === 0 ? 'Ground floor' : `Level ${l}` });
    [next] = addSlab(next, levelId, { points: outline, name: 'Floor slab' });
    const wallIds: Id[] = [];
    walls.forEach(([a, b], k) => { let wid: Id; [next, wid] = addWall(next, levelId, { a, b, thickness: 0.15, name: `Wall ${k + 1}` }); wallIds.push(wid); });
    for (const r of rooms) [next] = addZone(next, levelId, { name: r.name, use: useOf(r), points: cornersOf(r), floor: floorOf(r) });
    for (const o of planned) {
      // the wall this opening sits on: the one whose line passes through the point, between its ends
      const k = walls.findIndex(([a, b]) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, s = (o.at[0] - a[0]) * ux + (o.at[1] - a[1]) * uy; return s > 0 && s < len && Math.abs((o.at[0] - a[0]) * uy - (o.at[1] - a[1]) * ux) < 0.13; });
      if (k < 0) continue;
      try { [next] = addOpeningAt(next, wallIds[k], o.kind, o.at, { width: o.width, height: o.height, sill: o.sill, ...(o.open ? { state: 'open' as const } : {}) }); }
      catch (e) { if (!(e instanceof SceneError)) throw e; } // no room for it once corners moved to the grid: leave the wall plain
    }
  }
  return [next, buildingId];
}

/** The sample home the editor opens with: the README's plans, on two floors. */
export const SAMPLE: RoomlinesPlan = {
  name: 'Two bedroom house',
  rooms: [
    { name: 'Living room', type: 'living', x: 0, y: 0, w: 5.5, h: 4.5 },
    { name: 'Kitchen', type: 'kitchen', x: 0, y: 4.5, w: 5.5, h: 3.25 },
    { name: 'Hallway', type: 'hallway', x: 5.5, y: 0, w: 1.5, h: 7.75 },
    { name: 'Bedroom', type: 'bedroom', x: 7, y: 0, w: 4, h: 4.25 },
    { name: 'Bathroom', type: 'bathroom', x: 7, y: 4.25, w: 2.5, h: 3.5 },
    { name: 'Office', type: 'office', x: 9.5, y: 4.25, w: 1.5, h: 3.5 },
  ],
};
