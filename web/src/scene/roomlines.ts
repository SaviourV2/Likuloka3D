/**
 * Reads a Roomlines plan (see the repository README, "Plan format") into a
 * building with one level:
 *
 * - each room becomes a zone with the room's name and use;
 * - every room edge becomes wall, with edges that two rooms share merged into
 *   one wall, and collinear runs joined into one wall;
 * - the outline of all rooms together becomes the level's slab.
 */
import { GRID, ROOM_TYPES, type Id, type RoomType, type SceneDoc, type Vec2 } from './types';
import { SceneError, addBuilding, addLevel, addSlab, addWall, addZone, snap } from './ops';

interface Room { name: string; type?: string; x: number; y: number; w: number; h: number }
interface Split { size: number; dir?: 'row' | 'col'; name?: string; type?: string; children?: Split[] }
export interface RoomlinesPlan {
  name?: string;
  rooms?: Room[];
  width?: number;
  depth?: number;
  layout?: Split;
}

const GUESS: [RegExp, RoomType][] = [
  [/kitchen/i, 'kitchen'], [/dining/i, 'dining'], [/bed|master|guest/i, 'bedroom'],
  [/bath|wc|toilet|shower|ensuite/i, 'bathroom'], [/office|study/i, 'office'],
  [/hall|entry|corridor|foyer/i, 'hallway'], [/laundry|utility/i, 'laundry'],
  [/storage|store|closet|pantry/i, 'storage'], [/studio/i, 'studio'],
];
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
    const room = { name: String(r.name ?? `Room ${i + 1}`), type: r.type, x: n(r.x, 'x'), y: n(r.y, 'y'), w: n(r.w, 'w'), h: n(r.h, 'h') };
    if (room.w < GRID || room.h < GRID) throw new SceneError(`Room ${i + 1} has no area`);
    return room;
  });
  if (!out.length) throw new SceneError('The plan has no rooms');
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
export function importRoomlines(doc: SceneDoc, plan: RoomlinesPlan, opts: { origin?: Vec2; levels?: number } = {}): [SceneDoc, Id] {
  const rooms = roomsOf(plan);
  let [next, buildingId] = addBuilding(doc, { name: plan.name || 'Imported plan', origin: opts.origin });
  const walls = wallsOf(rooms);
  const outline = outlineOf(rooms);
  for (let l = 0; l < Math.max(1, opts.levels ?? 1); l++) {
    let levelId: Id;
    [next, levelId] = addLevel(next, buildingId, { name: l === 0 ? 'Ground floor' : `Level ${l}` });
    [next] = addSlab(next, levelId, { points: outline, name: 'Floor slab' });
    walls.forEach(([a, b], k) => { [next] = addWall(next, levelId, { a, b, thickness: 0.15, name: `Wall ${k + 1}` }); });
    for (const r of rooms) {
      [next] = addZone(next, levelId, {
        name: r.name, use: useOf(r),
        points: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]],
      });
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
