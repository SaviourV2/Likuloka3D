/**
 * Reads a DXF drawing so its geometry can be used as it is, instead of being
 * traced from a picture: closed polylines become the plot or rooms at their
 * true size, and the other lines can be shown under the model to draw over.
 *
 * It reads ASCII DXF: LINE, LWPOLYLINE, POLYLINE with its VERTEX records, and
 * TEXT or MTEXT for room names. Curved segments are read as straight ones,
 * and blocks (INSERT) are not expanded.
 *
 * CAD has y pointing up and no fixed unit. The result is in plan metres with
 * y down, moved so the drawing's top-left corner is at the origin.
 */
import { addBuilding, addLevel, addZone, setPlot, snapPoint } from './ops';
import { importRoomlines, useOf } from './roomlines';
import type { Id, SceneDoc, Vec2 } from './types';

export type DxfUnit = 'mm' | 'cm' | 'm';
export interface DxfLayer { name: string; closed: Vec2[][]; segments: [Vec2, Vec2][]; texts: { at: Vec2; text: string }[] }
export interface DxfDrawing {
  layers: DxfLayer[];
  /** Width and height of everything drawn, in drawing units. */
  size: [number, number];
  /** The unit the file states (`$INSUNITS`), or the one its size suggests. */
  unit: DxfUnit;
  stated: boolean;
}

const SCALE: Record<DxfUnit, number> = { mm: 0.001, cm: 0.01, m: 1 };

interface Raw { layer: string; closed: boolean; pts: [number, number][]; text?: string }

/** Parses the text of a DXF file. Throws an Error with a plain message when it is not one this reader can use. */
export function parseDxf(text: string): DxfDrawing {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new Error('This is not a text DXF file. Save it from your CAD program as DXF (ASCII), not DWG or binary DXF.');
    pairs.push([code, lines[i + 1].trim()]);
  }
  let stated: DxfUnit | null = null;
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') { const u = Number(pairs[i + 1][1]); stated = u === 4 ? 'mm' : u === 5 ? 'cm' : u === 6 ? 'm' : null; break; }
  }
  let start = pairs.findIndex((p, i) => p[0] === 2 && p[1] === 'ENTITIES' && i > 0 && pairs[i - 1][0] === 0 && pairs[i - 1][1] === 'SECTION');
  if (start < 0) throw new Error('This DXF file has no drawing in it.');
  const raws: Raw[] = [];
  let open: Raw | null = null; // a POLYLINE collecting its VERTEX records
  for (let i = start + 1; i < pairs.length; ) {
    if (pairs[i][0] !== 0) { i++; continue; }
    const type = pairs[i][1];
    if (type === 'ENDSEC') break;
    let j = i + 1;
    const rec: [number, string][] = [];
    while (j < pairs.length && pairs[j][0] !== 0) rec.push(pairs[j++]);
    const get = (c: number) => rec.find(r => r[0] === c)?.[1];
    const num = (c: number) => Number(get(c) ?? NaN);
    const layer = get(8) ?? '0';
    if (type === 'LINE') raws.push({ layer, closed: false, pts: [[num(10), num(20)], [num(11), num(21)]] });
    else if (type === 'LWPOLYLINE') {
      const xs = rec.filter(r => r[0] === 10).map(r => Number(r[1])), ys = rec.filter(r => r[0] === 20).map(r => Number(r[1]));
      raws.push({ layer, closed: (Number(get(70) ?? 0) & 1) === 1, pts: xs.map((x, k) => [x, ys[k]]) });
    } else if (type === 'POLYLINE') { open = { layer, closed: (Number(get(70) ?? 0) & 1) === 1, pts: [] }; }
    else if (type === 'VERTEX' && open) open.pts.push([num(10), num(20)]);
    else if (type === 'SEQEND' && open) { raws.push(open); open = null; }
    else if (type === 'TEXT' || type === 'MTEXT') {
      const t = (get(1) ?? '').replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;|[{}]/g, '').trim();
      if (t) raws.push({ layer, closed: false, pts: [[num(10), num(20)]], text: t });
    }
    i = j;
  }
  const good = raws.filter(r => r.pts.length && r.pts.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  const all = good.filter(r => !r.text).flatMap(r => r.pts);
  if (!all.length) throw new Error('This DXF file has no lines or polylines to read.');
  const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0])), minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1]));
  const size: [number, number] = [maxX - minX, maxY - minY];
  // With no unit stated: a drawing thousands of units across is in millimetres, a few hundred in centimetres.
  const big = Math.max(...size), unit: DxfUnit = stated ?? (big > 2000 ? 'mm' : big > 200 ? 'cm' : 'm');
  const layers = new Map<string, DxfLayer>();
  const at = (name: string) => { let l = layers.get(name); if (!l) { l = { name, closed: [], segments: [], texts: [] }; layers.set(name, l); } return l; };
  // y is flipped here; the unit is applied by `scaled`, once the person has confirmed it.
  const P = (p: [number, number]): Vec2 => [p[0] - minX, maxY - p[1]];
  for (const r of good) {
    const l = at(r.layer), pts = r.pts.map(P);
    if (r.text) { l.texts.push({ at: pts[0], text: r.text }); continue; }
    const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
    const loop = r.closed || (pts.length > 3 && same(pts[0], pts[pts.length - 1]));
    const ring = loop && same(pts[0], pts[pts.length - 1]) ? pts.slice(0, -1) : pts;
    if (loop && ring.length >= 3) l.closed.push(ring);
    for (let k = 0; k + 1 < pts.length; k++) l.segments.push([pts[k], pts[k + 1]]);
    if (r.closed && pts.length > 2 && !same(pts[0], pts[pts.length - 1])) l.segments.push([pts[pts.length - 1], pts[0]]);
  }
  return { layers: [...layers.values()].sort((a, b) => a.name.localeCompare(b.name)), size, unit, stated: stated !== null };
}

const area = (P: readonly Vec2[]) => Math.abs(P.reduce((t, p, i) => { const q = P[(i + 1) % P.length]; return t + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
const inside = (P: readonly Vec2[], p: Vec2) => {
  let k = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) k = !k;
  }
  return k;
};

/** Layer names that usually hold the land's boundary, and room outlines, in English and Indonesian. */
export const PLOT_LAYER = /prop|site|plot|bndy|bound|lahan|tanah|kavling|batas|persil/i;
export const ROOM_LAYER = /room|area|zone|space|ruang|rm-/i;

export interface DxfChoice { unit: DxfUnit; plot: string | null; rooms: string | null }

/** What a drawing gives with the person's choices: the plot, the rooms with their names, and every line in metres. */
export function fromDxf(d: DxfDrawing, c: DxfChoice) {
  const k = SCALE[c.unit], S = (p: Vec2): Vec2 => [p[0] * k, p[1] * k];
  const layer = (n: string | null) => d.layers.find(l => l.name === n);
  // the plot is the largest closed outline on its layer
  const plot = layer(c.plot)?.closed.map(r => r.map(S)).sort((a, b) => area(b) - area(a))[0] ?? null;
  const texts = d.layers.flatMap(l => l.texts).map(t => ({ at: S(t.at), text: t.text }));
  const rooms = (layer(c.rooms)?.closed ?? []).map(r => r.map(S)).filter(r => area(r) >= 1).map((points, i) => {
    // a room is named by the text written inside it; of several, the first that is not a number
    const inner = texts.filter(t => inside(points, t.at)).map(t => t.text);
    return { name: inner.find(t => !/^[\d\s.,x×m²]+$/i.test(t)) ?? `Room ${i + 1}`, points };
  });
  const segments = d.layers.flatMap(l => l.segments).map(([a, b]) => [S(a), S(b)] as [Vec2, Vec2]);
  return { plot, rooms, segments, size: [d.size[0] * k, d.size[1] * k] as [number, number] };
}

/**
 * Brings a drawing into the project in one step: its plot, and its rooms as a
 * new building with walls, a slab, doors and windows (the Roomlines import
 * does that part, so corners go onto the 0.25 m grid). A pool is added as a
 * pool, without walls. Returns the new document and how much came in.
 */
export function importDxf(doc: SceneDoc, d: DxfDrawing, c: DxfChoice, name = 'Imported drawing'): [SceneDoc, { plot: boolean; rooms: number; pools: number }] {
  const got = fromDxf(d, c);
  let next = doc;
  if (got.plot) next = setPlot(next, got.plot);
  const pools = got.rooms.filter(r => useOf(r) === 'pool'), rooms = got.rooms.filter(r => useOf(r) !== 'pool');
  if (rooms.length || pools.length) {
    let building: Id;
    if (rooms.length) [next, building] = importRoomlines(next, { name, rooms: rooms.map(r => ({ name: r.name, x: 0, y: 0, w: 0, h: 0, points: r.points.map(p => [p[0], p[1]] as Vec2) })) }, { origin: [0, 0], openings: true });
    else { [next, building] = addBuilding(next, { name, origin: [0, 0] }); [next] = addLevel(next, building, { name: 'Ground floor' }); }
    const b = next.nodes[building];
    const level = b?.type === 'building' ? b.children[0] : '';
    for (const p of pools) [next] = addZone(next, level, { name: p.name, use: 'pool', points: p.points.map(snapPoint) });
  }
  return [next, { plot: !!got.plot, rooms: rooms.length, pools: pools.length }];
}
