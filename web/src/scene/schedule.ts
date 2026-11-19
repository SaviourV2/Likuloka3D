/**
 * The door and window schedule: every opening in the project with its
 * reference, place and sizes, for ordering and making frames. Sizes are in
 * millimetres, as joiners and fabricators work.
 *
 * References run D01, D02… for doors and W01, W02… for windows, in the order
 * of the scene: building, level from the ground up, wall, then along the wall.
 */
import type { OpeningNode, SceneDoc } from './types';
import { FINISH_LABELS } from './types';

export interface ScheduleRow {
  ref: string;
  id: string;
  building: string;
  level: string;
  kind: 'Door' | 'Window';
  shape: 'Square' | 'Rounded';
  finish: string;
  state: 'Open' | 'Closed';
  width: number;
  height: number;
  sill: number;
  head: number;
  /** Wall thickness: the depth the frame must span. */
  wall: number;
}

const mm = (m: number) => Math.round(m * 1000);

export function schedule(doc: SceneDoc): ScheduleRow[] {
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
          rows.push({
            ref: `${o.kind === 'door' ? 'D' : 'W'}${String(n).padStart(2, '0')}`,
            id: o.id,
            building: building.name,
            level: level.name,
            kind: o.kind === 'door' ? 'Door' : 'Window',
            shape: o.shape === 'arched' ? 'Rounded' : 'Square',
            finish: FINISH_LABELS[o.finish],
            state: o.state === 'open' ? 'Open' : 'Closed',
            width: mm(o.width), height: mm(o.height), sill: mm(o.sill), head: mm(o.sill + o.height),
            wall: mm(wall.thickness),
          });
        }
      }
    }
  }
  return rows;
}

/** Openings that can be made the same way, with how many of each: what to order. */
export function types(rows: ScheduleRow[]) {
  const map = new Map<string, { kind: string; shape: string; finish: string; width: number; height: number; wall: number; refs: string[] }>();
  for (const r of rows) {
    const key = [r.kind, r.shape, r.finish, r.width, r.height, r.wall].join('|');
    const t = map.get(key) ?? { kind: r.kind, shape: r.shape, finish: r.finish, width: r.width, height: r.height, wall: r.wall, refs: [] };
    t.refs.push(r.ref);
    map.set(key, t);
  }
  return [...map.values()].sort((p, q) => p.kind.localeCompare(q.kind) || q.refs.length - p.refs.length);
}

const cell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function scheduleCsv(doc: SceneDoc): string {
  const head = ['Ref', 'Type', 'Shape', 'Finish', 'Width (mm)', 'Height (mm)', 'Sill (mm)', 'Head (mm)', 'Wall (mm)', 'Building', 'Level', 'Drawn'];
  const rows = schedule(doc).map(r => [r.ref, r.kind, r.shape, r.finish, r.width, r.height, r.sill, r.head, r.wall, r.building, r.level, r.state]);
  return [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
