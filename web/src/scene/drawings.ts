/**
 * Drawings for site and factory, as SVG sheets at true scale on A3 landscape.
 *
 * - A plan of each level: walls cut at the section with their build-up
 *   layers, door swings, window glazing, rooms with names and areas, wall
 *   lengths, overall dimensions, door and window tags matching the schedule,
 *   and a title block.
 * - Elevations of every wall that has doors or windows: chain dimensions along
 *   the wall, each opening's size, sill and head heights, and the wall height.
 *
 * SVG units are millimetres on paper; a scale of 1:50 makes one metre 20 mm.
 * Everything here is pure: it takes a document and returns text.
 */
import { area } from './ops';
import { schedule } from './schedule';
import { frameSize, type Id, type LevelNode, type OpeningNode, type SceneDoc, type Vec2, type WallNode, type ZoneNode } from './types';
import type { Catalogue } from './catalogue';

export interface Sheet { id: string; title: string; svg: string }

const PAPER = { w: 420, h: 297 };
const MARGIN = 10;
const TITLE_H = 24;
const SCALES = [20, 50, 100, 200, 500];
const INK = '#10142b';
const ACCENT = '#1428a0';
const FILL: Record<string, string> = {
  living: '#f0b45a', kitchen: '#e98a5c', dining: '#d9a35f', bedroom: '#8fa4ef', bathroom: '#6cc3cf',
  office: '#9dc26f', hallway: '#c9cbd6', laundry: '#86b9d9', storage: '#b5a58f', studio: '#c08ad8',
};

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const mm = (m: number) => Math.round(m * 1000);
const f = (n: number) => Number(n.toFixed(2));

function pickScale(widthM: number, heightM: number, boxW: number, boxH: number) {
  for (const s of SCALES) if ((widthM * 1000) / s <= boxW && (heightM * 1000) / s <= boxH) return s;
  return SCALES[SCALES.length - 1];
}

function sheet(content: string, title: { project: string; drawing: string; scale: number; number: string }) {
  const tbY = PAPER.h - MARGIN - TITLE_H;
  const date = new Date().toISOString().slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAPER.w}mm" height="${PAPER.h}mm" viewBox="0 0 ${PAPER.w} ${PAPER.h}" font-family="Archivo, Helvetica, Arial, sans-serif" fill="none" stroke-linecap="round">
<rect x="0" y="0" width="${PAPER.w}" height="${PAPER.h}" fill="#fff"/>
<rect x="${MARGIN}" y="${MARGIN}" width="${PAPER.w - 2 * MARGIN}" height="${PAPER.h - 2 * MARGIN}" stroke="${INK}" stroke-width="0.5"/>
${content}
<g data-part="title">
<line x1="${MARGIN}" y1="${tbY}" x2="${PAPER.w - MARGIN}" y2="${tbY}" stroke="${INK}" stroke-width="0.35"/>
<text x="${MARGIN + 4}" y="${tbY + 9}" font-size="5.5" font-weight="700" fill="${INK}">${esc(title.project)}</text>
<text x="${MARGIN + 4}" y="${tbY + 17}" font-size="4" fill="${INK}">${esc(title.drawing)}</text>
<text x="${PAPER.w - MARGIN - 4}" y="${tbY + 9}" font-size="4" text-anchor="end" fill="${INK}">Scale 1:${title.scale} at A3 · ${date}</text>
<text x="${PAPER.w - MARGIN - 4}" y="${tbY + 17}" font-size="4" text-anchor="end" fill="${ACCENT}" font-weight="700">${esc(title.number)}</text>
<text x="${PAPER.w / 2}" y="${tbY + 17}" font-size="3" text-anchor="middle" fill="#4a4f68">All dimensions in millimetres. Check on site before ordering.</text>
${scaleBar(PAPER.w / 2 - 25, tbY + 6, title.scale)}
</g>
</svg>`;
}

function scaleBar(x: number, y: number, scale: number) {
  const step = scale <= 50 ? 1 : scale <= 100 ? 2 : 5; // metres per division
  const len = (step * 1000) / scale;
  let out = '';
  for (let i = 0; i < 5; i++) out += `<rect x="${f(x + i * len)}" y="${y}" width="${f(len)}" height="1.5" ${i % 2 ? 'fill="#fff"' : `fill="${INK}"`} stroke="${INK}" stroke-width="0.2"/>`;
  return `<g data-part="scale-bar">${out}<text x="${f(x + 5 * len + 2)}" y="${y + 1.6}" font-size="3" fill="${INK}">${5 * step} m</text></g>`;
}

/** A dimension line between two paper points, with ticks and its length in millimetres. */
function dim(x1: number, y1: number, x2: number, y2: number, value: number, side: 1 | -1 = -1) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const deg = (ang * 180) / Math.PI;
  const flip = deg > 90 || deg < -90;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const nx = -Math.sin(ang) * 2.2 * side, ny = Math.cos(ang) * 2.2 * side;
  const tick = (x: number, y: number) => `<line x1="${f(x - Math.cos(ang + Math.PI / 4) * 1.2)}" y1="${f(y - Math.sin(ang + Math.PI / 4) * 1.2)}" x2="${f(x + Math.cos(ang + Math.PI / 4) * 1.2)}" y2="${f(y + Math.sin(ang + Math.PI / 4) * 1.2)}" stroke="${INK}" stroke-width="0.35"/>`;
  return `<g data-part="dimension"><line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${INK}" stroke-width="0.18"/>${tick(x1, y1)}${tick(x2, y2)}<text x="${f(mx + nx)}" y="${f(my + ny)}" font-size="2.6" fill="${INK}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${f(flip ? deg + 180 : deg)} ${f(mx + nx)} ${f(my + ny)})">${value}</text></g>`;
}

interface Placed { o: OpeningNode; ref: string }
function refsFor(doc: SceneDoc, catalogue?: Catalogue) {
  const map = new Map<Id, string>();
  for (const r of schedule(doc, catalogue)) map.set(r.id, r.ref);
  return map;
}
const openingsOf = (doc: SceneDoc, w: WallNode) => w.children.map(c => doc.nodes[c]).filter((o): o is OpeningNode => o?.type === 'opening').sort((p, q) => p.offset - q.offset);
function inside(p: Vec2, poly: readonly Vec2[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const levelsOf = (doc: SceneDoc) => doc.roots.flatMap(b => {
  const building = doc.nodes[b];
  if (building?.type !== 'building') return [];
  return building.children.map(c => doc.nodes[c]).filter((l): l is LevelNode => l?.type === 'level').sort((p, q) => p.elevation - q.elevation).map(level => ({ building, level }));
});

/** A plan of one level. */
export function planSheet(doc: SceneDoc, levelId: Id, number: string, catalogue?: Catalogue): Sheet {
  const level = doc.nodes[levelId] as LevelNode;
  const building = doc.nodes[level.parent];
  const kids = level.children.map(c => doc.nodes[c]);
  const walls = kids.filter((n): n is WallNode => n?.type === 'wall');
  const zones = kids.filter((n): n is ZoneNode => n?.type === 'zone');
  const refs = refsFor(doc, catalogue);
  const pts: Vec2[] = [...walls.flatMap(w => [w.a, w.b]), ...zones.flatMap(z => z.points)];
  if (!pts.length) pts.push([0, 0], [5, 5]);
  const minX = Math.min(...pts.map(p => p[0])) - 0.5, maxX = Math.max(...pts.map(p => p[0])) + 0.5;
  const minY = Math.min(...pts.map(p => p[1])) - 0.5, maxY = Math.max(...pts.map(p => p[1])) + 0.5;
  const boxW = PAPER.w - 2 * MARGIN - 50, boxH = PAPER.h - 2 * MARGIN - TITLE_H - 40;
  const scale = pickScale(maxX - minX, maxY - minY, boxW, boxH);
  const k = 1000 / scale;
  const ox = MARGIN + 30 + (boxW - (maxX - minX) * k) / 2, oy = MARGIN + 25 + (boxH - (maxY - minY) * k) / 2;
  const X = (x: number) => f(ox + (x - minX) * k), Y = (y: number) => f(oy + (y - minY) * k);
  const P = (p: Vec2) => `${X(p[0])},${Y(p[1])}`;
  let g = '';

  for (const z of zones) {
    g += `<polygon data-zone="${esc(z.id)}" points="${z.points.map(P).join(' ')}" fill="${FILL[z.use] ?? '#ddd'}" fill-opacity="0.22" stroke="none"/>`;
    const cx = z.points.reduce((s, p) => s + p[0], 0) / z.points.length, cy = z.points.reduce((s, p) => s + p[1], 0) / z.points.length;
    g += `<text x="${X(cx)}" y="${Y(cy)}" font-size="3.4" font-weight="600" fill="${INK}" text-anchor="middle">${esc(z.name)}</text>`;
    g += `<text x="${X(cx)}" y="${f(Y(cy) + 4)}" font-size="2.8" fill="#4a4f68" text-anchor="middle">${Math.abs(area(z.points)).toFixed(1)} m²</text>`;
  }

  for (const w of walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const u: Vec2 = [(w.b[0] - w.a[0]) / len, (w.b[1] - w.a[1]) / len];
    const n: Vec2 = [-u[1], u[0]];
    const t = w.thickness;
    const at = (s: number, d: number): Vec2 => [w.a[0] + u[0] * s + n[0] * d, w.a[1] + u[1] * s + n[1] * d];
    const os = openingsOf(doc, w);
    // Wall pieces between openings, cut at the section.
    const spans: [number, number][] = [];
    let s0 = -t / 2;
    for (const o of os) { spans.push([s0, o.offset - o.width / 2]); s0 = o.offset + o.width / 2; }
    spans.push([s0, len + t / 2]);
    for (const [a, b] of spans) {
      if (b - a < 1e-6) continue;
      g += `<polygon data-wall="${esc(w.id)}" points="${[at(a, -t / 2), at(b, -t / 2), at(b, t / 2), at(a, t / 2)].map(P).join(' ')}" fill="#2b2f45" stroke="${INK}" stroke-width="0.25"/>`;
      // Build-up layer lines.
      let d = -t / 2;
      for (const l of w.layers.slice(0, -1)) {
        d += l.thickness;
        g += `<line x1="${X(at(a, d)[0])}" y1="${Y(at(a, d)[1])}" x2="${X(at(b, d)[0])}" y2="${Y(at(b, d)[1])}" stroke="#fff" stroke-width="0.15" stroke-opacity="0.8"/>`;
      }
    }
    for (const o of os) {
      const a = o.offset - o.width / 2, b = o.offset + o.width / 2;
      const ref = refs.get(o.id) ?? '';
      if (o.kind === 'door') {
        // Leaf drawn open at 90° on the normal side, with its swing.
        const hinge = at(a, t / 2), tip = at(b, t / 2);
        const open: Vec2 = [hinge[0] + n[0] * o.width, hinge[1] + n[1] * o.width];
        g += `<g data-opening="${esc(o.id)}"><line x1="${X(hinge[0])}" y1="${Y(hinge[1])}" x2="${X(open[0])}" y2="${Y(open[1])}" stroke="${INK}" stroke-width="0.4"/>`;
        g += `<path d="M ${X(open[0])} ${Y(open[1])} A ${f(o.width * k)} ${f(o.width * k)} 0 0 ${u[0] * n[1] - u[1] * n[0] > 0 ? 1 : 0} ${X(tip[0])} ${Y(tip[1])}" stroke="${INK}" stroke-width="0.18" stroke-dasharray="1 0.8"/></g>`;
      } else {
        g += `<g data-opening="${esc(o.id)}">`;
        for (const d of [-t / 2, -t / 6, t / 6, t / 2]) g += `<line x1="${X(at(a, d)[0])}" y1="${Y(at(a, d)[1])}" x2="${X(at(b, d)[0])}" y2="${Y(at(b, d)[1])}" stroke="${INK}" stroke-width="${Math.abs(d) < t / 3 ? 0.18 : 0.3}"/>`;
        g += '</g>';
      }
      const tagSide = zones.some(z => inside(at(o.offset, t / 2 + 0.3), z.points)) ? 1 : -1;
      const tag = at(o.offset, tagSide * (t / 2 + 0.45));
      g += `<g data-tag="${esc(ref)}"><rect x="${f(X(tag[0]) - 4.5)}" y="${f(Y(tag[1]) - 2.3)}" width="9" height="4.6" rx="1" fill="#fff" stroke="${ACCENT}" stroke-width="0.3"/><text x="${X(tag[0])}" y="${f(Y(tag[1]) + 1)}" font-size="2.8" font-weight="700" fill="${ACCENT}" text-anchor="middle">${esc(ref)}</text></g>`;
    }
    // An outside wall gets its length outside the building; inside walls are read from the rooms.
    const probe = (side: number) => at(len / 2, side * (t / 2 + 0.3));
    const out = [1, -1].find(side => !zones.some(z => inside(probe(side), z.points)));
    const otherIn = out !== undefined && zones.some(z => inside(probe(-out), z.points));
    if (out !== undefined && otherIn) {
      const d = out * (t / 2 + 0.9);
      const p1 = at(0, d), p2 = at(len, d);
      g += dim(ox + (p1[0] - minX) * k, oy + (p1[1] - minY) * k, ox + (p2[0] - minX) * k, oy + (p2[1] - minY) * k, mm(len), out > 0 ? 1 : -1);
    }
  }

  // Overall dimensions, above and to the left.
  const wx0 = Math.min(...walls.flatMap(w => [w.a[0], w.b[0]]), minX + 0.5), wx1 = Math.max(...walls.flatMap(w => [w.a[0], w.b[0]]), maxX - 0.5);
  const wy0 = Math.min(...walls.flatMap(w => [w.a[1], w.b[1]]), minY + 0.5), wy1 = Math.max(...walls.flatMap(w => [w.a[1], w.b[1]]), maxY - 0.5);
  g += dim(X(wx0), f(Y(wy0) - 1.6 * k - 6), X(wx1), f(Y(wy0) - 1.6 * k - 6), mm(wx1 - wx0));
  g += dim(f(X(wx0) - 1.6 * k - 6), Y(wy0), f(X(wx0) - 1.6 * k - 6), Y(wy1), mm(wy1 - wy0), 1);

  const name = `${building?.name ?? ''} — ${level.name} plan`;
  return { id: `plan-${levelId}`, title: name, svg: sheet(`<g data-part="plan">${g}</g>`, { project: doc.name, drawing: name, scale, number }) };
}

/** Elevations of walls with doors or windows, two to a sheet, so most fit at 1:50. */
export function elevationSheets(doc: SceneDoc, firstNumber: number, catalogue?: Catalogue): Sheet[] {
  const refs = refsFor(doc, catalogue);
  const walls: { w: WallNode; where: string }[] = [];
  for (const { building, level } of levelsOf(doc)) {
    for (const c of level.children) {
      const w = doc.nodes[c];
      if (w?.type === 'wall' && openingsOf(doc, w).length) walls.push({ w, where: `${building.name}, ${level.name}` });
    }
  }
  const sheets: Sheet[] = [];
  const PER = 2;
  const cellW = PAPER.w - 2 * MARGIN, cellH = (PAPER.h - 2 * MARGIN - TITLE_H) / PER;
  for (let i = 0; i < walls.length; i += PER) {
    const group = walls.slice(i, i + PER);
    const longest = Math.max(...group.map(g => Math.hypot(g.w.b[0] - g.w.a[0], g.w.b[1] - g.w.a[1])));
    const tallest = Math.max(...group.map(g => g.w.height));
    const scale = pickScale(longest, tallest, cellW - 40, cellH - 34);
    const k = 1000 / scale;
    let g = '';
    group.forEach(({ w, where }, j) => {
      const cx = MARGIN, cy = MARGIN + j * cellH;
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const x0 = cx + 22, base = cy + cellH - 18;
      const X = (s: number) => f(x0 + s * k), Y = (h: number) => f(base - h * k);
      g += `<g data-elevation="${esc(w.id)}">`;
      g += `<text x="${cx + 6}" y="${cy + 8}" font-size="3.6" font-weight="700" fill="${INK}">${esc(w.name)}</text><text x="${cx + 6}" y="${cy + 13}" font-size="2.8" fill="#4a4f68">${esc(where)} · seen from the side its normal faces</text>`;
      g += `<rect x="${X(0)}" y="${Y(w.height)}" width="${f(len * k)}" height="${f(w.height * k)}" fill="#f1efe9" stroke="${INK}" stroke-width="0.35"/>`;
      g += `<line x1="${f(X(0) - 4)}" y1="${Y(0)}" x2="${f(X(len) + 4)}" y2="${Y(0)}" stroke="${INK}" stroke-width="0.5"/>`;
      const chain = [0];
      for (const o of openingsOf(doc, w)) {
        const a = o.offset - o.width / 2, b = o.offset + o.width / 2, top = o.sill + o.height;
        chain.push(a, b);
        const r = o.width / 2;
        const shape = o.shape === 'arched'
          ? `<path d="M ${X(a)} ${Y(o.sill)} L ${X(a)} ${Y(top - r)} A ${f(r * k)} ${f(r * k)} 0 0 1 ${X(b)} ${Y(top - r)} L ${X(b)} ${Y(o.sill)} Z" fill="#fff" stroke="${INK}" stroke-width="0.35"/>`
          : `<rect x="${X(a)}" y="${Y(top)}" width="${f(o.width * k)}" height="${f(o.height * k)}" fill="#fff" stroke="${INK}" stroke-width="0.35"/>`;
        const fr = frameSize(o, doc.settings.tolerance);
        g += `<g data-opening="${esc(o.id)}">${shape}<text x="${X(o.offset)}" y="${f(Y(o.sill + o.height / 2) - 1)}" font-size="2.8" font-weight="700" fill="${ACCENT}" text-anchor="middle">${esc(refs.get(o.id) ?? '')}</text><text x="${X(o.offset)}" y="${f(Y(o.sill + o.height / 2) + 3)}" font-size="2.3" fill="${INK}" text-anchor="middle">${mm(o.width)} × ${mm(o.height)}</text><text x="${X(o.offset)}" y="${f(Y(o.sill + o.height / 2) + 6.4)}" font-size="2" fill="#4a4f68" text-anchor="middle">frame ${mm(fr.width)} × ${mm(fr.height)}</text>`;
        if (o.sill > 0) g += dim(f(X(b) + 2.5), Y(0), f(X(b) + 2.5), Y(o.sill), mm(o.sill), 1);
        g += dim(f(X(a) - 2.5), Y(0), f(X(a) - 2.5), Y(top), mm(top), -1);
        g += '</g>';
      }
      chain.push(len);
      for (let c = 0; c < chain.length - 1; c++) if (chain[c + 1] - chain[c] > 1e-6) g += dim(X(chain[c]), f(Y(0) + 6), X(chain[c + 1]), f(Y(0) + 6), mm(chain[c + 1] - chain[c]), 1);
      g += dim(X(0), f(Y(0) + 12), X(len), f(Y(0) + 12), mm(len), 1);
      g += dim(f(X(len) + 8), Y(0), f(X(len) + 8), Y(w.height), mm(w.height), 1);
      g += '</g>';
    });
    const number = `A${String(firstNumber + sheets.length).padStart(2, '0')}`;
    const n = i / PER + 1;
    sheets.push({ id: `elevations-${n}`, title: `Wall elevations ${n}`, svg: sheet(g, { project: doc.name, drawing: `Wall elevations ${n} of ${Math.ceil(walls.length / PER)}`, scale, number }) });
  }
  return sheets;
}

/** Every sheet: a plan of each level, then the wall elevations. */
export function drawingSet(doc: SceneDoc, catalogue?: Catalogue): Sheet[] {
  const plans = levelsOf(doc).map(({ level }, i) => planSheet(doc, level.id, `A${String(i + 1).padStart(2, '0')}`, catalogue));
  return [...plans, ...elevationSheets(doc, plans.length + 1, catalogue)];
}
