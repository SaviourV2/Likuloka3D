/**
 * The welcome page's line drawing: an axonometric sketch of a two-storey house
 * with a cantilevered upper floor, its ground grid and a dimension line.
 * Worked out from the numbers below, so it is the same on every load.
 */

type P3 = [number, number, number];
type P2 = [number, number];

const COS = Math.cos(Math.PI / 6), SIN = Math.sin(Math.PI / 6), S = 34;
/** Plan x runs down to the right, plan y down to the left, z up. */
const iso = ([x, y, z]: P3): P2 => [(x - y) * COS * S, (x + y) * SIN * S - z * S];

interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/** Edges of a box seen from the +x +y side: the ones in front and the ones behind it. */
function boxEdges(b: Box): { front: [P3, P3][]; back: [P3, P3][] } {
  const { x0, y0, z0, x1, y1, z1 } = b;
  const top: [P3, P3][] = [[[x0, y0, z1], [x1, y0, z1]], [[x1, y0, z1], [x1, y1, z1]], [[x1, y1, z1], [x0, y1, z1]], [[x0, y1, z1], [x0, y0, z1]]];
  const front: [P3, P3][] = [
    ...top,
    [[x1, y0, z0], [x1, y0, z1]], [[x1, y1, z0], [x1, y1, z1]], [[x0, y1, z0], [x0, y1, z1]],
    [[x1, y0, z0], [x1, y1, z0]], [[x1, y1, z0], [x0, y1, z0]],
  ];
  const back: [P3, P3][] = [[[x0, y0, z0], [x0, y0, z1]], [[x0, y0, z0], [x1, y0, z0]], [[x0, y0, z0], [x0, y1, z0]]];
  return { front, back };
}

/** Window frames with one mullion on the face x = const, between y0 and y1. */
function windowsX(x: number, y0: number, y1: number, z0: number, sill: number, head: number, n: number): [P3, P3][] {
  const out: [P3, P3][] = [], w = (y1 - y0) / n, m = w * .14;
  for (let i = 0; i < n; i++) {
    const a = y0 + i * w + m, b = y0 + (i + 1) * w - m, lo = z0 + sill, hi = z0 + head, mid = (a + b) / 2;
    out.push([[x, a, lo], [x, b, lo]], [[x, b, lo], [x, b, hi]], [[x, b, hi], [x, a, hi]], [[x, a, hi], [x, a, lo]], [[x, mid, lo], [x, mid, hi]]);
  }
  return out;
}

/** The same on the face y = const, between x0 and x1. */
function windowsY(y: number, x0: number, x1: number, z0: number, sill: number, head: number, n: number): [P3, P3][] {
  return windowsX(0, x0, x1, z0, sill, head, n).map(([a, b]) => [[a[1], y, a[2]], [b[1], y, b[2]]]);
}

const ground: Box = { x0: 0, y0: 0, z0: 0, x1: 9, y1: 7, z1: 3.2 };
const upper: Box = { x0: 1.5, y0: -1, z0: 3.2, x1: 11.5, y1: 6, z1: 6.4 };
const roof: Box = { x0: 1, y0: -1.5, z0: 6.4, x1: 12, y1: 6.5, z1: 6.75 };

const g = boxEdges(ground), u = boxEdges(upper), r = boxEdges(roof);
const strong: [P3, P3][] = [...g.front, ...u.front, ...r.front];
const hidden: [P3, P3][] = [...g.back, ...u.back];
const thin: [P3, P3][] = [
  ...windowsX(ground.x1, .6, 6.4, 0, 0, 2.4, 3),
  ...windowsY(ground.y1, .6, 8.4, 0, .9, 2.4, 3),
  ...windowsX(upper.x1, -.4, 5.4, 3.2, .3, 2.7, 4),
  ...windowsY(upper.y1, 2.1, 10.9, 3.2, 1, 2.6, 4),
  // columns under the cantilever
  [[11, -.5, 0], [11, -.5, 3.2]], [[11, 5.5, 0], [11, 5.5, 3.2]], [[9, -.5, 0], [9, -.5, 3.2]],
  // terrace edge under the overhang
  [[9, -1, 0], [11.5, -1, 0]], [[11.5, -1, 0], [11.5, 6, 0]], [[11.5, 6, 0], [9, 6, 0]],
];
/** Construction lines: the ground grid and the column lines carried up past the roof. */
const dashed: [P3, P3][] = [];
for (let i = 0; i <= 12; i += 2) dashed.push([[i, -2, 0], [i, 8, 0]]);
for (let j = -2; j <= 8; j += 2) dashed.push([[-.5, j, 0], [12.5, j, 0]]);
for (const [x, y] of [[12, -1.5], [12, 6.5], [1, 6.5], [6, 6.5], [12, 2.5]] as const) dashed.push([[x, y, 6.75], [x, y, 13]]);
/** A datum plane over the roof, where the next storey would go. */
dashed.push([[1, 6.5, 10], [12, 6.5, 10]], [[12, 6.5, 10], [12, -1.5, 10]]);

/** A dimension line along the front of the ground floor, 1.2 m out. */
const dimY = ground.y1 + 1.6;
const dims: [P3, P3][] = [[[0, dimY, 0], [9, dimY, 0]], [[0, ground.y1 + .2, 0], [0, dimY + .3, 0]], [[9, ground.y1 + .2, 0], [9, dimY + .3, 0]]];
const ticks: [P3, P3][] = [[[-.25, dimY - .25, 0], [.25, dimY + .25, 0]], [[8.75, dimY - .25, 0], [9.25, dimY + .25, 0]]];

const all = [...strong, ...hidden, ...thin, ...dashed, ...dims].flatMap(([a, b]) => [iso(a), iso(b)]);
const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0]));
const minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1]));
/** The frame keeps likuloka.com's drawing proportions (1312 × 1431). */
const ASPECT = 1312 / 1431, PAD = 24;
const bw = maxX - minX + PAD * 2, bh = maxY - minY + PAD * 2;
const vw = Math.max(bw, bh * ASPECT), vh = vw / ASPECT;
const ox = minX - PAD - (vw - bw) / 2, oy = minY - PAD - (vh - bh) / 2;

const f = (n: number) => n.toFixed(1);
const path = (segs: [P3, P3][]) => segs.map(([a, b]) => { const p = iso(a), q = iso(b); return `M${f(p[0])} ${f(p[1])}L${f(q[0])} ${f(q[1])}`; }).join('');

const label = iso([4.5, dimY + .9, 0]);

export const drawing = {
  viewBox: `${f(ox)} ${f(oy)} ${f(vw)} ${f(vh)}`,
  width: 1312,
  height: 1431,
  strong: path([...strong, ...dims, ...ticks]),
  thin: path(thin),
  hidden: path(hidden),
  dashed: path(dashed),
  label: { x: f(label[0]), y: f(label[1]), text: '9 000' },
};
