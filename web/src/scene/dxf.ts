/**
 * DXF export of the plans, for AutoCAD and other CAD programs.
 *
 * DXF is AutoCAD's open exchange format. AutoCAD, BricsCAD, DraftSight,
 * LibreCAD, QCAD and SketchUp Pro open it; in AutoCAD, Save As turns it into a
 * DWG. (DWG itself is a closed format that a web page cannot write reliably.)
 *
 * The file is DXF R12, the version every CAD program reads. It is drawn at
 * true size: one drawing unit is one millimetre, and the units are set to
 * millimetres. Plan y runs down the page; in CAD, y runs up, so plan y becomes
 * -y. Each level's plan sits beside the previous one, with its name below.
 *
 * Everything is on its own layer, named in the common A-… style, so a drafter
 * can switch parts on and off:
 *
 *   A-WALL       wall outlines, cut at the plan's section
 *   A-WALL-PATT  the build-up's layer lines inside walls
 *   A-DOOR       door leaves and swings
 *   A-GLAZ       windows
 *   A-FLOR-OTLN  floor slab outlines
 *   A-AREA-IDEN  room names, sizes and areas
 *   A-ANNO-DIMS  dimensions (as lines and text, so they look the same everywhere)
 *   A-ANNO-TAGS  door and window tags matching the schedule
 *   A-ANNO-TTLB  plan titles
 */
import { area } from './ops';
import { schedule } from './schedule';
import type { Catalogue } from './catalogue';
import type { Id, LevelNode, OpeningNode, SceneDoc, SlabNode, Vec2, WallNode, ZoneNode } from './types';

export const DXF_LAYERS: [name: string, colour: number, linetype: string][] = [
  ['A-WALL', 7, 'CONTINUOUS'],
  ['A-WALL-PATT', 8, 'CONTINUOUS'],
  ['A-DOOR', 3, 'CONTINUOUS'],
  ['A-GLAZ', 4, 'CONTINUOUS'],
  ['A-FLOR-OTLN', 9, 'DASHED'],
  ['A-AREA-IDEN', 2, 'CONTINUOUS'],
  ['A-ANNO-DIMS', 1, 'CONTINUOUS'],
  ['A-ANNO-TAGS', 5, 'CONTINUOUS'],
  ['A-ANNO-TTLB', 7, 'CONTINUOUS'],
];

type P = [number, number];

/** Text for an R12 file: printable ASCII as is, anything else as \U+XXXX, which CAD programs show. */
function text(s: string) {
  let out = '';
  for (const ch of s.replace(/[\r\n]+/g, ' ')) {
    const c = ch.codePointAt(0)!;
    out += c >= 32 && c < 127 ? ch : c <= 0xffff ? `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}` : '?';
  }
  return out;
}
const num = (n: number) => String(Math.round(n * 1000) / 1000);

class Out {
  rows: string[] = [];
  min: P = [Infinity, Infinity];
  max: P = [-Infinity, -Infinity];
  pair(code: number, value: string | number) { this.rows.push(String(code), typeof value === 'number' ? num(value) : value); }
  grow(p: P) {
    this.min = [Math.min(this.min[0], p[0]), Math.min(this.min[1], p[1])];
    this.max = [Math.max(this.max[0], p[0]), Math.max(this.max[1], p[1])];
  }
  line(layer: string, a: P, b: P) {
    this.pair(0, 'LINE'); this.pair(8, layer);
    this.pair(10, a[0]); this.pair(20, a[1]); this.pair(30, 0);
    this.pair(11, b[0]); this.pair(21, b[1]); this.pair(31, 0);
    this.grow(a); this.grow(b);
  }
  poly(layer: string, pts: P[], closed = true) {
    this.pair(0, 'POLYLINE'); this.pair(8, layer); this.pair(66, 1);
    this.pair(10, 0); this.pair(20, 0); this.pair(30, 0); this.pair(70, closed ? 1 : 0);
    for (const p of pts) {
      this.pair(0, 'VERTEX'); this.pair(8, layer);
      this.pair(10, p[0]); this.pair(20, p[1]); this.pair(30, 0);
      this.grow(p);
    }
    this.pair(0, 'SEQEND'); this.pair(8, layer);
  }
  /** An arc counter-clockwise from `from` to `to`, in degrees. */
  arc(layer: string, c: P, r: number, from: number, to: number) {
    this.pair(0, 'ARC'); this.pair(8, layer);
    this.pair(10, c[0]); this.pair(20, c[1]); this.pair(30, 0);
    this.pair(40, r); this.pair(50, from); this.pair(51, to);
    this.grow([c[0] - r, c[1] - r]); this.grow([c[0] + r, c[1] + r]);
  }
  /** Text centred on a point, turned by `rotation` degrees. */
  text(layer: string, at: P, height: number, value: string, rotation = 0) {
    this.pair(0, 'TEXT'); this.pair(8, layer);
    this.pair(10, at[0]); this.pair(20, at[1]); this.pair(30, 0);
    this.pair(40, height); this.pair(1, text(value));
    if (rotation) this.pair(50, rotation);
    this.pair(72, 1); this.pair(11, at[0]); this.pair(21, at[1]); this.pair(31, 0); this.pair(73, 2);
    this.grow(at);
  }
}

/** A dimension drawn as a line with ticks and its length in millimetres above it. */
function dimension(out: Out, a: P, b: P, offset: P, size: number) {
  const pa: P = [a[0] + offset[0], a[1] + offset[1]], pb: P = [b[0] + offset[0], b[1] + offset[1]];
  out.line('A-ANNO-DIMS', a, pa);
  out.line('A-ANNO-DIMS', b, pb);
  out.line('A-ANNO-DIMS', pa, pb);
  const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
  const t = size * 0.6;
  for (const p of [pa, pb]) {
    out.line('A-ANNO-DIMS', [p[0] - Math.cos(ang + Math.PI / 4) * t, p[1] - Math.sin(ang + Math.PI / 4) * t], [p[0] + Math.cos(ang + Math.PI / 4) * t, p[1] + Math.sin(ang + Math.PI / 4) * t]);
  }
  let deg = (ang * 180) / Math.PI;
  if (deg > 90.01 || deg < -89.99) deg += 180;
  const len = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]));
  const n: P = [-Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
  out.text('A-ANNO-DIMS', [(pa[0] + pb[0]) / 2 + n[0] * size * 0.9, (pa[1] + pb[1]) / 2 + n[1] * size * 0.9], size, String(len), deg);
}

function inside(p: Vec2, poly: readonly Vec2[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Draws one level's plan with its origin at `at` (millimetres, CAD axes). Returns its width. */
function drawLevel(out: Out, doc: SceneDoc, level: LevelNode, refs: Map<Id, string>, at: P, title: string): number {
  const kids = level.children.map(c => doc.nodes[c]);
  const walls = kids.filter((n): n is WallNode => n?.type === 'wall');
  const zones = kids.filter((n): n is ZoneNode => n?.type === 'zone');
  const slabs = kids.filter((n): n is SlabNode => n?.type === 'slab');
  const pts: Vec2[] = [...walls.flatMap(w => [w.a, w.b]), ...zones.flatMap(z => z.points), ...slabs.flatMap(s => s.points)];
  if (!pts.length) pts.push([0, 0], [5, 5]);
  const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
  const minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  // Plan metres to CAD millimetres: the plan's top-left at `at`, y up.
  const C = (p: Vec2): P => [at[0] + (p[0] - minX) * 1000, at[1] - (p[1] - minY) * 1000];
  const TXT = 250, DIM = 180, TAG = 200;

  for (const s of slabs) out.poly('A-FLOR-OTLN', s.points.map(C));

  for (const z of zones) {
    const cx = z.points.reduce((s, p) => s + p[0], 0) / z.points.length, cy = z.points.reduce((s, p) => s + p[1], 0) / z.points.length;
    const c = C([cx, cy]);
    out.text('A-AREA-IDEN', [c[0], c[1] + TXT * 0.8], TXT, z.name);
    const xs = [...new Set(z.points.map(p => p[0]))], ys = [...new Set(z.points.map(p => p[1]))];
    if (z.points.length === 4 && xs.length === 2 && ys.length === 2) {
      out.text('A-AREA-IDEN', [c[0], c[1] - TXT * 0.6], TXT * 0.7, `${Math.round(Math.abs(xs[1] - xs[0]) * 1000)} x ${Math.round(Math.abs(ys[1] - ys[0]) * 1000)}`);
    }
    out.text('A-AREA-IDEN', [c[0], c[1] - TXT * 1.7], TXT * 0.7, `${Math.abs(area(z.points)).toFixed(2)} m²`);
  }

  for (const w of walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const u: Vec2 = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len];
    const n: Vec2 = [-u[1], u[0]];
    const t = w.thickness;
    const on = (s: number, d: number): P => C([w.a[0] + u[0] * s + n[0] * d, w.a[1] + u[1] * s + n[1] * d]);
    const os = w.children.map(c => doc.nodes[c]).filter((o): o is OpeningNode => o?.type === 'opening').sort((p, q) => p.offset - q.offset);
    const spans: [number, number][] = [];
    let s0 = -t / 2;
    for (const o of os) { spans.push([s0, o.offset - o.width / 2]); s0 = o.offset + o.width / 2; }
    spans.push([s0, len + t / 2]);
    for (const [a, b] of spans) {
      if (b - a < 1e-6) continue;
      out.poly('A-WALL', [on(a, -t / 2), on(b, -t / 2), on(b, t / 2), on(a, t / 2)]);
      let d = -t / 2;
      for (const l of w.layers.slice(0, -1)) { d += l.thickness; out.line('A-WALL-PATT', on(a, d), on(b, d)); }
    }
    for (const o of os) {
      const a = o.offset - o.width / 2, b = o.offset + o.width / 2;
      if (o.kind === 'door') {
        // Leaf drawn open at 90°, hinged at the start side, with its swing.
        const hinge = on(a, t / 2), tip = on(b, t / 2), open = on(a, t / 2 + o.width);
        out.line('A-DOOR', hinge, open);
        const a1 = (Math.atan2(tip[1] - hinge[1], tip[0] - hinge[0]) * 180) / Math.PI;
        const a2 = (Math.atan2(open[1] - hinge[1], open[0] - hinge[0]) * 180) / Math.PI;
        const ccw = ((a2 - a1) % 360 + 360) % 360 <= 180;
        out.arc('A-DOOR', hinge, o.width * 1000, ccw ? a1 : a2, ccw ? a2 : a1);
      } else {
        for (const d of [-t / 2, -t / 6, t / 6, t / 2]) out.line('A-GLAZ', on(a, d), on(b, d));
      }
      const tagSide = zones.some(z => inside([w.a[0] + u[0] * o.offset + n[0] * (t / 2 + 0.3), w.a[1] + u[1] * o.offset + n[1] * (t / 2 + 0.3)], z.points)) ? 1 : -1;
      const tag = on(o.offset, tagSide * (t / 2 + 0.45));
      const ref = refs.get(o.id) ?? '';
      out.poly('A-ANNO-TAGS', [[tag[0] - TAG * 1.6, tag[1] - TAG * 0.8], [tag[0] + TAG * 1.6, tag[1] - TAG * 0.8], [tag[0] + TAG * 1.6, tag[1] + TAG * 0.8], [tag[0] - TAG * 1.6, tag[1] + TAG * 0.8]]);
      out.text('A-ANNO-TAGS', tag, TAG, ref);
    }
    // Outside walls get their length, outside the building.
    const probe = (side: number): Vec2 => [w.a[0] + u[0] * len / 2 + n[0] * side * (t / 2 + 0.3), w.a[1] + u[1] * len / 2 + n[1] * side * (t / 2 + 0.3)];
    const outSide = [1, -1].find(side => !zones.some(z => inside(probe(side), z.points)));
    if (outSide !== undefined && zones.some(z => inside(probe(-outSide), z.points))) {
      const a = on(0, outSide * (t / 2)), b = on(len, outSide * (t / 2));
      const away = on(0, outSide * (t / 2 + 0.9));
      dimension(out, a, b, [away[0] - a[0], away[1] - a[1]], DIM);
    }
  }

  // Overall dimensions, above and to the left.
  const tl = C([minX, minY]), tr = C([maxX, minY]), bl = C([minX, maxY]);
  dimension(out, tl, tr, [0, 1800], DIM);
  dimension(out, tl, bl, [-1800, 0], DIM);
  const width = (maxX - minX) * 1000;
  out.text('A-ANNO-TTLB', [at[0] + width / 2, at[1] - (maxY - minY) * 1000 - 2200], 400, title);
  out.text('A-ANNO-TTLB', [at[0] + width / 2, at[1] - (maxY - minY) * 1000 - 2800], 220, 'Dimensions in millimetres');
  return width;
}

/** The plans of the given levels (all of them by default), side by side, as a DXF file. */
export function dxfFile(doc: SceneDoc, opts: { levels?: Id[]; catalogue?: Catalogue } = {}): string {
  const refs = new Map(schedule(doc, opts.catalogue).map(r => [r.id, r.ref]));
  const levels: { level: LevelNode; title: string }[] = [];
  for (const b of doc.roots) {
    const building = doc.nodes[b];
    if (building?.type !== 'building') continue;
    for (const l of building.children.map(c => doc.nodes[c]).filter((n): n is LevelNode => n?.type === 'level').sort((p, q) => p.elevation - q.elevation)) {
      if (!opts.levels || opts.levels.includes(l.id)) levels.push({ level: l, title: `${building.name} - ${l.name} plan` });
    }
  }
  const out = new Out();
  let x = 0;
  for (const { level, title } of levels) x += drawLevel(out, doc, level, refs, [x, 0], title) + 6000;
  if (!isFinite(out.min[0])) { out.min = [0, 0]; out.max = [1, 1]; }

  const h: string[] = [];
  const pair = (code: number, value: string | number) => h.push(String(code), typeof value === 'number' ? num(value) : value);
  pair(0, 'SECTION'); pair(2, 'HEADER');
  pair(9, '$ACADVER'); pair(1, 'AC1009');
  pair(9, '$INSBASE'); pair(10, 0); pair(20, 0); pair(30, 0);
  pair(9, '$EXTMIN'); pair(10, out.min[0]); pair(20, out.min[1]); pair(30, 0);
  pair(9, '$EXTMAX'); pair(10, out.max[0]); pair(20, out.max[1]); pair(30, 0);
  pair(9, '$LIMMIN'); pair(10, out.min[0]); pair(20, out.min[1]);
  pair(9, '$LIMMAX'); pair(10, out.max[0]); pair(20, out.max[1]);
  // Millimetres, metric.
  pair(9, '$INSUNITS'); pair(70, 4);
  pair(9, '$MEASUREMENT'); pair(70, 1);
  pair(9, '$LUNITS'); pair(70, 2);
  pair(9, '$LUPREC'); pair(70, 0);
  pair(9, '$TEXTSIZE'); pair(40, 250);
  pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'TABLES');
  pair(0, 'TABLE'); pair(2, 'LTYPE'); pair(70, 2);
  pair(0, 'LTYPE'); pair(2, 'CONTINUOUS'); pair(70, 0); pair(3, 'Solid line'); pair(72, 65); pair(73, 0); pair(40, 0);
  pair(0, 'LTYPE'); pair(2, 'DASHED'); pair(70, 0); pair(3, '__ __ __'); pair(72, 65); pair(73, 2); pair(40, 300); pair(49, 200); pair(49, -100);
  pair(0, 'ENDTAB');
  pair(0, 'TABLE'); pair(2, 'LAYER'); pair(70, DXF_LAYERS.length + 1);
  pair(0, 'LAYER'); pair(2, '0'); pair(70, 0); pair(62, 7); pair(6, 'CONTINUOUS');
  for (const [name, colour, lt] of DXF_LAYERS) { pair(0, 'LAYER'); pair(2, name); pair(70, 0); pair(62, colour); pair(6, lt); }
  pair(0, 'ENDTAB');
  pair(0, 'TABLE'); pair(2, 'STYLE'); pair(70, 1);
  pair(0, 'STYLE'); pair(2, 'STANDARD'); pair(70, 0); pair(40, 0); pair(41, 1); pair(50, 0); pair(71, 0); pair(42, 250); pair(3, 'txt'); pair(4, '');
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');
  pair(0, 'SECTION'); pair(2, 'BLOCKS'); pair(0, 'ENDSEC');
  pair(0, 'SECTION'); pair(2, 'ENTITIES');

  const tail = ['0', 'ENDSEC', '0', 'EOF'];
  // CRLF line ends: what AutoCAD writes, and what every reader accepts.
  return [...h, ...out.rows, ...tail].join('\r\n') + '\r\n';
}
