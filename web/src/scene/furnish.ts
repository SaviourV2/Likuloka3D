/**
 * Furniture for a level, worked out from its rooms.
 *
 * Nothing here is stored: the pieces follow from each zone's outline and use
 * and from where the level's doors and windows are, so they move when a wall
 * does. The recipes and the placing rules are Roomlines' (`app.html`), kept
 * as they were so both lay a room out the same way:
 *
 * - a piece is tried along a wall of the room (`along`, `anySide`) or loose in
 *   the room (`free`), and placed only where it stays inside the outline,
 *   clear of other pieces and of the floor in front of every door;
 * - tall pieces also stay clear of windows;
 * - each piece is a list of boxes, and may name model files that replace the
 *   boxes when they have loaded (`public/models`).
 *
 * A room is measured to the inside faces of its walls: each edge of the zone
 * is moved in by half the thickness of the wall on it.
 */
import type { Id, OpeningNode, RoomType, SceneDoc, WallNode, ZoneNode } from './types';

type Pt = [number, number];
/** A box of a piece: from a0 to a1 along the wall, d0 to d1 out from it, z0 to z1 up, its colour and its shape. */
type Part = [number, number, number, number, number, number, number, string?];
/** A model of a piece: its file name, then the same six limits, and 'flip' to face the wall. */
type Model = [string, number, number, number, number, number, number, string?];
interface Item { w: number; dep: number; parts: Part[]; models?: Model[]; tall?: boolean; soft?: boolean }

export interface FurnitureBox { kind: 'box' | 'cyl' | 'ball' | 'glass'; cx: number; cz: number; lw: number; ld: number; z0: number; z1: number; yaw: number; color: number; x0: number; x1: number; y0: number; y1: number }
export interface FurnitureModel { name: string; cx: number; cz: number; w: number; d: number; y0: number; h: number; yaw: number }
/** One piece of furniture: its boxes and, when it has them, the models that replace the boxes. */
export interface FurniturePiece { zone: Id; boxes: FurnitureBox[]; models: FurnitureModel[] | null; tint: number }

interface Quad { pts: Pt[]; flat: boolean; x0: number; x1: number; y0: number; y1: number }
interface Frame { side: string; len: number; depth: number; u: Pt; n: Pt; yaw: number; at: (a: number, d: number) => Pt }
interface Info { side: string; fr: Frame; len: number; depth: number; doors: number; windows: number; score?: number }
interface Room { x: number; y: number; w: number; h: number; points?: Pt[] }
interface Ctx { r: Room; frames: Frame[]; zones: Quad[]; winZones: Quad[]; placed: Quad[]; pieces: FurniturePiece[]; soft: number; zone: Id }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const signedArea = (P: readonly (readonly number[])[]) => P.reduce((t, p, i) => { const q = P[(i + 1) % P.length]; return t + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

function inPoly(P: Pt[], x: number, y: number, tol = 1e-6) { // inside or on the edge
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j], dx = xj - xi, dy = yj - yi, len2 = dx * dx + dy * dy;
    const k = len2 ? clamp(((x - xi) * dx + (y - yi) * dy) / len2, 0, 1) : 0;
    if (Math.hypot(x - xi - dx * k, y - yi - dy * k) <= tol) return true;
    if ((yi > y) !== (yj > y) && x < dx * (y - yi) / dy + xi) inside = !inside;
  }
  return inside;
}

/** The edges of a room. `u` runs along the edge and `n` points into the room; `at(a, d)` is the point a metres along and d metres in. */
function edgesOf(r: Room): Frame[] {
  const P: Pt[] = r.points ?? [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  // A rectangle lists its sides as north, south, west, east, the order Roomlines has always used.
  const order = r.points ? P.map((_, i) => i) : [0, 2, 3, 1], names: Record<number, string> | null = r.points ? null : { 0: 'N', 2: 'S', 3: 'W', 1: 'E' };
  return order.map(i => {
    const A = P[i], B = P[(i + 1) % P.length], len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1e-9;
    const u: Pt = [(B[0] - A[0]) / len, (B[1] - A[1]) / len], n: Pt = [-u[1], u[0]];
    return { side: names ? names[i] : 'e' + i, len, u, n,
      depth: Math.max(...P.map(q => (q[0] - A[0]) * n[0] + (q[1] - A[1]) * n[1])), yaw: Math.atan2(-u[1], u[0]),
      at: (a: number, d: number): Pt => [A[0] + u[0] * a + n[0] * d, A[1] + u[1] * a + n[1] * d] };
  });
}

/** A four-cornered area on the floor: its corners, its bounding box, and whether it is square to the axes. */
function quadOf(pts: Pt[]): Quad {
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
  const flat = pts.every((q, i) => { const c = pts[(i + 1) % 4]; return Math.abs(q[0] - c[0]) < 1e-9 || Math.abs(q[1] - c[1]) < 1e-9; });
  return { pts, flat, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

function hit(A: Quad, B: Quad) { // do two such areas overlap by more than a hair
  if (!(A.x0 < B.x1 - 1e-6 && A.x1 > B.x0 + 1e-6 && A.y0 < B.y1 - 1e-6 && A.y1 > B.y0 + 1e-6)) return false;
  if (A.flat && B.flat) return true;
  for (const Q of [A, B]) for (let i = 0; i < 4; i++) { // any edge of either that separates them means no overlap
    const a = Q.pts[i], b = Q.pts[(i + 1) % 4], nx = b[1] - a[1], ny = a[0] - b[0], len = Math.hypot(nx, ny) || 1;
    const span = (W: Quad) => { const v = W.pts.map(q => (q[0] * nx + q[1] * ny) / len); return [Math.min(...v), Math.max(...v)]; };
    const [a0, a1] = span(A), [b0, b1] = span(B);
    if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
  }
  return true;
}

const C = { wood: 0xb58d62, dark: 0x6a5242, white: 0xf3f1ec, steel: 0xb7bfc7, black: 0x22272c, stone: 0xe4e1da, cab: 0x7f8f8a, ward: 0xd9d2c4, green: 0x5d8f5c, pot: 0x8b8f95, rug: 0xcdbfa8 };
const SOFT = [0x6f8ba3, 0xb9805f, 0x86a184, 0xa48db5];
const lighten = (c: number, k: number) => { const r = c >> 16 & 255, g = c >> 8 & 255, b = c & 255, m = (v: number) => Math.round(v + (255 - v) * k); return m(r) << 16 | m(g) << 8 | m(b); };

// The floor area a piece covers, measured from one wall of the room: a0..a1 along the wall, d0..d1 out from it.
const area = (fr: Frame, a0: number, a1: number, d0: number, d1: number) => quadOf([fr.at(a0, d0), fr.at(a1, d0), fr.at(a1, d1), fr.at(a0, d1)]);
function sideInfo(ctx: Ctx, fr: Frame): Info {
  const strip = area(fr, 0, fr.len, 0, 0.3);
  return { side: fr.side, fr, len: fr.len, depth: fr.depth, doors: ctx.zones.filter(z => hit(z, strip)).length, windows: ctx.winZones.filter(z => hit(z, strip)).length };
}
type Score = (i: Info) => number;
const sides = (ctx: Ctx, score: Score, skip: string[] = []) => ctx.frames.filter(f => !skip.includes(f.side)).map(f => sideInfo(ctx, f)).map(i => ({ ...i, score: score(i) })).sort((a, b) => b.score - a.score);
// the wall that faces a given one most directly
const facing = (ctx: Ctx, fr: Frame) => sideInfo(ctx, ctx.frames.filter(f => f !== fr).reduce((best, f) => (f.n[0] * fr.n[0] + f.n[1] * fr.n[1] < best.n[0] * fr.n[0] + best.n[1] * fr.n[1] - 1e-9 ? f : best)));

function put(ctx: Ctx, fr: Frame, a: number, d: number, item: Item): boolean {
  if (a < 0.04 || a + item.w > fr.len - 0.04 || d < 0 || d + item.dep > fr.depth - 0.04) return false;
  if (ctx.r.points) { // a slanted wall or an inward corner may cut into the footprint, so test points all over it, not just its corners
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const q = fr.at(a + 0.01 + (item.w - 0.02) * i / 4, d + 0.01 + (item.dep - 0.02) * j / 4); if (!inPoly(ctx.r.points, q[0], q[1], 0.02)) return false; }
  }
  if (!item.soft) {
    const box = area(fr, a + 0.01, a + item.w - 0.01, d + 0.01, d + item.dep - 0.01);
    if (ctx.placed.some(p => hit(p, box)) || ctx.zones.some(z => hit(z, box))) return false;
    if (item.tall && ctx.winZones.some(z => hit(z, box))) return false;
    ctx.placed.push(box);
  }
  // every box knows its bounding box (x0..y1) and, for drawing, its centre, size and turn
  const solidOf = (a0: number, a1: number, d0: number, d1: number) => { const q = area(fr, a0, a1, d0, d1), c = fr.at((a0 + a1) / 2, (d0 + d1) / 2); return { x0: q.x0, x1: q.x1, y0: q.y0, y1: q.y1, cx: c[0], cz: c[1], lw: a1 - a0, ld: d1 - d0, yaw: fr.yaw }; };
  const boxes: FurnitureBox[] = item.parts.map(p => ({ ...solidOf(a + p[0], a + p[1], d + p[2], d + p[3]), z0: p[4], z1: p[5], color: p[6], kind: (p[7] || 'box') as FurnitureBox['kind'] }));
  // Every model in the kit faces +z with its back at the lowest z, so turning it with the wall puts its back to the wall.
  const models = item.models ? item.models.map(m => {
    const c = fr.at(a + (m[1] + m[2]) / 2, d + (m[3] + m[4]) / 2);
    return { name: m[0], cx: c[0], cz: c[1], w: m[2] - m[1], d: m[4] - m[3], y0: m[5], h: m[6] - m[5], yaw: fr.yaw + (m[7] === 'flip' ? Math.PI : 0) };
  }) : null;
  ctx.pieces.push({ zone: ctx.zone, boxes, models, tint: ctx.soft });
  return true;
}
type Where = 'center' | 'start' | 'end';
function along(ctx: Ctx, info: Info, item: Item, order: Where[] = ['center', 'start', 'end'], d = 0): number | null {
  for (const o of order) {
    const a = o === 'center' ? (info.len - item.w) / 2 : o === 'start' ? 0.06 : info.len - item.w - 0.06;
    if (put(ctx, info.fr, a, d, item)) return a;
  }
  return null;
}
function anySide(ctx: Ctx, item: Item, score: Score, order?: Where[], skip?: string[]): Info | null { for (const s of sides(ctx, score, skip)) if (along(ctx, s, item, order) !== null) return s; return null; }
function free(ctx: Ctx, item: Item): boolean {
  const spots = [[.5, .5], [.5, .64], [.5, .36], [.64, .5], [.36, .5], [.66, .66], [.34, .34], [.66, .34], [.34, .66]];
  // tried along one wall and then along the wall most square to it, so the piece can sit either way round
  const all = ctx.frames, first = all[0], second = all.find(f => f.side === 'W') || all.slice(1).reduce((b, f) => (Math.abs(f.u[0] * first.u[0] + f.u[1] * first.u[1]) < Math.abs(b.u[0] * first.u[0] + b.u[1] * first.u[1]) ? f : b));
  for (const fr of [first, second]) for (const [fa, fd] of spots) if (put(ctx, fr, (fr.len - item.w) * fa, (fr.depth - item.dep) * fd, item)) return true;
  return false;
}
const solid: Score = i => -i.doors * 10 - i.windows * 3 + i.len * 0.1;

const bedItem = (bw: number, ns: boolean, col: number): Item => {
  const o = ns ? 0.5 : 0, P: Part[] = [[o, o + bw, 0, 0.08, 0, 0.95, C.wood], [o, o + bw, 0.08, 2.05, 0.08, 0.3, C.dark], [o + 0.03, o + bw - 0.03, 0.1, 2.03, 0.3, 0.5, C.white], [o, o + bw, 0.8, 2.05, 0.5, 0.55, col]];
  const n = bw > 1.2 ? 2 : 1;
  for (let i = 0; i < n; i++) { const c = o + bw * (i + 0.5) / n; P.push([c - 0.3, c + 0.3, 0.16, 0.56, 0.5, 0.6, 0xffffff]); }
  if (ns) for (const a0 of [0.03, o + bw + 0.03]) { P.push([a0, a0 + 0.44, 0, 0.4, 0, 0.46, C.wood]); P.push([a0 + 0.13, a0 + 0.31, 0.11, 0.29, 0.46, 0.76, 0xf1e3c4, 'cyl']); }
  const M: Model[] = [[bw > 1.2 ? 'bedDouble' : 'bedSingle', o, o + bw, 0, 2.05, 0, 0.9]];
  if (ns) for (const a0 of [0.03, o + bw + 0.03]) M.push(['cabinetBed', a0, a0 + 0.44, 0, 0.4, 0, 0.48], ['lampRoundTable', a0 + 0.11, a0 + 0.33, 0.09, 0.31, 0.48, 0.9]);
  return { w: bw + 2 * o, dep: 2.05, parts: P, models: M };
};
const sofaItem = (w: number, col: number): Item => {
  const P: Part[] = [[0, w, 0.04, 0.92, 0.08, 0.42, col], [0, w, 0.04, 0.26, 0.42, 0.82, col], [0, 0.16, 0.04, 0.92, 0.42, 0.6, col], [w - 0.16, w, 0.04, 0.92, 0.42, 0.6, col]];
  const n = Math.max(2, Math.round((w - 0.32) / 0.75)), cw = (w - 0.36) / n;
  for (let i = 0; i < n; i++) P.push([0.18 + i * cw + 0.01, 0.18 + (i + 1) * cw - 0.01, 0.28, 0.9, 0.42, 0.5, lighten(col, 0.18)]);
  return { w, dep: 0.92, parts: P, models: [['loungeSofa', 0, w, 0.04, 0.92, 0, 0.86]] };
};
const shelfItem = (w: number): Item => {
  const P: Part[] = [[0, w, 0, 0.03, 0, 1.95, C.wood], [0, 0.03, 0, 0.32, 0, 1.95, C.wood], [w - 0.03, w, 0, 0.32, 0, 1.95, C.wood]];
  [0.02, 0.4, 0.78, 1.16, 1.54, 1.92].forEach((y, i) => { P.push([0.03, w - 0.03, 0.03, 0.32, y, y + 0.03, C.wood]); if (i < 5) P.push([0.07, 0.07 + (w - 0.2) * (0.5 + 0.1 * ((i * 3) % 5)), 0.08, 0.28, y + 0.03, y + 0.29, SOFT[i % 4]]); });
  return { w, dep: 0.32, tall: true, parts: P, models: [['bookcaseOpen', 0, w, 0, 0.32, 0, 1.95]] };
};
const plantItem = (): Item => ({ w: 0.5, dep: 0.5, parts: [[0.1, 0.4, 0.1, 0.4, 0, 0.36, C.pot, 'cyl'], [0.02, 0.48, 0.02, 0.48, 0.36, 1.05, C.green, 'ball']], models: [['pottedPlant', 0.1, 0.4, 0.1, 0.4, 0, 1.05]] });
const chair = (P: Part[], c: number, d0: number, backAtStart: boolean) => {
  P.push([c - 0.21, c + 0.21, d0, d0 + 0.42, 0.41, 0.45, C.dark]);
  const b = backAtStart ? d0 : d0 + 0.38; P.push([c - 0.21, c + 0.21, b, b + 0.04, 0.45, 0.88, C.dark]);
  for (const [la, ld] of [[c - 0.2, d0 + 0.01], [c + 0.165, d0 + 0.01], [c - 0.2, d0 + 0.375], [c + 0.165, d0 + 0.375]]) P.push([la, la + 0.035, ld, ld + 0.035, 0, 0.41, C.dark]);
};
const tableSet = (tw: number, td: number): Item => {
  const P: Part[] = [[0.05, 0.05 + tw, 0.5, 0.5 + td, 0.71, 0.75, C.wood]], dep = td + 1.0;
  for (const [la, ld] of [[0.1, 0.55], [tw - 0.06, 0.55], [0.1, 0.39 + td], [tw - 0.06, 0.39 + td]]) P.push([la, la + 0.06, ld, ld + 0.06, 0, 0.71, C.wood]);
  const n = tw >= 1.5 ? 2 : 1, M: Model[] = [['table', 0.05, 0.05 + tw, 0.5, 0.5 + td, 0, 0.76]];
  for (let i = 0; i < n; i++) {
    const c = 0.05 + tw * (i + 0.5) / n; chair(P, c, 0.1, true); chair(P, c, dep - 0.52, false);
    M.push(['chairCushion', c - 0.22, c + 0.22, 0.1, 0.54, 0, 0.92], ['chairCushion', c - 0.22, c + 0.22, dep - 0.54, dep - 0.1, 0, 0.92, 'flip']);
  }
  return { w: tw + 0.1, dep, parts: P, models: M };
};
const kitchenRun = (L: number, uppers: boolean): Item => {
  const P: Part[] = [[0, 0.66, 0.02, 0.68, 0, 1.9, C.steel], [0.68, L, 0.06, 0.56, 0, 0.1, C.dark], [0.68, L, 0.02, 0.6, 0.1, 0.86, C.cab], [0.68, L, 0, 0.63, 0.86, 0.9, C.stone]];
  const run = L - 0.68;
  if (run >= 1.5) { const h = 0.68 + run * 0.66 - 0.3, s = 0.68 + run * 0.22 - 0.25; P.push([h, h + 0.6, 0.08, 0.56, 0.9, 0.908, C.black], [s, s + 0.5, 0.12, 0.5, 0.9, 0.906, 0x99a3ac]); }
  else if (run >= 0.7) P.push([0.72, 1.32, 0.08, 0.56, 0.9, 0.908, C.black]);
  if (uppers) P.push([0.68, L, 0.02, 0.36, 1.45, 2.1, C.cab]);
  // the same run as cabinet modules about 60 cm wide: a sink a quarter of the way along, a stove under a hood further on
  const n = Math.max(1, Math.round(run / 0.6)), m = run / n, M: Model[] = [['kitchenFridge', 0, 0.66, 0.02, 0.68, 0, 1.9]];
  for (let i = 0; i < n; i++) {
    const a0 = 0.68 + i * m, name = n >= 3 && i === Math.floor(n * 0.7) ? 'kitchenStove' : n >= 2 && i === Math.floor(n * 0.25) ? 'kitchenSink' : i % 2 ? 'kitchenCabinetDrawer' : 'kitchenCabinet';
    M.push([name, a0, a0 + m, 0, 0.63, 0, name === 'kitchenSink' ? 1.0 : 0.92]);
    if (uppers) M.push(name === 'kitchenStove' ? ['hoodModern', a0, a0 + m, 0.02, 0.5, 1.5, 2.1] : ['kitchenCabinetUpper', a0, a0 + m, 0.02, 0.37, 1.45, 2.1]);
  }
  return { w: L, dep: 0.68, parts: P, models: M };
};

const RECIPES: Partial<Record<RoomType, (ctx: Ctx) => void>> = {
  bedroom(ctx: Ctx) {
    const r = ctx.r, area = r.w * r.h, dbl = Math.min(r.w, r.h) >= 2.7 && area >= 8.5, bw = dbl ? (area >= 13 ? 1.8 : 1.6) : 0.95;
    let bedSide: string | null = null;
    const order = sides(ctx, i => solid(i) + (i.depth >= 2.75 ? 4 : -20) + (i.len >= bw + 1.1 ? 2 : 0));
    for (const ns of [true, false]) { for (const s of order) { if (along(ctx, s, bedItem(bw, ns, ctx.soft)) !== null) { bedSide = s.side; break; } } if (bedSide) break; }
    for (const w of [1.8, 1.2, 0.9]) if (anySide(ctx, { w, dep: 0.6, tall: true, parts: [[0, w, 0, 0.6, 0, 2.1, C.ward], [w / 2 - 0.01, w / 2 + 0.01, 0.6, 0.605, 0.05, 2.05, C.dark]], models: ((n: number) => Array.from({ length: n }, (_, i): Model => ['bookcaseClosedDoors', i * w / n, (i + 1) * w / n, 0, 0.6, 0, 2.1]))(Math.round(w / 0.9)) }, i => -i.doors * 10 - i.windows * 5 + i.len * 0.1, ['start', 'end', 'center'], bedSide ? [bedSide] : [])) break;
    if (area >= 12) anySide(ctx, plantItem(), () => 0, ['start', 'end']);
  },
  living(ctx: Ctx) {
    const order = sides(ctx, i => solid(i) + (i.depth >= 3 ? 3 : 0) + i.len * 0.2);
    let done: Info | null = null, a: number | null = null, w = 0;
    for (const s of order) { w = clamp(Math.round(s.len * 0.55 * 4) / 4, 1.7, 2.6); a = along(ctx, s, sofaItem(w, ctx.soft)); if (a !== null) { done = s; break; } }
    if (done) {
      const c = a! + w / 2;
      if (done.depth >= 2.7) put(ctx, done.fr, c - 0.55, 1.35, { w: 1.1, dep: 0.6, parts: [[0, 1.1, 0, 0.6, 0.34, 0.39, C.wood], [0.06, 1.04, 0.06, 0.54, 0.1, 0.14, C.wood], [0.04, 0.1, 0.04, 0.1, 0, 0.34, C.dark], [1.0, 1.06, 0.04, 0.1, 0, 0.34, C.dark], [0.04, 0.1, 0.5, 0.56, 0, 0.34, C.dark], [1.0, 1.06, 0.5, 0.56, 0, 0.34, C.dark]], models: [['tableCoffee', 0, 1.1, 0, 0.6, 0, 0.42]] });
      const rw = Math.min(2.8, done.len - 0.3), rd = Math.min(2.0, done.depth - 0.9);
      if (rd > 1) put(ctx, done.fr, clamp(c - rw / 2, 0.1, done.len - rw - 0.1), 0.7, { w: rw, dep: rd, soft: true, parts: [[0, rw, 0, rd, 0.004, 0.018, C.rug], [0.12, rw - 0.12, 0.12, rd - 0.12, 0.018, 0.022, lighten(ctx.soft, 0.55)]], models: [['rugRectangle', 0, rw, 0, rd, 0.004, 0.026]] });
      if (done.depth >= 3.1) {
        const opp = facing(ctx, done.fr);
        const tv: Item = { w: 1.6, dep: 0.42, parts: [[0, 1.6, 0, 0.42, 0.06, 0.48, C.wood], [0.2, 1.4, 0.16, 0.2, 0.56, 1.26, C.black]], models: [['cabinetTelevision', 0, 1.6, 0, 0.42, 0, 0.5], ['televisionModern', 0.25, 1.35, 0.12, 0.32, 0.5, 1.22]] };
        if (!put(ctx, opp.fr, clamp(opp.len - c - 0.8, 0.06, opp.len - 1.66), 0, tv)) along(ctx, opp, tv);
      }
    }
    anySide(ctx, shelfItem(1.0), i => -i.doors * 6 - i.windows * 5, ['start', 'end']);
    if (ctx.r.w * ctx.r.h >= 18) anySide(ctx, { w: 0.9, dep: 0.9, parts: [[0, 0.9, 0.04, 0.9, 0.08, 0.42, ctx.soft], [0, 0.9, 0.04, 0.24, 0.42, 0.82, ctx.soft], [0, 0.14, 0.04, 0.9, 0.42, 0.6, ctx.soft], [0.76, 0.9, 0.04, 0.9, 0.42, 0.6, ctx.soft]], models: [['loungeChair', 0, 0.9, 0.04, 0.9, 0, 0.86]] }, i => -i.doors * 4 - i.windows, ['end', 'start']);
    anySide(ctx, { w: 0.4, dep: 0.4, parts: [[0.17, 0.23, 0.17, 0.23, 0, 1.45, C.dark, 'cyl'], [0.07, 0.33, 0.07, 0.33, 1.45, 1.72, 0xf1e3c4, 'cyl']], models: [['lampRoundFloor', 0.08, 0.32, 0.08, 0.32, 0, 1.72]] }, () => 0, ['start', 'end']);
    anySide(ctx, plantItem(), () => 0, ['end', 'start']);
  },
  studio(ctx: Ctx) {
    RECIPES.bedroom!(ctx);
    const s = anySide(ctx, sofaItem(1.8, ctx.soft), i => solid(i), ['center', 'end', 'start']);
    if (!s) anySide(ctx, sofaItem(1.5, ctx.soft), solid, ['start', 'end']);
    free(ctx, tableSet(0.9, 0.8));
  },
  kitchen(ctx: Ctx) {
    outer: for (const s of sides(ctx, i => -i.doors * 4 + i.len - i.windows * 0.5)) {
      for (const f of [1, 0.8, 0.6]) { const L = Math.min(4.6, s.len * f - 0.12); if (L < 1.4) continue;
        if (along(ctx, s, kitchenRun(L, !s.windows), ['start', 'end', 'center']) !== null) break outer; }
    }
    const r = ctx.r, area = r.w * r.h;
    if (area >= 13 && Math.min(r.w, r.h) >= 3.2) free(ctx, tableSet(1.6, 0.9)) || free(ctx, tableSet(1.2, 0.8));
    else if (area >= 8.5) free(ctx, tableSet(0.9, 0.8));
  },
  dining(ctx: Ctx) {
    const r = ctx.r, big = Math.max(r.w, r.h) >= 3.4;
    free(ctx, tableSet(big ? 1.8 : 1.2, 0.9)) || free(ctx, tableSet(0.9, 0.8));
    anySide(ctx, { w: 1.4, dep: 0.42, parts: [[0, 1.4, 0, 0.42, 0.08, 0.82, C.wood], [0, 1.4, 0, 0.44, 0.82, 0.85, C.dark]], models: [['cabinetTelevision', 0, 1.4, 0, 0.42, 0, 0.85]] }, solid, ['center', 'start', 'end']);
  },
  bathroom(ctx: Ctx) {
    const r = ctx.r, area = r.w * r.h, sc: Score = i => -i.doors * 10 + i.len * 0.2;
    if (area >= 5 && Math.max(r.w, r.h) >= 2.2) anySide(ctx, { w: 1.7, dep: 0.75, parts: [[0, 1.7, 0, 0.75, 0, 0.56, C.white], [0.07, 1.63, 0.07, 0.68, 0.56, 0.566, 0xcfe3ea]], models: [['bathtub', 0, 1.7, 0, 0.75, 0, 0.6]] }, sc, ['start', 'end']);
    else for (const s of sides(ctx, sc)) {
      if (along(ctx, s, { w: 0.9, dep: 0.9, parts: [[0, 0.9, 0, 0.9, 0, 0.06, C.white], [0.87, 0.9, 0, 0.9, 0.06, 2.0, 0, 'glass'], [0, 0.9, 0.87, 0.9, 0.06, 2.0, 0, 'glass']], models: [['shower', 0, 0.9, 0, 0.9, 0, 2.0]] }, ['start']) !== null) break;
      if (along(ctx, s, { w: 0.9, dep: 0.9, parts: [[0, 0.9, 0, 0.9, 0, 0.06, C.white], [0, 0.03, 0, 0.9, 0.06, 2.0, 0, 'glass'], [0, 0.9, 0.87, 0.9, 0.06, 2.0, 0, 'glass']], models: [['shower', 0, 0.9, 0, 0.9, 0, 2.0]] }, ['end']) !== null) break;
    }
    anySide(ctx, { w: 0.42, dep: 0.68, parts: [[0, 0.42, 0, 0.18, 0.36, 0.8, C.white], [0.03, 0.39, 0.18, 0.66, 0, 0.4, C.white], [0.02, 0.4, 0.17, 0.67, 0.4, 0.43, 0xe2e0da]], models: [['toilet', 0, 0.42, 0, 0.68, 0, 0.82]] }, sc, ['end', 'start', 'center']);
    for (const w of [0.8, 0.6]) if (anySide(ctx, { w, dep: 0.48, parts: [[0, w, 0.02, 0.46, 0.3, 0.8, C.wood], [0, w, 0, 0.48, 0.8, 0.84, C.white], [w / 2 - 0.2, w / 2 + 0.2, 0.1, 0.4, 0.84, 0.846, 0xd6e2e8], [0.05, w - 0.05, 0, 0.025, 1.1, 1.75, 0xbcd2de]], models: [['bathroomCabinetDrawer', 0, w, 0, 0.48, 0, 0.9], ['bathroomMirror', 0.1, w - 0.1, 0, 0.08, 1.1, 1.75]] }, i => sc(i) - i.windows * 3, ['center', 'start', 'end'])) break;
  },
  office(ctx: Ctx) {
    const desk: Item = { w: 1.4, dep: 1.25, parts: [[0, 1.4, 0, 0.65, 0.7, 0.74, C.wood], [0, 0.04, 0.02, 0.63, 0, 0.7, C.dark], [1.36, 1.4, 0.02, 0.63, 0, 0.7, C.dark], [0.92, 1.36, 0.05, 0.6, 0.3, 0.7, C.wood], [0.45, 0.95, 0.12, 0.15, 0.84, 1.16, C.black], [0.66, 0.74, 0.08, 0.2, 0.74, 0.84, C.black], [0.48, 0.92, 0.74, 1.18, 0.44, 0.5, C.black], [0.48, 0.92, 1.14, 1.18, 0.5, 0.95, C.black], [0.62, 0.78, 0.88, 1.04, 0, 0.44, C.dark, 'cyl']], models: [['desk', 0, 1.4, 0, 0.65, 0, 0.75], ['computerScreen', 0.45, 0.95, 0.1, 0.26, 0.75, 1.2], ['chairDesk', 0.42, 0.98, 0.7, 1.22, 0, 1.05, 'flip']] };
    const s = anySide(ctx, desk, i => -i.doors * 10 + i.windows * 3 + i.len * 0.1);
    anySide(ctx, shelfItem(0.9), i => -i.doors * 6 - i.windows * 5, ['start', 'end', 'center'], s ? [s.side] : []);
    anySide(ctx, plantItem(), () => 0, ['end', 'start']);
  },
  hallway(ctx: Ctx) {
    if (Math.min(ctx.r.w, ctx.r.h) < 1.2) return;
    anySide(ctx, { w: 1.0, dep: 0.3, parts: [[0, 1.0, 0, 0.3, 0.74, 0.78, C.wood], [0.02, 0.06, 0.02, 0.28, 0, 0.74, C.dark], [0.94, 0.98, 0.02, 0.28, 0, 0.74, C.dark]], models: [['sideTable', 0, 1.0, 0, 0.3, 0, 0.78]] }, i => -i.doors * 10 + i.len * 0.1, ['center', 'start', 'end']);
  },
  laundry(ctx: Ctx) {
    anySide(ctx, { w: 1.26, dep: 0.64, parts: [[0, 0.6, 0.02, 0.62, 0, 0.85, C.white], [0.64, 1.24, 0.02, 0.62, 0, 0.85, C.white], [0, 1.26, 0, 0.64, 0.85, 0.89, C.stone], [0.14, 0.46, 0.62, 0.635, 0.28, 0.6, C.black, 'box'], [0.78, 1.1, 0.62, 0.635, 0.28, 0.6, C.black, 'box']], models: [['washer', 0, 0.6, 0.02, 0.62, 0, 0.86], ['dryer', 0.64, 1.24, 0.02, 0.62, 0, 0.86]] }, solid, ['start', 'end', 'center']);
    anySide(ctx, shelfItem(0.9), i => -i.doors * 6 - i.windows * 5, ['start', 'end']);
  },
  storage(ctx: Ctx) { for (const w of [1.8, 1.2, 0.9]) if (anySide(ctx, shelfItem(w), solid, ['center', 'start', 'end'])) break; },
};

// ---- from the scene ----------------------------------------------------------------

/** Moves each edge of a polygon in by its own distance. `P` runs with its inside on the left of each edge's normal `[-u.y, u.x]`. */
export function inset(P: Pt[], by: number[]): Pt[] {
  const n = P.length;
  const line = (i: number) => {
    const A = P[i], B = P[(i + 1) % n], len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1e-9, u: Pt = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    return { p: [A[0] - u[1] * by[i], A[1] + u[0] * by[i]] as Pt, u };
  };
  return P.map((_, i) => {
    const a = line((i + n - 1) % n), b = line(i), det = a.u[0] * b.u[1] - a.u[1] * b.u[0];
    if (Math.abs(det) < 1e-9) return b.p; // the two edges run on in one line
    const t = ((b.p[0] - a.p[0]) * b.u[1] - (b.p[1] - a.p[1]) * b.u[0]) / det;
    return [a.p[0] + a.u[0] * t, a.p[1] + a.u[1] * t] as Pt;
  });
}

/** Half the thickness of the wall an edge of a room lies on, or 0 when no wall does. */
function wallOn(A: Pt, B: Pt, walls: WallNode[]): number {
  const m: Pt = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1e-9, u: Pt = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
  for (const w of walls) {
    const wl = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1e-9, wu: Pt = [(w.b[0] - w.a[0]) / wl, (w.b[1] - w.a[1]) / wl];
    if (Math.abs(u[0] * wu[1] - u[1] * wu[0]) > 2e-3) continue;
    const dx = m[0] - w.a[0], dy = m[1] - w.a[1], t = dx * wu[0] + dy * wu[1];
    if (Math.abs(dx * wu[1] - dy * wu[0]) < 0.02 && t > -0.02 && t < wl + 0.02) return w.thickness / 2;
  }
  return 0;
}

/** A zone as the room the recipes furnish: measured to the inside faces of its walls. */
function roomOf(z: ZoneNode, walls: WallNode[]): Room | null {
  let P = z.points.map(p => [p[0], p[1]] as Pt);
  if (signedArea(P) < 0) P.reverse();
  P = inset(P, P.map((A, i) => wallOn(A, P[(i + 1) % P.length], walls)));
  if (P.length < 3 || signedArea(P) < 0.5) return null;
  const xs = P.map(q => q[0]), ys = P.map(q => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  const box = P.length === 4 && P.every(q => (Math.abs(q[0] - x) < 1e-6 || Math.abs(q[0] - x - w) < 1e-6) && (Math.abs(q[1] - y) < 1e-6 || Math.abs(q[1] - y - h) < 1e-6)) && Math.abs(signedArea(P) - w * h) < 1e-6;
  return box ? { x, y, w, h } : { x, y, w, h, points: P };
}

/** The furniture of one level, in the level's plan coordinates. The same scene always gives the same pieces. */
export function furnishLevel(doc: SceneDoc, levelId: Id): FurniturePiece[] {
  const level = doc.nodes[levelId];
  if (level?.type !== 'level') return [];
  const kids = level.children.map(c => doc.nodes[c]);
  const walls = kids.filter((n): n is WallNode => n?.type === 'wall');
  // the floor to keep clear in front of each door and window, on both sides of its wall
  const zones: Quad[] = [], winZones: Quad[] = [];
  for (const w of walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1e-9, u: Pt = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len];
    const at = (t: number, off: number): Pt => [w.a[0] + u[0] * t - u[1] * off, w.a[1] + u[1] * t + u[0] * off];
    for (const o of w.children.map(c => doc.nodes[c]).filter((n): n is OpeningNode => n?.type === 'opening')) {
      const d = o.kind === 'window' ? 0.45 : 1.0, a = o.offset - o.width / 2 - 0.08, b = o.offset + o.width / 2 + 0.08;
      (o.kind === 'window' ? winZones : zones).push(quadOf([at(a, -d), at(b, -d), at(b, d), at(a, d)]));
    }
  }
  const pieces: FurniturePiece[] = [];
  kids.filter((n): n is ZoneNode => n?.type === 'zone').forEach((z, i) => {
    const recipe = RECIPES[z.use], r = recipe && roomOf(z, walls);
    if (recipe && r) recipe({ r, frames: edgesOf(r), zones, winZones, placed: [], pieces, soft: SOFT[i % SOFT.length], zone: z.id });
  });
  return pieces;
}

