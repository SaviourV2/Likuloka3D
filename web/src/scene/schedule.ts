/**
 * The door and window schedule: every opening in the project with its
 * reference, product, place and sizes, for ordering and making frames.
 * Sizes are in millimetres, as joiners and fabricators work: the structural
 * opening (the hole in the wall) and the frame that fits it.
 *
 * References run D01, D02… for doors and W01, W02… for windows, in the order
 * of the scene: building, level from the ground up, wall, then along the wall.
 */
import { frameSize, FINISH_LABELS, type OpeningNode, type SceneDoc } from './types';
import { productFor, type Catalogue } from './catalogue';

export interface ScheduleRow {
  ref: string;
  id: string;
  building: string;
  level: string;
  kind: 'Door' | 'Window';
  shape: 'Square' | 'Rounded';
  finish: string;
  state: 'Open' | 'Closed';
  /** Catalogue code, or empty for a custom size. */
  product: string;
  productName: string;
  /** Structural opening. */
  width: number;
  height: number;
  frameWidth: number;
  frameHeight: number;
  sill: number;
  head: number;
  /** Wall thickness: the depth the frame must span. */
  wall: number;
  /** Unit price from the catalogue, or null for a custom size. */
  price: number | null;
}

const mm = (m: number) => Math.round(m * 1000);

export function schedule(doc: SceneDoc, catalogue?: Catalogue): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let doors = 0, windows = 0;
  for (const b of doc.roots) {
    const building = doc.nodes[b];
    if (building?.type !== 'building') continue;
    const levels = building.children.map(c => doc.nodes[c]).filter(n => n?.type === 'level').sort((p, q) => (p as { elevation: number }).elevation - (q as { elevation: number }).elevation);
    for (const level of levels) {
      if (level?.type !== 'level') continue;
      for (const c of level.children) {
        const wall = doc.nodes[c];
        if (wall?.type !== 'wall') continue;
        const openings = wall.children.map(o => doc.nodes[o]).filter((o): o is OpeningNode => o?.type === 'opening').sort((p, q) => p.offset - q.offset);
        for (const o of openings) {
          const n = o.kind === 'door' ? ++doors : ++windows;
          const frame = frameSize(o, doc.settings.tolerance);
          const product = catalogue ? productFor(catalogue, o.product) : null;
          rows.push({
            ref: `${o.kind === 'door' ? 'D' : 'W'}${String(n).padStart(2, '0')}`,
            id: o.id,
            building: building.name,
            level: level.name,
            kind: o.kind === 'door' ? 'Door' : 'Window',
            shape: o.shape === 'arched' ? 'Rounded' : 'Square',
            finish: FINISH_LABELS[o.finish],
            state: o.state === 'open' ? 'Open' : 'Closed',
            product: o.product ?? '',
            productName: product?.name ?? (o.product ? 'Not in the catalogue' : 'Custom size'),
            width: mm(o.width), height: mm(o.height),
            frameWidth: mm(frame.width), frameHeight: mm(frame.height),
            sill: mm(o.sill), head: mm(o.sill + o.height),
            wall: mm(wall.thickness),
            price: product?.price ?? null,
          });
        }
      }
    }
  }
  return rows;
}

/** Openings that can be made the same way, with how many of each: what to order. */
export function types(rows: ScheduleRow[]) {
  const map = new Map<string, { kind: string; product: string; productName: string; shape: string; finish: string; width: number; height: number; frameWidth: number; frameHeight: number; wall: number; price: number | null; refs: string[] }>();
  for (const r of rows) {
    const key = [r.kind, r.product, r.shape, r.finish, r.width, r.height, r.wall].join('|');
    const t = map.get(key) ?? { kind: r.kind, product: r.product, productName: r.productName, shape: r.shape, finish: r.finish, width: r.width, height: r.height, frameWidth: r.frameWidth, frameHeight: r.frameHeight, wall: r.wall, price: r.price, refs: [] };
    t.refs.push(r.ref);
    map.set(key, t);
  }
  return [...map.values()].sort((p, q) => p.kind.localeCompare(q.kind) || q.refs.length - p.refs.length);
}

/** The total of every priced opening, and how many have no price. */
export function totals(rows: ScheduleRow[]) {
  return {
    total: rows.reduce((s, r) => s + (r.price ?? 0), 0),
    unpriced: rows.filter(r => r.price === null).length,
  };
}

export const COLUMNS: Record<string, { head: string; value: (r: ScheduleRow) => string | number }> = {
  ref: { head: 'Ref', value: r => r.ref },
  kind: { head: 'Type', value: r => r.kind },
  product: { head: 'Product', value: r => r.product },
  productName: { head: 'Description', value: r => r.productName },
  shape: { head: 'Shape', value: r => r.shape },
  finish: { head: 'Finish', value: r => r.finish },
  frameWidth: { head: 'Frame width (mm)', value: r => r.frameWidth },
  frameHeight: { head: 'Frame height (mm)', value: r => r.frameHeight },
  width: { head: 'Opening width (mm)', value: r => r.width },
  height: { head: 'Opening height (mm)', value: r => r.height },
  sill: { head: 'Sill (mm)', value: r => r.sill },
  head: { head: 'Head (mm)', value: r => r.head },
  wall: { head: 'Wall (mm)', value: r => r.wall },
  price: { head: 'Price', value: r => (r.price === null ? '' : r.price) },
  building: { head: 'Building', value: r => r.building },
  level: { head: 'Level', value: r => r.level },
  state: { head: 'Drawn', value: r => r.state },
};
export const DEFAULT_COLUMNS = Object.keys(COLUMNS);

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The schedule as CSV, with the catalogue's columns in its order (unknown names are left out). */
export function scheduleCsv(doc: SceneDoc, catalogue?: Catalogue): string {
  const wanted = (catalogue?.scheduleColumns.length ? catalogue.scheduleColumns : DEFAULT_COLUMNS).filter(k => k in COLUMNS);
  const rows = schedule(doc, catalogue);
  const lines = [wanted.map(k => COLUMNS[k].head), ...rows.map(r => wanted.map(k => COLUMNS[k].value(r)))];
  return lines.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
